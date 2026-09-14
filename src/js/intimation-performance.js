// ============================================================================
// Motorola Care - Intimation Calling Performance Controller
// Tracks ETR commitments, SLA coverage, on-time resolution, and ETA extensions
// ============================================================================

import { supabase } from "./supabase.js";
import { getCurrentProfile, isAdmin } from "./auth.js";
import { icons, escapeHtml, formatDate, formatDateTime } from "./utils.js";
import { renderSpinner } from "../components/loading.js";
import { renderKpiCard } from "../components/kpi-card.js";

export async function renderIntimationPerformancePage(container) {
  const admin = isAdmin();
  const profile = getCurrentProfile() || {};

  container.innerHTML = `
    <!-- Header -->
    <div style="margin-bottom:1.5rem; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:1rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Intimation &amp; ETR Performance</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">
          ${admin ? "Network-wide turnaround SLA compliance and customer ETR intimation analytics." : `Turnaround SLA and resolution intimation metrics for ${escapeHtml(profile.cci_name || profile.cci_code || "your station")}.`}
        </p>
      </div>

      <div style="display:flex; gap:0.5rem; align-items:center;">
        <button id="btn-refresh-intimation-perf" class="btn-secondary" style="padding:6px 12px; font-size:0.8125rem;">
          <span style="width:14px; height:14px;">${icons.refreshCw}</span>
          <span>Refresh Metrics</span>
        </button>
      </div>
    </div>

    <!-- Metrics Mount -->
    <div id="intimation-perf-mount">
      ${renderSpinner("Aggregating intimation and ETR compliance records...")}
    </div>
  `;

  document.getElementById("btn-refresh-intimation-perf")?.addEventListener("click", () => {
    loadIntimationPerformanceData(container);
  });

  await loadIntimationPerformanceData(container);
}

/**
 * Calculate and render intimation performance metrics
 */
