// ============================================================================
// Motorola Care - Intimation Calling CCI & Regional Performance Controller
// Features separate, dedicated tracking for:
// 1. Active Open Calls Progress (Action Queue: Ageing > 3d, Intimated, Pending)
// 2. Closed Calls Intimation Audit (Historical: Turnaround, On-Time ETR, Compliance)
// Supports multi-region selection, filtering, and CSV export for both modes.
// ============================================================================

import { supabase, fetchAllRows, subscribeToTable, unsubscribeChannel, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin, isBSM, hasAdminOrBsmAccess, getUserAssignedRegions } from "./auth.js";
import { icons, escapeHtml, formatDate, formatDateTime, downloadCsvWithBom } from "./utils.js";
import { renderSpinner } from "../components/loading.js";
import { renderKpiCard } from "../components/kpi-card.js";
import { initMultiSelectDropdown } from "../components/multi-select-dropdown.js";

// Page state
let currentViewMode = "OPEN"; // "OPEN" (Action Progress) | "CLOSED" (Resolution Audit)
let allStationOpenData = [];
let allStationClosedData = [];
let networkOpenStats = {};
let networkClosedStats = {};
let uniqueRegions = [];

let searchQuery = "";
let selectedRegionalSummaryRegions = new Set();
let selectedRankingsRegions = new Set();
let regionalSummaryDropdown = null;
let rankingsDropdown = null;
let filterTier = "ALL";
let sortBy = "coverage_rate"; // Default for Open: coverage_rate. For Closed: on_time_rate
let sortOrder = "desc";

export async function renderIntimationPerformancePage(container) {
  searchQuery = "";
  currentViewMode = "OPEN";
  selectedRegionalSummaryRegions = new Set();
  selectedRankingsRegions = new Set();
  filterTier = "ALL";
  sortBy = "coverage_rate";
  sortOrder = "desc";

  const admin = isAdmin();
  const isBsmUser = isBSM();
  const profile = getCurrentProfile() || {};
  const assignedRegions = getUserAssignedRegions();

  const title = isBsmUser 
    ? "Regional Intimation & Partner Leaderboard" 
    : admin 
    ? "CCI & Regional Intimation Performance" 
    : "Intimation & ETR Performance Metrics";

  const perfSubtitle = isBsmUser
    ? `Regional turnaround SLA and customer ETR intimation analytics for your assigned regions (${assignedRegions.join(", ") || "All Assigned"}).`
    : admin
    ? "Network-wide turnaround SLA compliance, regional benchmarks, and customer ETR intimation rankings."
    : `Turnaround SLA and resolution intimation metrics for ${escapeHtml(profile.cci_name || profile.cci_code || "your station")}.`;

  container.innerHTML = `
    <!-- Header with Back / Command Center & Export -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
          <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary); margin:0;">${title}</h2>
          <span class="badge ${isBsmUser ? "badge-warning" : "badge-info"}" style="font-size:0.6875rem; padding:2px 8px;">
            ${isBsmUser ? "BSM REGIONAL SCOPED" : "TARGET: 95% SLA"}
          </span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin:0;">
          ${perfSubtitle}
        </p>
      </div>

      <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
        ${hasAdminOrBsmAccess() ? `
          <button type="button" id="btn-export-intimation-perf-csv" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
            <span style="width:16px; height:16px;">${icons.download}</span>
            <span id="btn-export-label">Export Open Calls CSV</span>
          </button>
          <a href="#/intimation/admin" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
            <span style="width:16px; height:16px;">${icons.dashboard}</span>
            <span>Command Center</span>
          </a>
        ` : ""}
        <button id="btn-refresh-intimation-perf" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:14px; height:14px;">${icons.refreshCw}</span>
          <span>Refresh Metrics</span>
        </button>
      </div>
    </div>

    <!-- Metrics Mount -->
    <div id="intimation-perf-mount">
      ${renderSpinner("Aggregating intimation and ETR compliance records across network...")}
    </div>
  `;

  document.getElementById("btn-refresh-intimation-perf")?.addEventListener("click", () => {
    loadIntimationPerformanceData(container);
  });

  document.getElementById("btn-export-intimation-perf-csv")?.addEventListener("click", () => {
    exportIntimationPerfCsv();
  });

  await loadIntimationPerformanceData(container);

  // Subscribe to real-time changes
  subscribeToTable("intimation_perf_realtime_calls", "open_calls_master", "*", () => {
    loadIntimationPerformanceData(container);
  });
  subscribeToTable("intimation_perf_realtime_intimation", "intimation_calling", "*", () => {
    loadIntimationPerformanceData(container);
  });
}

/**
 * Calculate and render intimation performance metrics, regional summary, and rankings
 */
