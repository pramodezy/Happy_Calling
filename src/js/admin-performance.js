// ============================================================================
// Admin: CCI Partner Performance & Leaderboard Controller
// Route: #/admin/performance
// ============================================================================

import { supabase, formatSupabaseError, subscribeToTable, unsubscribeChannel } from "./supabase.js";
import { isBSM, getUserAssignedRegions } from "./auth.js";
import { icons, escapeHtml, renderRatingBadge } from "./utils.js";
import { renderKpiCard } from "../components/kpi-card.js";
import { renderSpinner } from "../components/loading.js";
import Chart from "chart.js/auto";

let perfCompareChart = null;
let allCciData = [];
let surveyByCci = {};
let searchQuery = "";
let filterRegion = "";
let filterTier = "ALL";
let sortBy = "completion_rate"; // completion_rate, total_closures, happy_rate, avg_rating, pending_calls, survey_complete
let sortOrder = "desc";

export async function renderAdminPerformancePage(container) {
  searchQuery = "";
  filterRegion = "";
  filterTier = "ALL";
  sortBy = "completion_rate";
  sortOrder = "desc";

  container.innerHTML = `
    <!-- Header with Back Button and Export -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">CCI Partner Performance & Leaderboard</h2>
          <span class="badge badge-info" style="font-size:0.6875rem; padding:2px 8px;">TARGET: 95% SLA</span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Station-by-station rankings, Happy Calling completion rates, customer CSAT, and partner benchmarks.</p>
      </div>

      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <button type="button" id="btn-export-cci-perf-csv" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.download}</span>
          <span>Export Leaderboard CSV</span>
        </button>
        <a href="#/admin" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.dashboard}</span>
          <span>Overview</span>
        </a>
      </div>
    </div>

    <!-- Performance Tier KPI Cards -->
    <div id="perf-kpi-mount" class="kpi-grid">
      ${renderSpinner("Aggregating partner performance metrics...")}
    </div>

    <!-- Chart: CCI Performance Comparison -->
    <div class="chart-card" style="margin-bottom:1.5rem;">
      <div class="chart-card-header" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <div>
          <span class="chart-card-title">Top 12 Service Centers: Completion vs CSAT Benchmark</span>
          <div style="font-size:0.75rem; color:var(--text-tertiary);">Comparison of Completion Rate % (Blue) and Happy Customer % (Green)</div>
        </div>
      </div>
      <div class="chart-container-relative" style="min-height:260px;">
        <canvas id="canvas-perf-compare"></canvas>
      </div>
    </div>

    <!-- Leaderboard & Table Card -->
    <div class="table-card">
      <div class="table-card-header" style="flex-wrap:wrap; gap:0.75rem;">
        <div>
          <h3 class="table-card-title">Partner Performance Rankings</h3>
          <span style="font-size:0.75rem; color:var(--text-tertiary);">Real-time ranking based on completed Happy Calling operations</span>
        </div>

        <!-- Filter and Search Toolbar -->
        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
          <input type="text" id="perf-search-input" placeholder="Search CCI code, name, city..." class="form-input" style="padding:5px 10px; font-size:0.8125rem; width:220px;">
          
          <select id="perf-region-filter" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
            <option value="">${isBSM() ? `All My Regions (${getUserAssignedRegions().join(", ") || "Assigned"})` : "All Regions"}</option>
          </select>

          <select id="perf-tier-filter" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
            <option value="ALL">All Tiers</option>
            <option value="HIGH">High Performers (≥90%)</option>
            <option value="MID">Average Tier (70-89%)</option>
            <option value="LOW">Underperforming (&lt;70%)</option>
          </select>

          <select id="perf-sort-by" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
            <option value="completion_rate">Sort: Completion Rate</option>
            <option value="survey_complete">Sort: Survey Complete %</option>
            <option value="survey_email">Sort: Survey Email %</option>
            <option value="total_closures">Sort: Total Closures</option>
            <option value="happy_rate">Sort: Happy %</option>
            <option value="avg_rating">Sort: Avg Rating</option>
            <option value="pending_calls">Sort: Pending Calls</option>
          </select>
        </div>
      </div>

      <div class="table-responsive-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width:70px;">Rank</th>
              <th>CCI Code & Center Name</th>
              <th>Region</th>
              <th>Location</th>
              <th>Total Closures</th>
              <th>Completed Calls</th>
              <th>Pending Calls</th>
              <th style="min-width:140px;">Completion %</th>
              <th>Happy %</th>
              <th>DSAT %</th>
              <th>Survey (Email / Sub)</th>
              <th>Avg Rating</th>
            </tr>
          </thead>
          <tbody id="perf-table-body">
            <tr><td colspan="12">${renderSpinner("Loading partner rankings...")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Attach event listeners
  document.getElementById("perf-search-input")?.addEventListener("input", (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderFilteredTable();
  });

  document.getElementById("perf-region-filter")?.addEventListener("change", (e) => {
    filterRegion = e.target.value;
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

  document.getElementById("btn-export-cci-perf-csv")?.addEventListener("click", () => {
    exportPerfCsv();
  });

  await loadPerformanceMetrics();

  // Subscribe to real-time changes
  subscribeToTable("admin_perf_realtime", "happy_calling", "*", () => {
    loadPerformanceMetrics();
  });
}

async function loadPerformanceMetrics() {
  const kpiMount = document.getElementById("perf-kpi-mount");
  if (!kpiMount) return;

  try {
    const { data, error } = await supabase.rpc("get_admin_dashboard");
    if (error) throw error;
    if (!data) return;

    const rawCciData = data.cci_performance || [];
    const DEMO_CODES = new Set(["BLR01", "DEL01", "MUM01", "KOC01", "KOL01"]);
    const hasStationCodes = rawCciData.some((c) => !DEMO_CODES.has(c.cci_code));
    allCciData = hasStationCodes ? rawCciData.filter((c) => !DEMO_CODES.has(c.cci_code)) : rawCciData;

    // Calculate Tiers
    const totalStations = allCciData.length;
    const highPerformers = allCciData.filter((c) => Number(c.completion_rate) >= 90).length;
    const midPerformers = allCciData.filter((c) => Number(c.completion_rate) >= 70 && Number(c.completion_rate) < 90).length;
    const lowPerformers = allCciData.filter((c) => Number(c.completion_rate) < 70).length;

    // Fetch survey confirmation metrics across CCIs
    let surveyReceivedRate = 0;
    let surveySubmittedRate = 0;
    let surveyReceivedCount = 0;
    let surveySubmittedCount = 0;
    surveyByCci = {};

    try {
      const { data: sRows, error: sErr } = await supabase
        .from("happy_calling")
        .select("cci_code, survey_email_received, survey_submitted")
        .eq("calling_status", "Completed");

      if (!sErr && sRows && sRows.length > 0) {
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

        // Scope to visible stations (e.g. BSM regions or selected region)
        const currentCciSet = new Set(allCciData.map((c) => c.cci_code));
        const scopedRows = sRows.filter((r) => currentCciSet.has(r.cci_code));
        const tracked = scopedRows.filter((r) => r.survey_email_received !== null && r.survey_email_received !== undefined);
        const totalTracked = tracked.length;
        if (totalTracked > 0) {
          surveyReceivedCount = tracked.filter((r) => r.survey_email_received === "Yes").length;
          surveySubmittedCount = tracked.filter((r) => r.survey_submitted === "Yes").length;
          surveyReceivedRate = Math.round((surveyReceivedCount / totalTracked) * 100);
          surveySubmittedRate = Math.round((surveySubmittedCount / totalTracked) * 100);
        }
      }
    } catch {
      // safe fallback
    }

    kpiMount.innerHTML = `
      ${renderKpiCard({
        title: "Active Stations",
        value: totalStations.toLocaleString(),
        icon: icons.mapPin,
        colorScheme: "blue",
        subtitle: "Motorola Authorized Centers",
      })}
      ${renderKpiCard({
        title: "High Performers (≥90%)",
        value: highPerformers.toLocaleString(),
        icon: icons.award,
        colorScheme: "green",
        subtitle: `${totalStations > 0 ? Math.round((highPerformers / totalStations) * 100) : 0}% Meeting SLA Target`,
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
        title: "Average Tier (70-89%)",
        value: midPerformers.toLocaleString(),
        icon: icons.clock,
        colorScheme: "amber",
        subtitle: "Needs Follow-Up",
      })}
      ${renderKpiCard({
        title: "Critical Tier (<70%)",
        value: lowPerformers.toLocaleString(),
        icon: icons.alertTriangle,
        colorScheme: lowPerformers > 0 ? "red" : "green",
        subtitle: "SLA Risk Stations",
      })}
    `;

    // Dynamically populate Region options from actual station mapping
    const regSelect = document.getElementById("perf-region-filter");
    if (regSelect && regSelect.options.length <= 1) {
      const isBsmUser = isBSM();
      const assignedRegions = getUserAssignedRegions();
      const currentVal = filterRegion;
      regSelect.innerHTML = `<option value="">${isBsmUser ? `All My Regions (${assignedRegions.join(", ") || "Assigned"})` : "All Regions"}</option>`;
      
      let uniqueRegions = [];
      if (isBsmUser && assignedRegions.length > 0) {
        uniqueRegions = [...assignedRegions].sort();
      } else {
        uniqueRegions = Array.from(
          new Set(
            allCciData
              .map((c) => (c.region || "").trim())
              .filter((r) => r.length > 0)
          )
        ).sort();
      }

      uniqueRegions.forEach((reg) => {
        const opt = document.createElement("option");
        opt.value = reg;
        opt.textContent = reg;
        if (reg === currentVal) opt.selected = true;
        regSelect.appendChild(opt);
      });
    }

    renderCompareChart(allCciData.slice(0, 12));
    renderFilteredTable();
  } catch (err) {
    console.error("loadPerformanceMetrics error:", err);
    if (kpiMount) {
      kpiMount.innerHTML = `
        <div style="grid-column: 1 / -1; padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
          <strong>Error:</strong> ${formatSupabaseError(err)}
        </div>
      `;
    }
  }
}

function renderCompareChart(cciList) {
  const ctx = document.getElementById("canvas-perf-compare")?.getContext("2d");
  if (!ctx) return;

  if (perfCompareChart) perfCompareChart.destroy();

  const labels = cciList.map((c) => c.cci_code);
  const completionRates = cciList.map((c) => c.completion_rate);
  const happyRates = cciList.map((c) => c.happy_rate);

  perfCompareChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Completion Rate (%)",
          data: completionRates,
          backgroundColor: "#0072ce",
          borderRadius: 4,
        },
        {
          label: "Happy CSAT (%)",
          data: happyRates,
          backgroundColor: "#10b981",
          borderRadius: 4,
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
        y: {
          beginAtZero: true,
          max: 100,
          ticks: { callback: (v) => `${v}%` },
          grid: { color: "#e2e8f0" },
        },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderFilteredTable() {
  const tbody = document.getElementById("perf-table-body");
  if (!tbody) return;

  let filtered = [...allCciData];

  // Search filter
  if (searchQuery) {
    filtered = filtered.filter(
      (c) =>
        (c.cci_code && c.cci_code.toLowerCase().includes(searchQuery)) ||
        (c.cci_name && c.cci_name.toLowerCase().includes(searchQuery)) ||
        (c.location && c.location.toLowerCase().includes(searchQuery))
    );
  }

  // Region filter
  if (filterRegion) {
    filtered = filtered.filter((c) => c.region === filterRegion);
  }

  // Tier filter
  if (filterTier === "HIGH") {
    filtered = filtered.filter((c) => Number(c.completion_rate) >= 90);
  } else if (filterTier === "MID") {
    filtered = filtered.filter((c) => Number(c.completion_rate) >= 70 && Number(c.completion_rate) < 90);
  } else if (filterTier === "LOW") {
    filtered = filtered.filter((c) => Number(c.completion_rate) < 70);
  }

  // Sorting
  filtered.sort((a, b) => {
    if (sortBy === "survey_complete") {
      const valA = surveyByCci[a.cci_code]?.subRate || 0;
      const valB = surveyByCci[b.cci_code]?.subRate || 0;
      return sortOrder === "desc" ? valB - valA : valA - valB;
    }
    if (sortBy === "survey_email") {
      const valA = surveyByCci[a.cci_code]?.emailRate || 0;
      const valB = surveyByCci[b.cci_code]?.emailRate || 0;
      return sortOrder === "desc" ? valB - valA : valA - valB;
    }
    const valA = Number(a[sortBy]) || 0;
    const valB = Number(b[sortBy]) || 0;
    return sortOrder === "desc" ? valB - valA : valA - valB;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
          No station records match your filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered
    .map((cci, idx) => {
      let rankBadge = `<span style="font-weight:700; color:var(--text-tertiary);">#${idx + 1}</span>`;
      if (idx === 0) rankBadge = `🥇 <strong style="color:#d97706;">1st</strong>`;
      if (idx === 1) rankBadge = `🥈 <strong style="color:#64748b;">2nd</strong>`;
      if (idx === 2) rankBadge = `🥉 <strong style="color:#b45309;">3rd</strong>`;

      const compRate = Number(cci.completion_rate) || 0;
      const progressColor = compRate >= 90 ? "#10b981" : compRate >= 70 ? "#0072ce" : "#ef4444";
      const sInfo = surveyByCci[cci.cci_code];

      return `
        <tr>
          <td>${rankBadge}</td>
          <td>
            <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(cci.cci_code)}</div>
            <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(cci.cci_name || "—")}</div>
          </td>
          <td><span class="badge badge-neutral">${escapeHtml(cci.region || "—")}</span></td>
          <td>${escapeHtml(cci.location || "—")}</td>
          <td><strong>${Number(cci.total_closures).toLocaleString()}</strong></td>
          <td><span style="color:var(--status-success-dot); font-weight:600;">${Number(cci.completed_calls).toLocaleString()}</span></td>
          <td><span style="color:var(--status-warning-dot); font-weight:600;">${Number(cci.pending_calls).toLocaleString()}</span></td>
          <td>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <div style="flex:1; height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden;">
                <div style="width:${Math.min(compRate, 100)}%; height:100%; background:${progressColor}; border-radius:3px;"></div>
              </div>
              <strong style="min-width:40px; font-size:0.8125rem;">${compRate}%</strong>
            </div>
          </td>
          <td><span style="color:var(--status-success-dot); font-weight:600;">${cci.happy_rate}%</span></td>
          <td><span style="color:var(--status-danger-dot); font-weight:600;">${cci.dsat_rate}%</span></td>
          <td>
            ${sInfo && sInfo.total > 0 ? `
              <div style="display:flex; flex-direction:column; gap:2px; font-size:0.75rem;">
                <span>Email: <strong style="color:${sInfo.emailRate >= 80 ? '#059669' : '#d97706'}">${sInfo.emailRate}%</strong></span>
                <span>Sub: <strong style="color:${sInfo.subRate >= 70 ? '#059669' : '#dc2626'}">${sInfo.subRate}%</strong></span>
              </div>
            ` : `<span style="color:var(--text-tertiary); font-size:0.75rem;">—</span>`}
          </td>
          <td>${renderRatingBadge(cci.avg_rating)}</td>
        </tr>
      `;
    })
    .join("");
}

