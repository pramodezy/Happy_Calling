// ============================================================================
// Motorola Care - Intimation Calling CCI & Regional Performance Controller
// Tracks ETR commitments, SLA coverage, regional performance summary,
// and partner performance rankings with territory/region tagging.
// ============================================================================

import { supabase, fetchAllRows, subscribeToTable, unsubscribeChannel, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin, isBSM, hasAdminOrBsmAccess, getUserAssignedRegions } from "./auth.js";
import { icons, escapeHtml, formatDate, formatDateTime, downloadCsvWithBom } from "./utils.js";
import { renderSpinner } from "../components/loading.js";
import { renderKpiCard } from "../components/kpi-card.js";
import { initMultiSelectDropdown } from "../components/multi-select-dropdown.js";

// Page state
let allStationData = [];
let regionalSummaryData = [];
let searchQuery = "";
let selectedRegionalSummaryRegions = new Set();
let selectedRankingsRegions = new Set();
let regionalSummaryDropdown = null;
let rankingsDropdown = null;
let filterTier = "ALL";
let sortBy = "coverage_rate";
let sortOrder = "desc";

export async function renderIntimationPerformancePage(container) {
  searchQuery = "";
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
            <span>Export Leaderboard CSV</span>
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

  const admin = isAdmin();
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

    // Filter calls with Ageing > 3 days
    const callsOver3d = allCalls.filter((c) => {
      const carryMs = new Date(c.carry_in_time).getTime();
      return (nowMs - carryMs) > threeDaysMs;
    });

    // Completed intimations lookup: service_order -> array of intimation records
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

    // Unique calls that received at least 1 completed ETA
    const intimatedUniqueSoCount = completedIntimationMap.size;
    const overallCoverageRate = callsOver3d.length > 0
      ? Math.min(100, Math.round((intimatedUniqueSoCount / callsOver3d.length) * 100))
      : 100;

    // Calculate On-Time Resolution against Committed ETR for finished repairs
    let totalFinishedWithEtr = 0;
    let totalMetEtrOnTime = 0;

    allCalls.forEach((c) => {
      if (c.finish_repair_time && completedIntimationMap.has(c.service_order)) {
        totalFinishedWithEtr++;
        const finishDateStr = new Date(c.finish_repair_time).toISOString().split("T")[0];
        const records = completedIntimationMap.get(c.service_order);
        const latestEtr = records[records.length - 1].etr_date;
        if (finishDateStr <= latestEtr) {
          totalMetEtrOnTime++;
        }
      }
    });

    const overallOnTimeRate = totalFinishedWithEtr > 0
      ? Math.round((totalMetEtrOnTime / totalFinishedWithEtr) * 100)
      : 100;

    const overallReachability = totalAttempts > 0
      ? Math.round((completedAttempts / totalAttempts) * 100)
      : 100;

    // Multiple ETAs count (calls with >= 2 ETAs)
    let multiEtaCallsCount = 0;
    completedIntimationMap.forEach((records) => {
      if (records.length > 1) {
        multiEtaCallsCount++;
      }
    });

    const overallExtensionRate = intimatedUniqueSoCount > 0
      ? Math.round((multiEtaCallsCount / intimatedUniqueSoCount) * 100)
      : 0;

    // ========================================================================
    // Station-by-Station Aggregation for Rankings & Regional Summary
    // ========================================================================
    const stationMap = new Map();

    // Group open calls by CCI code
    allCalls.forEach((call) => {
      const code = call.cci_code || call.station_code || "Unknown";
      if (!stationMap.has(code)) {
        const meta = cciMetaMap.get(code) || {};
        stationMap.set(code, {
          cci_code: code,
          station_code: call.station_code || code,
          cci_name: meta.cci_name || call.station_name || `Station ${code}`,
          region: (meta.region || "Unassigned").trim() || "Unassigned",
          location: meta.location || "—",
          total_open: 0,
          total_calls: 0,
          over_3d: 0,
          intimated: 0,
          pending: 0,
          finishedWithEtr: 0,
          metEtrOnTime: 0,
          multi_eta_count: 0,
        });
      }

      const st = stationMap.get(code);
      st.total_calls++;
      if (call.is_open !== false) {
        st.total_open++;
      }

      const carryMs = new Date(call.carry_in_time).getTime();
      const isOver3d = (nowMs - carryMs) > threeDaysMs;
      const isIntimated = completedIntimationMap.has(call.service_order);

      if (isOver3d) {
        st.over_3d++;
        if (isIntimated) {
          st.intimated++;
        } else {
          st.pending++;
        }
      }

      if (isIntimated) {
        const records = completedIntimationMap.get(call.service_order);
        if (records.length > 1) {
          st.multi_eta_count++;
        }

        if (call.finish_repair_time) {
          st.finishedWithEtr++;
          const finishDateStr = new Date(call.finish_repair_time).toISOString().split("T")[0];
          const latestEtr = records[records.length - 1].etr_date;
          if (finishDateStr <= latestEtr) {
            st.metEtrOnTime++;
          }
        }
      }
    });

    // Also include active CCIs from cci_master if they have 0 calls but exist in assigned region
    if (isPrivileged) {
      cciMasterList.forEach((c) => {
        if (!stationMap.has(c.cci_code) && c.status === "ACTIVE") {
          stationMap.set(c.cci_code, {
            cci_code: c.cci_code,
            station_code: c.cci_code,
            cci_name: c.cci_name || `Station ${c.cci_code}`,
            region: (c.region || "Unassigned").trim() || "Unassigned",
            location: c.location || "—",
            total_open: 0,
            total_calls: 0,
            over_3d: 0,
            intimated: 0,
            pending: 0,
            finishedWithEtr: 0,
            metEtrOnTime: 0,
            multi_eta_count: 0,
          });
        }
      });
    }

    // Compute station-level rates
    const rawStations = Array.from(stationMap.values()).map((st) => {
      const covRate = st.over_3d > 0
        ? Math.round((st.intimated / st.over_3d) * 1000) / 10
        : (st.total_open === 0 ? 100 : 100);

      const onTime = st.finishedWithEtr > 0
        ? Math.round((st.metEtrOnTime / st.finishedWithEtr) * 100)
        : 100;

      const extRate = st.intimated > 0
        ? Math.round((st.multi_eta_count / st.intimated) * 100)
        : 0;

      const callStats = intimationsByCci.get(st.cci_code) || { total: 0, completed: 0, unreachable: 0, callback: 0 };
      const reachRate = callStats.total > 0
        ? Math.round((callStats.completed / callStats.total) * 100)
        : 100;

      return {
        ...st,
        coverage_rate: covRate,
        on_time_rate: onTime,
        extension_rate: extRate,
        totalAttempts: callStats.total,
        completedAttempts: callStats.completed,
        reachability_rate: reachRate,
      };
    });

    // Filter demo codes if non-demo stations exist
    const DEMO_CODES = new Set(["BLR01", "DEL01", "MUM01", "KOC01", "KOL01"]);
    const hasRealCodes = rawStations.some((s) => !DEMO_CODES.has(s.cci_code));
    let cleanedStations = hasRealCodes ? rawStations.filter((s) => !DEMO_CODES.has(s.cci_code)) : rawStations;

    // BSM Regional scoping filter
    if (isBsmUser && assignedRegions.length > 0) {
      const assignedSet = new Set(assignedRegions.map((r) => r.trim().toLowerCase()));
      cleanedStations = cleanedStations.filter((s) => assignedSet.has((s.region || "").trim().toLowerCase()));
    }

    allStationData = cleanedStations;

    // Tiers calculation
    const highPerformers = allStationData.filter((c) => Number(c.coverage_rate) >= 90).length;
    const midPerformers = allStationData.filter((c) => Number(c.coverage_rate) >= 70 && Number(c.coverage_rate) < 90).length;
    const lowPerformers = allStationData.filter((c) => Number(c.coverage_rate) < 70).length;

    // Render Mount Content
    mount.innerHTML = `
      <!-- Top Performance Tier KPI Cards -->
      <div class="kpi-grid" style="margin-bottom:1.5rem;">
        ${renderKpiCard({
          title: "Intimation Coverage",
          value: `${overallCoverageRate}%`,
          icon: icons.award,
          colorScheme: overallCoverageRate >= 90 ? "green" : overallCoverageRate >= 70 ? "blue" : "red",
          subtitle: `${intimatedUniqueSoCount} of ${callsOver3d.length} (>3d) Intimated`,
        })}
        ${renderKpiCard({
          title: "On-Time ETR Resolution",
          value: `${overallOnTimeRate}%`,
          icon: icons.checkCircle,
          colorScheme: "green",
          subtitle: `${totalMetEtrOnTime} of ${totalFinishedWithEtr} Met Committed ETR`,
        })}
        ${renderKpiCard({
          title: "High Performers (≥90%)",
          value: highPerformers.toLocaleString(),
          icon: icons.award,
          colorScheme: "green",
          subtitle: "Target SLA Met",
        })}
        ${renderKpiCard({
          title: "ETA Extension Rate",
          value: `${overallExtensionRate}%`,
          icon: icons.clock,
          colorScheme: "amber",
          subtitle: `${multiEtaCallsCount} Orders with ETA #2 / #3`,
        })}
        ${renderKpiCard({
          title: "Customer Reachability",
          value: `${overallReachability}%`,
          icon: icons.phone,
          colorScheme: "blue",
          subtitle: `${completedAttempts} Reached of ${totalAttempts} Calls`,
        })}
        ${renderKpiCard({
          title: "Critical Tier (<70%)",
          value: lowPerformers.toLocaleString(),
          icon: icons.alertTriangle,
          colorScheme: lowPerformers > 0 ? "red" : "green",
          subtitle: "SLA Risk Stations",
        })}
      </div>

      <!-- Detail Analysis Grid: ETA Commitments & Outreach Breakdown -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); gap:1.5rem; margin-bottom:1.75rem;">
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

          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
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

      <!-- Regional Performance Summary Section (Same layout as Happy Calling CCI Performance) -->
      <div class="table-card" style="margin-bottom:1.75rem; overflow:visible;">
        <div class="table-card-header" style="flex-wrap:wrap; gap:0.5rem; position:relative; z-index:30;">
          <div>
            <h3 class="table-card-title">${isBsmUser ? "Assigned Regional Performance Summary" : "Regional Performance Summary"}</h3>
            <span style="font-size:0.75rem; color:var(--text-tertiary);">Territory-level Intimation coverage rates, on-time ETR compliance, and customer reachability</span>
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
            <thead>
              <tr>
                <th>Region</th>
                <th>Active CCIs</th>
                <th>Total Open</th>
                <th>Ageing &gt; 3 Days</th>
                <th>Intimated Calls</th>
                <th>Pending Intimations</th>
                <th>Coverage %</th>
                <th>On-Time ETR %</th>
                <th>Multi-ETA %</th>
                <th>Reachability %</th>
              </tr>
            </thead>
            <tbody id="perf-regional-table-body">
              <tr><td colspan="10">${renderSpinner("Loading regional performance...")}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Partner Performance Rankings Section with Region Tagging (Same layout as Happy Calling CCI Performance) -->
      <div class="table-card" style="overflow:visible;">
        <div class="table-card-header" style="flex-wrap:wrap; gap:0.75rem; position:relative; z-index:20;">
          <div>
            <h3 class="table-card-title">Partner Performance Rankings</h3>
            <span style="font-size:0.75rem; color:var(--text-tertiary);">Real-time ranking based on completed customer intimation and committed ETR resolution</span>
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

            <select id="perf-sort-by" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
              <option value="coverage_rate">Sort: Coverage Rate %</option>
              <option value="on_time_rate">Sort: On-Time ETR %</option>
              <option value="pending">Sort: Pending Intimations</option>
              <option value="over_3d">Sort: Ageing > 3 Days</option>
              <option value="total_open">Sort: Total Open</option>
              <option value="reachability_rate">Sort: Reachability %</option>
            </select>

            <button type="button" id="btn-perf-rankings-reset-all" class="btn-secondary" style="padding:5px 12px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;" title="Reset all filters to default">
              <span style="width:14px; height:14px;">${icons.refreshCw || ''}</span>
              <span>Reset All</span>
            </button>
          </div>
        </div>

        <div class="table-responsive-wrapper">
          <table class="data-table">
            <thead>
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
                <th>On-Time ETR %</th>
                <th>Multi-ETA %</th>
                <th>Reachability %</th>
                <th>Performance Tier</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="perf-table-body">
              <tr><td colspan="14">${renderSpinner("Loading partner rankings...")}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    // Compute unique regions list
    let uniqueRegions = [];
    if (isBsmUser && assignedRegions.length > 0) {
      uniqueRegions = [...assignedRegions].sort();
    } else {
      uniqueRegions = Array.from(
        new Set(
          allStationData
            .map((c) => (c.region || "").trim())
            .filter((r) => r.length > 0 && r !== "Unassigned")
        )
      ).sort();
    }

    const regPlaceholder = isBsmUser ? `All My Regions (${assignedRegions.join(", ") || "Assigned"})` : "All Regions";

    // 1. Regional Performance Summary Multi-Select Checkbox Dropdown
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

    // 2. Partner Performance Rankings Multi-Select Checkbox Dropdown
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

      sortBy = "coverage_rate";
      const sortSelect = document.getElementById("perf-sort-by");
      if (sortSelect) sortSelect.value = "coverage_rate";

      renderFilteredTable();
    });

    renderRegionalPerformanceTable();
    renderFilteredTable();
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
 * Render Regional Performance Summary Table
 */