async function loadIntimationPerformanceData(container) {
  const mount = document.getElementById("intimation-perf-mount");
  if (!mount) return;

  const isBsmUser = isBSM();
  const isPrivileged = hasAdminOrBsmAccess();
  const profile = getCurrentProfile() || {};
  const cciCode = profile.cci_code;
  const assignedRegions = getUserAssignedRegions();

  try {
    const nowMs = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    // 1. Fetch Open Calls inventory (active + resolved) - paginated to overcome 1000 row limit
    const openCalls = await fetchAllRows((from, to) => {
      let q = supabase
        .from("open_calls_master")
        .select("service_order, station_code, cci_code, station_name, carry_in_time, finish_repair_time, current_etr_date, eta_count, is_open")
        .range(from, to);
      if (!isPrivileged && cciCode) {
        q = q.eq("cci_code", cciCode);
      }
      return q;
    });

    // 2. Fetch all intimation calling logs - paginated to ensure full coverage
    const intimations = await fetchAllRows((from, to) => {
      let q = supabase
        .from("intimation_calling")
        .select("service_order, cci_code, etr_date, calling_status, eta_number, revision_reason, created_at")
        .range(from, to);
      if (!isPrivileged && cciCode) {
        q = q.eq("cci_code", cciCode);
      }
      return q;
    });

    // 3. Fetch master CCI directory for complete station details, regions, and locations
    let cciMasterList = [];
    try {
      const { data: cData } = await supabase
        .from("cci_master")
        .select("cci_code, cci_name, region, location, status")
        .order("cci_code");
      cciMasterList = cData || [];
    } catch (cErr) {
      console.warn("Notice: unable to load cci_master:", cErr);
    }

    const cciMetaMap = new Map();
    cciMasterList.forEach((c) => {
      if (c && c.cci_code) {
        cciMetaMap.set(c.cci_code, c);
      }
    });

    const allCalls = openCalls || [];
    const allIntimations = intimations || [];

    // Distinct partition between Open Calls and Closed Calls
    const openCallsList = allCalls.filter((c) => c.is_open === true || (!c.finish_repair_time && c.is_open !== false));
    const closedCallsList = allCalls.filter((c) => c.is_open === false || !!c.finish_repair_time);

    // Completed intimations lookup: service_order -> array of intimation records
    const completedIntimationMap = new Map();
    let totalAttempts = allIntimations.length;
    let completedAttempts = 0;
    let unreachableAttempts = 0;
    let callbackAttempts = 0;

    allIntimations.forEach((item) => {
      if (item.calling_status === "Completed") {
        completedAttempts++;
        if (!completedIntimationMap.has(item.service_order)) {
          completedIntimationMap.set(item.service_order, []);
        }
        completedIntimationMap.get(item.service_order).push(item);
      } else if (item.calling_status === "Customer Not Reachable") {
        unreachableAttempts++;
      } else if (item.calling_status === "Call Back Required") {
        callbackAttempts++;
      }
    });

    // Intimations lookup by CCI code
    const intimationsByCci = new Map();
    allIntimations.forEach((item) => {
      const code = item.cci_code || "Unknown";
      if (!intimationsByCci.has(code)) {
        intimationsByCci.set(code, {
          total: 0,
          completed: 0,
          unreachable: 0,
          callback: 0,
        });
      }
      const st = intimationsByCci.get(code);
      st.total++;
      if (item.calling_status === "Completed") st.completed++;
      else if (item.calling_status === "Customer Not Reachable") st.unreachable++;
      else if (item.calling_status === "Call Back Required") st.callback++;
    });

    // ========================================================================
    // A. Network-Wide Metrics for Active OPEN Calls (Actionable Operational Tracking)
    // ========================================================================
    const openCallsOver3d = openCallsList.filter((c) => {
      const carryMs = new Date(c.carry_in_time).getTime();
      return (nowMs - carryMs) > threeDaysMs;
    });

    const openCallsOver3dIntimated = openCallsOver3d.filter((c) => completedIntimationMap.has(c.service_order));
    const openCallsOver3dPending = openCallsOver3d.filter((c) => !completedIntimationMap.has(c.service_order));

    const openCoverageRate = openCallsOver3d.length > 0
      ? Math.min(100, Math.round((openCallsOver3dIntimated.length / openCallsOver3d.length) * 100))
      : 100;

    let openEta1Count = 0;
    let openEta2Count = 0;
    let openEta3Count = 0;
    let openMultiEtaCount = 0;

    openCallsList.forEach((c) => {
      if (completedIntimationMap.has(c.service_order)) {
        const records = completedIntimationMap.get(c.service_order);
        if (records.length > 1) openMultiEtaCount++;
        const latest = records[records.length - 1];
        if (latest.eta_number === 1) openEta1Count++;
        else if (latest.eta_number === 2) openEta2Count++;
        else if (latest.eta_number >= 3) openEta3Count++;
      }
    });

    const overallReachability = totalAttempts > 0
      ? Math.round((completedAttempts / totalAttempts) * 100)
      : 100;

    networkOpenStats = {
      totalOpen: openCallsList.length,
      openOver3d: openCallsOver3d.length,
      openIntimated: openCallsOver3dIntimated.length,
      openPending: openCallsOver3dPending.length,
      openCoverageRate,
      openEta1Count,
      openEta2Count,
      openEta3Count,
      openMultiEtaCount,
      totalAttempts,
      completedAttempts,
      unreachableAttempts,
      callbackAttempts,
      reachabilityRate: overallReachability,
    };

    // ========================================================================
    // B. Network-Wide Metrics for CLOSED Calls (Resolution & Compliance Audit)
    // ========================================================================
    const closedCallsOver3d = closedCallsList.filter((c) => {
      const carryMs = new Date(c.carry_in_time).getTime();
      const finishMs = c.finish_repair_time ? new Date(c.finish_repair_time).getTime() : nowMs;
      return (finishMs - carryMs) > threeDaysMs;
    });

    const closedCallsIntimated = closedCallsList.filter((c) => completedIntimationMap.has(c.service_order));
    const closedOver3dIntimated = closedCallsOver3d.filter((c) => completedIntimationMap.has(c.service_order));

    const closedComplianceRate = closedCallsOver3d.length > 0
      ? Math.min(100, Math.round((closedOver3dIntimated.length / closedCallsOver3d.length) * 100))
      : 100;

    let closedWithEtr = 0;
    let closedMetEtrOnTime = 0;
    let closedMultiEtaCount = 0;

    closedCallsList.forEach((c) => {
      if (completedIntimationMap.has(c.service_order)) {
        const records = completedIntimationMap.get(c.service_order);
        if (records.length > 1) closedMultiEtaCount++;
        if (c.finish_repair_time) {
          closedWithEtr++;
          const finishDateStr = new Date(c.finish_repair_time).toISOString().split("T")[0];
          const latestEtr = records[records.length - 1].etr_date;
          if (finishDateStr <= latestEtr) {
            closedMetEtrOnTime++;
          }
        }
      }
    });

    const closedOnTimeRate = closedWithEtr > 0
      ? Math.round((closedMetEtrOnTime / closedWithEtr) * 100)
      : 100;

    networkClosedStats = {
      totalClosed: closedCallsList.length,
      closedOver3d: closedCallsOver3d.length,
      closedIntimated: closedOver3dIntimated.length,
      closedIntimatedTotal: closedCallsIntimated.length,
      complianceRate: closedComplianceRate,
      finishedWithEtr: closedWithEtr,
      metEtrOnTime: closedMetEtrOnTime,
      onTimeRate: closedOnTimeRate,
      multiEtaCallsCount: closedMultiEtaCount,
    };

    // ========================================================================
    // C. Station-by-Station Aggregation for Both Open and Closed Modes
    // ========================================================================
    const stationMap = new Map();

    function getOrCreateStation(code, callObj) {
      if (!stationMap.has(code)) {
        const meta = cciMetaMap.get(code) || {};
        stationMap.set(code, {
          cci_code: code,
          station_code: (callObj && callObj.station_code) || code,
          cci_name: meta.cci_name || (callObj && callObj.station_name) || `Station ${code}`,
          region: (meta.region || "Unassigned").trim() || "Unassigned",
          location: meta.location || "—",
          // Open Calls tracking (Strictly open calls)
          open_total: 0,
          open_over_3d: 0,
          open_intimated: 0,
          open_pending: 0,
          open_multi_eta: 0,
          open_coverage_rate: 100,
          // Closed Calls tracking (Strictly resolved calls)
          closed_total: 0,
          closed_over_3d: 0,
          closed_intimated: 0,
          closed_with_etr: 0,
          closed_met_on_time: 0,
          closed_multi_eta: 0,
          closed_compliance_rate: 100,
          closed_on_time_rate: 100,
          // Calling attempts & reachability
          totalAttempts: 0,
          completedAttempts: 0,
          reachability_rate: 100,
        });
      }
      return stationMap.get(code);
    }

    allCalls.forEach((call) => {
      const code = call.cci_code || call.station_code || "Unknown";
      const st = getOrCreateStation(code, call);

      const isOpen = call.is_open === true || (!call.finish_repair_time && call.is_open !== false);
      const carryMs = new Date(call.carry_in_time).getTime();
      const isIntimated = completedIntimationMap.has(call.service_order);
      const records = isIntimated ? completedIntimationMap.get(call.service_order) : [];

      if (isOpen) {
        st.open_total++;
        const isOpenOver3d = (nowMs - carryMs) > threeDaysMs;
        if (isOpenOver3d) {
          st.open_over_3d++;
          if (isIntimated) {
            st.open_intimated++;
          } else {
            st.open_pending++;
          }
        }
        if (isIntimated && records.length > 1) {
          st.open_multi_eta++;
        }
      } else {
        // Closed call
        st.closed_total++;
        const finishMs = call.finish_repair_time ? new Date(call.finish_repair_time).getTime() : nowMs;
        const isClosedOver3d = (finishMs - carryMs) > threeDaysMs;
        if (isClosedOver3d) {
          st.closed_over_3d++;
          if (isIntimated) {
            st.closed_intimated++;
          }
        } else if (isIntimated) {
          st.closed_intimated++;
        }
        if (isIntimated && records.length > 1) {
          st.closed_multi_eta++;
        }
        if (isIntimated && call.finish_repair_time) {
          st.closed_with_etr++;
          const finishDateStr = new Date(call.finish_repair_time).toISOString().split("T")[0];
          const latestEtr = records[records.length - 1].etr_date;
          if (finishDateStr <= latestEtr) {
            st.closed_met_on_time++;
          }
        }
      }
    });

    // Also include active CCIs from cci_master if they have 0 calls
    if (isPrivileged) {
      cciMasterList.forEach((c) => {
        if (!stationMap.has(c.cci_code) && c.status === "ACTIVE") {
          getOrCreateStation(c.cci_code, null);
        }
      });
    }

    // Attach calling stats and compute rates
    stationMap.forEach((st) => {
      const callStats = intimationsByCci.get(st.cci_code) || { total: 0, completed: 0, unreachable: 0, callback: 0 };
      st.totalAttempts = callStats.total;
      st.completedAttempts = callStats.completed;
      st.reachability_rate = callStats.total > 0 ? Math.round((callStats.completed / callStats.total) * 100) : 100;

      // Open coverage rate
      st.open_coverage_rate = st.open_over_3d > 0
        ? Math.min(100, Math.round((st.open_intimated / st.open_over_3d) * 1000) / 10)
        : 100;

      // Closed compliance and on-time rates
      st.closed_compliance_rate = st.closed_over_3d > 0
        ? Math.min(100, Math.round((st.closed_intimated / st.closed_over_3d) * 100))
        : 100;

      st.closed_on_time_rate = st.closed_with_etr > 0
        ? Math.round((st.closed_met_on_time / st.closed_with_etr) * 100)
        : 100;

      st.closed_extension_rate = st.closed_intimated > 0
        ? Math.round((st.closed_multi_eta / st.closed_intimated) * 100)
        : 0;

      st.open_extension_rate = st.open_intimated > 0
        ? Math.round((st.open_multi_eta / st.open_intimated) * 100)
        : 0;
    });

    const rawStations = Array.from(stationMap.values());

    // Filter demo codes if real codes exist
    const DEMO_CODES = new Set(["BLR01", "DEL01", "MUM01", "KOC01", "KOL01"]);
    const hasRealCodes = rawStations.some((s) => !DEMO_CODES.has(s.cci_code));
    let cleanedStations = hasRealCodes ? rawStations.filter((s) => !DEMO_CODES.has(s.cci_code)) : rawStations;

    // BSM Regional scoping filter
    if (isBsmUser && assignedRegions.length > 0) {
      const assignedSet = new Set(assignedRegions.map((r) => r.trim().toLowerCase()));
      cleanedStations = cleanedStations.filter((s) => assignedSet.has((s.region || "").trim().toLowerCase()));
    }

    // Build Open dataset
    allStationOpenData = cleanedStations.map((s) => ({
      ...s,
      total_open: s.open_total,
      over_3d: s.open_over_3d,
      intimated: s.open_intimated,
      pending: s.open_pending,
      coverage_rate: s.open_coverage_rate,
      extension_rate: s.open_extension_rate,
    }));

    // Build Closed dataset
    allStationClosedData = cleanedStations.map((s) => ({
      ...s,
      total_closed: s.closed_total,
      closed_over_3d: s.closed_over_3d,
      closed_intimated: s.closed_intimated,
      compliance_rate: s.closed_compliance_rate,
      finishedWithEtr: s.closed_with_etr,
      metEtrOnTime: s.closed_met_on_time,
      on_time_rate: s.closed_on_time_rate,
      extension_rate: s.closed_extension_rate,
    }));

    // Compute unique regions list
    if (isBsmUser && assignedRegions.length > 0) {
      uniqueRegions = [...assignedRegions].sort();
    } else {
      uniqueRegions = Array.from(
        new Set(
          cleanedStations
            .map((c) => (c.region || "").trim())
            .filter((r) => r.length > 0 && r !== "Unassigned")
        )
      ).sort();
    }

    const regPlaceholder = isBsmUser ? `All My Regions (${assignedRegions.join(", ") || "Assigned"})` : "All Regions";

    // ========================================================================
    // Render Dashboard Shell & Controls
    // ========================================================================
    mount.innerHTML = `
      <!-- View Mode Switcher: Open Calls Progress vs Closed Calls Audit -->
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1.5rem; background:var(--bg-surface); padding:0.75rem 1rem; border-radius:var(--radius-lg); border:1px solid var(--border-subtle); box-shadow:var(--shadow-xs);">
        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
          <button type="button" id="btn-toggle-mode-open" class="btn-toggle-mode ${currentViewMode === 'OPEN' ? 'active' : ''}">
            <span>⚡ Active Open Calls Progress</span>
            <span class="badge ${currentViewMode === 'OPEN' ? 'badge-primary' : 'badge-neutral'}" style="margin-left:6px; font-size:0.75rem;">${networkOpenStats.totalOpen.toLocaleString()} Open</span>
          </button>
          <button type="button" id="btn-toggle-mode-closed" class="btn-toggle-mode ${currentViewMode === 'CLOSED' ? 'active' : ''}">
            <span>📋 Closed Calls Intimations Audit</span>
            <span class="badge ${currentViewMode === 'CLOSED' ? 'badge-primary' : 'badge-neutral'}" style="margin-left:6px; font-size:0.75rem;">${networkClosedStats.totalClosed.toLocaleString()} Closed</span>
          </button>
        </div>
        <div id="mode-context-hint" style="font-size:0.8125rem; color:var(--text-secondary); display:flex; align-items:center; gap:0.4rem;">
          <span style="width:8px; height:8px; border-radius:50%; background:${currentViewMode === 'OPEN' ? '#10b981' : '#0072ce'}; display:inline-block;"></span>
          <span>${currentViewMode === 'OPEN' ? 'Action Queue: Open repairs exceeding 3 days SLA' : 'Resolution Audit: Completed repairs & committed ETR compliance'}</span>
        </div>
      </div>

      <!-- Top KPI Row -->
      <div id="perf-kpis-mount" class="kpi-grid" style="margin-bottom:1.5rem;"></div>

      <!-- Detail Analysis Grid -->
      <div id="perf-details-mount" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); gap:1.5rem; margin-bottom:1.75rem;"></div>

      <!-- Regional Performance Summary Section -->
      <div class="table-card" style="margin-bottom:1.75rem; overflow:visible;">
        <div class="table-card-header" style="flex-wrap:wrap; gap:0.5rem; position:relative; z-index:30;">
          <div>
            <h3 id="regional-card-title" class="table-card-title">${isBsmUser ? "Assigned Regional Performance Summary" : "Regional Performance Summary"}</h3>
            <span id="regional-card-subtitle" style="font-size:0.75rem; color:var(--text-tertiary);"></span>
          </div>
          <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; margin-left:auto;">
            <div id="perf-regional-summary-multiselect-mount"></div>
            <button type="button" id="btn-perf-regional-summary-reset" class="btn-secondary" style="padding:5px 10px; font-size:0.8125rem;" title="Reset regional filter">
              <span>Reset</span>
            </button>
            <span class="badge ${isBsmUser ? "badge-warning" : "badge-info"}" style="font-size:0.6875rem; padding:2px 8px;">
              ${isBsmUser ? "TERRITORY SCOPED" : "NATIONAL BREAKDOWN"}
            </span>
          </div>
        </div>

        <div class="table-responsive-wrapper">
          <table class="data-table">
            <thead id="perf-regional-thead"></thead>
            <tbody id="perf-regional-table-body">
              <tr><td colspan="10">${renderSpinner("Loading regional performance...")}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Partner Performance Rankings Section with Region Tagging -->
      <div class="table-card" style="overflow:visible;">
        <div class="table-card-header" style="flex-wrap:wrap; gap:0.75rem; position:relative; z-index:20;">
          <div>
            <h3 id="rankings-card-title" class="table-card-title">Partner Performance Rankings</h3>
            <span id="rankings-card-subtitle" style="font-size:0.75rem; color:var(--text-tertiary);"></span>
          </div>

          <!-- Filter and Search Toolbar -->
          <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
            <input type="text" id="perf-search-input" placeholder="Search CCI code, name, city..." class="form-input" style="padding:5px 10px; font-size:0.8125rem; width:220px;">
            
            <div id="perf-rankings-multiselect-mount"></div>

            <select id="perf-tier-filter" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
              <option value="ALL">All Tiers</option>
              <option value="HIGH">High Performers (≥90%)</option>
              <option value="MID">Average Tier (70-89%)</option>
              <option value="LOW">Underperforming (&lt;70%)</option>
            </select>

            <select id="perf-sort-by" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;"></select>

            <button type="button" id="btn-perf-rankings-reset-all" class="btn-secondary" style="padding:5px 12px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;" title="Reset all filters to default">
              <span style="width:14px; height:14px;">${icons.refreshCw || ''}</span>
              <span>Reset All</span>
            </button>
          </div>
        </div>

        <div class="table-responsive-wrapper">
          <table class="data-table">
            <thead id="perf-rankings-thead"></thead>
            <tbody id="perf-table-body">
              <tr><td colspan="13">${renderSpinner("Loading partner rankings...")}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    // 1. Initialize Regional Performance Summary Multi-Select Checkbox Dropdown
    const regSummaryMount = document.getElementById("perf-regional-summary-multiselect-mount");
    if (regSummaryMount) {
      if (regionalSummaryDropdown) regionalSummaryDropdown.destroy();
      regionalSummaryDropdown = initMultiSelectDropdown({
        container: regSummaryMount,
        labelPrefix: "Region",
        defaultPlaceholder: regPlaceholder,
        options: uniqueRegions,
        selected: selectedRegionalSummaryRegions,
        onChange: (selected) => {
          selectedRegionalSummaryRegions = new Set(selected);
          renderRegionalPerformanceTable();
        },
      });
    }

    // 2. Initialize Partner Performance Rankings Multi-Select Checkbox Dropdown
    const rankingsMount = document.getElementById("perf-rankings-multiselect-mount");
    if (rankingsMount) {
      if (rankingsDropdown) rankingsDropdown.destroy();
      rankingsDropdown = initMultiSelectDropdown({
        container: rankingsMount,
        labelPrefix: "Region",
        defaultPlaceholder: regPlaceholder,
        options: uniqueRegions,
        selected: selectedRankingsRegions,
        onChange: (selected) => {
          selectedRankingsRegions = new Set(selected);
          renderFilteredTable();
        },
      });
    }

    // Attach search and filter event listeners
    document.getElementById("perf-search-input")?.addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderFilteredTable();
    });

    document.getElementById("perf-tier-filter")?.addEventListener("change", (e) => {
      filterTier = e.target.value;
      renderFilteredTable();
    });

    document.getElementById("perf-sort-by")?.addEventListener("change", (e) => {
      sortBy = e.target.value;
      renderFilteredTable();
    });

    document.getElementById("btn-perf-regional-summary-reset")?.addEventListener("click", () => {
      selectedRegionalSummaryRegions.clear();
      regionalSummaryDropdown?.reset();
      renderRegionalPerformanceTable();
    });

    document.getElementById("btn-perf-rankings-reset-all")?.addEventListener("click", () => {
      searchQuery = "";
      const searchInput = document.getElementById("perf-search-input");
      if (searchInput) searchInput.value = "";

      selectedRankingsRegions.clear();
      rankingsDropdown?.reset();

      filterTier = "ALL";
      const tierSelect = document.getElementById("perf-tier-filter");
      if (tierSelect) tierSelect.value = "ALL";

      sortBy = currentViewMode === "OPEN" ? "coverage_rate" : "on_time_rate";
      const sortSelect = document.getElementById("perf-sort-by");
      if (sortSelect) sortSelect.value = sortBy;

      renderFilteredTable();
    });

    // Mode Toggle Handlers
    document.getElementById("btn-toggle-mode-open")?.addEventListener("click", () => {
      if (currentViewMode === "OPEN") return;
      currentViewMode = "OPEN";
      sortBy = "coverage_rate";
      filterTier = "ALL";
      updateModeUi();
    });

    document.getElementById("btn-toggle-mode-closed")?.addEventListener("click", () => {
      if (currentViewMode === "CLOSED") return;
      currentViewMode = "CLOSED";
      sortBy = "on_time_rate";
      filterTier = "ALL";
      updateModeUi();
    });

    // Initial render of active mode
    updateModeUi();
  } catch (err) {
    console.error("Intimation performance error:", err);
    mount.innerHTML = `
      <div style="padding:1.5rem; background:#fee2e2; border-radius:var(--radius-lg); color:#b91c1c;">
        <strong>Error loading intimation performance:</strong> ${escapeHtml(err.message)}
      </div>
    `;
  }
}

/**
 * Updates UI to reflect current active mode (OPEN vs CLOSED)
 */
function updateModeUi() {
  const isBsmUser = isBSM();

  // 1. Update Mode Switcher Buttons
  const btnOpen = document.getElementById("btn-toggle-mode-open");
  const btnClosed = document.getElementById("btn-toggle-mode-closed");
  const contextHint = document.getElementById("mode-context-hint");
  const exportLabel = document.getElementById("btn-export-label");

  if (btnOpen) btnOpen.className = `btn-toggle-mode ${currentViewMode === 'OPEN' ? 'active' : ''}`;
  if (btnClosed) btnClosed.className = `btn-toggle-mode ${currentViewMode === 'CLOSED' ? 'active' : ''}`;
  if (exportLabel) exportLabel.textContent = currentViewMode === "OPEN" ? "Export Open Calls CSV" : "Export Closed Calls CSV";

  if (contextHint) {
    contextHint.innerHTML = `
      <span style="width:8px; height:8px; border-radius:50%; background:${currentViewMode === 'OPEN' ? '#10b981' : '#0072ce'}; display:inline-block;"></span>
      <span>${currentViewMode === 'OPEN' ? 'Action Queue: Open repairs exceeding 3 days SLA' : 'Resolution Audit: Completed repairs & committed ETR compliance'}</span>
    `;
  }

  // 2. Render KPIs & Detail Cards
  renderKpisAndDetails();

  // 3. Update Table Headers & Subtitles
  const regTitle = document.getElementById("regional-card-title");
  const regSubtitle = document.getElementById("regional-card-subtitle");
  const regThead = document.getElementById("perf-regional-thead");

  const rankTitle = document.getElementById("rankings-card-title");
  const rankSubtitle = document.getElementById("rankings-card-subtitle");
  const rankThead = document.getElementById("perf-rankings-thead");

  if (currentViewMode === "OPEN") {
    if (regTitle) regTitle.textContent = isBsmUser ? "Assigned Regional Performance Summary (Open Calls)" : "Regional Performance Summary (Open Calls)";
    if (regSubtitle) regSubtitle.textContent = "Live territory breakdown of currently open repairs, critical ageing backlog (>3 days), and committed ETR coverage.";
    if (regThead) {
      regThead.innerHTML = `
        <tr>
          <th>Region</th>
          <th>Active CCIs</th>
          <th>Total Open</th>
          <th>Ageing &gt; 3 Days</th>
          <th>Intimated Calls</th>
          <th>Pending Intimations</th>
          <th>Coverage %</th>
          <th>Multi-ETA %</th>
          <th>Reachability %</th>
        </tr>
      `;
    }

    if (rankTitle) rankTitle.textContent = "Partner Performance Rankings (Open Calls Action Queue)";
    if (rankSubtitle) rankSubtitle.textContent = "Real-time service center rankings based on open repair intimation coverage and pending backlog.";
    if (rankThead) {
      rankThead.innerHTML = `
        <tr>
          <th style="width:70px;">Rank</th>
          <th>CCI Code &amp; Center Name</th>
          <th>Region</th>
          <th>Location</th>
          <th>Total Open</th>
          <th>Ageing &gt; 3 Days</th>
          <th>Intimated Calls</th>
          <th>Pending Intimations</th>
          <th style="min-width:140px;">Coverage %</th>
          <th>Multi-ETA %</th>
          <th>Reachability %</th>
          <th>Performance Tier</th>
          <th>Action</th>
        </tr>
      `;
    }
  } else {
    // CLOSED View
    if (regTitle) regTitle.textContent = isBsmUser ? "Assigned Regional Performance Summary (Closed Calls Audit)" : "Regional Performance Summary (Closed Calls Audit)";
    if (regSubtitle) regSubtitle.textContent = "Historical resolution audit verifying whether completed repairs received advance intimation and met committed ETRs.";
    if (regThead) {
      regThead.innerHTML = `
        <tr>
          <th>Region</th>
          <th>Active CCIs</th>
          <th>Total Closed</th>
          <th>Closed Ageing &gt; 3d</th>
          <th>Intimated Before Closure</th>
          <th>Compliance %</th>
          <th>Finished with ETR</th>
          <th>Met ETR On-Time %</th>
          <th>Multi-ETA %</th>
        </tr>
      `;
    }

    if (rankTitle) rankTitle.textContent = "Partner Performance Rankings (Closed Calls Resolution Audit)";
    if (rankSubtitle) rankSubtitle.textContent = "Historical resolution audit based on customer advance notice delivery and turnaround against committed ETRs.";
    if (rankThead) {
      rankThead.innerHTML = `
        <tr>
          <th style="width:70px;">Rank</th>
          <th>CCI Code &amp; Center Name</th>
          <th>Region</th>
          <th>Location</th>
          <th>Total Closed</th>
          <th>Closed Ageing &gt; 3d</th>
          <th>Intimated Before Closure</th>
          <th>Compliance %</th>
          <th>Finished with ETR</th>
          <th style="min-width:140px;">Met ETR On-Time %</th>
          <th>Multi-ETA %</th>
          <th>Resolution Grade</th>
          <th>Action</th>
        </tr>
      `;
    }
  }

  // 4. Update Sort Dropdown Options
  updateSortOptions();

  // 5. Render Tables
  renderRegionalPerformanceTable();
  renderFilteredTable();
}

/**
 * Update Sort Dropdown Options according to active mode
 */
function updateSortOptions() {
  const sortSelect = document.getElementById("perf-sort-by");
  if (!sortSelect) return;

  if (currentViewMode === "OPEN") {
    sortSelect.innerHTML = `
      <option value="coverage_rate">Sort: Open Coverage %</option>
      <option value="pending">Sort: Pending Intimations</option>
      <option value="over_3d">Sort: Ageing > 3 Days</option>
      <option value="total_open">Sort: Total Open</option>
      <option value="reachability_rate">Sort: Reachability %</option>
    `;
    sortSelect.value = sortBy || "coverage_rate";
  } else {
    sortSelect.innerHTML = `
      <option value="on_time_rate">Sort: On-Time ETR %</option>
      <option value="compliance_rate">Sort: Compliance %</option>
      <option value="total_closed">Sort: Total Closed</option>
      <option value="closed_over_3d">Sort: Closed Ageing > 3d</option>
      <option value="extension_rate">Sort: Multi-ETA Rate %</option>
    `;
    sortSelect.value = sortBy || "on_time_rate";
  }
}

/**
 * Render KPI Cards and Detailed Breakdown Cards
 */
function renderKpisAndDetails() {
  const kpiMount = document.getElementById("perf-kpis-mount");
  const detailsMount = document.getElementById("perf-details-mount");

  if (currentViewMode === "OPEN") {
    const s = networkOpenStats;
    const highPerformers = allStationOpenData.filter((c) => Number(c.coverage_rate) >= 90).length;
    const lowPerformers = allStationOpenData.filter((c) => Number(c.coverage_rate) < 70).length;

    if (kpiMount) {
      kpiMount.innerHTML = `
        ${renderKpiCard({
          title: "Active Open Inventory",
          value: (s.totalOpen || 0).toLocaleString(),
          icon: icons.database,
          colorScheme: "blue",
          subtitle: "Currently open repairs in network",
        })}
        ${renderKpiCard({
          title: "Ageing > 3 Days (Critical)",
          value: (s.openOver3d || 0).toLocaleString(),
          icon: icons.alertTriangle,
          colorScheme: (s.openOver3d || 0) > 0 ? "red" : "green",
          subtitle: "Mandatory customer intimation queue",
        })}
        ${renderKpiCard({
          title: "Open Calls Intimated",
          value: (s.openIntimated || 0).toLocaleString(),
          icon: icons.checkCircle,
          colorScheme: "green",
          subtitle: "Open orders with committed ETR",
        })}
        ${renderKpiCard({
          title: "Pending Intimations",
          value: (s.openPending || 0).toLocaleString(),
          icon: icons.clock,
          colorScheme: (s.openPending || 0) > 0 ? "amber" : "green",
          subtitle: "Open calls awaiting agent outreach",
        })}
        ${renderKpiCard({
          title: "Open Intimation Coverage",
          value: `${s.openCoverageRate || 0}%`,
          icon: icons.award,
          colorScheme: (s.openCoverageRate || 0) >= 90 ? "green" : (s.openCoverageRate || 0) >= 70 ? "blue" : "red",
          subtitle: `${s.openIntimated || 0} of ${s.openOver3d || 0} (>3d) Intimated`,
        })}
        ${renderKpiCard({
          title: "Customer Reachability",
          value: `${s.reachabilityRate || 0}%`,
          icon: icons.phone,
          colorScheme: "blue",
          subtitle: `${s.completedAttempts || 0} Reached of ${s.totalAttempts || 0} Calls`,
        })}
      `;
    }

    if (detailsMount) {
      detailsMount.innerHTML = `
        <!-- Card 1: 3-ETA Volume Breakdown on Open Orders -->
        <div class="call-feedback-form-card">
          <h3 style="font-size:1.1rem; font-weight:700; margin-bottom:0.25rem;">Open Orders ETA Commitments</h3>
          <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:1.25rem;">Volume of Initial vs Extended ETAs on active open repairs</p>

          <div style="display:flex; flex-direction:column; gap:1.25rem;">
            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">ETA #1 (Initial Intimation)</span>
                <span style="font-weight:700; color:#10b981;">${s.openEta1Count} Orders</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${s.openIntimated > 0 ? (s.openEta1Count / s.openIntimated) * 100 : 0}%; height:100%; background:#10b981;"></div>
              </div>
            </div>

            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">ETA #2 (First Extension)</span>
                <span style="font-weight:700; color:#f59e0b;">${s.openEta2Count} Orders</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${s.openIntimated > 0 ? (s.openEta2Count / s.openIntimated) * 100 : 0}%; height:100%; background:#f59e0b;"></div>
              </div>
            </div>

            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">ETA #3 (Final Policy Extension)</span>
                <span style="font-weight:700; color:#ef4444;">${s.openEta3Count} Orders</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${s.openIntimated > 0 ? (s.openEta3Count / s.openIntimated) * 100 : 0}%; height:100%; background:#ef4444;"></div>
              </div>
            </div>
          </div>

          <div style="margin-top:1.5rem; padding-top:1rem; border-top:1px solid var(--border-subtle); font-size:0.8rem; color:var(--text-tertiary);">
            Orders on ETA #3 must receive expedited parts or priority bench time to prevent SLA breach.
          </div>
        </div>

        <!-- Card 2: Outreach & Reachability Breakdown -->
        <div class="call-feedback-form-card">
          <h3 style="font-size:1.1rem; font-weight:700; margin-bottom:0.25rem;">Calling Reachability Summary</h3>
          <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:1.25rem;">Overall contact outcomes across network calling queue</p>

          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:0.75rem; text-align:center; margin-bottom:1.5rem;">
            <div style="padding:1rem; background:#ecfdf5; border-radius:8px; border:1px solid #a7f3d0;">
              <div style="font-size:0.75rem; color:#065f46; font-weight:700;">Completed</div>
              <div style="font-size:1.5rem; font-weight:800; color:#059669; margin-top:2px;">${s.completedAttempts}</div>
            </div>

            <div style="padding:1rem; background:#fffbeb; border-radius:8px; border:1px solid #fde68a;">
              <div style="font-size:0.75rem; color:#92400e; font-weight:700;">Unreachable</div>
              <div style="font-size:1.5rem; font-weight:800; color:#d97706; margin-top:2px;">${s.unreachableAttempts}</div>
            </div>

            <div style="padding:1rem; background:#eff6ff; border-radius:8px; border:1px solid #bfdbfe;">
              <div style="font-size:0.75rem; color:#1e40af; font-weight:700;">Callback Req.</div>
              <div style="font-size:1.5rem; font-weight:800; color:#2563eb; margin-top:2px;">${s.callbackAttempts}</div>
            </div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
            <a href="#/intimation/history" class="btn-secondary" style="font-size:0.8125rem;">
              <span>View Full Intimation History</span>
              <span style="display:inline-block; width:14px; height:14px;">&rarr;</span>
            </a>
            <a href="#/intimation/calling" class="btn-primary" style="font-size:0.8125rem;">
              <span>Continue Open Calling Queue</span>
            </a>
          </div>
        </div>
      `;
    }
  } else {
    // CLOSED View KPIs & Details
    const s = networkClosedStats;

    if (kpiMount) {
      kpiMount.innerHTML = `
        ${renderKpiCard({
          title: "Total Closed Repairs",
          value: (s.totalClosed || 0).toLocaleString(),
          icon: icons.clipboardCheck || icons.checkCircle,
          colorScheme: "blue",
          subtitle: "Completed / repaired service orders",
        })}
        ${renderKpiCard({
          title: "Closed Ageing > 3 Days",
          value: (s.closedOver3d || 0).toLocaleString(),
          icon: icons.clock,
          colorScheme: "amber",
          subtitle: "Repairs that had ageing > 3 days",
        })}
        ${renderKpiCard({
          title: "Intimated Before Closure",
          value: (s.closedIntimated || 0).toLocaleString(),
          icon: icons.checkCircle,
          colorScheme: "green",
          subtitle: "Customer received advance notice",
        })}
        ${renderKpiCard({
          title: "Intimation Compliance %",
          value: `${s.complianceRate || 0}%`,
          icon: icons.award,
          colorScheme: (s.complianceRate || 0) >= 90 ? "green" : "amber",
          subtitle: `${s.closedIntimated || 0} of ${s.closedOver3d || 0} (>3d) Intimated`,
        })}
        ${renderKpiCard({
          title: "On-Time ETR Resolution",
          value: `${s.onTimeRate || 0}%`,
          icon: icons.checkCircle,
          colorScheme: (s.onTimeRate || 0) >= 90 ? "green" : (s.onTimeRate || 0) >= 70 ? "blue" : "red",
          subtitle: `${s.metEtrOnTime || 0} of ${s.finishedWithEtr || 0} Met Committed ETR`,
        })}
        ${renderKpiCard({
          title: "Multi-ETA Extensions",
          value: (s.multiEtaCallsCount || 0).toLocaleString(),
          icon: icons.alertTriangle,
          colorScheme: "purple",
          subtitle: "Closed orders with >= 2 ETAs",
        })}
      `;
    }

    if (detailsMount) {
      const metOnTime = s.metEtrOnTime || 0;
      const delayed = Math.max(0, (s.finishedWithEtr || 0) - metOnTime);
      const noAdvanceEtr = Math.max(0, (s.closedOver3d || 0) - (s.closedIntimated || 0));

      detailsMount.innerHTML = `
        <!-- Card 1: On-Time Resolution Analysis -->
        <div class="call-feedback-form-card">
          <h3 style="font-size:1.1rem; font-weight:700; margin-bottom:0.25rem;">ETR Resolution Compliance Breakdown</h3>
          <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:1.25rem;">Actual repair finish time vs latest committed customer ETR</p>

          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:0.75rem; text-align:center; margin-bottom:1.5rem;">
            <div style="padding:1rem; background:#ecfdf5; border-radius:8px; border:1px solid #a7f3d0;">
              <div style="font-size:0.75rem; color:#065f46; font-weight:700;">Met On-Time</div>
              <div style="font-size:1.5rem; font-weight:800; color:#059669; margin-top:2px;">${metOnTime}</div>
            </div>

            <div style="padding:1rem; background:#fee2e2; border-radius:8px; border:1px solid #fecaca;">
              <div style="font-size:0.75rem; color:#991b1b; font-weight:700;">Delayed vs ETR</div>
              <div style="font-size:1.5rem; font-weight:800; color:#dc2626; margin-top:2px;">${delayed}</div>
            </div>

            <div style="padding:1rem; background:#fffbeb; border-radius:8px; border:1px solid #fde68a;">
              <div style="font-size:0.75rem; color:#92400e; font-weight:700;">No Advance ETR</div>
              <div style="font-size:1.5rem; font-weight:800; color:#d97706; margin-top:2px;">${noAdvanceEtr}</div>
            </div>
          </div>

          <div style="padding-top:1rem; border-top:1px solid var(--border-subtle); font-size:0.8rem; color:var(--text-tertiary);">
            Target benchmark is 95% on-time resolution against committed customer ETRs.
          </div>
        </div>

        <!-- Card 2: Historical Intimation Coverage Audit -->
        <div class="call-feedback-form-card">
          <h3 style="font-size:1.1rem; font-weight:700; margin-bottom:0.25rem;">Closed Calls Intimation Audit</h3>
          <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:1.25rem;">Audit of whether completed repairs received advance customer notice</p>

          <div style="display:flex; flex-direction:column; gap:1.25rem;">
            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">Intimated with Single ETA</span>
                <span style="font-weight:700; color:#10b981;">${Math.max(0, (s.closedIntimated || 0) - (s.multiEtaCallsCount || 0))} Orders</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${(s.closedIntimated || 0) > 0 ? (Math.max(0, (s.closedIntimated || 0) - (s.multiEtaCallsCount || 0)) / s.closedIntimated) * 100 : 0}%; height:100%; background:#10b981;"></div>
              </div>
            </div>

            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">Required ETA Extensions (2+ ETAs)</span>
                <span style="font-weight:700; color:#f59e0b;">${s.multiEtaCallsCount || 0} Orders</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${(s.closedIntimated || 0) > 0 ? ((s.multiEtaCallsCount || 0) / s.closedIntimated) * 100 : 0}%; height:100%; background:#f59e0b;"></div>
              </div>
            </div>
          </div>

          <div style="margin-top:1.5rem; padding-top:1rem; border-top:1px solid var(--border-subtle); font-size:0.8rem; color:var(--text-tertiary);">
            Historical intimation audit ensures service centers consistently notify customers before repair completion.
          </div>
        </div>
      `;
    }
  }
}

/**
 * Render Regional Performance Summary Table (Adapts to OPEN vs CLOSED)
 */
function renderRegionalPerformanceTable() {
  const tbody = document.getElementById("perf-regional-table-body");
  if (!tbody) return;

  const activeStationList = currentViewMode === "OPEN" ? allStationOpenData : allStationClosedData;
  const regionalMap = {};

  activeStationList.forEach((st) => {
    const reg = (st.region || "Unassigned").trim() || "Unassigned";
    if (!regionalMap[reg]) {
      regionalMap[reg] = {
        region: reg,
        cciCount: 0,
        // Open counters
        open_total: 0,
        open_over_3d: 0,
        open_intimated: 0,
        open_pending: 0,
        open_multi_eta: 0,
        // Closed counters
        closed_total: 0,
        closed_over_3d: 0,
        closed_intimated: 0,
        closed_with_etr: 0,
        closed_met_on_time: 0,
        closed_multi_eta: 0,
        // Calling counters
        totalAttempts: 0,
        completedAttempts: 0,
      };
    }
    const item = regionalMap[reg];
    item.cciCount++;

    if (currentViewMode === "OPEN") {
      item.open_total += Number(st.open_total) || 0;
      item.open_over_3d += Number(st.open_over_3d) || 0;
      item.open_intimated += Number(st.open_intimated) || 0;
      item.open_pending += Number(st.open_pending) || 0;
      item.open_multi_eta += Number(st.open_multi_eta) || 0;
      item.totalAttempts += Number(st.totalAttempts) || 0;
      item.completedAttempts += Number(st.completedAttempts) || 0;
    } else {
      item.closed_total += Number(st.closed_total) || 0;
      item.closed_over_3d += Number(st.closed_over_3d) || 0;
      item.closed_intimated += Number(st.closed_intimated) || 0;
      item.closed_with_etr += Number(st.finishedWithEtr) || 0;
      item.closed_met_on_time += Number(st.metEtrOnTime) || 0;
      item.closed_multi_eta += Number(st.closed_multi_eta) || 0;
    }
  });

  let regions = Object.values(regionalMap).sort((a, b) => {
    if (currentViewMode === "OPEN") {
      return (b.open_over_3d - a.open_over_3d) || (b.open_total - a.open_total);
    } else {
      return (b.closed_total - a.closed_total);
    }
  });

  if (selectedRegionalSummaryRegions.size > 0) {
    regions = regions.filter((r) => selectedRegionalSummaryRegions.has(r.region.trim()));
  }

  if (regions.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
          No regional performance records match the selected regions.
        </td>
      </tr>
    `;
    return;
  }

  if (currentViewMode === "OPEN") {
    tbody.innerHTML = regions
      .map((reg) => {
        const covRate = reg.open_over_3d > 0
          ? Math.round((reg.open_intimated / reg.open_over_3d) * 1000) / 10
          : 100;

        const extRate = reg.open_intimated > 0
          ? Math.round((reg.open_multi_eta / reg.open_intimated) * 100)
          : 0;

        const reachRate = reg.totalAttempts > 0
          ? Math.round((reg.completedAttempts / reg.totalAttempts) * 100)
          : 100;

        const progressColor = covRate >= 90 ? "#10b981" : covRate >= 70 ? "#0072ce" : "#ef4444";

        return `
          <tr>
            <td><strong style="color:var(--text-primary); font-size:0.875rem;">${escapeHtml(reg.region)}</strong></td>
            <td><span class="badge badge-neutral">${reg.cciCount} CCIs</span></td>
            <td><strong>${reg.open_total.toLocaleString()}</strong></td>
            <td><span style="color:${reg.open_over_3d > 0 ? '#ef4444' : 'var(--text-secondary)'}; font-weight:700;">${reg.open_over_3d.toLocaleString()}</span></td>
            <td><span style="color:var(--status-success-dot); font-weight:600;">${reg.open_intimated.toLocaleString()}</span></td>
            <td><span style="color:var(--status-warning-dot); font-weight:600;">${reg.open_pending.toLocaleString()}</span></td>
            <td>
              <div style="display:flex; align-items:center; gap:0.5rem;">
                <div style="flex:1; min-width:60px; height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden;">
                  <div style="width:${Math.min(covRate, 100)}%; height:100%; background:${progressColor}; border-radius:3px;"></div>
                </div>
                <strong style="min-width:40px; font-size:0.8125rem;">${covRate}%</strong>
              </div>
            </td>
            <td><span style="font-weight:600; color:${extRate > 20 ? '#ef4444' : 'var(--text-secondary)'};">${extRate}%</span></td>
            <td><span style="color:var(--status-success-dot); font-weight:600;">${reachRate}%</span></td>
          </tr>
        `;
      })
      .join("");
  } else {
    // CLOSED Table Body
    tbody.innerHTML = regions
      .map((reg) => {
        const compRate = reg.closed_over_3d > 0
          ? Math.round((reg.closed_intimated / reg.closed_over_3d) * 100)
          : (reg.closed_total > 0 ? Math.round((reg.closed_intimated / reg.closed_total) * 100) : 100);

        const onTimeRate = reg.closed_with_etr > 0
          ? Math.round((reg.closed_met_on_time / reg.closed_with_etr) * 100)
          : 100;

        const extRate = reg.closed_intimated > 0
          ? Math.round((reg.closed_multi_eta / reg.closed_intimated) * 100)
          : 0;

        const progressColor = onTimeRate >= 90 ? "#10b981" : onTimeRate >= 70 ? "#0072ce" : "#ef4444";

        return `
          <tr>
            <td><strong style="color:var(--text-primary); font-size:0.875rem;">${escapeHtml(reg.region)}</strong></td>
            <td><span class="badge badge-neutral">${reg.cciCount} CCIs</span></td>
            <td><strong>${reg.closed_total.toLocaleString()}</strong></td>
            <td><span style="color:var(--text-secondary); font-weight:600;">${reg.closed_over_3d.toLocaleString()}</span></td>
            <td><span style="color:var(--status-success-dot); font-weight:600;">${reg.closed_intimated.toLocaleString()}</span></td>
            <td><span class="badge ${compRate >= 90 ? 'badge-success' : 'badge-warning'}">${compRate}%</span></td>
            <td><strong>${reg.closed_with_etr.toLocaleString()}</strong></td>
            <td>
              <div style="display:flex; align-items:center; gap:0.5rem;">
                <div style="flex:1; min-width:60px; height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden;">
                  <div style="width:${Math.min(onTimeRate, 100)}%; height:100%; background:${progressColor}; border-radius:3px;"></div>
                </div>
                <strong style="min-width:40px; font-size:0.8125rem;">${onTimeRate}%</strong>
              </div>
            </td>
            <td><span style="font-weight:600; color:${extRate > 20 ? '#ef4444' : 'var(--text-secondary)'};">${extRate}%</span></td>
          </tr>
        `;
      })
      .join("");
  }
}