async function loadIntimationPerformanceData(container) {
  const mount = document.getElementById("intimation-perf-mount");
  if (!mount) return;

  const admin = isAdmin();
  const profile = getCurrentProfile() || {};
  const cciCode = profile.cci_code;

  try {
    const nowMs = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    // 1. Fetch Open Calls inventory (active + recently resolved)
    let openCallsQuery = supabase
      .from("open_calls_master")
      .select("service_order, station_code, cci_code, carry_in_time, finish_repair_time, current_etr_date, eta_count, is_open");

    if (!admin && cciCode) {
      openCallsQuery = openCallsQuery.eq("cci_code", cciCode);
    }

    const { data: openCalls, error: openErr } = await openCallsQuery;
    if (openErr) throw openErr;

    // 2. Fetch all intimation calling logs
    let intimQuery = supabase
      .from("intimation_calling")
      .select("service_order, cci_code, etr_date, calling_status, eta_number, revision_reason, created_at");

    if (!admin && cciCode) {
      intimQuery = intimQuery.eq("cci_code", cciCode);
    }

    const { data: intimations, error: intimErr } = await intimQuery;
    if (intimErr) throw intimErr;

    const allCalls = openCalls || [];
    const allIntimations = intimations || [];

    // Filter calls with Ageing > 3 days
    const callsOver3d = allCalls.filter((c) => {
      const carryMs = new Date(c.carry_in_time).getTime();
      return (nowMs - carryMs) > threeDaysMs;
    });

    // Completed intimations lookup
    const completedIntimationMap = new Map();
    let totalAttempts = allIntimations.length;
    let completedAttempts = 0;
    let unreachableAttempts = 0;
    let callbackAttempts = 0;
    let eta1Count = 0;
    let eta2Count = 0;
    let eta3Count = 0;

    allIntimations.forEach((item) => {
      if (item.calling_status === "Completed") {
        completedAttempts++;
        if (!completedIntimationMap.has(item.service_order)) {
          completedIntimationMap.set(item.service_order, []);
        }
        completedIntimationMap.get(item.service_order).push(item);

        if (item.eta_number === 1) eta1Count++;
        else if (item.eta_number === 2) eta2Count++;
        else if (item.eta_number >= 3) eta3Count++;
      } else if (item.calling_status === "Customer Not Reachable") {
        unreachableAttempts++;
      } else if (item.calling_status === "Call Back Required") {
        callbackAttempts++;
      }
    });

    // Unique calls that received at least 1 completed ETA
    const intimatedUniqueSoCount = completedIntimationMap.size;
    const coverageRate = callsOver3d.length > 0
      ? Math.min(100, Math.round((intimatedUniqueSoCount / callsOver3d.length) * 100))
      : 100;

    // Calculate On-Time Resolution against Committed ETR for finished repairs
    let finishedWithEtr = 0;
    let metEtrOnTime = 0;

    allCalls.forEach((c) => {
      if (c.finish_repair_time && completedIntimationMap.has(c.service_order)) {
        finishedWithEtr++;
        const finishDateStr = new Date(c.finish_repair_time).toISOString().split("T")[0];
        // Check latest committed ETR
        const records = completedIntimationMap.get(c.service_order);
        const latestEtr = records[records.length - 1].etr_date;
        if (finishDateStr <= latestEtr) {
          metEtrOnTime++;
        }
      }
    });

    const onTimeRate = finishedWithEtr > 0
      ? Math.round((metEtrOnTime / finishedWithEtr) * 100)
      : 100;

    const firstCallReachability = totalAttempts > 0
      ? Math.round((completedAttempts / totalAttempts) * 100)
      : 100;

    // Multiple ETAs count (calls with >= 2 ETAs)
    let multiEtaCallsCount = 0;
    completedIntimationMap.forEach((records) => {
      if (records.length > 1) {
        multiEtaCallsCount++;
      }
    });

    const extensionRate = intimatedUniqueSoCount > 0
      ? Math.round((multiEtaCallsCount / intimatedUniqueSoCount) * 100)
      : 0;

    mount.innerHTML = `
      <!-- Top Scorecards Row -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:1.25rem; margin-bottom:2rem;">
        <div class="kpi-card" style="border-left:4px solid var(--moto-blue-accent);">
          <div class="kpi-label">Intimation Coverage</div>
          <div class="kpi-value" style="color:var(--moto-blue-accent); font-size:1.75rem;">${coverageRate}%</div>
          <div class="kpi-subtext">${intimatedUniqueSoCount} of ${callsOver3d.length} (&gt;3d) calls intimated</div>
        </div>

        <div class="kpi-card" style="border-left:4px solid #10b981;">
          <div class="kpi-label">On-Time ETR Resolution</div>
          <div class="kpi-value" style="color:#10b981; font-size:1.75rem;">${onTimeRate}%</div>
          <div class="kpi-subtext">${metEtrOnTime} of ${finishedWithEtr} completed on/before ETR</div>
        </div>

        <div class="kpi-card" style="border-left:4px solid #f59e0b;">
          <div class="kpi-label">ETA Extension Rate</div>
          <div class="kpi-value" style="color:#f59e0b; font-size:1.75rem;">${extensionRate}%</div>
          <div class="kpi-subtext">${multiEtaCallsCount} orders required ETA #2 or #3</div>
        </div>

        <div class="kpi-card" style="border-left:4px solid #6366f1;">
          <div class="kpi-label">Customer Reachability</div>
          <div class="kpi-value" style="color:#6366f1; font-size:1.75rem;">${firstCallReachability}%</div>
          <div class="kpi-subtext">${completedAttempts} reached of ${totalAttempts} attempts</div>
        </div>
      </div>

      <!-- Detail Analysis Grid -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); gap:1.5rem; margin-bottom:2rem;">
        <!-- Card 1: 3-ETA Volume Breakdown -->
        <div class="call-feedback-form-card">
          <h3 style="font-size:1.1rem; font-weight:700; margin-bottom:0.25rem;">ETA Commitments Breakdown</h3>
          <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:1.25rem;">Volume of Initial vs Revised ETAs committed (Cap: 3 ETAs)</p>

          <div style="display:flex; flex-direction:column; gap:1.25rem;">
            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">ETA #1 (Initial Intimation)</span>
                <span style="font-weight:700; color:#10b981;">${eta1Count} Calls</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${completedAttempts > 0 ? (eta1Count / completedAttempts) * 100 : 0}%; height:100%; background:#10b981;"></div>
              </div>
            </div>

            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">ETA #2 (First Extension)</span>
                <span style="font-weight:700; color:#f59e0b;">${eta2Count} Calls</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${completedAttempts > 0 ? (eta2Count / completedAttempts) * 100 : 0}%; height:100%; background:#f59e0b;"></div>
              </div>
            </div>

            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">ETA #3 (Final Policy Extension)</span>
                <span style="font-weight:700; color:#ef4444;">${eta3Count} Calls</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${completedAttempts > 0 ? (eta3Count / completedAttempts) * 100 : 0}%; height:100%; background:#ef4444;"></div>
              </div>
            </div>
          </div>

          <div style="margin-top:1.5rem; padding-top:1rem; border-top:1px solid var(--border-subtle); font-size:0.8rem; color:var(--text-tertiary);">
            Orders requiring ETA #3 should be closely monitored by the technical lead to avoid customer escalation.
          </div>
        </div>

        <!-- Card 2: Outreach & Reachability Breakdown -->
        <div class="call-feedback-form-card">
          <h3 style="font-size:1.1rem; font-weight:700; margin-bottom:0.25rem;">Calling Reachability Summary</h3>
          <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:1.25rem;">Total call outreach outcomes</p>

          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:0.75rem; text-align:center; margin-bottom:1.5rem;">
            <div style="padding:1rem; background:#ecfdf5; border-radius:8px; border:1px solid #a7f3d0;">
              <div style="font-size:0.75rem; color:#065f46; font-weight:700;">Completed</div>
              <div style="font-size:1.5rem; font-weight:800; color:#059669; margin-top:2px;">${completedAttempts}</div>
            </div>

            <div style="padding:1rem; background:#fffbeb; border-radius:8px; border:1px solid #fde68a;">
              <div style="font-size:0.75rem; color:#92400e; font-weight:700;">Unreachable</div>
              <div style="font-size:1.5rem; font-weight:800; color:#d97706; margin-top:2px;">${unreachableAttempts}</div>
            </div>

            <div style="padding:1rem; background:#eff6ff; border-radius:8px; border:1px solid #bfdbfe;">
              <div style="font-size:0.75rem; color:#1e40af; font-weight:700;">Callback Req.</div>
              <div style="font-size:1.5rem; font-weight:800; color:#2563eb; margin-top:2px;">${callbackAttempts}</div>
            </div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center;">
            <a href="#/intimation/history" class="btn-secondary" style="font-size:0.8125rem;">
              <span>View Full Intimation History</span>
              <span style="display:inline-block; width:14px; height:14px;">&rarr;</span>
            </a>
            <a href="#/intimation/calling" class="btn-primary" style="font-size:0.8125rem;">
              <span>Continue Calling</span>
            </a>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    console.error("Intimation performance error:", err);
    mount.innerHTML = `
      <div style="padding:1.5rem; background:#fee2e2; border-radius:var(--radius-lg); color:#b91c1c;">
        <strong>Error loading intimation performance:</strong> ${escapeHtml(err.message)}
      </div>
    `;
  }
}