function renderRegionalPerformanceTable() {
  const tbody = document.getElementById("perf-regional-table-body");
  if (!tbody) return;

  const regionalMap = {};
  allStationData.forEach((st) => {
    const reg = (st.region || "Unassigned").trim() || "Unassigned";
    if (!regionalMap[reg]) {
      regionalMap[reg] = {
        region: reg,
        cciCount: 0,
        total_open: 0,
        over_3d: 0,
        intimated: 0,
        pending: 0,
        finishedWithEtr: 0,
        metEtrOnTime: 0,
        multi_eta_count: 0,
        totalAttempts: 0,
        completedAttempts: 0,
      };
    }
    const item = regionalMap[reg];
    item.cciCount++;
    item.total_open += Number(st.total_open) || 0;
    item.over_3d += Number(st.over_3d) || 0;
    item.intimated += Number(st.intimated) || 0;
    item.pending += Number(st.pending) || 0;
    item.finishedWithEtr += Number(st.finishedWithEtr) || 0;
    item.metEtrOnTime += Number(st.metEtrOnTime) || 0;
    item.multi_eta_count += Number(st.multi_eta_count) || 0;
    item.totalAttempts += Number(st.totalAttempts) || 0;
    item.completedAttempts += Number(st.completedAttempts) || 0;
  });

  regionalSummaryData = Object.values(regionalMap).sort((a, b) => b.over_3d - a.over_3d || b.total_open - a.total_open);

  let regions = [...regionalSummaryData];
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

  tbody.innerHTML = regions
    .map((reg) => {
      const covRate = reg.over_3d > 0
        ? Math.round((reg.intimated / reg.over_3d) * 1000) / 10
        : 100;

      const onTimeRate = reg.finishedWithEtr > 0
        ? Math.round((reg.metEtrOnTime / reg.finishedWithEtr) * 100)
        : 100;

      const extRate = reg.intimated > 0
        ? Math.round((reg.multi_eta_count / reg.intimated) * 100)
        : 0;

      const reachRate = reg.totalAttempts > 0
        ? Math.round((reg.completedAttempts / reg.totalAttempts) * 100)
        : 100;

      const progressColor = covRate >= 90 ? "#10b981" : covRate >= 70 ? "#0072ce" : "#ef4444";

      return `
        <tr>
          <td><strong style="color:var(--text-primary); font-size:0.875rem;">${escapeHtml(reg.region)}</strong></td>
          <td><span class="badge badge-neutral">${reg.cciCount} CCIs</span></td>
          <td><strong>${reg.total_open.toLocaleString()}</strong></td>
          <td><span style="color:${reg.over_3d > 0 ? '#ef4444' : 'var(--text-secondary)'}; font-weight:700;">${reg.over_3d.toLocaleString()}</span></td>
          <td><span style="color:var(--status-success-dot); font-weight:600;">${reg.intimated.toLocaleString()}</span></td>
          <td><span style="color:var(--status-warning-dot); font-weight:600;">${reg.pending.toLocaleString()}</span></td>
          <td>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <div style="flex:1; min-width:60px; height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden;">
                <div style="width:${Math.min(covRate, 100)}%; height:100%; background:${progressColor}; border-radius:3px;"></div>
              </div>
              <strong style="min-width:40px; font-size:0.8125rem;">${covRate}%</strong>
            </div>
          </td>
          <td><span style="color:var(--status-success-dot); font-weight:600;">${onTimeRate}%</span></td>
          <td><span style="font-weight:600; color:${extRate > 20 ? '#ef4444' : 'var(--text-secondary)'};">${extRate}%</span></td>
          <td><span style="color:var(--status-success-dot); font-weight:600;">${reachRate}%</span></td>
        </tr>
      `;
    })
    .join("");
}