/**
 * Render Filtered Partner Performance Rankings Table
 */
function renderFilteredTable() {
  const tbody = document.getElementById("perf-table-body");
  if (!tbody) return;

  const rawList = currentViewMode === "OPEN" ? allStationOpenData : allStationClosedData;
  let filtered = [...rawList];

  // Search filter
  if (searchQuery) {
    filtered = filtered.filter(
      (c) =>
        (c.cci_code && c.cci_code.toLowerCase().includes(searchQuery)) ||
        (c.station_code && c.station_code.toLowerCase().includes(searchQuery)) ||
        (c.cci_name && c.cci_name.toLowerCase().includes(searchQuery)) ||
        (c.region && c.region.toLowerCase().includes(searchQuery)) ||
        (c.location && c.location.toLowerCase().includes(searchQuery))
    );
  }

  // Multi-region filter
  if (selectedRankingsRegions.size > 0) {
    filtered = filtered.filter((c) => selectedRankingsRegions.has((c.region || "").trim()));
  }

  // Tier filter
  if (currentViewMode === "OPEN") {
    if (filterTier === "HIGH") {
      filtered = filtered.filter((c) => Number(c.coverage_rate) >= 90);
    } else if (filterTier === "MID") {
      filtered = filtered.filter((c) => Number(c.coverage_rate) >= 70 && Number(c.coverage_rate) < 90);
    } else if (filterTier === "LOW") {
      filtered = filtered.filter((c) => Number(c.coverage_rate) < 70);
    }
  } else {
    // Closed Tier (based on on_time_rate)
    if (filterTier === "HIGH") {
      filtered = filtered.filter((c) => Number(c.on_time_rate) >= 90);
    } else if (filterTier === "MID") {
      filtered = filtered.filter((c) => Number(c.on_time_rate) >= 70 && Number(c.on_time_rate) < 90);
    } else if (filterTier === "LOW") {
      filtered = filtered.filter((c) => Number(c.on_time_rate) < 70);
    }
  }

  // Sorting
  filtered.sort((a, b) => {
    const valA = Number(a[sortBy]) || 0;
    const valB = Number(b[sortBy]) || 0;
    return sortOrder === "desc" ? valB - valA : valA - valB;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
          No station records match your filters.
        </td>
      </tr>
    `;
    return;
  }

  if (currentViewMode === "OPEN") {
    tbody.innerHTML = filtered
      .map((st, idx) => {
        let rankBadge = `<span style="font-weight:700; color:var(--text-tertiary);">#${idx + 1}</span>`;
        if (idx === 0) rankBadge = `🥇 <strong style="color:#d97706;">1st</strong>`;
        if (idx === 1) rankBadge = `🥈 <strong style="color:#64748b;">2nd</strong>`;
        if (idx === 2) rankBadge = `🥉 <strong style="color:#b45309;">3rd</strong>`;

        const covRate = Number(st.coverage_rate) || 0;
        const progressColor = covRate >= 90 ? "#10b981" : covRate >= 70 ? "#0072ce" : "#ef4444";

        const tierBadge = covRate >= 90 
          ? `<span class="badge badge-success" style="font-size:0.75rem;">HIGH (≥90%)</span>`
          : covRate >= 70
          ? `<span class="badge badge-info" style="font-size:0.75rem;">MID (70-89%)</span>`
          : `<span class="badge badge-danger" style="font-size:0.75rem;">SLA RISK (&lt;70%)</span>`;

        return `
          <tr>
            <td>${rankBadge}</td>
            <td>
              <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(st.cci_code || st.station_code)}</div>
              <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(st.cci_name || "—")}</div>
            </td>
            <td><span class="badge badge-neutral">${escapeHtml(st.region || "—")}</span></td>
            <td>${escapeHtml(st.location || "—")}</td>
            <td><strong>${Number(st.total_open).toLocaleString()}</strong></td>
            <td><span style="color:${st.over_3d > 0 ? '#ef4444' : 'var(--text-secondary)'}; font-weight:700;">${Number(st.over_3d).toLocaleString()}</span></td>
            <td><span style="color:var(--status-success-dot); font-weight:600;">${Number(st.intimated).toLocaleString()}</span></td>
            <td><span style="color:var(--status-warning-dot); font-weight:600;">${Number(st.pending).toLocaleString()}</span></td>
            <td>
              <div style="display:flex; align-items:center; gap:0.5rem;">
                <div style="flex:1; height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden;">
                  <div style="width:${Math.min(covRate, 100)}%; height:100%; background:${progressColor}; border-radius:3px;"></div>
                </div>
                <strong style="min-width:40px; font-size:0.8125rem;">${covRate}%</strong>
              </div>
            </td>
            <td><span style="font-weight:600; color:${st.extension_rate > 20 ? '#ef4444' : 'var(--text-secondary)'};">${st.intimated > 0 ? `${st.extension_rate}%` : '—'}</span></td>
            <td><span style="color:var(--status-success-dot); font-weight:600;">${st.totalAttempts > 0 ? `${st.reachability_rate}%` : '—'}</span></td>
            <td>${tierBadge}</td>
            <td>
              <a href="#/intimation/calling" class="btn-secondary" style="padding:4px 8px; font-size:0.75rem; white-space:nowrap;" title="Call open queue">
                <span>Call Queue</span>
              </a>
            </td>
          </tr>
        `;
      })
      .join("");
  } else {
    // CLOSED Table Body
    tbody.innerHTML = filtered
      .map((st, idx) => {
        let rankBadge = `<span style="font-weight:700; color:var(--text-tertiary);">#${idx + 1}</span>`;
        if (idx === 0) rankBadge = `🥇 <strong style="color:#d97706;">1st</strong>`;
        if (idx === 1) rankBadge = `🥈 <strong style="color:#64748b;">2nd</strong>`;
        if (idx === 2) rankBadge = `🥉 <strong style="color:#b45309;">3rd</strong>`;

        const onTimeRate = Number(st.on_time_rate) || 0;
        const progressColor = onTimeRate >= 90 ? "#10b981" : onTimeRate >= 70 ? "#0072ce" : "#ef4444";

        const gradeBadge = onTimeRate >= 90
          ? `<span class="badge badge-success" style="font-size:0.75rem;">GRADE A (≥90%)</span>`
          : onTimeRate >= 70
          ? `<span class="badge badge-info" style="font-size:0.75rem;">GRADE B (70-89%)</span>`
          : `<span class="badge badge-danger" style="font-size:0.75rem;">GRADE C (&lt;70%)</span>`;

        return `
          <tr>
            <td>${rankBadge}</td>
            <td>
              <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(st.cci_code || st.station_code)}</div>
              <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(st.cci_name || "—")}</div>
            </td>
            <td><span class="badge badge-neutral">${escapeHtml(st.region || "—")}</span></td>
            <td>${escapeHtml(st.location || "—")}</td>
            <td><strong>${Number(st.total_closed).toLocaleString()}</strong></td>
            <td><span style="color:var(--text-secondary); font-weight:600;">${Number(st.closed_over_3d).toLocaleString()}</span></td>
            <td><span style="color:var(--status-success-dot); font-weight:600;">${Number(st.closed_intimated).toLocaleString()}</span></td>
            <td><span class="badge ${st.compliance_rate >= 90 ? 'badge-success' : 'badge-warning'}">${st.compliance_rate}%</span></td>
            <td><strong>${Number(st.finishedWithEtr).toLocaleString()}</strong></td>
            <td>
              <div style="display:flex; align-items:center; gap:0.5rem;">
                <div style="flex:1; height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden;">
                  <div style="width:${Math.min(onTimeRate, 100)}%; height:100%; background:${progressColor}; border-radius:3px;"></div>
                </div>
                <strong style="min-width:40px; font-size:0.8125rem;">${onTimeRate}%</strong>
              </div>
            </td>
            <td><span style="font-weight:600; color:${st.extension_rate > 20 ? '#ef4444' : 'var(--text-secondary)'};">${st.closed_intimated > 0 ? `${st.extension_rate}%` : '—'}</span></td>
            <td>${gradeBadge}</td>
            <td>
              <a href="#/intimation/history" class="btn-secondary" style="padding:4px 8px; font-size:0.75rem; white-space:nowrap;" title="Audit closed orders">
                <span>Audit Logs</span>
              </a>
            </td>
          </tr>
        `;
      })
      .join("");
  }
}