function exportPerfCsv() {
  if (!allCciData || allCciData.length === 0) return;

  const headers = ["Rank", "CCI Code", "CCI Name", "Region", "Location", "Total Closures", "Completed Calls", "Pending Calls", "Completion Rate (%)", "Happy Rate (%)", "DSAT Rate (%)", "Survey Email Rate (%)", "Survey Complete Rate (%)", "Avg Rating"];
  const rows = allCciData.map((c, idx) => {
    const sInfo = surveyByCci[c.cci_code];
    return [
      idx + 1,
      `"${(c.cci_code || "").replace(/"/g, '""')}"`,
      `"${(c.cci_name || "").replace(/"/g, '""')}"`,
      `"${(c.region || "").replace(/"/g, '""')}"`,
      `"${(c.location || "").replace(/"/g, '""')}"`,
      c.total_closures,
      c.completed_calls,
      c.pending_calls,
      c.completion_rate,
      c.happy_rate,
      c.dsat_rate,
      sInfo && sInfo.total > 0 ? `${sInfo.emailRate}%` : "—",
      sInfo && sInfo.total > 0 ? `${sInfo.subRate}%` : "—",
      c.avg_rating,
    ];
  });

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `motorola_cci_performance_${new Date().toISOString().split("T")[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function cleanupAdminPerformance() {
  unsubscribeChannel("admin_perf_realtime");
  if (perfCompareChart) {
    perfCompareChart.destroy();
    perfCompareChart = null;
  }
}
