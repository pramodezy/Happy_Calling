import { supabase, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin } from "./auth.js";
import { formatMobile, formatDate, formatDateTime, calculateAgeingDays, renderAgeingBadge, escapeHtml, icons } from "./utils.js";
import { showToast } from "../components/toast.js";
import { renderSpinner } from "../components/loading.js";

let currentClosure = null;
let isSubmitting = false;
const skippedClosureIds = new Set();
const attemptedClosureIds = new Set();

export async function renderHappyCallingPage(container) {
  container.innerHTML = `
    <div class="call-workflow-container">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem;">
        <div>
          <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Happy Calling Queue</h2>
          <p style="font-size:0.875rem; color:var(--text-secondary);">Pending customer service closures automatically retrieved in priority sequence.</p>
        </div>
        <button type="button" id="btn-refresh-pending" class="btn-secondary" style="display:flex; align-items:center; gap:0.35rem; font-size:0.8125rem;">
          <span style="display:block; width:16px; height:16px;">${icons.refreshCw}</span>
          <span>Refresh</span>
        </button>
      </div>

      <div id="calling-queue-mount">
        ${renderSpinner("Retrieving next pending customer closure...")}
      </div>
    </div>
  `;

  document.getElementById("btn-refresh-pending")?.addEventListener("click", () => {
    if (window.location.hash.includes("?so=")) {
      window.location.hash = "#/happy-calling";
    } else {
      loadNextClosure();
    }
  });

  let initialSo = null;
  const hash = window.location.hash || "";
  if (hash.includes("?so=")) {
    initialSo = decodeURIComponent(hash.split("?so=")[1].split("&")[0]);
  }

  await loadNextClosure(initialSo);
}

/**
 * Fetch next pending closure while respecting skipped items and CCIs
 */
