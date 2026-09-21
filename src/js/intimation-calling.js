// ============================================================================
// Motorola Care - Intimation Calling Workflow Controller
// Manages ETR updates, dynamic re-intimation on expiring ETAs, and 3-ETA cap
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin, hasAdminOrBsmAccess } from "./auth.js";
import { formatMobile, formatDate, formatDateTime, calculateAgeingDays, escapeHtml, icons } from "./utils.js";
import { showToast } from "../components/toast.js";
import { renderSpinner } from "../components/loading.js";

let currentCall = null;
let isSubmitting = false;
const skippedServiceOrders = new Set();
const attemptedServiceOrders = new Set();

export async function renderIntimationCallingPage(container) {
  container.innerHTML = `
    <div class="call-workflow-container">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
        <div>
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <span class="badge" style="background:#fef3c7; color:#b45309; font-weight:700;">Critical Ageing (&gt;3 Days)</span>
            <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary); margin:0;">Intimation Calling Queue</h2>
          </div>
          <p style="font-size:0.875rem; color:var(--text-secondary); margin-top:0.25rem;">
            Intimate customer with Expected Time of Resolution (ETR) for active open service orders (Max 3 ETAs per order).
          </p>
        </div>
        <div style="display:flex; gap:0.5rem;">
          <a href="#/intimation/pending" class="btn-secondary" style="font-size:0.8125rem;">
            <span>View All Open Calls</span>
          </a>
          <button type="button" id="btn-refresh-intimation" class="btn-secondary" style="display:flex; align-items:center; gap:0.35rem; font-size:0.8125rem;">
            <span style="display:block; width:16px; height:16px;">${icons.refreshCw}</span>
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <div id="intimation-queue-mount">
        ${renderSpinner("Retrieving next open call requiring ETR intimation...")}
      </div>
    </div>
  `;

  document.getElementById("btn-refresh-intimation")?.addEventListener("click", () => {
    // Clear any ?so= from hash so next call picks next oldest
    if (window.location.hash.includes("?so=")) {
      window.location.hash = "#/intimation/calling";
    } else {
      loadNextIntimationCall();
    }
  });

  let initialSo = null;
  const hash = window.location.hash || "";
  if (hash.includes("?so=")) {
    initialSo = decodeURIComponent(hash.split("?so=")[1].split("&")[0]);
  }

  await loadNextIntimationCall(initialSo);
}

/**
 * Fetch next oldest open call requiring intimation (carry_in_time > 3 days ago OR expiring ETR)
 */