/**
 * Export Partner Performance Rankings to CSV (Adapts based on current view mode)
 */
function exportIntimationPerfCsv() {
  if (currentViewMode === "OPEN") {
    if (!allStationOpenData || allStationOpenData.length === 0) return;

    const headers = [
      "Rank",
      "CCI Code",
      "Center Name",
      "Region",
      "Location",
      "Active Open Inventory",
      "Open Ageing > 3 Days",
      "Open Calls Intimated",
      "Pending Intimations",
      "Open Coverage Rate (%)",
      "Multi-ETA Rate (%)",
      "Customer Reachability (%)",
    ];

    const rows = allStationOpenData.map((st, idx) => [
      idx + 1,
      `"${(st.cci_code || st.station_code || "").replace(/"/g, '""')}"`,
      `"${(st.cci_name || "").replace(/"/g, '""')}"`,
      `"${(st.region || "").replace(/"/g, '""')}"`,
      `"${(st.location || "").replace(/"/g, '""')}"`,
      st.total_open,
      st.over_3d,
      st.intimated,
      st.pending,
      st.coverage_rate,
      st.intimated > 0 ? `${st.extension_rate}%` : "—",
      st.totalAttempts > 0 ? `${st.reachability_rate}%` : "—",
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    downloadCsvWithBom(csvContent, `motorola_open_calls_intimation_progress_${new Date().toISOString().split("T")[0]}.csv`);
  } else {
    if (!allStationClosedData || allStationClosedData.length === 0) return;

    const headers = [
      "Rank",
      "CCI Code",
      "Center Name",
      "Region",
      "Location",
      "Total Closed Repairs",
      "Closed Ageing > 3 Days",
      "Intimated Before Closure",
      "Intimation Compliance (%)",
      "Finished with Committed ETR",
      "Met ETR On-Time (%)",
      "Multi-ETA Rate (%)",
    ];

    const rows = allStationClosedData.map((st, idx) => [
      idx + 1,
      `"${(st.cci_code || st.station_code || "").replace(/"/g, '""')}"`,
      `"${(st.cci_name || "").replace(/"/g, '""')}"`,
      `"${(st.region || "").replace(/"/g, '""')}"`,
      `"${(st.location || "").replace(/"/g, '""')}"`,
      st.total_closed,
      st.closed_over_3d,
      st.closed_intimated,
      st.compliance_rate,
      st.finishedWithEtr,
      st.finishedWithEtr > 0 ? `${st.on_time_rate}%` : "—",
      st.closed_intimated > 0 ? `${st.extension_rate}%` : "—",
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    downloadCsvWithBom(csvContent, `motorola_closed_calls_intimation_audit_${new Date().toISOString().split("T")[0]}.csv`);
  }
}

/**
 * Cleanup subscriptions on unmount / route transition
 */
export function cleanupIntimationPerformance() {
  if (regionalSummaryDropdown) {
    regionalSummaryDropdown.destroy();
    regionalSummaryDropdown = null;
  }
  if (rankingsDropdown) {
    rankingsDropdown.destroy();
    rankingsDropdown = null;
  }
  unsubscribeChannel("intimation_perf_realtime_calls");
  unsubscribeChannel("intimation_perf_realtime_intimation");
}