/**
 * Render Filtered Partner Performance Rankings Table with Region Tagging
 */
function renderFilteredTable() {
  const tbody = document.getElementById("perf-table-body");
  if (!tbody) return;

  let filtered = [...allStationData];

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
  if (filterTier === "HIGH") {
    filtered = filtered.filter((c) => Number(c.coverage_rate) >= 90);
  } else if (filterTier === "MID") {
    filtered = filtered.filter((c) => Number(c.coverage_rate) >= 70 && Number(c.coverage_rate) < 90);
  } else if (filterTier === "LOW") {
    filtered = filtered.filter((c) => Number(c.coverage_rate) < 70);
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
        <td colspan="14" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
          No station records match your filters.
        </td>
      </tr>
    `;
    return;
  }

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
          <!-- Region Tagging Badge identical to Happy Calling CCI Performance -->
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
          <td><span style="color:var(--status-success-dot); font-weight:600;">${st.finishedWithEtr > 0 ? `${st.on_time_rate}%` : '—'}</span></td>
          <td><span style="font-weight:600; color:${st.extension_rate > 20 ? '#ef4444' : 'var(--text-secondary)'};">${st.intimated > 0 ? `${st.extension_rate}%` : '—'}</span></td>
          <td><span style="color:var(--status-success-dot); font-weight:600;">${st.totalAttempts > 0 ? `${st.reachability_rate}%` : '—'}</span></td>
          <td>${tierBadge}</td>
          <td>
            <a href="#/intimation/pending" class="btn-secondary" style="padding:4px 8px; font-size:0.75rem;" title="View Open Backlog">
              <span>Backlog</span>
            </a>
          </td>
        </tr>
      `;
    })
    .join("");
}

/**
 * Export Partner Performance Rankings to CSV
 */
function exportIntimationPerfCsv() {
  if (!allStationData || allStationData.length === 0) return;

  const headers = [
    "Rank",
    "CCI Code",
    "Center Name",
    "Region",
    "Location",
    "Total Open",
    "Ageing > 3 Days",
    "Intimated Calls",
    "Pending Intimations",
    "Coverage Rate (%)",
    "On-Time ETR (%)",
    "Multi-ETA Rate (%)",
    "Customer Reachability (%)",
  ];

  const rows = allStationData.map((st, idx) => {
    return [
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
      st.finishedWithEtr > 0 ? `${st.on_time_rate}%` : "—",
      st.intimated > 0 ? `${st.extension_rate}%` : "—",
      st.totalAttempts > 0 ? `${st.reachability_rate}%` : "—",
    ];
  });

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  downloadCsvWithBom(csvContent, `motorola_intimation_cci_performance_${new Date().toISOString().split("T")[0]}.csv`);
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