export async function loadNextIntimationCall(specificSoNumber = null) {
  const mount = document.getElementById("intimation-queue-mount");
  if (!mount) return;

  mount.innerHTML = renderSpinner("Fetching eligible open call...");

  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    let callRecord = null;
    let isReintimation = false;
    let etaDue = 1;

    if (specificSoNumber) {
      // Direct load by SO Number (from pending list click)
      let query = supabase.from("open_calls_master").select("*").eq("service_order", specificSoNumber.trim());
      if (!hasAdminOrBsmAccess() && profile?.cci_code) {
        query = query.eq("cci_code", profile.cci_code);
      }
      const { data, error } = await query.order("created_at", { ascending: false }).limit(1);
      if (error) throw error;
      callRecord = data && data.length > 0 ? data[0] : null;
      if (callRecord) {
        isReintimation = (callRecord.eta_count > 0 || !!callRecord.current_etr_date);
        etaDue = isReintimation ? (callRecord.eta_count || 1) + 1 : 1;
      }
    } else {
      const todayStr = new Date().toISOString().split("T")[0];
      const tomorrowStr = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const threeDaysAgoIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

      let candidateBatch = [];

      // 1. Check for expiring/overdue ETRs first (Re-intimation priority)
      let qExpiring = supabase
        .from("open_calls_master")
        .select("*")
        .eq("is_open", true)
        .is("finish_repair_time", null)
        .not("current_etr_date", "is", null)
        .lte("current_etr_date", tomorrowStr)
        .lt("eta_count", 3);

      if (!hasAdminOrBsmAccess() && profile?.cci_code) {
        qExpiring = qExpiring.eq("cci_code", profile.cci_code);
      }

      const { data: expiringBatch } = await qExpiring.order("current_etr_date", { ascending: true }).limit(30);
      if (expiringBatch && expiringBatch.length > 0) {
        expiringBatch.forEach((c) => {
          c._isReintimation = true;
          c._etaDue = (c.eta_count || 1) + 1;
        });
        candidateBatch.push(...expiringBatch);
      }

      // 2. Fresh open calls with Ageing > 3 days
      let q = supabase
        .from("open_calls_master")
        .select("*")
        .eq("is_open", true)
        .lte("carry_in_time", threeDaysAgoIso);

      if (!hasAdminOrBsmAccess() && profile?.cci_code) {
        q = q.eq("cci_code", profile.cci_code);
      }

      const { data: openBatch } = await q.order("carry_in_time", { ascending: true }).limit(50);

      if (openBatch && openBatch.length > 0) {
        const soList = openBatch.map((c) => c.service_order);
        const { data: completedIntimations } = await supabase
          .from("intimation_calling")
          .select("service_order")
          .in("service_order", soList)
          .eq("calling_status", "Completed");

        const completedSoSet = new Set((completedIntimations || []).map((i) => i.service_order));
        const pendingFresh = openBatch.filter((c) => !completedSoSet.has(c.service_order));
        pendingFresh.forEach((c) => {
          c._isReintimation = false;
          c._etaDue = 1;
        });
        candidateBatch.push(...pendingFresh);
      }

      // Exclude calls already attempted in this session
      candidateBatch = candidateBatch.filter((c) => !attemptedServiceOrders.has(c.service_order));

      if (candidateBatch.length > 0) {
        // Query recent attempts today to deprioritize calls already attempted today
        const candidateSos = candidateBatch.map((c) => c.service_order);
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        try {
          const { data: todayAttempts } = await supabase
            .from("intimation_calling")
            .select("service_order")
            .in("service_order", candidateSos)
            .gte("created_at", todayStart.toISOString());

          const attemptedTodaySet = new Set((todayAttempts || []).map((a) => a.service_order));

          // Sort so calls NOT attempted today come first
          candidateBatch.sort((a, b) => {
            const aToday = attemptedTodaySet.has(a.service_order) ? 1 : 0;
            const bToday = attemptedTodaySet.has(b.service_order) ? 1 : 0;
            if (aToday !== bToday) return aToday - bToday;
            return 0;
          });
        } catch (e) {
          console.warn("Could not check today intimation attempts:", e);
        }

        // Pick first candidate not yet skipped in this session
        callRecord = candidateBatch.find((c) => !skippedServiceOrders.has(c.service_order));

        // If all available calls were skipped, wrap around ONLY to skipped calls
        if (!callRecord && skippedServiceOrders.size > 0) {
          const skippedCandidates = candidateBatch.filter((c) => skippedServiceOrders.has(c.service_order));
          if (skippedCandidates.length > 0) {
            skippedServiceOrders.clear();
            callRecord = skippedCandidates[0];
            showToast("Reached end of pending queue. Returning to first skipped call.", "info");
          }
        }

        if (callRecord) {
          isReintimation = !!callRecord._isReintimation;
          etaDue = callRecord._etaDue || 1;
        }
      }

      // 3. Fallback to RPC if direct query yielded nothing and no skip/attempt active
      if (!callRecord && skippedServiceOrders.size === 0 && attemptedServiceOrders.size === 0) {
        try {
          const { data: rpcData } = await supabase.rpc("get_next_intimation_call");
          if (rpcData?.found && rpcData.call && !attemptedServiceOrders.has(rpcData.call.service_order)) {
            callRecord = rpcData.call;
            isReintimation = !!rpcData.is_reintimation;
            etaDue = rpcData.eta_due || 1;
          }
        } catch (e) {
          console.warn("RPC get_next_intimation_call fallback:", e);
        }
      }
    }

    if (!callRecord) {
      currentCall = null;
      mount.innerHTML = `
        <div class="empty-state" style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:3rem 1.5rem;">
          <div class="empty-state-icon" style="color:var(--status-success-dot);">${icons.checkCircle}</div>
          <h3 style="margin-top:0.75rem; font-size:1.25rem;">All Caught Up on Intimation Calls!</h3>
          <p style="color:var(--text-secondary); max-width:480px; margin:0.5rem auto 1.5rem auto;">
            There are no pending open calls requiring customer initial ETR or re-intimation right now.
          </p>
          <div style="display:flex; justify-content:center; gap:0.75rem; flex-wrap:wrap;">
            <a href="#/intimation/pending" class="btn-primary">View All Open Calls</a>
            <a href="#/intimation/history" class="btn-secondary">View Intimation History</a>
          </div>
        </div>
      `;
      return;
    }

    currentCall = callRecord;
    currentCall.is_reintimation = isReintimation;

    // Check past intimation attempts & completed ETAs
    try {
      const { data: pastAttempts } = await supabase
        .from("intimation_calling")
        .select("etr_date, calling_status, cci_comment, customer_comment, eta_number, revision_reason, created_at")
        .eq("service_order", currentCall.service_order)
        .order("created_at", { ascending: false });

      currentCall.pastAttempts = pastAttempts || [];
    } catch (e) {
      console.warn("Could not load past intimation attempts:", e);
      currentCall.pastAttempts = [];
    }

    // Determine current ETA count and due ETA sequence
    const completedPast = (currentCall.pastAttempts || []).filter((a) => a.calling_status === "Completed");
    currentCall.completedEtasCount = completedPast.length;
    currentCall.currentEtaNumber = Math.min(3, currentCall.completedEtasCount + 1);
    currentCall.isMaxEtasReached = currentCall.completedEtasCount >= 3;

    renderEtrWindow(mount, currentCall);
  } catch (err) {
    console.error("loadNextIntimationCall error:", err);
    mount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error retrieving open call:</strong> ${formatSupabaseError(err)}
        <div style="margin-top:1rem;">
          <button type="button" class="btn-secondary" id="btn-retry-intimation">Try Again</button>
        </div>
      </div>
    `;
    document.getElementById("btn-retry-intimation")?.addEventListener("click", () => loadNextIntimationCall(specificSoNumber));
  }
}

/**
 * Render the ETR Update Window with all 9 required info fields, 3-ETA stepper, and input form
 */
function renderEtrWindow(mount, call) {
  const ageingDays = calculateAgeingDays(call.carry_in_time);
  const formattedPhone = formatMobile(call.customer_mobile);
  const telHref = call.customer_mobile ? `tel:${call.customer_mobile.replace(/\D/g, "")}` : "#";
  const altPhone = call.alternate_mobile ? formatMobile(call.alternate_mobile) : null;
  const altTelHref = altPhone ? `tel:${call.alternate_mobile.replace(/\D/g, "")}` : null;

  // Tomorrow as default ETR date suggestion
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const defaultEtrDate = tomorrow.toISOString().split("T")[0];
  const todayStr = new Date().toISOString().split("T")[0];

  const pastAttempts = call.pastAttempts || [];
  const completedPast = pastAttempts.filter((a) => a.calling_status === "Completed");
  const latestCompletedEtr = completedPast.length > 0 ? completedPast[0] : null;

  const isReintimation = call.completedEtasCount > 0 && !call.isMaxEtasReached;
  const isMaxEtas = call.isMaxEtasReached;
  const currentEtaNum = call.currentEtaNumber;

  // Attempt History HTML
  let attemptHistoryHtml = "";
  if (pastAttempts.length > 0) {
    attemptHistoryHtml = `
      <div style="margin-top:1.25rem; padding:1rem; background:var(--bg-surface-secondary); border:1px solid var(--border-subtle); border-radius:var(--radius-lg);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
          <strong style="color:var(--text-primary); font-size:0.875rem; display:flex; align-items:center; gap:0.35rem;">
            <span>${icons.clock}</span>
            <span>Intimation &amp; ETA History (${pastAttempts.length} records)</span>
          </strong>
          <span style="font-size:0.75rem; color:var(--text-tertiary);">Max Limit: 3 ETAs</span>
        </div>

        <div style="display:flex; flex-direction:column; gap:0.5rem;">
          ${pastAttempts.map((attempt, idx) => {
            const isCompleted = attempt.calling_status === "Completed";
            const badgeClass = isCompleted ? "badge-success" : attempt.calling_status === "Customer Not Reachable" ? "badge-warning" : "badge-info";
            return `
              <div style="padding:0.6rem 0.75rem; background:#fff; border:1px solid var(--border-subtle); border-radius:6px; font-size:0.8125rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.25rem;">
                  <div>
                    ${attempt.eta_number ? `<strong style="color:var(--moto-blue-accent);">ETA #${attempt.eta_number}:</strong> ` : ""}
                    ${attempt.etr_date ? `<strong style="color:var(--text-primary);">${formatDate(attempt.etr_date)}</strong>` : ""}
                    <span style="color:var(--text-tertiary); font-size:0.75rem; margin-left:6px;">&bull; ${formatDateTime(attempt.created_at)}</span>
                  </div>
                  <span class="badge ${badgeClass}" style="font-size:0.7rem;">${escapeHtml(attempt.calling_status)}</span>
                </div>
                ${attempt.revision_reason ? `<div style="color:#b45309; font-size:0.75rem; margin-top:2px;"><strong>Revision Reason:</strong> ${escapeHtml(attempt.revision_reason)}</div>` : ""}
                ${attempt.cci_comment || attempt.customer_comment ? `<div style="color:var(--text-secondary); font-size:0.75rem; margin-top:2px;"><em>"${escapeHtml(attempt.customer_comment || attempt.cci_comment)}"</em></div>` : ""}
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  // Warranty badge styling
  const isOut = (call.warranty_status || "").toUpperCase().includes("OUT") || (call.warranty_status || "").toUpperCase().includes("OOW");
  const warrantyBadge = call.warranty_status
    ? `<span class="badge ${isOut ? "badge-warning" : "badge-success"}" style="font-size:0.75rem; font-weight:600;">${escapeHtml(call.warranty_status)}</span>`
    : `<span class="badge badge-neutral" style="font-size:0.75rem;">N/A</span>`;

  // Parts status badge
  let partsBadge = `<span class="badge badge-neutral" style="font-size:0.75rem;">${escapeHtml(call.parts_status || "No Parts Required")}</span>`;
  if ((call.parts_status || "").toLowerCase().includes("shortage")) {
    partsBadge = `<span class="badge badge-danger" style="font-size:0.75rem; font-weight:600;">⚠️ ${escapeHtml(call.parts_status)}</span>`;
  } else if ((call.parts_status || "").toLowerCase().includes("service center") || (call.parts_status || "").toLowerCase().includes("available")) {
    partsBadge = `<span class="badge badge-success" style="font-size:0.75rem;">📦 ${escapeHtml(call.parts_status)}</span>`;
  } else if (call.parts_status) {
    partsBadge = `<span class="badge badge-info" style="font-size:0.75rem;">🚚 ${escapeHtml(call.parts_status)}</span>`;
  }

  mount.innerHTML = `
    <!-- 3-ETA Stepper Banner -->
    <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:1rem 1.25rem; margin-bottom:1.25rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
      <div>
        <div style="font-size:0.75rem; text-transform:uppercase; font-weight:800; color:var(--text-tertiary); letter-spacing:0.5px;">Turnaround Intimation Policy</div>
        <div style="font-size:1.1rem; font-weight:700; color:var(--text-primary); margin-top:2px;">
          ${isMaxEtas
            ? `<span style="color:#ef4444;">Maximum 3 ETAs Reached (Limit Exceeded)</span>`
            : isReintimation
            ? `<span style="color:#f59e0b;">Re-Intimation Due: Providing ETA #${currentEtaNum} of 3</span>`
            : `<span>Initial Customer Intimation: ETA #1 of 3</span>`
          }
        </div>
      </div>

      <!-- Stepper Pill Indicators -->
      <div style="display:flex; align-items:center; gap:0.5rem;">
        <span class="badge" style="padding:6px 10px; font-weight:700; ${call.completedEtasCount >= 1 ? 'background:#dcfce7; color:#15803d; border:1px solid #86efac;' : currentEtaNum === 1 ? 'background:#e0f2fe; color:#0369a1; border:1px solid #7dd3fc;' : 'background:#f1f5f9; color:#94a3b8;'}">
          ${call.completedEtasCount >= 1 ? '✓ ETA #1' : 'ETA #1'}
        </span>
        <span style="color:#cbd5e1; font-weight:700;">&rarr;</span>
        <span class="badge" style="padding:6px 10px; font-weight:700; ${call.completedEtasCount >= 2 ? 'background:#dcfce7; color:#15803d; border:1px solid #86efac;' : currentEtaNum === 2 ? 'background:#fef3c7; color:#b45309; border:1px solid #fcd34d;' : 'background:#f1f5f9; color:#94a3b8;'}">
          ${call.completedEtasCount >= 2 ? '✓ ETA #2' : 'ETA #2'}
        </span>
        <span style="color:#cbd5e1; font-weight:700;">&rarr;</span>
        <span class="badge" style="padding:6px 10px; font-weight:700; ${call.completedEtasCount >= 3 ? 'background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5;' : currentEtaNum === 3 ? 'background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5;' : 'background:#f1f5f9; color:#94a3b8;'}">
          ${call.completedEtasCount >= 3 ? '🛑 ETA #3 (Max)' : 'ETA #3 (Final)'}
        </span>
      </div>
    </div>

    <!-- Alert Banner for Expired / Expiring ETR -->
    ${isReintimation && latestCompletedEtr ? `
      <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:var(--radius-lg); padding:1rem 1.25rem; margin-bottom:1.25rem; display:flex; gap:0.75rem; align-items:flex-start;">
        <span style="color:#f59e0b; font-size:1.25rem; margin-top:2px;">⚠️</span>
        <div style="font-size:0.875rem; color:#92400e; line-height:1.5;">
          <strong>Previous ETR Expired / Expiring:</strong> Previous committed ETR was <strong>${formatDate(latestCompletedEtr.etr_date)}</strong>. Since repair remains open, call customer to communicate revised resolution date (ETA #${currentEtaNum}) and capture the extension reason.
        </div>
      </div>
    ` : ""}

    <!-- Critical Alert if 3 ETAs reached -->
    ${isMaxEtas ? `
      <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:var(--radius-lg); padding:1rem 1.25rem; margin-bottom:1.25rem; display:flex; gap:0.75rem; align-items:flex-start;">
        <span style="color:#dc2626; font-size:1.35rem; margin-top:2px;">🛑</span>
        <div style="font-size:0.875rem; color:#991b1b; line-height:1.5;">
          <strong>Maximum 3 ETAs Limit Reached:</strong> This service order has already been provided with the maximum permitted 3 customer ETAs under company turnaround policy. Additional ETA commitments are locked. Please escalate directly to the Service Center Manager or Technical Lead for priority resolution.
        </div>
      </div>
    ` : ""}

    <!-- Customer Header & Phone Contact Card -->
    <div class="customer-detail-card" style="margin-bottom:1.25rem;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem;">
        <div>
          <span style="font-size:0.75rem; text-transform:uppercase; color:var(--text-tertiary); font-weight:700; letter-spacing:0.5px;">Customer Contact Information</span>
          <h3 style="font-size:1.35rem; font-weight:700; color:var(--text-primary); margin-top:0.25rem;">
            ${escapeHtml(call.customer_name || "Valued Motorola Customer")}
          </h3>
          <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.5rem; flex-wrap:wrap;">
            <div style="display:inline-flex; align-items:center; gap:4px;">
              <a href="${telHref}" class="customer-phone-highlight" title="Click to call primary number" style="font-size:0.95rem;">
                <span style="width:18px; height:18px;">${icons.phone}</span>
                <span>${escapeHtml(formattedPhone)}</span>
              </a>
              ${
                call.primary_phone
                  ? `
                <button type="button" class="copy-btn-inline btn-copy-trigger" data-copy-text="${escapeHtml(String(call.primary_phone).replace(/\D/g, ""))}" title="Copy Phone Number" aria-label="Copy Phone Number">
                  <span style="width:13px; height:13px; display:inline-block;">${icons.copy}</span>
                </button>
              `
                  : ""
              }
            </div>
            ${
              altPhone
                ? `
              <div style="display:inline-flex; align-items:center; gap:4px;">
                <a href="${altTelHref}" class="customer-phone-highlight" style="background:#f1f5f9; color:var(--text-secondary); border-color:#cbd5e1; font-size:0.875rem;" title="Click to call alternate number">
                  <span style="width:16px; height:16px;">${icons.phone}</span>
                  <span>Alt: ${escapeHtml(altPhone)}</span>
                </a>
                <button type="button" class="copy-btn-inline btn-copy-trigger" data-copy-text="${escapeHtml(String(altPhone).replace(/\D/g, ""))}" title="Copy Alternate Number" aria-label="Copy Alt Phone">
                  <span style="width:13px; height:13px; display:inline-block;">${icons.copy}</span>
                </button>
              </div>
            `
                : ""
            }
          </div>
        </div>

        <div style="text-align:right;">
          <span class="badge" style="background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; font-size:0.875rem; padding:6px 12px; font-weight:700;">
            ⏳ ${ageingDays} Days Ageing (Carry-In)
          </span>
          <div style="font-size:0.75rem; color:var(--text-tertiary); margin-top:4px;">
            Carry-In: ${formatDateTime(call.carry_in_time)}
          </div>
        </div>
      </div>

      <!-- EXACT 9 INFO FIELDS REQUIRED IN USER SPECIFICATION -->
      <div style="margin-top:1.25rem; border-top:1px solid var(--border-subtle); padding-top:1.25rem;">
        <h4 style="font-size:0.8125rem; font-weight:700; color:var(--text-secondary); text-transform:uppercase; margin-bottom:0.75rem; letter-spacing:0.5px;">
          Service Order Specifications
        </h4>

        <div class="customer-meta-grid">
          <!-- 1. Service Order -->
          <div class="customer-meta-item">
            <span class="meta-label">1. Service Order</span>
            <div style="display:inline-flex; align-items:center; gap:4px;">
              <span class="meta-value" style="font-family:monospace; color:var(--moto-blue-accent); font-weight:700; font-size:0.95rem;">
                ${escapeHtml(call.service_order)}
              </span>
              <button type="button" class="copy-btn-inline btn-copy-trigger" data-copy-text="${escapeHtml(call.service_order)}" title="Copy Service Order" aria-label="Copy Service Order">
                <span style="width:13px; height:13px; display:inline-block;">${icons.copy}</span>
              </button>
            </div>
          </div>

          <!-- 2. Station Name -->
          <div class="customer-meta-item">
            <span class="meta-label">2. Station Name</span>
            <span class="meta-value" title="Station Code: ${escapeHtml(call.station_code || call.cci_code)}">
              ${escapeHtml(call.station_name || `Station ${call.station_code || call.cci_code}`)}
            </span>
          </div>

          <!-- 3. Model -->
          <div class="customer-meta-item">
            <span class="meta-label">3. Model</span>
            <span class="meta-value">${escapeHtml(call.model || "Motorola Device")}</span>
          </div>

          <!-- 4. Service Order Status -->
          <div class="customer-meta-item">
            <span class="meta-label">4. Service Order Status</span>
            <span class="meta-value" style="font-weight:600; color:var(--text-primary);">${escapeHtml(call.so_status || "Open / In Progress")}</span>
          </div>

          <!-- 5. Warranty Status -->
          <div class="customer-meta-item">
            <span class="meta-label">5. Warranty Status</span>
            <div class="meta-value" style="margin-top:2px;">${warrantyBadge}</div>
          </div>

          <!-- 6. Parts Status -->
          <div class="customer-meta-item">
            <span class="meta-label">6. Parts Status</span>
            <div class="meta-value" style="margin-top:2px;">${partsBadge}</div>
          </div>

          <!-- 7. DOA Status -->
          <div class="customer-meta-item">
            <span class="meta-label">7. DOA Status</span>
            <span class="meta-value">${escapeHtml(call.doa_status || "Not DOA")}</span>
          </div>

          <!-- 8. Carry-In Time -->
          <div class="customer-meta-item">
            <span class="meta-label">8. Carry-In Time</span>
            <span class="meta-value">${formatDateTime(call.carry_in_time)}</span>
          </div>

          <!-- 9. Finish Repair Time -->
          <div class="customer-meta-item">
            <span class="meta-label">9. Finish Repair Time</span>
            <span class="meta-value">${call.finish_repair_time ? formatDateTime(call.finish_repair_time) : '<em style="color:var(--text-tertiary);">Pending Completion</em>'}</span>
          </div>
        </div>
      </div>

      ${attemptHistoryHtml}
    </div>

    <!-- ETR UPDATE WINDOW (INTERACTIVE INPUT FORM) -->
    <form id="intimation-etr-form" class="call-feedback-form-card" novalidate style="border-top:4px solid ${isMaxEtas ? '#ef4444' : isReintimation ? '#f59e0b' : 'var(--moto-blue-accent)'};">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.5rem;">
        <div>
          <h3 style="font-size:1.15rem; font-weight:700; color:var(--text-primary); margin:0;">
            ${isMaxEtas
              ? `ETR Commitment Locked (Max 3 Reached)`
              : `Updating ETA #${currentEtaNum} of 3 (Expected Time of Resolution)`
            }
          </h3>
          <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:2px;">
            ${isMaxEtas
              ? `You can still record reachability attempts or internal notes, but ETR extension is capped.`
              : `Communicate realistic resolution date to customer. Cap of 3 ETAs per order.`
            }
          </p>
        </div>
        <span class="badge ${isMaxEtas ? 'badge-danger' : 'badge-info'}" style="font-size:0.75rem;">
          ${isMaxEtas ? 'Policy Capped' : `ETA #${currentEtaNum}`}
        </span>
      </div>

      <!-- 1-Click Quick Intimation Action Chips -->
      <div class="quick-chips-wrapper">
        <div class="quick-chips-header">
          <span style="width:16px; height:16px;">${icons.zap}</span>
          <span>1-Click Quick Dispositions</span>
        </div>
        <div class="quick-chips-grid">
          <button type="button" class="btn-quick-chip chip-success" data-intimation-chip="quick-agreed" ${isMaxEtas ? "disabled" : ""} title="Auto-set Customer Intimated & Agreed">
            <span>🤝</span>
            <span>Customer Agreed to ETR</span>
          </button>
          <button type="button" class="btn-quick-chip chip-warning" data-intimation-chip="quick-ringing" title="Auto-set Ringing / No Reply">
            <span>🔔</span>
            <span>Ringing / No Reply</span>
          </button>
          <button type="button" class="btn-quick-chip chip-warning" data-intimation-chip="quick-switched-off" title="Auto-set Switched Off / Busy">
            <span>📴</span>
            <span>Switched Off / Busy</span>
          </button>
          <button type="button" class="btn-quick-chip" data-intimation-chip="quick-callback" title="Auto-set Call Back Later">
            <span>📞</span>
            <span>Call Back Requested</span>
          </button>
        </div>
      </div>

      <!-- Calling Reachability Status -->
      <div class="form-group" style="margin-bottom:1.25rem;">
        <label class="form-label" style="font-weight:600;">Calling Outcome Status *</label>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:0.75rem;">
          <label style="display:flex; align-items:center; gap:0.5rem; padding:10px 14px; border:1px solid var(--border-medium); border-radius:8px; cursor:pointer; background:var(--bg-surface-subtle);" id="label-status-completed">
            <input type="radio" name="intimation-status" value="Completed" ${isMaxEtas ? "disabled" : "checked"} style="accent-color:var(--moto-blue-accent);">
            <div>
              <strong style="display:block; font-size:0.875rem; color:var(--text-primary);">Customer Intimated &amp; Agreed</strong>
              <span style="font-size:0.75rem; color:var(--text-secondary);">${isMaxEtas ? 'Disabled (Limit reached)' : `Commit ETA #${currentEtaNum}`}</span>
            </div>
          </label>

          <label style="display:flex; align-items:center; gap:0.5rem; padding:10px 14px; border:1px solid var(--border-medium); border-radius:8px; cursor:pointer; background:var(--bg-surface-subtle);" id="label-status-unreachable">
            <input type="radio" name="intimation-status" value="Customer Not Reachable" ${isMaxEtas ? "checked" : ""} style="accent-color:var(--moto-blue-accent);">
            <div>
              <strong style="display:block; font-size:0.875rem; color:var(--text-primary);">Not Reachable / Busy</strong>
              <span style="font-size:0.75rem; color:var(--text-secondary);">Log call attempt in history</span>
            </div>
          </label>

          <label style="display:flex; align-items:center; gap:0.5rem; padding:10px 14px; border:1px solid var(--border-medium); border-radius:8px; cursor:pointer; background:var(--bg-surface-subtle);" id="label-status-callback">
            <input type="radio" name="intimation-status" value="Call Back Required" style="accent-color:var(--moto-blue-accent);">
            <div>
              <strong style="display:block; font-size:0.875rem; color:var(--text-primary);">Call Back Later</strong>
              <span style="font-size:0.75rem; color:var(--text-secondary);">Customer requested callback</span>
            </div>
          </label>
        </div>
      </div>

      <!-- Revision Reason (Shown for ETA 2 or 3) -->
      ${currentEtaNum > 1 && !isMaxEtas ? `
        <div class="form-group" style="margin-bottom:1.25rem;">
          <label for="select-revision-reason" class="form-label" style="font-weight:700; color:#b45309;">
            Reason for Delay / ETA Extension #${currentEtaNum} *
          </label>
          <select id="select-revision-reason" class="form-select" style="max-width:400px; font-size:0.875rem; font-weight:600;">
            <option value="Parts in transit / delayed from hub">Parts in transit / delayed from hub</option>
            <option value="Component-level diagnostics in progress">Component-level diagnostics in progress</option>
            <option value="Awaiting customer estimate confirmation">Awaiting customer estimate confirmation</option>
            <option value="Repaired unit in soak test / QC testing">Repaired unit in soak test / QC testing</option>
            <option value="Motherboard replacement / advanced level repair">Motherboard replacement / advanced level repair</option>
            <option value="Customer requested postponement of pickup">Customer requested postponement of pickup</option>
            <option value="Other technical delay">Other technical delay</option>
          </select>
        </div>
      ` : ""}

      <!-- Input Field 1: ETR Date (Mandatory unless max ETAs reached) -->
      <div class="form-group" style="margin-bottom:1.25rem;">
        <label for="input-etr-date" class="form-label" style="font-weight:700; color:var(--text-primary);">
          Expected Time of Resolution (ETA #${currentEtaNum} Date) *
        </label>
        <div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">
          <input 
            type="date" 
            id="input-etr-date" 
            class="form-input" 
            style="max-width:260px; font-size:0.95rem; font-weight:600; padding:8px 12px;" 
            required 
            min="${todayStr}"
            value="${defaultEtrDate}"
            ${isMaxEtas ? "disabled" : ""}
          >
          ${!isMaxEtas ? `
            <div style="display:flex; gap:0.35rem; flex-wrap:wrap;">
              <button type="button" class="btn-secondary btn-quick-etr" data-days="1" style="padding:5px 10px; font-size:0.75rem;">Tomorrow</button>
              <button type="button" class="btn-secondary btn-quick-etr" data-days="2" style="padding:5px 10px; font-size:0.75rem;">In 2 Days</button>
              <button type="button" class="btn-secondary btn-quick-etr" data-days="4" style="padding:5px 10px; font-size:0.75rem;">In 4 Days</button>
              <button type="button" class="btn-secondary btn-quick-etr" data-days="7" style="padding:5px 10px; font-size:0.75rem;">In 1 Week</button>
            </div>
          ` : ""}
        </div>
        <span style="font-size:0.75rem; color:var(--text-secondary); margin-top:4px; display:block;">
          ${isMaxEtas
            ? "New ETR date disabled because order has already reached 3 customer ETAs."
            : "The estimated date when customer device repair will be completed and ready for pickup."
          }
        </span>
      </div>

      <!-- Input Field 2: Optional CCI Comment -->
      <div class="form-group" style="margin-bottom:1.25rem;">
        <label for="input-cci-comment" class="form-label">
          CCI Internal Comment <span style="font-weight:400; color:var(--text-tertiary);">(Optional)</span>
        </label>
        <textarea 
          id="input-cci-comment" 
          class="form-textarea" 
          rows="2" 
          placeholder="e.g. Parts tracking # dispatched; customer notified of expected delivery date."
          style="font-size:0.875rem;"
        ></textarea>
      </div>

      <!-- Input Field 3: Optional Customer Comment -->
      <div class="form-group" style="margin-bottom:1.5rem;">
        <label for="input-customer-comment" class="form-label">
          Customer Response / Comment <span style="font-weight:400; color:var(--text-tertiary);">(Optional)</span>
        </label>
        <textarea 
          id="input-customer-comment" 
          class="form-textarea" 
          rows="2" 
          placeholder="e.g. Customer agreed to wait until committed date; asked for callback morning of pickup."
          style="font-size:0.875rem;"
        ></textarea>
      </div>

      <!-- Action Buttons -->
      <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-subtle); padding-top:1.25rem; flex-wrap:wrap; gap:0.75rem;">
        <button type="button" id="btn-skip-intimation" class="btn-secondary" style="display:flex; align-items:center; gap:0.35rem;">
          <span>Skip to Next Order</span>
          <span style="display:inline-block; width:16px; height:16px;">&rarr;</span>
        </button>

        ${isMaxEtas ? `
          <button type="submit" id="btn-submit-intimation" class="btn-secondary" style="padding:10px 24px; font-size:0.95rem; display:flex; align-items:center; gap:0.5rem;">
            <span>Log Attempt / Notes (ETA Locked)</span>
          </button>
        ` : `
          <button type="submit" id="btn-submit-intimation" class="btn-primary" style="padding:10px 24px; font-size:0.95rem; display:flex; align-items:center; gap:0.5rem; ${isReintimation ? 'background:#ea580c; border-color:#c2410c;' : ''}">
            <span style="display:block; width:18px; height:18px;">${icons.checkCircle}</span>
            <span>Commit ETA #${currentEtaNum} &amp; Next Call</span>
          </button>
        `}
      </div>
    </form>
  `;

  // 1-Click Inline Copy Listeners
  mount.querySelectorAll(".btn-copy-trigger").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = btn.getAttribute("data-copy-text");
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        btn.classList.add("copied");
        btn.innerHTML = `<span style="width:13px; height:13px; display:inline-block;">${icons.check}</span>`;
        showToast(`Copied ${text}`, "success");
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = `<span style="width:13px; height:13px; display:inline-block;">${icons.copy}</span>`;
        }, 1800);
      } catch {
        showToast("Unable to copy", "warning");
      }
    });
  });

  // 1-Click Quick Intimation Action Chips
  mount.querySelectorAll("[data-intimation-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const action = chip.getAttribute("data-intimation-chip");
      const statusRadios = mount.querySelectorAll('input[name="intimation-status"]');
      const cciComment = mount.querySelector("#input-cci-comment");
      const customerComment = mount.querySelector("#input-customer-comment");
      const submitBtn = mount.querySelector("#btn-submit-intimation");

      // Highlight active intimation disposition chip
      mount.querySelectorAll("[data-intimation-chip]").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");

      if (action === "quick-agreed") {
        statusRadios.forEach((r) => {
          if (r.value === "Completed") r.checked = true;
        });
        if (customerComment) {
          customerComment.value = "Customer verified current repair stage and accepted projected ETR.";
        }
        if (cciComment) {
          cciComment.value = "";
        }
        showToast("Auto-set Customer Agreed to ETR", "success");
      } else if (action === "quick-ringing") {
        statusRadios.forEach((r) => {
          if (r.value === "Customer Not Reachable") r.checked = true;
        });
        if (cciComment) {
          cciComment.value = "Call placed to customer, phone kept ringing without response.";
        }
        if (customerComment) {
          customerComment.value = "";
        }
        showToast("Auto-set Ringing / No Reply", "info");
      } else if (action === "quick-switched-off") {
        statusRadios.forEach((r) => {
          if (r.value === "Customer Not Reachable") r.checked = true;
        });
        if (cciComment) {
          cciComment.value = "Customer primary mobile switched off / out of coverage.";
        }
        if (customerComment) {
          customerComment.value = "";
        }
        showToast("Auto-set Switched Off", "info");
      } else if (action === "quick-callback") {
        statusRadios.forEach((r) => {
          if (r.value === "Call Back Required") r.checked = true;
        });
        if (cciComment) {
          cciComment.value = "Spoke briefly with customer, requested callback later today.";
        }
        if (customerComment) {
          customerComment.value = "";
        }
        showToast("Auto-set Call Back Requested", "info");
      }

      if (submitBtn) {
        submitBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  });

  // Quick ETR Date helper buttons
  mount.querySelectorAll(".btn-quick-etr").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const days = parseInt(e.currentTarget.getAttribute("data-days") || "1", 10);
      const target = new Date();
      target.setDate(target.getDate() + days);
      const dateInput = mount.querySelector("#input-etr-date");
      if (dateInput) {
        dateInput.value = target.toISOString().split("T")[0];
      }
    });
  });

  // Skip button
  mount.querySelector("#btn-skip-intimation")?.addEventListener("click", () => {
    if (call?.service_order) {
      skippedServiceOrders.add(call.service_order);
    }
    if (window.location.hash.includes("?so=")) {
      window.location.hash = "#/intimation/calling";
    } else {
      loadNextIntimationCall();
    }
  });

  // Form submission
  const form = mount.querySelector("#intimation-etr-form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const etrDate = mount.querySelector("#input-etr-date")?.value;
    const callingStatus = mount.querySelector('input[name="intimation-status"]:checked')?.value || "Completed";
    const revisionReason = mount.querySelector("#select-revision-reason")?.value || null;
    const cciComment = mount.querySelector("#input-cci-comment")?.value.trim() || null;
    const customerComment = mount.querySelector("#input-customer-comment")?.value.trim() || null;

    if (callingStatus === "Completed" && !etrDate) {
      showToast("Please select a valid ETR date.", "warning");
      return;
    }

    if (callingStatus === "Completed" && isMaxEtas) {
      showToast("Cannot commit a 4th ETA for this Service Order. Policy limit reached.", "error");
      return;
    }

    isSubmitting = true;
    const submitBtn = mount.querySelector("#btn-submit-intimation");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span>Saving...</span>`;
    }

    try {
      // 1. Try RPC submit_intimation_call with revision reason
      let rpcSuccess = false;
      try {
        const { data: rpcRes, error: rpcErr } = await supabase.rpc("submit_intimation_call", {
          p_service_order: call.service_order,
          p_cci_code: call.cci_code,
          p_etr_date: etrDate || todayStr,
          p_calling_status: callingStatus,
          p_cci_comment: cciComment,
          p_customer_comment: customerComment,
          p_revision_reason: revisionReason,
        });
        if (!rpcErr && rpcRes?.success) {
          rpcSuccess = true;
        } else if (rpcErr) {
          throw rpcErr;
        }
      } catch (e) {
        if (e.message && e.message.includes("Maximum 3 ETAs")) {
          throw e;
        }
        console.warn("RPC submit_intimation_call fallback to direct insert:", e);
      }

      // 2. Direct insert fallback
      if (!rpcSuccess) {
        const profile = getCurrentProfile();
        const { error: insertErr } = await supabase.from("intimation_calling").insert({
          service_order: call.service_order,
          cci_code: call.cci_code,
          etr_date: etrDate || todayStr,
          calling_status: callingStatus,
          cci_comment: cciComment,
          customer_comment: customerComment,
          eta_number: currentEtaNum,
          revision_reason: revisionReason,
          calling_user_id: profile?.auth_user_id || (await supabase.auth.getUser())?.data?.user?.id || null,
        });
        if (insertErr) throw insertErr;

        if (callingStatus === "Completed") {
          await supabase.from("open_calls_master").update({
            current_etr_date: etrDate,
            eta_count: currentEtaNum,
            etr_status: currentEtaNum >= 3 ? "MAX_ETAS_REACHED" : "COMMITTED",
            updated_at: new Date().toISOString(),
          }).eq("service_order", call.service_order);
        }
      }

      showToast(`ETA #${currentEtaNum} committed successfully for SO ${call.service_order}!`, "success");
      isSubmitting = false;

      if (call?.service_order) {
        attemptedServiceOrders.add(call.service_order);
        skippedServiceOrders.delete(call.service_order);
      }

      // Navigate to next call
      if (window.location.hash.includes("?so=")) {
        window.location.hash = "#/intimation/calling";
      } else {
        await loadNextIntimationCall();
      }
    } catch (err) {
      isSubmitting = false;
      console.error("submit_intimation_call error:", err);
      showToast(`Submission failed: ${formatSupabaseError(err)}`, "error");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<span>Try Again</span>`;
      }
    }
  });
}
