// ============================================================================
// Motorola Care - Intimation Calling Workflow Controller
// Manages ETR (Expected Time of Resolution) updates for open calls ageing > 3 days
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin } from "./auth.js";
import { formatMobile, formatDate, formatDateTime, calculateAgeingDays, escapeHtml, icons } from "./utils.js";
import { showToast } from "../components/toast.js";
import { renderSpinner } from "../components/loading.js";

let currentCall = null;
let isSubmitting = false;

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
            Intimate customer with Expected Time of Resolution (ETR) for active open service orders.
          </p>
        </div>
        <div style="display:flex; gap:0.5rem;">
          <a href="#/intimation/pending" class="btn-secondary" style="font-size:0.8125rem;">
            <span>View All Open Calls</span>
          </a>
          <button type="button" id="btn-refresh-intimation" class="btn-secondary" style="display:flex; align-items:center; gap:0.35rem; font-size:0.8125rem;">
            <span style="display:block; width:16px; height:16px;">${icons.refreshCw}</span>
            <span>Next Call</span>
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
 * Fetch next oldest open call requiring intimation (carry_in_time > 3 days ago)
 */
export async function loadNextIntimationCall(specificSoNumber = null) {
  const mount = document.getElementById("intimation-queue-mount");
  if (!mount) return;

  mount.innerHTML = renderSpinner("Fetching next open call with ageing > 3 days...");

  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    let callRecord = null;

    if (specificSoNumber) {
      // Direct load by SO Number (from pending list click)
      let query = supabase.from("open_calls_master").select("*").eq("service_order", specificSoNumber);
      if (!isAdmin()) {
        query = query.eq("cci_code", profile.cci_code);
      }
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      callRecord = data;
    } else {
      // 1. Try secure RPC get_next_intimation_call
      try {
        const { data, error } = await supabase.rpc("get_next_intimation_call");
        if (!error && data?.found && data.call) {
          callRecord = data.call;
        }
      } catch (rpcErr) {
        console.warn("RPC get_next_intimation_call fallback:", rpcErr);
      }

      // 2. Direct Supabase Query Fallback
      if (!callRecord) {
        const threeDaysAgoIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        let q = supabase
          .from("open_calls_master")
          .select("*")
          .eq("is_open", true)
          .lte("carry_in_time", threeDaysAgoIso);

        if (!isAdmin()) {
          q = q.eq("cci_code", profile.cci_code);
        }

        // Exclude orders with already completed intimation
        const { data: openBatch } = await q.order("carry_in_time", { ascending: true }).limit(20);

        if (openBatch && openBatch.length > 0) {
          const soList = openBatch.map((c) => c.service_order);
          const { data: completedIntimations } = await supabase
            .from("intimation_calling")
            .select("service_order")
            .in("service_order", soList)
            .eq("calling_status", "Completed");

          const completedSoSet = new Set((completedIntimations || []).map((i) => i.service_order));
          callRecord = openBatch.find((c) => !completedSoSet.has(c.service_order)) || null;
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
            There are no pending open calls exceeding 3 days of ageing waiting for customer ETR intimation right now.
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

    // Check previous intimation attempts (unreachable, call back)
    try {
      const { data: pastAttempts } = await supabase
        .from("intimation_calling")
        .select("etr_date, calling_status, cci_comment, customer_comment, created_at")
        .eq("service_order", currentCall.service_order)
        .order("created_at", { ascending: false });

      if (pastAttempts && pastAttempts.length > 0) {
        currentCall.pastAttempts = pastAttempts;
      }
    } catch (e) {
      console.warn("Could not load past intimation attempts:", e);
    }

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
 * Render the ETR Update Window with all 9 required info fields and 3 input fields
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

  // Attempt History HTML
  const pastAttempts = call.pastAttempts || [];
  let attemptHistoryHtml = "";
  if (pastAttempts.length > 0) {
    const latest = pastAttempts[0];
    const isUnreachable = latest.calling_status === "Customer Not Reachable";
    const bg = isUnreachable ? "#fffbeb" : "#eff6ff";
    const border = isUnreachable ? "#fde68a" : "#bfdbfe";

    attemptHistoryHtml = `
      <div style="margin-top:1.25rem; padding:0.875rem 1rem; background:${bg}; border:1px solid ${border}; border-radius:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <span style="font-size:1.1rem;">${isUnreachable ? "⚠️" : "📞"}</span>
            <strong style="color:var(--text-primary); font-size:0.875rem;">Previous Intimation History (${pastAttempts.length} attempt${pastAttempts.length > 1 ? "s" : ""})</strong>
          </div>
          <span class="badge ${isUnreachable ? "badge-warning" : "badge-info"}" style="font-size:0.75rem;">
            ${escapeHtml(latest.calling_status)}
          </span>
        </div>
        <div style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0.35rem;">
          Last Attempt: <strong>${formatDateTime(latest.created_at)}</strong>
          ${latest.etr_date ? ` • Committed ETR: <strong>${formatDate(latest.etr_date)}</strong>` : ""}
          ${latest.customer_comment || latest.cci_comment ? ` • Remarks: <em>"${escapeHtml(latest.customer_comment || latest.cci_comment)}"</em>` : ""}
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
    <!-- Customer Header & Phone Contact Card -->
    <div class="customer-detail-card" style="margin-bottom:1.25rem;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.75rem;">
        <div>
          <span style="font-size:0.75rem; text-transform:uppercase; color:var(--text-tertiary); font-weight:700; letter-spacing:0.5px;">Customer Contact Information</span>
          <h3 style="font-size:1.35rem; font-weight:700; color:var(--text-primary); margin-top:0.25rem;">
            ${escapeHtml(call.customer_name || "Valued Motorola Customer")}
          </h3>
          <div style="display:flex; align-items:center; gap:0.75rem; margin-top:0.5rem; flex-wrap:wrap;">
            <a href="${telHref}" class="customer-phone-highlight" title="Click to call primary number" style="font-size:0.95rem;">
              <span style="width:18px; height:18px;">${icons.phone}</span>
              <span>${escapeHtml(formattedPhone)}</span>
            </a>
            ${
              altPhone
                ? `
              <a href="${altTelHref}" class="customer-phone-highlight" style="background:#f1f5f9; color:var(--text-secondary); border-color:#cbd5e1; font-size:0.875rem;" title="Click to call alternate number">
                <span style="width:16px; height:16px;">${icons.phone}</span>
                <span>Alt: ${escapeHtml(altPhone)}</span>
              </a>
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
            <span class="meta-value" style="font-family:monospace; color:var(--moto-blue-accent); font-weight:700; font-size:0.95rem;">
              ${escapeHtml(call.service_order)}
            </span>
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
    <form id="intimation-etr-form" class="call-feedback-form-card" novalidate style="border-top:4px solid var(--moto-blue-accent);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.5rem;">
        <div>
          <h3 style="font-size:1.15rem; font-weight:700; color:var(--text-primary); margin:0;">
            ETR Update &amp; Customer Intimation Commitment
          </h3>
          <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:2px;">
            Provide the Expected Time of Resolution (ETR) communicated to the customer.
          </p>
        </div>
        <span class="badge badge-info" style="font-size:0.75rem;">Mandatory Customer Intimation</span>
      </div>

      <!-- Calling Reachability Status -->
      <div class="form-group" style="margin-bottom:1.25rem;">
        <label class="form-label" style="font-weight:600;">Calling Outcome Status *</label>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:0.75rem;">
          <label style="display:flex; align-items:center; gap:0.5rem; padding:10px 14px; border:1px solid var(--border-medium); border-radius:8px; cursor:pointer; background:var(--bg-surface-subtle);" id="label-status-completed">
            <input type="radio" name="intimation-status" value="Completed" checked style="accent-color:var(--moto-blue-accent);">
            <div>
              <strong style="display:block; font-size:0.875rem; color:var(--text-primary);">Customer Intimated &amp; Agreed</strong>
              <span style="font-size:0.75rem; color:var(--text-secondary);">ETR successfully committed</span>
            </div>
          </label>

          <label style="display:flex; align-items:center; gap:0.5rem; padding:10px 14px; border:1px solid var(--border-medium); border-radius:8px; cursor:pointer; background:var(--bg-surface-subtle);" id="label-status-unreachable">
            <input type="radio" name="intimation-status" value="Customer Not Reachable" style="accent-color:var(--moto-blue-accent);">
            <div>
              <strong style="display:block; font-size:0.875rem; color:var(--text-primary);">Not Reachable / Busy</strong>
              <span style="font-size:0.75rem; color:var(--text-secondary);">Kept pending in backlog</span>
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

      <!-- Input Field 1: ETR Date (Mandatory) -->
      <div class="form-group" style="margin-bottom:1.25rem;">
        <label for="input-etr-date" class="form-label" style="font-weight:700; color:var(--text-primary);">
          Expected Time of Resolution (ETR Date) *
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
          >
          <div style="display:flex; gap:0.35rem; flex-wrap:wrap;">
            <button type="button" class="btn-secondary btn-quick-etr" data-days="1" style="padding:5px 10px; font-size:0.75rem;">Tomorrow</button>
            <button type="button" class="btn-secondary btn-quick-etr" data-days="2" style="padding:5px 10px; font-size:0.75rem;">In 2 Days</button>
            <button type="button" class="btn-secondary btn-quick-etr" data-days="4" style="padding:5px 10px; font-size:0.75rem;">In 4 Days</button>
            <button type="button" class="btn-secondary btn-quick-etr" data-days="7" style="padding:5px 10px; font-size:0.75rem;">In 1 Week</button>
          </div>
        </div>
        <span style="font-size:0.75rem; color:var(--text-secondary); margin-top:4px; display:block;">
          The estimated date when customer device repair will be completed and ready for pickup.
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
          placeholder="e.g. Part ordered under warranty; delayed at ASP central hub; board replacement in progress."
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
          placeholder="e.g. Customer agreed to wait until Friday; requested SMS notification once ready."
          style="font-size:0.875rem;"
        ></textarea>
      </div>

      <!-- Action Buttons -->
      <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-subtle); padding-top:1.25rem; flex-wrap:wrap; gap:0.75rem;">
        <button type="button" id="btn-skip-intimation" class="btn-secondary" style="display:flex; align-items:center; gap:0.35rem;">
          <span>Skip to Next Order</span>
          <span style="display:inline-block; width:16px; height:16px;">&rarr;</span>
        </button>

        <button type="submit" id="btn-submit-intimation" class="btn-primary" style="padding:10px 24px; font-size:0.95rem; display:flex; align-items:center; gap:0.5rem;">
          <span style="display:block; width:18px; height:18px;">${icons.checkCircle}</span>
          <span>Submit ETR &amp; Next Call</span>
        </button>
      </div>
    </form>
  `;

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
    loadNextIntimationCall();
  });

  // Form submission
  const form = mount.querySelector("#intimation-etr-form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const etrDate = mount.querySelector("#input-etr-date")?.value;
    const callingStatus = mount.querySelector('input[name="intimation-status"]:checked')?.value || "Completed";
    const cciComment = mount.querySelector("#input-cci-comment")?.value.trim() || null;
    const customerComment = mount.querySelector("#input-customer-comment")?.value.trim() || null;

    if (!etrDate) {
      showToast("Please select a valid ETR date.", "warning");
      return;
    }

    isSubmitting = true;
    const submitBtn = mount.querySelector("#btn-submit-intimation");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `<span>Saving ETR...</span>`;
    }

    try {
      // 1. Try RPC submit_intimation_call
      let rpcSuccess = false;
      try {
        const { data: rpcRes, error: rpcErr } = await supabase.rpc("submit_intimation_call", {
          p_service_order: call.service_order,
          p_cci_code: call.cci_code,
          p_etr_date: etrDate,
          p_calling_status: callingStatus,
          p_cci_comment: cciComment,
          p_customer_comment: customerComment,
        });
        if (!rpcErr && rpcRes?.success) {
          rpcSuccess = true;
        }
      } catch (e) {
        console.warn("RPC submit_intimation_call fallback to direct insert:", e);
      }

      // 2. Direct insert fallback
      if (!rpcSuccess) {
        const profile = getCurrentProfile();
        const { error: insertErr } = await supabase.from("intimation_calling").insert({
          service_order: call.service_order,
          cci_code: call.cci_code,
          etr_date: etrDate,
          calling_status: callingStatus,
          cci_comment: cciComment,
          customer_comment: customerComment,
          calling_user_id: profile?.id || null,
        });
        if (insertErr) throw insertErr;
      }

      showToast(`ETR committed successfully for SO ${call.service_order}!`, "success");
      await loadNextIntimationCall();
    } catch (err) {
      console.error("submit_intimation_call error:", err);
      showToast(`Submission failed: ${formatSupabaseError(err)}`, "error");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<span>Submit ETR &amp; Next Call</span>`;
      }
    } finally {
      isSubmitting = false;
    }
  });
}