async function loadNextClosure(specificSoNumber = null) {
  const mount = document.getElementById("calling-queue-mount");
  if (!mount) return;

  mount.innerHTML = renderSpinner("Fetching next pending repair closure...");

  const profile = getCurrentProfile();

  try {
    let targetClosure = null;

    if (specificSoNumber) {
      let q = supabase.from("closure_master").select("*").eq("so_number", specificSoNumber.trim());
      if (!isAdmin() && profile?.cci_code) {
        q = q.eq("cci_code", profile.cci_code);
      }
      const { data } = await q.order("created_at", { ascending: false }).limit(1);
      targetClosure = data && data.length > 0 ? data[0] : null;
    } else {
      // Query candidate pending closures
      let q = supabase
        .from("closure_master")
        .select(`
          id,
          closure_id,
          so_number,
          cci_code,
          cci_name,
          customer_name,
          customer_mobile,
          model,
          closure_date,
          repair_complete_date,
          repair_creation_date,
          source_data,
          warranty_status,
          repair_type
        `)
        .order("closure_date", { ascending: true })
        .order("created_at", { ascending: true });

      if (!isAdmin() && profile?.cci_code) {
        q = q.eq("cci_code", profile.cci_code);
      }

      // Exclude already completed calls directly from queue query
      let compQ = supabase
        .from("happy_calling")
        .select("closure_id")
        .eq("calling_status", "Completed");

      if (!isAdmin() && profile?.cci_code) {
        compQ = compQ.eq("cci_code", profile.cci_code);
      }
      const { data: compRows } = await compQ;
      const completedClosureIds = (compRows || []).map((r) => r.closure_id);

      if (completedClosureIds.length > 0 && completedClosureIds.length <= 400) {
        q = q.not("closure_id", "in", `(${completedClosureIds.join(",")})`);
      }

      q = q.limit(60);

      const { data: batch, error } = await q;
      if (error) throw error;

      if (batch && batch.length > 0) {
        const cIds = batch.map((c) => c.closure_id);
        const { data: attempts } = await supabase
          .from("happy_calling")
          .select("closure_id, calling_status, calling_date, created_at")
          .in("closure_id", cIds);

        const completedSet = new Set((attempts || []).filter((a) => a.calling_status === "Completed").map((c) => c.closure_id));

        // Exclude calls completed in DB and calls already attempted in this session
        let pendingBatch = batch.filter(
          (c) => !completedSet.has(c.closure_id) && !attemptedClosureIds.has(c.closure_id) && !attemptedClosureIds.has(c.id)
        );

        if (pendingBatch.length > 0) {
          // Prioritize fresh/unattempted calls over calls already attempted today
          const todayStr = new Date().toISOString().split("T")[0];
          const attemptedTodaySet = new Set();
          (attempts || []).forEach((a) => {
            const aDate = a.calling_date || (a.created_at ? a.created_at.split("T")[0] : "");
            if (aDate === todayStr) {
              attemptedTodaySet.add(a.closure_id);
            }
          });

          pendingBatch.sort((a, b) => {
            const aToday = attemptedTodaySet.has(a.closure_id) ? 1 : 0;
            const bToday = attemptedTodaySet.has(b.closure_id) ? 1 : 0;
            if (aToday !== bToday) return aToday - bToday;
            return 0;
          });

          // Find first call that user has NOT skipped in this session
          targetClosure = pendingBatch.find((c) => !skippedClosureIds.has(c.closure_id) && !skippedClosureIds.has(c.id));

          // If all available pending calls have been skipped, wrap around ONLY to skipped calls
          if (!targetClosure && skippedClosureIds.size > 0) {
            const skippedCandidates = pendingBatch.filter((c) => skippedClosureIds.has(c.closure_id) || skippedClosureIds.has(c.id));
            if (skippedCandidates.length > 0) {
              skippedClosureIds.clear();
              targetClosure = skippedCandidates[0];
              showToast("Reached end of pending queue. Returning to first skipped call.", "info");
            }
          }
        }
      }

      // Fallback to RPC if direct query yielded nothing and no skip/attempt active
      if (!targetClosure && skippedClosureIds.size === 0 && attemptedClosureIds.size === 0) {
        try {
          const { data: rpcData } = await supabase.rpc("get_next_pending_closure");
          const candidate = rpcData?.closure || (rpcData?.closure_id ? rpcData : null);
          if (candidate && !attemptedClosureIds.has(candidate.closure_id)) {
            targetClosure = candidate;
          }
        } catch (e) {
          console.warn("RPC get_next_pending_closure fallback:", e);
        }
      }
    }

    if (!targetClosure) {
      currentClosure = null;
      mount.innerHTML = `
        <div class="empty-state" style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-lg);">
          <div class="empty-state-icon">${icons.checkCircle}</div>
          <h3>All Caught Up!</h3>
          <p>There are no pending customer closures waiting for Happy Calling right now. Great job!</p>
          <div style="display:flex; justify-content:center; gap:0.75rem;">
            <a href="#/dashboard" class="btn-primary">Go to Dashboard</a>
            <a href="#/completed" class="btn-secondary">View Completed Calls</a>
          </div>
        </div>
      `;
      return;
    }

    currentClosure = targetClosure;

    // Load full closure fields (source_data, warranty_status, repair_type)
    try {
      const { data: fullRecord } = await supabase
        .from("closure_master")
        .select("source_data, warranty_status, repair_type")
        .eq("id", currentClosure.id)
        .maybeSingle();

      if (fullRecord) {
        currentClosure.source_data = fullRecord.source_data || currentClosure.source_data || {};
        if (fullRecord.warranty_status) currentClosure.warranty_status = fullRecord.warranty_status;
        if (fullRecord.repair_type) currentClosure.repair_type = fullRecord.repair_type;
      }
    } catch (e) {
      console.warn("Could not load extended closure fields:", e);
    }

    // Check if previous calling attempts exist for this closure
    try {
      const { data: pastAttempts } = await supabase
        .from("happy_calling")
        .select("calling_status, calling_date, calling_time, customer_remarks, cci_remarks, created_at")
        .eq("closure_id", currentClosure.closure_id)
        .order("created_at", { ascending: false });

      if (pastAttempts && pastAttempts.length > 0) {
        currentClosure.attempts = pastAttempts;
      }
    } catch (e) {
      console.warn("Could not check previous attempts:", e);
    }

    renderCallingForm(mount, currentClosure);
  } catch (err) {
    console.error("loadNextClosure error:", err);
    mount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error retrieving closure:</strong> ${formatSupabaseError(err)}
        <div style="margin-top:1rem;">
          <button type="button" class="btn-secondary" id="btn-retry-closure">Try Again</button>
        </div>
      </div>
    `;
    document.getElementById("btn-retry-closure")?.addEventListener("click", () => loadNextClosure(specificSoNumber));
  }
}

/**
 * Extract Warranty Status and Repair Type from closure properties or source_data
 */
export function extractWarrantyAndRepair(closure) {
  let warranty = closure.warranty_status || "";
  let repair = closure.repair_type || "";

  const src = closure.source_data || {};
  const keys = Object.keys(src);

  const findInSrc = (...synonyms) => {
    for (const syn of synonyms) {
      const target = syn.toLowerCase().replace(/[\s_/-]/g, "");
      const matchedKey = keys.find((k) => k.toLowerCase().replace(/[\s_/-]/g, "") === target);
      if (matchedKey && src[matchedKey] !== undefined && src[matchedKey] !== null) {
        const val = String(src[matchedKey]).trim();
        if (val) return val;
      }
    }
    return "";
  };

  if (!warranty) {
    warranty = findInSrc(
      "warranty status",
      "warrantystatus",
      "warranty_status",
      "warranty",
      "warranty type",
      "warrantytype",
      "warranty condition",
      "warranty condition code",
      "warranty category",
      "iw oow",
      "iw/oow",
      "in warranty",
      "out of warranty",
      "warranty desc",
      "warranty description"
    );
  }

  if (!repair) {
    repair = findInSrc(
      "repair type",
      "repairtype",
      "repair_type",
      "job type",
      "jobtype",
      "type of repair",
      "repair nature",
      "service type",
      "servicetype",
      "action taken",
      "repair category",
      "repair description",
      "fault type",
      "defect type",
      "repair action",
      "repair status"
    );
  }

  return {
    warrantyStatus: warranty || "N/A",
    repairType: repair || "N/A",
  };
}

function renderWarrantyBadge(status) {
  if (!status || status === "N/A") {
    return `<span class="badge badge-neutral" style="font-size:0.75rem;">Warranty: N/A</span>`;
  }
  const sUpper = status.toUpperCase();
  if (sUpper.includes("OUT") || sUpper.includes("OOW")) {
    return `<span class="badge badge-warning" style="font-size:0.75rem; font-weight:600; display:inline-flex; align-items:center; gap:4px;">
      <span>⚠️</span> <span>${escapeHtml(status)}</span>
    </span>`;
  } else if (sUpper.includes("IN") || sUpper.includes("IW") || sUpper.includes("WARRANTY")) {
    return `<span class="badge badge-success" style="font-size:0.75rem; font-weight:600; display:inline-flex; align-items:center; gap:4px;">
      <span>🛡️</span> <span>${escapeHtml(status)}</span>
    </span>`;
  }
  return `<span class="badge badge-info" style="font-size:0.75rem; font-weight:600;">${escapeHtml(status)}</span>`;
}

function renderRepairBadge(repairType) {
  if (!repairType || repairType === "N/A") {
    return `<span class="badge badge-neutral" style="font-size:0.75rem;">Repair: N/A</span>`;
  }
  return `<span class="badge badge-neutral" style="font-size:0.75rem; font-weight:600; background:var(--bg-card); border:1px solid var(--border-medium); color:var(--text-primary); display:inline-flex; align-items:center; gap:4px;">
    <span>🔧</span> <span>${escapeHtml(repairType)}</span>
  </span>`;
}

/**
 * Render customer details and calling feedback form
 */
function renderCallingForm(mount, closure) {
  const ageingDays = calculateAgeingDays(closure.closure_date);
  const formattedPhone = formatMobile(closure.customer_mobile);
  const telHref = closure.customer_mobile ? `tel:${closure.customer_mobile.replace(/\D/g, "")}` : "#";
  const { warrantyStatus, repairType } = extractWarrantyAndRepair(closure);

  const attempts = closure.attempts || [];
  let attemptHistoryHtml = "";
  if (attempts.length > 0) {
    const latest = attempts[0];
    const isUnreachable = latest.calling_status === "Customer Not Reachable";
    const bg = isUnreachable ? "#fffbeb" : "#eff6ff";
    const border = isUnreachable ? "#fde68a" : "#bfdbfe";

    attemptHistoryHtml = `
      <div style="margin-top:1rem; padding:0.875rem 1rem; background:${bg}; border:1px solid ${border}; border-radius:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <span style="font-size:1.1rem;">${isUnreachable ? "⚠️" : "📞"}</span>
            <strong style="color:var(--text-primary); font-size:0.875rem;">Calling Attempt History (${attempts.length} previous attempt${attempts.length > 1 ? "s" : ""})</strong>
          </div>
          <span class="badge ${isUnreachable ? "badge-warning" : "badge-info"}" style="font-size:0.75rem;">
            ${escapeHtml(latest.calling_status)}
          </span>
        </div>
        <div style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0.35rem;">
          Last Attempt: <strong>${formatDateTime(latest.created_at || `${latest.calling_date} ${latest.calling_time}`)}</strong>
          ${latest.customer_remarks || latest.cci_remarks ? ` • Notes: <em>"${escapeHtml(latest.customer_remarks || latest.cci_remarks)}"</em>` : ""}
        </div>
      </div>
    `;
  }

  mount.innerHTML = `
    <!-- Customer & Job Details Card -->
    <div class="customer-detail-card">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:0.5rem;">
        <div>
          <span style="font-size:0.75rem; text-transform:uppercase; color:var(--text-tertiary); font-weight:700;">Customer Information</span>
          <h3 style="font-size:1.25rem; font-weight:700; color:var(--text-primary); margin-top:0.25rem;">
            ${escapeHtml(closure.customer_name || "Valued Motorola Customer")}
          </h3>
        </div>
        <div>
          ${renderAgeingBadge(ageingDays)}
        </div>
      </div>

      <div class="customer-meta-grid" style="margin-top:1.25rem;">
        <div class="customer-meta-item">
          <span class="meta-label">Customer Mobile</span>
          <div style="display:inline-flex; align-items:center; gap:4px;">
            <a href="${telHref}" class="customer-phone-highlight" title="Click to call">
              <span style="width:18px; height:18px;">${icons.phone}</span>
              <span>${escapeHtml(formattedPhone)}</span>
            </a>
            ${
              closure.customer_mobile
                ? `
              <button type="button" class="copy-btn-inline btn-copy-trigger" data-copy-text="${escapeHtml(closure.customer_mobile.replace(/\D/g, ""))}" title="Copy Mobile Number" aria-label="Copy Mobile Number">
                <span style="width:13px; height:13px; display:inline-block;">${icons.copy}</span>
              </button>
            `
                : ""
            }
          </div>
        </div>

        <div class="customer-meta-item">
          <span class="meta-label">Motorola Model</span>
          <span class="meta-value">${escapeHtml(closure.model || "Motorola Device")}</span>
        </div>

        <div class="customer-meta-item">
          <span class="meta-label">SO Number</span>
          <div style="display:inline-flex; align-items:center; gap:4px;">
            <span class="meta-value" style="font-family:monospace; color:var(--moto-blue-accent); font-weight:700;">${escapeHtml(closure.so_number)}</span>
            <button type="button" class="copy-btn-inline btn-copy-trigger" data-copy-text="${escapeHtml(closure.so_number)}" title="Copy SO Number" aria-label="Copy SO Number">
              <span style="width:13px; height:13px; display:inline-block;">${icons.copy}</span>
            </button>
          </div>
        </div>

        <div class="customer-meta-item">
          <span class="meta-label">Warranty Status</span>
          <div class="meta-value" style="margin-top:2px;">${renderWarrantyBadge(warrantyStatus)}</div>
        </div>

        <div class="customer-meta-item">
          <span class="meta-label">Repair Type</span>
          <div class="meta-value" style="margin-top:2px;">${renderRepairBadge(repairType)}</div>
        </div>

        <div class="customer-meta-item">
          <span class="meta-label">Closure Date</span>
          <span class="meta-value">${formatDate(closure.closure_date)}</span>
        </div>

        <div class="customer-meta-item">
          <span class="meta-label">CCI Location</span>
          <span class="meta-value">${escapeHtml(closure.cci_name || closure.cci_code)}</span>
        </div>
      </div>

      ${attemptHistoryHtml}
    </div>

    <!-- Calling Feedback Form -->
    <form id="happy-calling-form" class="call-feedback-form-card" novalidate>
      <input type="hidden" id="form-closure-id" value="${escapeHtml(closure.closure_id)}">
      <input type="hidden" id="form-so-number" value="${escapeHtml(closure.so_number)}">
      <input type="hidden" id="form-cci-code" value="${escapeHtml(closure.cci_code)}">

      <!-- 1-Click Quick Dispositions Bar -->
      <div class="quick-chips-wrapper">
        <div class="quick-chips-header">
          <span style="width:16px; height:16px;">${icons.zap}</span>
          <span>1-Click Quick Dispositions</span>
        </div>
        <div class="quick-chips-grid">
          <button type="button" class="btn-quick-chip chip-success" data-action-chip="quick-happy" title="Auto-fill 10/10 Happy response">
            <span>😊</span>
            <span>Customer Satisfied (10/10)</span>
          </button>
          <button type="button" class="btn-quick-chip chip-warning" data-action-chip="quick-ringing" title="Auto-fill Ringing / No Reply">
            <span>🔔</span>
            <span>Ringing / No Reply</span>
          </button>
          <button type="button" class="btn-quick-chip chip-warning" data-action-chip="quick-switched-off" title="Auto-fill Switched Off / Busy">
            <span>📴</span>
            <span>Switched Off / Busy</span>
          </button>
          <button type="button" class="btn-quick-chip" data-action-chip="quick-callback" title="Auto-fill Call Back Required">
            <span>📞</span>
            <span>Call Back Requested</span>
          </button>
          <button type="button" class="btn-quick-chip chip-danger" data-action-chip="quick-complaint" title="Auto-fill DSAT complaint">
            <span>⚠️</span>
            <span>DSAT / Complaint</span>
          </button>
        </div>
      </div>

      <!-- 1. Calling Status -->
      <div class="form-group">
        <label for="calling-status-select" class="form-label">Calling Status *</label>
        <select id="calling-status-select" class="form-select" required>
          <option value="Completed" selected>Completed (Spoke with Customer)</option>
          <option value="Customer Not Reachable">Customer Not Reachable (Switched Off / Busy / No Reply)</option>
          <option value="Call Back Required">Call Back Required (Customer requested later time)</option>
        </select>
      </div>

      <!-- Section conditional on Completed -->
      <div id="completed-feedback-section">
        <!-- 2. Customer Feedback Category -->
        <div class="form-group">
          <label class="form-label">Customer Feedback Category *</label>
          <div class="feedback-options-row">
            <div class="feedback-option-card happy selected" data-feedback="Happy">
              <span style="font-size:1.5rem;">😊</span>
              <span style="font-weight:600; font-size:0.875rem;">Happy</span>
              <span style="font-size:0.75rem; color:var(--text-tertiary);">Satisfied with repair</span>
            </div>

            <div class="feedback-option-card neutral" data-feedback="Neutral">
              <span style="font-size:1.5rem;">😐</span>
              <span style="font-weight:600; font-size:0.875rem;">Neutral</span>
              <span style="font-size:0.75rem; color:var(--text-tertiary);">Average experience</span>
            </div>

            <div class="feedback-option-card unhappy" data-feedback="Unhappy">
              <span style="font-size:1.5rem;">🙁</span>
              <span style="font-weight:600; font-size:0.875rem;">Unhappy</span>
              <span style="font-size:0.75rem; color:var(--text-tertiary);">DSAT / Issue reported</span>
            </div>
          </div>
          <input type="hidden" id="form-feedback-category" value="Happy">
        </div>

        <!-- 3. Customer Rating (1 to 10) -->
        <div class="form-group">
          <label class="form-label" style="display:flex; justify-content:space-between;">
            <span>Customer Rating (1 to 10) *</span>
            <span id="rating-display-value" style="font-weight:700; color:var(--moto-blue-accent);">Score: 10 / 10</span>
          </label>
          <div class="rating-pills-row" id="rating-pills-container">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
              .map(
                (num) => `
                <button type="button" class="rating-pill-btn ${num === 10 ? "selected" : ""}" data-rating="${num}">
                  ${num}
                </button>
              `
              )
              .join("")}
          </div>
          <input type="hidden" id="form-customer-rating" value="10">
        </div>

        <!-- 4. Customer Remarks -->
        <div class="form-group">
          <label for="form-customer-remarks" class="form-label">Customer Remarks</label>
          <textarea id="form-customer-remarks" class="form-textarea" rows="2" placeholder="Specific comments made by customer regarding handset, service turnaround, staff behavior..."></textarea>
        </div>
      </div>

      <!-- 5. CCI Remarks -->
      <div class="form-group">
        <label for="form-cci-remarks" class="form-label">CCI Internal Remarks</label>
        <textarea id="form-cci-remarks" class="form-textarea" rows="2" placeholder="Agent notes, follow-up actions taken, technician escalation..."></textarea>
      </div>

      <!-- Submit & Next Action Bar -->
      <div class="calling-action-bar">
        <button type="button" id="btn-skip-call" class="btn-secondary" style="font-size:0.875rem;">
          Skip to Next
        </button>
        <button type="submit" id="btn-submit-call" class="btn-primary" style="font-size:0.95rem; font-weight:700;">
          <span style="width:18px; height:18px;">${icons.checkCircle}</span>
          <span>SUBMIT & NEXT</span>
        </button>
      </div>
    </form>
  `;

  attachFormEvents();
}

/**
 * Attach interactive form listeners
 */
function attachFormEvents() {
  const form = document.getElementById("happy-calling-form");
  if (!form) return;

  const statusSelect = document.getElementById("calling-status-select");
  const completedSection = document.getElementById("completed-feedback-section");
  const feedbackInput = document.getElementById("form-feedback-category");
  const ratingInput = document.getElementById("form-customer-rating");
  const ratingDisplay = document.getElementById("rating-display-value");

  // Status Change: show/hide feedback & rating fields
  statusSelect.addEventListener("change", (e) => {
    const isCompleted = e.target.value === "Completed";
    if (completedSection) {
      completedSection.style.display = isCompleted ? "block" : "none";
    }
  });

  // 1-Click Inline Copy Listeners
  document.querySelectorAll(".btn-copy-trigger").forEach((btn) => {
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

  // 1-Click Quick Dispositions Handling
  document.querySelectorAll("[data-action-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const action = chip.getAttribute("data-action-chip");
      const customerRemarks = document.getElementById("form-customer-remarks");
      const cciRemarks = document.getElementById("form-cci-remarks");
      const submitBtn = document.getElementById("btn-submit-call");

      if (action === "quick-happy") {
        statusSelect.value = "Completed";
        if (completedSection) completedSection.style.display = "block";
        feedbackInput.value = "Happy";
        document.querySelectorAll(".feedback-option-card").forEach((c) => {
          c.classList.toggle("selected", c.getAttribute("data-feedback") === "Happy");
        });
        setRatingValue(10);
        if (customerRemarks && !customerRemarks.value) {
          customerRemarks.value = "Customer verified handset repair and expressed full satisfaction.";
        }
        showToast("Auto-set 10/10 Happy response", "success");
      } else if (action === "quick-ringing") {
        statusSelect.value = "Customer Not Reachable";
        if (completedSection) completedSection.style.display = "none";
        if (cciRemarks && !cciRemarks.value) {
          cciRemarks.value = "Customer call placed, phone kept ringing without response.";
        }
        showToast("Auto-set Ringing / No Reply", "info");
      } else if (action === "quick-switched-off") {
        statusSelect.value = "Customer Not Reachable";
        if (completedSection) completedSection.style.display = "none";
        if (cciRemarks && !cciRemarks.value) {
          cciRemarks.value = "Customer number switched off / not reachable on network.";
        }
        showToast("Auto-set Switched Off", "info");
      } else if (action === "quick-callback") {
        statusSelect.value = "Call Back Required";
        if (completedSection) completedSection.style.display = "none";
        if (cciRemarks && !cciRemarks.value) {
          cciRemarks.value = "Customer answered and requested a callback at a later time.";
        }
        showToast("Auto-set Call Back Requested", "info");
      } else if (action === "quick-complaint") {
        statusSelect.value = "Completed";
        if (completedSection) completedSection.style.display = "block";
        feedbackInput.value = "Unhappy";
        document.querySelectorAll(".feedback-option-card").forEach((c) => {
          c.classList.toggle("selected", c.getAttribute("data-feedback") === "Unhappy");
        });
        setRatingValue(3);
        if (customerRemarks) {
          customerRemarks.focus();
        }
        showToast("Auto-set DSAT - please enter customer issue", "warning");
      }

      if (submitBtn) {
        submitBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  });

  // Feedback Category Pill Click
  document.querySelectorAll(".feedback-option-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".feedback-option-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      const category = card.getAttribute("data-feedback");
      feedbackInput.value = category;

      // Auto-suggest rating based on category if currently incompatible
      if (category === "Unhappy" && Number(ratingInput.value) > 6) {
        setRatingValue(4);
      } else if (category === "Happy" && Number(ratingInput.value) < 7) {
        setRatingValue(9);
      } else if (category === "Neutral" && (Number(ratingInput.value) > 7 || Number(ratingInput.value) < 5)) {
        setRatingValue(6);
      }
    });
  });

  // Rating Pills Click
  document.querySelectorAll(".rating-pill-btn").forEach((pill) => {
    pill.addEventListener("click", () => {
      const val = parseInt(pill.getAttribute("data-rating"), 10);
      setRatingValue(val);
    });
  });

  function setRatingValue(val) {
    ratingInput.value = val;
    if (ratingDisplay) {
      ratingDisplay.textContent = `Score: ${val} / 10`;
    }
    document.querySelectorAll(".rating-pill-btn").forEach((p) => {
      if (parseInt(p.getAttribute("data-rating"), 10) === val) {
        p.classList.add("selected");
      } else {
        p.classList.remove("selected");
      }
    });
  }

  // Skip button
  document.getElementById("btn-skip-call")?.addEventListener("click", () => {
    if (currentClosure) {
      skippedClosureIds.add(currentClosure.closure_id);
      if (currentClosure.id) skippedClosureIds.add(currentClosure.id);
    }
    if (window.location.hash.includes("?so=")) {
      window.location.hash = "#/happy-calling";
    } else {
      loadNextClosure();
    }
  });

  // Form Submit
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const callingStatus = statusSelect.value;
    const closureId = document.getElementById("form-closure-id").value;
    const soNumber = document.getElementById("form-so-number").value;
    const cciCode = document.getElementById("form-cci-code").value;
    const customerRemarks = document.getElementById("form-customer-remarks")?.value.trim() || null;
    const cciRemarks = document.getElementById("form-cci-remarks")?.value.trim() || null;

    let customerRating = null;
    let feedbackCategory = null;

    if (callingStatus === "Completed") {
      customerRating = parseInt(ratingInput.value, 10);
      feedbackCategory = feedbackInput.value;

      if (isNaN(customerRating) || customerRating < 1 || customerRating > 10) {
        showToast("Please provide a customer rating between 1 and 10.", "warning");
        return;
      }
      if (!["Happy", "Neutral", "Unhappy"].includes(feedbackCategory)) {
        showToast("Please choose a valid feedback category.", "warning");
        return;
      }
    }

    const submitBtn = document.getElementById("btn-submit-call");
    isSubmitting = true;
    submitBtn.disabled = true;
    submitBtn.innerHTML = `Submitting...`;

    try {
      // Call atomic RPC function submit_happy_calling()
      // Enforces DB duplicate protection, RLS, audit log, and state consistency
      const { data, error } = await supabase.rpc("submit_happy_calling", {
        p_closure_id: closureId,
        p_so_number: soNumber,
        p_cci_code: cciCode,
        p_calling_status: callingStatus,
        p_customer_rating: customerRating,
        p_feedback_category: feedbackCategory,
        p_customer_remarks: customerRemarks,
        p_cci_remarks: cciRemarks,
      });

      if (error) throw error;

      if (currentClosure) {
        attemptedClosureIds.add(currentClosure.closure_id);
        if (currentClosure.id) attemptedClosureIds.add(currentClosure.id);
        skippedClosureIds.delete(currentClosure.closure_id);
        if (currentClosure.id) skippedClosureIds.delete(currentClosure.id);
      }

      showToast(`Happy Calling submitted successfully for SO ${soNumber}!`, "success");

      // Seamlessly advance to the next pending closure
      if (window.location.hash.includes("?so=")) {
        window.location.hash = "#/happy-calling";
      } else {
        await loadNextClosure();
      }
    } catch (err) {
      console.error("Submission error:", err);
      showToast(formatSupabaseError(err), "error");
    } finally {
      isSubmitting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <span style="width:18px; height:18px;">${icons.checkCircle}</span>
          <span>SUBMIT & NEXT</span>
        `;
      }
    }
  });
}
