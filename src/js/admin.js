// ============================================================================
// Admin Dashboard & Company-Wide Overview Controller
// ============================================================================

import { supabase, formatSupabaseError, subscribeToTable, unsubscribeChannel } from "./supabase.js";
import { isAdmin, isBSM, getUserAssignedRegions } from "./auth.js";
import { icons, escapeHtml, renderRatingBadge } from "./utils.js";
import { renderKpiCard } from "../components/kpi-card.js";
import { renderSpinner } from "../components/loading.js";
import Chart from "chart.js/auto";

let adminTrendChart = null;
let adminFeedbackChart = null;
let adminCciCompareChart = null;

let filterCci = "";
let filterRegion = "";
let filterDateFrom = "";
let filterDateTo = "";
let cachedCcis = [];

export async function renderAdminDashboard(container) {
  const isBsmUser = isBSM();
  const assignedRegions = getUserAssignedRegions();
  const title = isBsmUser ? "Motorola Regional Operations Dashboard" : "Motorola Enterprise Care Dashboard";
  const subtitle = isBsmUser
    ? `Regional Happy Calling operations across assigned territories (${assignedRegions.join(", ") || "Assigned Regions"}).`
    : "Company-wide Happy Calling operations, CCI partner rankings, and customer sentiment analytics.";

  container.innerHTML = `
    <!-- Header with Live Indicator -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">${title}</h2>
          <span class="badge ${isBsmUser ? "badge-warning" : "badge-success"}" style="font-size:0.6875rem; padding:2px 8px;">
            <span class="badge-dot" style="animation:pulse 1.5s infinite;"></span> ${isBsmUser ? "BSM SCOPED" : "LIVE REALTIME"}
          </span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary);">${subtitle}</p>
      </div>

      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <a href="#/admin/performance" class="btn-secondary" style="padding:7px 12px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.award}</span>
          <span>CCI Performance</span>
        </a>
        <a href="#/admin/ageing" class="btn-secondary" style="padding:7px 12px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.clock}</span>
          <span>Pending Ageing</span>
        </a>
        <a href="#/admin/feedback" class="btn-secondary" style="padding:7px 12px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.smile}</span>
          <span>Feedback</span>
        </a>
        ${
          isAdmin()
            ? `
        <a href="#/admin/import" class="btn-primary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.upload}</span>
          <span>Import Closures</span>
        </a>`
            : ""
        }
      </div>
    </div>

    <!-- Filter Toolbar -->
    <div class="filter-toolbar">
      <div class="filter-group">
        <label for="admin-filter-cci">CCI:</label>
        <select id="admin-filter-cci" class="filter-select">
          <option value="">All CCIs</option>
        </select>
      </div>

      <div class="filter-group">
        <label for="admin-filter-region">Region:</label>
        <select id="admin-filter-region" class="filter-select">
          <option value="">All Regions</option>
        </select>
      </div>

      <div class="filter-group">
        <label for="admin-filter-from">From:</label>
        <input type="date" id="admin-filter-from" class="filter-select">
      </div>

      <div class="filter-group">
        <label for="admin-filter-to">To:</label>
        <input type="date" id="admin-filter-to" class="filter-select">
      </div>

      <button type="button" id="btn-admin-filter-reset" class="btn-secondary" style="padding:4px 10px; font-size:0.75rem; margin-left:auto;">
        Reset Filters
      </button>
    </div>

    <!-- KPI Cards Grid (8 Required KPIs) -->
    <div id="admin-kpi-mount" class="kpi-grid">
      ${renderSpinner("Aggregating live company-wide KPIs...")}
    </div>

    <!-- Row 1: CCI Completion Comparison & Feedback Donut -->
    <div class="dashboard-row">
      <div class="chart-card">
        <div class="chart-card-header">
          <span class="chart-card-title">CCI Completion Rate Comparison (%)</span>
        </div>
        <div class="chart-container-relative">
          <canvas id="canvas-admin-cci-compare"></canvas>
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-card-header">
          <span class="chart-card-title">National Feedback Distribution</span>
        </div>
        <div class="chart-container-relative">
          <canvas id="canvas-admin-feedback"></canvas>
        </div>
      </div>
    </div>

    <!-- Row 2: 14-Day Completion Trend -->
    <div class="chart-card" style="margin-bottom:1.75rem;">
      <div class="chart-card-header">
        <span class="chart-card-title">14-Day National Happy Calling Trend</span>
      </div>
      <div class="chart-container-relative" style="min-height:240px;">
        <canvas id="canvas-admin-trend"></canvas>
      </div>
    </div>

    <!-- Regional Performance Summary Section -->
    <div class="table-card" style="margin-bottom:1.75rem;">
      <div class="table-card-header" style="flex-wrap:wrap; gap:0.5rem;">
        <div>
          <h3 class="table-card-title">${isBsmUser ? "Assigned Regional Performance Summary" : "Regional Performance Summary"}</h3>
          <span style="font-size:0.75rem; color:var(--text-tertiary);">Territory-level Happy Calling completion rates, customer CSAT, and Motorola Survey compliance</span>
        </div>
        <span class="badge ${isBsmUser ? "badge-warning" : "badge-info"}" style="font-size:0.6875rem; padding:2px 8px;">
          ${isBsmUser ? "TERRITORY SCOPED" : "NATIONAL BREAKDOWN"}
        </span>
      </div>

      <div class="table-responsive-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Region</th>
              <th>Active CCIs</th>
              <th>Total Closures</th>
              <th>Completed Calls</th>
              <th>Pending Calls</th>
              <th>Completion %</th>
              <th>Happy %</th>
              <th>DSAT %</th>
              <th>Survey Email %</th>
              <th>Survey Complete %</th>
              <th>Avg Rating</th>
            </tr>
          </thead>
          <tbody id="admin-regional-table-body">
            <tr><td colspan="11">${renderSpinner("Loading regional performance...")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- CCI Performance Table & Leaderboard -->
    <div class="table-card">
      <div class="table-card-header" style="flex-wrap:wrap; gap:0.5rem;">
        <div>
          <h3 class="table-card-title">Top CCI Partners Snapshot</h3>
          <span style="font-size:0.75rem; color:var(--text-tertiary);">Ranked by Completion % and Happy Calling CSAT</span>
        </div>
        <a href="#/admin/performance" class="btn-secondary" style="padding:5px 12px; font-size:0.75rem; display:flex; align-items:center; gap:0.35rem;">
          <span>View Full Leaderboard & Export</span>
          <span>→</span>
        </a>
      </div>

      <div class="table-responsive-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>CCI Code & Name</th>
              <th>Region</th>
              <th>Location</th>
              <th>Total Closures</th>
              <th>Completed Calls</th>
              <th>Pending Calls</th>
              <th>Completion %</th>
              <th>Happy %</th>
              <th>DSAT %</th>
              <th>Survey (Email / Sub)</th>
              <th>Avg Rating</th>
            </tr>
          </thead>
          <tbody id="admin-cci-table-body">
            <tr><td colspan="12">${renderSpinner("Loading CCI performance table...")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Populate CCI and Region dropdown options from cci_master
  await populateFilters();

  // Attach filter listeners
  document.getElementById("admin-filter-cci")?.addEventListener("change", (e) => {
    filterCci = e.target.value;
    loadAdminMetrics();
  });

  document.getElementById("admin-filter-region")?.addEventListener("change", (e) => {
    filterRegion = e.target.value;
    updateCciDropdownOptions(filterRegion);
    loadAdminMetrics();
  });

  document.getElementById("admin-filter-from")?.addEventListener("change", (e) => {
    filterDateFrom = e.target.value;
    loadAdminMetrics();
  });

  document.getElementById("admin-filter-to")?.addEventListener("change", (e) => {
    filterDateTo = e.target.value;
    loadAdminMetrics();
  });

  document.getElementById("btn-admin-filter-reset")?.addEventListener("click", () => {
    filterCci = "";
    filterRegion = "";
    filterDateFrom = "";
    filterDateTo = "";
    const regSel = document.getElementById("admin-filter-region");
    const fromInput = document.getElementById("admin-filter-from");
    const toInput = document.getElementById("admin-filter-to");
    if (regSel) regSel.value = "";
    if (fromInput) fromInput.value = "";
    if (toInput) toInput.value = "";
    updateCciDropdownOptions("");
    loadAdminMetrics();
  });

  await loadAdminMetrics();

  // Enable Realtime updates for Admin Dashboard
  subscribeToTable("admin_dashboard_realtime", "happy_calling", "*", () => {
    loadAdminMetrics();
  });
}

/**
 * Dynamically updates the CCI dropdown based on the currently selected Region
 */
function updateCciDropdownOptions(selectedRegion) {
  const cciSelect = document.getElementById("admin-filter-cci");
  if (!cciSelect) return;

  const isBsmUser = isBSM();
  const assignedRegions = getUserAssignedRegions();
  const previousVal = filterCci;
  cciSelect.innerHTML = `<option value="">${isBsmUser ? "All Assigned CCIs" : "All CCIs"}</option>`;

  let filteredCcis = [];
  if (selectedRegion) {
    filteredCcis = cachedCcis.filter(
      (c) => (c.region || "").trim().toLowerCase() === selectedRegion.trim().toLowerCase()
    );
  } else if (isBsmUser && assignedRegions.length > 0) {
    const assignedSet = new Set(assignedRegions.map((r) => r.trim().toLowerCase()));
    filteredCcis = cachedCcis.filter((c) => assignedSet.has((c.region || "").trim().toLowerCase()));
  } else {
    filteredCcis = cachedCcis;
  }

  filteredCcis.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.cci_code;
    opt.textContent = `${c.cci_code} - ${c.cci_name}${!selectedRegion && c.region ? ` (${c.region})` : ""}`;
    cciSelect.appendChild(opt);
  });

  if (previousVal && filteredCcis.some((c) => c.cci_code === previousVal)) {
    cciSelect.value = previousVal;
  } else {
    filterCci = "";
    cciSelect.value = "";
  }
}

/**
 * Populate CCI and Region filter dropdowns dynamically from cci_master
 */
async function populateFilters() {
  const cciSelect = document.getElementById("admin-filter-cci");
  const regSelect = document.getElementById("admin-filter-region");
  if (!cciSelect && !regSelect) return;

  const isBsmUser = isBSM();
  const assignedRegions = getUserAssignedRegions();

  try {
    const { data } = await supabase.from("cci_master").select("cci_code, cci_name, region").order("cci_code");
    if (data) {
      // Legacy demo codes seeded during initial setup
      const DEMO_CODES = new Set(["BLR01", "DEL01", "MUM01", "KOC01", "KOL01"]);
      const hasStationCodes = data.some((c) => !DEMO_CODES.has(c.cci_code));
      cachedCcis = hasStationCodes ? data.filter((c) => !DEMO_CODES.has(c.cci_code)) : data;

      // Strictly filter cachedCcis to assigned regions if BSM user
      if (isBsmUser && assignedRegions.length > 0) {
        const assignedSet = new Set(assignedRegions.map((r) => r.trim().toLowerCase()));
        cachedCcis = cachedCcis.filter((c) => assignedSet.has((c.region || "").trim().toLowerCase()));
      }

      // Clean up legacy demo records from database if real station mapping has been ingested
      if (hasStationCodes) {
        supabase.from("closure_master").delete().in("closure_id", ["CLO-1001", "CLO-1002", "CLO-1003", "CLO-1004", "CLO-1005"]).then(() => {
          supabase.from("cci_master").delete().in("cci_code", ["BLR01", "DEL01", "MUM01", "KOC01", "KOL01"]).catch(() => {});
        }).catch(() => {});
      }

      if (regSelect) {
        regSelect.innerHTML = "";
        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = isBsmUser
          ? `All My Regions (${assignedRegions.join(", ") || "Assigned"})`
          : "All Regions";
        regSelect.appendChild(defaultOpt);

        let uniqueRegions = [];
        if (isBsmUser && assignedRegions.length > 0) {
          // Strictly show assigned regions for BSM
          uniqueRegions = [...assignedRegions].sort();
        } else {
          // Distinct regions from master data for Admin
          uniqueRegions = Array.from(
            new Set(
              cachedCcis
                .map((c) => (c.region || "").trim())
                .filter((r) => r.length > 0)
            )
          ).sort();
        }

        uniqueRegions.forEach((reg) => {
          const opt = document.createElement("option");
          opt.value = reg;
          opt.textContent = reg;
          regSelect.appendChild(opt);
        });
      }

      // Initialize CCI dropdown based on initial (empty) region filter
      updateCciDropdownOptions(filterRegion);
    }
  } catch (err) {
    console.warn("Could not load filter options from cci_master:", err);
  }
}

/**
 * Fetch and render admin dashboard data
 */
export async function loadAdminMetrics() {
  const kpiMount = document.getElementById("admin-kpi-mount");
  const tableBody = document.getElementById("admin-cci-table-body");
  const regionalTableBody = document.getElementById("admin-regional-table-body");
  if (!kpiMount) return;

  const isBsmUser = isBSM();
  const assignedRegions = getUserAssignedRegions();

  try {
    const { data, error } = await supabase.rpc("get_admin_dashboard", {
      p_cci_code: filterCci || null,
      p_region: filterRegion || null,
      p_date_from: filterDateFrom || null,
      p_date_to: filterDateTo || null,
    });

    if (error) throw error;
    if (!data) return;

    const totalClosures = Number(data.total_closures) || 0;
    const completedCalls = Number(data.completed_calls) || 0;
    const pendingCalls = Number(data.pending_calls) || 0;
    const completionRate = data.completion_rate !== undefined && data.completion_rate !== null ? data.completion_rate : 0;
    const happyRate = data.happy_rate !== undefined && data.happy_rate !== null ? data.happy_rate : 0;
    const neutralRate = data.neutral_rate !== undefined && data.neutral_rate !== null ? data.neutral_rate : 0;
    const unhappyRate = data.unhappy_rate !== undefined && data.unhappy_rate !== null ? data.unhappy_rate : 0;
    const happyCount = Number(data.happy_count) || 0;
    const neutralCount = Number(data.neutral_count) || 0;
    const unhappyCount = Number(data.unhappy_count) || 0;
    const avgRating = data.avg_rating !== undefined && data.avg_rating !== null ? data.avg_rating : 0;

    // Fetch survey confirmation metrics across CCIs / assigned scope
    let surveyReceivedRate = 0;
    let surveySubmittedRate = 0;
    let surveyReceivedCount = 0;
    let surveySubmittedCount = 0;
    const surveyByCci = {};

    try {
      const { data: sRows, error: sErr } = await supabase
        .from("happy_calling")
        .select("cci_code, survey_email_received, survey_submitted")
        .eq("calling_status", "Completed");

      if (!sErr && sRows && sRows.length > 0) {
        // Aggregate per CCI
        sRows.forEach((r) => {
          if (!surveyByCci[r.cci_code]) {
            surveyByCci[r.cci_code] = { total: 0, received: 0, submitted: 0 };
          }
          if (r.survey_email_received !== null && r.survey_email_received !== undefined) {
            surveyByCci[r.cci_code].total++;
            if (r.survey_email_received === "Yes") surveyByCci[r.cci_code].received++;
            if (r.survey_submitted === "Yes") surveyByCci[r.cci_code].submitted++;
          }
        });

        Object.keys(surveyByCci).forEach((code) => {
          const item = surveyByCci[code];
          item.emailRate = item.total > 0 ? Math.round((item.received / item.total) * 100) : 0;
          item.subRate = item.total > 0 ? Math.round((item.submitted / item.total) * 100) : 0;
        });

        // Filter rows matching current view/filters for KPI cards
        let filteredRows = sRows;
        if (filterCci) {
          filteredRows = filteredRows.filter((r) => r.cci_code === filterCci);
        } else if (filterRegion) {
          const regionCciSet = new Set(cachedCcis.filter((c) => (c.region || "").trim().toLowerCase() === filterRegion.trim().toLowerCase()).map((c) => c.cci_code));
          filteredRows = filteredRows.filter((r) => regionCciSet.has(r.cci_code));
        } else if (isBsmUser && assignedRegions.length > 0) {
          const assignedCciSet = new Set(cachedCcis.map((c) => c.cci_code));
          filteredRows = filteredRows.filter((r) => assignedCciSet.has(r.cci_code));
        }

        const tracked = filteredRows.filter((r) => r.survey_email_received !== null && r.survey_email_received !== undefined);
        const totalTracked = tracked.length;
        if (totalTracked > 0) {
          surveyReceivedCount = tracked.filter((r) => r.survey_email_received === "Yes").length;
          surveySubmittedCount = tracked.filter((r) => r.survey_submitted === "Yes").length;
          surveyReceivedRate = Math.round((surveyReceivedCount / totalTracked) * 100);
          surveySubmittedRate = Math.round((surveySubmittedCount / totalTracked) * 100);
        }
      }
    } catch (sEx) {
      console.warn("Survey metrics fetch notice:", sEx);
    }

    // Admin & BSM KPI cards
    kpiMount.innerHTML = `
      ${renderKpiCard({
        title: "Total Closures",
        value: totalClosures.toLocaleString(),
        icon: icons.database,
        colorScheme: "blue",
        subtitle: isBsmUser ? "Assigned Regions" : "Motorola Closed Jobs",
      })}
      ${renderKpiCard({
        title: "Completed Calls",
        value: completedCalls.toLocaleString(),
        icon: icons.checkCircle,
        colorScheme: "green",
        subtitle: "Verified Happy Calls",
      })}
      ${renderKpiCard({
        title: "Pending Calls",
        value: pendingCalls.toLocaleString(),
        icon: icons.clock,
        colorScheme: "amber",
        subtitle: isBsmUser ? "Regional Pending" : "Across All CCIs",
      })}
      ${renderKpiCard({
        title: "Completion %",
        value: `${completionRate}%`,
        icon: icons.award,
        colorScheme: Number(completionRate) >= 90 ? "green" : "purple",
        subtitle: "Benchmark: 95%",
      })}
      ${renderKpiCard({
        title: "Survey Email %",
        value: `${surveyReceivedRate}%`,
        icon: icons.mail,
        colorScheme: "blue",
        subtitle: `${surveyReceivedCount.toLocaleString()} Received Email`,
      })}
      ${renderKpiCard({
        title: "Survey Complete %",
        value: `${surveySubmittedRate}%`,
        icon: icons.clipboardCheck || icons.checkCircle,
        colorScheme: "green",
        subtitle: `${surveySubmittedCount.toLocaleString()} Surveys Submitted`,
      })}
      ${renderKpiCard({
        title: "Happy %",
        value: `${happyRate}%`,
        icon: icons.smile,
        colorScheme: "green",
        subtitle: `${happyCount.toLocaleString()} Delighted Customers`,
      })}
      ${renderKpiCard({
        title: "Neutral %",
        value: `${neutralRate}%`,
        icon: icons.meh,
        colorScheme: "blue",
        subtitle: `${neutralCount.toLocaleString()} Neutral Feedback`,
      })}
      ${renderKpiCard({
        title: "Unhappy %",
        value: `${unhappyRate}%`,
        icon: icons.frown,
        colorScheme: Number(unhappyRate) > 5 ? "red" : "amber",
        subtitle: `${unhappyCount.toLocaleString()} DSAT Escalations`,
      })}
      ${renderKpiCard({
        title: "Average Rating",
        value: `${avgRating} <span style="font-size:1.1rem; color:var(--text-tertiary);">/10</span>`,
        icon: icons.award,
        colorScheme: Number(avgRating) >= 8 ? "green" : "amber",
        subtitle: isBsmUser ? "Regional Customer CSAT" : "National Customer CSAT",
      })}
    `;

    const cciList = data.cci_performance || [];

    // Render Regional Performance Table
    if (regionalTableBody) {
      const regionalMap = {};
      cciList.forEach((c) => {
        const reg = (c.region || "Unassigned").trim();
        if (!regionalMap[reg]) {
          regionalMap[reg] = {
            region: reg,
            cciCount: 0,
            totalClosures: 0,
            completedCalls: 0,
            pendingCalls: 0,
            happyCalls: 0,
            dsatCalls: 0,
            ratingSum: 0,
            ratingCount: 0,
            surveyTracked: 0,
            surveyReceived: 0,
            surveySubmitted: 0,
          };
        }
        const item = regionalMap[reg];
        item.cciCount++;
        const closures = Number(c.total_closures) || 0;
        const completed = Number(c.completed_calls) || 0;
        const pending = Number(c.pending_calls) || 0;
        item.totalClosures += closures;
        item.completedCalls += completed;
        item.pendingCalls += pending;

        const happyRateVal = Number(c.happy_rate) || 0;
        const dsatRateVal = Number(c.dsat_rate) || 0;
        item.happyCalls += Math.round((happyRateVal / 100) * completed);
        item.dsatCalls += Math.round((dsatRateVal / 100) * completed);

        const avgR = Number(c.avg_rating) || 0;
        if (avgR > 0 && completed > 0) {
          item.ratingSum += avgR * completed;
          item.ratingCount += completed;
        }

        const sInfo = surveyByCci[c.cci_code];
        if (sInfo && sInfo.total > 0) {
          item.surveyTracked += sInfo.total;
          item.surveyReceived += sInfo.received;
          item.surveySubmitted += sInfo.submitted;
        }
      });

      const regions = Object.values(regionalMap).sort((a, b) => b.totalClosures - a.totalClosures);

      if (regions.length === 0) {
        regionalTableBody.innerHTML = `
          <tr>
            <td colspan="11" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
              No regional data available matching the filters.
            </td>
          </tr>
        `;
      } else {
        regionalTableBody.innerHTML = regions
          .map((reg) => {
            const compRate = reg.totalClosures > 0 ? Math.round((reg.completedCalls / reg.totalClosures) * 1000) / 10 : 0;
            const happyRateVal = reg.completedCalls > 0 ? Math.round((reg.happyCalls / reg.completedCalls) * 1000) / 10 : 0;
            const dsatRateVal = reg.completedCalls > 0 ? Math.round((reg.dsatCalls / reg.completedCalls) * 1000) / 10 : 0;
            const emailRate = reg.surveyTracked > 0 ? Math.round((reg.surveyReceived / reg.surveyTracked) * 100) : 0;
            const subRate = reg.surveyTracked > 0 ? Math.round((reg.surveySubmitted / reg.surveyTracked) * 100) : 0;
            const avgScore = reg.ratingCount > 0 ? (reg.ratingSum / reg.ratingCount).toFixed(1) : "—";
            const progressColor = compRate >= 90 ? "#10b981" : compRate >= 70 ? "#0072ce" : "#ef4444";

            return `
              <tr>
                <td><strong style="color:var(--text-primary); font-size:0.875rem;">${escapeHtml(reg.region)}</strong></td>
                <td><span class="badge badge-neutral">${reg.cciCount} CCIs</span></td>
                <td><strong>${reg.totalClosures.toLocaleString()}</strong></td>
                <td><span style="color:var(--status-success-dot); font-weight:600;">${reg.completedCalls.toLocaleString()}</span></td>
                <td><span style="color:var(--status-warning-dot); font-weight:600;">${reg.pendingCalls.toLocaleString()}</span></td>
                <td>
                  <div style="display:flex; align-items:center; gap:0.5rem;">
                    <div style="flex:1; min-width:60px; height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden;">
                      <div style="width:${Math.min(compRate, 100)}%; height:100%; background:${progressColor}; border-radius:3px;"></div>
                    </div>
                    <strong style="min-width:40px; font-size:0.8125rem;">${compRate}%</strong>
                  </div>
                </td>
                <td><span style="color:var(--status-success-dot); font-weight:600;">${happyRateVal}%</span></td>
                <td><span style="color:var(--status-danger-dot); font-weight:600;">${dsatRateVal}%</span></td>
                <td>
                  ${reg.surveyTracked > 0 ? `
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span class="badge ${emailRate >= 80 ? 'badge-success' : 'badge-warning'}" style="font-size:0.75rem;">${emailRate}%</span>
                      <span style="font-size:0.75rem; color:var(--text-tertiary);">(${reg.surveyReceived}/${reg.surveyTracked})</span>
                    </div>
                  ` : `<span style="color:var(--text-tertiary); font-size:0.75rem;">—</span>`}
                </td>
                <td>
                  ${reg.surveyTracked > 0 ? `
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span class="badge ${subRate >= 70 ? 'badge-success' : 'badge-danger'}" style="font-size:0.75rem;">${subRate}%</span>
                      <span style="font-size:0.75rem; color:var(--text-tertiary);">(${reg.surveySubmitted}/${reg.surveyTracked})</span>
                    </div>
                  ` : `<span style="color:var(--text-tertiary); font-size:0.75rem;">—</span>`}
                </td>
                <td>${renderRatingBadge(avgScore)}</td>
              </tr>
            `;
          })
          .join("");
      }
    }

    // Render CCI Performance Table
    if (tableBody) {
      if (cciList.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="12" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
              No CCI performance data matching the filters.
            </td>
          </tr>
        `;
      } else {
        tableBody.innerHTML = cciList
          .map((cci, idx) => {
            let rankBadge = `<span style="font-weight:700; color:var(--text-tertiary);">#${idx + 1}</span>`;
            if (idx === 0) rankBadge = `🥇 <strong style="color:#d97706;">1st</strong>`;
            if (idx === 1) rankBadge = `🥈 <strong style="color:#64748b;">2nd</strong>`;
            if (idx === 2) rankBadge = `🥉 <strong style="color:#b45309;">3rd</strong>`;

            const sInfo = surveyByCci[cci.cci_code];

            return `
            <tr>
              <td>${rankBadge}</td>
              <td>
                <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(cci.cci_code)}</div>
                <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(cci.cci_name)}</div>
              </td>
              <td><span class="badge badge-neutral">${escapeHtml(cci.region || "—")}</span></td>
              <td>${escapeHtml(cci.location || "—")}</td>
              <td><strong>${Number(cci.total_closures).toLocaleString()}</strong></td>
              <td><span style="color:var(--status-success-dot); font-weight:600;">${Number(cci.completed_calls).toLocaleString()}</span></td>
              <td><span style="color:var(--status-warning-dot); font-weight:600;">${Number(cci.pending_calls).toLocaleString()}</span></td>
              <td>
                <strong>${cci.completion_rate}%</strong>
              </td>
              <td><span style="color:var(--status-success-dot); font-weight:600;">${cci.happy_rate}%</span></td>
              <td><span style="color:var(--status-danger-dot); font-weight:600;">${cci.dsat_rate}%</span></td>
              <td>
                ${sInfo && sInfo.total > 0 ? `
                  <div style="display:flex; flex-direction:column; gap:2px; font-size:0.75rem;">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                      <span style="color:var(--text-secondary);">Email:</span>
                      <strong style="color:${sInfo.emailRate >= 80 ? '#059669' : '#d97706'}">${sInfo.emailRate}%</strong>
                    </div>
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                      <span style="color:var(--text-secondary);">Sub:</span>
                      <strong style="color:${sInfo.subRate >= 70 ? '#059669' : '#dc2626'}">${sInfo.subRate}%</strong>
                    </div>
                    <span style="font-size:0.68rem; color:var(--text-tertiary);">(${sInfo.submitted}/${sInfo.total})</span>
                  </div>
                ` : `<span style="color:var(--text-tertiary); font-size:0.75rem;">—</span>`}
              </td>
              <td>${renderRatingBadge(cci.avg_rating)}</td>
            </tr>
          `;
          })
          .join("");
      }
    }

    // Render Charts
    renderCciComparisonChart(cciList.slice(0, 10));
    renderAdminFeedbackChart(data.happy_count, data.neutral_count, data.unhappy_count);
    renderAdminTrendChart(data.daily_trend || []);
  } catch (err) {
    console.error("loadAdminMetrics error:", err);
    kpiMount.innerHTML = `
      <div style="grid-column: 1 / -1; padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

function renderCciComparisonChart(cciList) {
  const ctx = document.getElementById("canvas-admin-cci-compare")?.getContext("2d");
  if (!ctx) return;

  if (adminCciCompareChart) adminCciCompareChart.destroy();

  const labels = cciList.map((c) => c.cci_code);
  const completionRates = cciList.map((c) => c.completion_rate);

  adminCciCompareChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Completion Rate (%)",
          data: completionRates,
          backgroundColor: completionRates.map((r) => (r >= 90 ? "#10b981" : r >= 75 ? "#0072ce" : "#f59e0b")),
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        y: { beginAtZero: true, max: 100, grid: { color: "#e2e8f0" } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderAdminFeedbackChart(happy, neutral, unhappy) {
  const ctx = document.getElementById("canvas-admin-feedback")?.getContext("2d");
  if (!ctx) return;

  if (adminFeedbackChart) adminFeedbackChart.destroy();

  const total = happy + neutral + unhappy;

  adminFeedbackChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Happy", "Neutral", "Unhappy"],
      datasets: [
        {
          data: total > 0 ? [happy, neutral, unhappy] : [1, 0, 0],
          backgroundColor: total > 0 ? ["#10b981", "#94a3b8", "#ef4444"] : ["#e2e8f0", "#e2e8f0", "#e2e8f0"],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
      },
      cutout: "68%",
    },
  });
}

function renderAdminTrendChart(trend) {
  const ctx = document.getElementById("canvas-admin-trend")?.getContext("2d");
  if (!ctx) return;

  if (adminTrendChart) adminTrendChart.destroy();

  const labels = trend.map((t) => t.day_label);
  const completed = trend.map((t) => t.completed_count);
  const happy = trend.map((t) => t.happy_count);

  adminTrendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Completed Calls",
          data: completed,
          borderColor: "#0072ce",
          backgroundColor: "rgba(0, 114, 206, 0.08)",
          fill: true,
          tension: 0.35,
        },
        {
          label: "Happy Customers",
          data: happy,
          borderColor: "#10b981",
          backgroundColor: "transparent",
          borderDash: [5, 5],
          tension: 0.35,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top" },
      },
      scales: {
        y: { beginAtZero: true, grid: { color: "#e2e8f0" } },
        x: { grid: { display: false } },
      },
    },
  });
}

export function cleanupAdminDashboard() {
  unsubscribeChannel("admin_dashboard_realtime");
  if (adminTrendChart) adminTrendChart.destroy();
  if (adminFeedbackChart) adminFeedbackChart.destroy();
  if (adminCciCompareChart) adminCciCompareChart.destroy();
}
