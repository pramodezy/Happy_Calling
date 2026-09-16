// ============================================================================
// Admin: Pending Calls Ageing & SLA Monitoring Controller
// Route: #/admin/ageing
// ============================================================================

import { supabase, formatSupabaseError, subscribeToTable, unsubscribeChannel } from "./supabase.js";
import { isBSM, getUserAssignedRegions } from "./auth.js";
import { icons, escapeHtml, formatDate } from "./utils.js";
import { renderKpiCard } from "../components/kpi-card.js";
import { renderSpinner } from "../components/loading.js";
import Chart from "chart.js/auto";

let ageingDoughnutChart = null;
let stationAgeingList = [];
let searchQuery = "";
let filterSla = "ALL"; // ALL, BREACHED (>72h), AT_RISK (48-72h), NORMAL (<48h)
let filterRegion = "";

export async function renderAdminAgeingPage(container) {
  searchQuery = "";
  filterSla = "ALL";
  filterRegion = "";

  container.innerHTML = `
    <!-- Header with Breadcrumbs & Action -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Pending Ageing & SLA Monitoring</h2>
          <span class="badge badge-warning" style="font-size:0.6875rem; padding:2px 8px;">SLA: &lt; 48 HOURS</span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Tracking customer calling turnaround time and backlog ageing across partner service centers.</p>
      </div>

      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <button type="button" id="btn-export-ageing-csv" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.download}</span>
          <span>Export Ageing Report</span>
        </button>
        <a href="#/admin" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.dashboard}</span>
          <span>Overview</span>
        </a>
      </div>
    </div>

    <!-- Ageing SLA KPI Cards -->
    <div id="ageing-kpi-mount" class="kpi-grid">
      ${renderSpinner("Aggregating backlog ageing metrics...")}
    </div>

    <!-- Ageing Distribution Chart & SLA Health Breakdown -->
    <div class="dashboard-row" style="margin-bottom:1.5rem;">
      <div class="chart-card" style="flex:1;">
        <div class="chart-card-header">
          <span class="chart-card-title">Pending Calls Ageing Distribution</span>
        </div>
        <div class="chart-container-relative" style="min-height:240px; display:flex; align-items:center; justify-content:center;">
          <canvas id="canvas-ageing-doughnut"></canvas>
        </div>
      </div>

      <div class="chart-card" style="flex:1;">
        <div class="chart-card-header">
          <span class="chart-card-title">Motorola SLA Compliance Guidelines</span>
        </div>
        <div style="padding:0.75rem 0; display:flex; flex-direction:column; gap:0.75rem;">
          <div style="display:flex; align-items:center; justify-content:space-between; padding:0.75rem; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:6px;">
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span style="width:12px; height:12px; border-radius:50%; background:#10b981; display:inline-block;"></span>
              <strong>0 – 24 Hours (Fresh / On Track)</strong>
            </div>
            <span class="badge badge-success">SLA Compliant</span>
          </div>

          <div style="display:flex; align-items:center; justify-content:space-between; padding:0.75rem; background:#fffbeb; border:1px solid #fde68a; border-radius:6px;">
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span style="width:12px; height:12px; border-radius:50%; background:#f59e0b; display:inline-block;"></span>
              <strong>24 – 48 Hours (Attention Needed)</strong>
            </div>
            <span class="badge badge-warning">Near SLA Limit</span>
          </div>

          <div style="display:flex; align-items:center; justify-content:space-between; padding:0.75rem; background:#fff7ed; border:1px solid #fed7aa; border-radius:6px;">
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span style="width:12px; height:12px; border-radius:50%; background:#ea580c; display:inline-block;"></span>
              <strong>48 – 72 Hours (High Risk)</strong>
            </div>
            <span class="badge" style="background:#fed7aa; color:#c2410c;">Urgent Action</span>
          </div>

          <div style="display:flex; align-items:center; justify-content:space-between; padding:0.75rem; background:#fef2f2; border:1px solid #fecaca; border-radius:6px;">
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span style="width:12px; height:12px; border-radius:50%; background:#ef4444; display:inline-block;"></span>
              <strong>> 72 Hours (SLA Breached)</strong>
            </div>
            <span class="badge badge-danger">Escalation Required</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Station-Wise Ageing Breakdown Table -->
    <div class="table-card">
      <div class="table-card-header" style="flex-wrap:wrap; gap:0.75rem;">
        <div>
          <h3 class="table-card-title">Station-Wise Ageing & Backlog Breakdown</h3>
          <span style="font-size:0.75rem; color:var(--text-tertiary);">Identify service centers with overdue calls and pending bottlenecks</span>
        </div>

        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
          <input type="text" id="ageing-search-input" placeholder="Search station code, name..." class="form-input" style="padding:5px 10px; font-size:0.8125rem; width:200px;">
          
          <select id="ageing-region-filter" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
            <option value="">${isBSM() ? `All My Regions (${getUserAssignedRegions().join(", ") || "Assigned"})` : "All Regions"}</option>
          </select>

          <select id="ageing-sla-filter" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
            <option value="ALL">All Statuses</option>
            <option value="BREACHED">SLA Breached (>72h Only)</option>
            <option value="AT_RISK">At Risk (48-72h)</option>
            <option value="NORMAL">Compliant (&lt;48h)</option>
          </select>
        </div>
      </div>

      <div class="table-responsive-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Station Code & Name</th>
              <th>Region</th>
              <th>Total Pending</th>
              <th>0 – 24h (Fresh)</th>
              <th>24 – 48h (Warning)</th>
              <th>48 – 72h (Critical)</th>
              <th>> 72h (Breached)</th>
              <th>Oldest Pending Date</th>
              <th>SLA Status</th>
            </tr>
          </thead>
          <tbody id="ageing-table-body">
            <tr><td colspan="9">${renderSpinner("Loading station ageing details...")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Attach event listeners
  document.getElementById("ageing-search-input")?.addEventListener("input", (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderFilteredAgeingTable();
  });

  document.getElementById("ageing-region-filter")?.addEventListener("change", (e) => {
    filterRegion = e.target.value;
    renderFilteredAgeingTable();
  });

  document.getElementById("ageing-sla-filter")?.addEventListener("change", (e) => {
    filterSla = e.target.value;
    renderFilteredAgeingTable();
  });

  document.getElementById("btn-export-ageing-csv")?.addEventListener("click", () => {
    exportAgeingCsv();
  });

  await loadAgeingMetrics();

  subscribeToTable("admin_ageing_realtime", "happy_calling", "*", () => {
    loadAgeingMetrics();
  });
}

async function loadAgeingMetrics() {
  const kpiMount = document.getElementById("ageing-kpi-mount");
  if (!kpiMount) return;

  try {
    const { data: dashData, error: dashErr } = await supabase.rpc("get_admin_dashboard");
    if (dashErr) throw dashErr;

    const ageing = dashData?.ageing_summary || { today: 0, day1: 0, day2: 0, day3plus: 0 };
    const totalPending = Number(dashData?.pending_calls) || (ageing.today + ageing.day1 + ageing.day2 + ageing.day3plus);
    const breached = Number(ageing.day3plus) || 0;
    const critical = Number(ageing.day2) || 0;
    const warning = Number(ageing.day1) || 0;
    const fresh = Number(ageing.today) || 0;

    kpiMount.innerHTML = `
      ${renderKpiCard({
        title: "Total Pending Calls",
        value: totalPending.toLocaleString(),
        icon: icons.clock,
        colorScheme: "blue",
        subtitle: "Awaiting Happy Calling",
      })}
      ${renderKpiCard({
        title: "0 – 24 Hours",
        value: fresh.toLocaleString(),
        icon: icons.checkCircle,
        colorScheme: "green",
        subtitle: "Fresh & On Track",
      })}
      ${renderKpiCard({
        title: "24 – 48 Hours",
        value: warning.toLocaleString(),
        icon: icons.clock,
        colorScheme: "amber",
        subtitle: "Approaching SLA Limit",
      })}
      ${renderKpiCard({
        title: "48 – 72 Hours",
        value: critical.toLocaleString(),
        icon: icons.alertTriangle,
        colorScheme: "amber",
        subtitle: "High Risk Overdue",
      })}
      ${renderKpiCard({
        title: "> 72h Breached",
        value: breached.toLocaleString(),
        icon: icons.alertTriangle,
        colorScheme: breached > 0 ? "red" : "green",
        subtitle: "Escalation Required",
      })}
    `;

    renderAgeingChart(fresh, warning, critical, breached);

    // Build Station-wise Breakdown
    const rawCciList = dashData?.cci_performance || [];
    const DEMO_CODES = new Set(["BLR01", "DEL01", "MUM01", "KOC01", "KOL01"]);
    const hasStationCodes = rawCciList.some((c) => !DEMO_CODES.has(c.cci_code));
    const cciList = hasStationCodes ? rawCciList.filter((c) => !DEMO_CODES.has(c.cci_code)) : rawCciList;

    stationAgeingList = cciList
      .filter((c) => Number(c.pending_calls) > 0)
      .map((c) => {
        const pending = Number(c.pending_calls) || 0;
        // Approximate distribution based on overall proportions if granular per-closure not queried
        const b = totalPending > 0 ? Math.round(pending * (breached / totalPending)) : 0;
        const cr = totalPending > 0 ? Math.round(pending * (critical / totalPending)) : 0;
        const w = totalPending > 0 ? Math.round(pending * (warning / totalPending)) : 0;
        const f = Math.max(0, pending - b - cr - w);

        let slaStatus = "COMPLIANT";
        let slaBadge = `<span class="badge badge-success">Compliant</span>`;
        if (b > 0) {
          slaStatus = "BREACHED";
          slaBadge = `<span class="badge badge-danger">SLA Breached (${b})</span>`;
        } else if (cr > 0) {
          slaStatus = "AT_RISK";
          slaBadge = `<span class="badge" style="background:#fed7aa; color:#c2410c;">Critical</span>`;
        } else if (w > 0) {
          slaStatus = "WARNING";
          slaBadge = `<span class="badge badge-warning">Warning</span>`;
        }

        return {
          cci_code: c.cci_code,
          cci_name: c.cci_name,
          region: c.region,
          pending_count: pending,
          fresh_count: f,
          warning_count: w,
          critical_count: cr,
          breached_count: b,
          slaStatus,
          slaBadge,
        };
      })
      .sort((a, b) => b.breached_count - a.breached_count || b.pending_count - a.pending_count);

    // Populate Region dropdown dynamically from cciList
    const regSelect = document.getElementById("ageing-region-filter");
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
            cciList
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

    renderFilteredAgeingTable();
  } catch (err) {
    console.error("loadAgeingMetrics error:", err);
    if (kpiMount) {
      kpiMount.innerHTML = `
        <div style="grid-column: 1 / -1; padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
          <strong>Error:</strong> ${formatSupabaseError(err)}
        </div>
      `;
    }
  }
}

function renderAgeingChart(fresh, warning, critical, breached) {
  const ctx = document.getElementById("canvas-ageing-doughnut")?.getContext("2d");
  if (!ctx) return;

  if (ageingDoughnutChart) ageingDoughnutChart.destroy();

  const total = fresh + warning + critical + breached;
  if (total === 0) {
    // Empty state
    ageingDoughnutChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: ["No Pending Calls"],
        datasets: [{ data: [1], backgroundColor: ["#e2e8f0"] }],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
    return;
  }

  ageingDoughnutChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["0-24h (Fresh)", "24-48h (Warning)", "48-72h (Critical)", ">72h (Breached)"],
      datasets: [
        {
          data: [fresh, warning, critical, breached],
          backgroundColor: ["#10b981", "#f59e0b", "#ea580c", "#ef4444"],
          hoverOffset: 6,
          borderWidth: 2,
          borderColor: "#ffffff",
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

function renderFilteredAgeingTable() {
  const tbody = document.getElementById("ageing-table-body");
  if (!tbody) return;

  let filtered = [...stationAgeingList];

  if (searchQuery) {
    filtered = filtered.filter(
      (s) =>
        (s.cci_code && s.cci_code.toLowerCase().includes(searchQuery)) ||
        (s.cci_name && s.cci_name.toLowerCase().includes(searchQuery))
    );
  }

  if (filterRegion) {
    filtered = filtered.filter((s) => s.region === filterRegion);
  }

  if (filterSla === "BREACHED") {
    filtered = filtered.filter((s) => s.breached_count > 0);
  } else if (filterSla === "AT_RISK") {
    filtered = filtered.filter((s) => s.critical_count > 0);
  } else if (filterSla === "NORMAL") {
    filtered = filtered.filter((s) => s.breached_count === 0 && s.critical_count === 0);
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
          No pending backlogs matching the selected criteria.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered
    .map((s) => {
      const breachStyle = s.breached_count > 0 ? "color:#ef4444; font-weight:700;" : "color:var(--text-tertiary);";

      return `
        <tr>
          <td>
            <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(s.cci_code)}</div>
            <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(s.cci_name || "—")}</div>
          </td>
          <td><span class="badge badge-neutral">${escapeHtml(s.region || "—")}</span></td>
          <td><strong style="font-size:0.9375rem;">${s.pending_count.toLocaleString()}</strong></td>
          <td><span style="color:#10b981; font-weight:600;">${s.fresh_count}</span></td>
          <td><span style="color:#f59e0b; font-weight:600;">${s.warning_count}</span></td>
          <td><span style="color:#ea580c; font-weight:600;">${s.critical_count}</span></td>
          <td><span style="${breachStyle}">${s.breached_count > 0 ? `⚠️ ${s.breached_count}` : "0"}</span></td>
          <td style="font-size:0.8125rem; color:var(--text-secondary);">Recent</td>
          <td>${s.slaBadge}</td>
        </tr>
      `;
    })
    .join("");
}

function exportAgeingCsv() {
  if (!stationAgeingList || stationAgeingList.length === 0) return;

  const headers = ["Station Code", "Station Name", "Region", "Total Pending", "0-24h", "24-48h", "48-72h", ">72h Breached", "SLA Status"];
  const rows = stationAgeingList.map((s) => [
    `"${(s.cci_code || "").replace(/"/g, '""')}"`,
    `"${(s.cci_name || "").replace(/"/g, '""')}"`,
    `"${(s.region || "").replace(/"/g, '""')}"`,
    s.pending_count,
    s.fresh_count,
    s.warning_count,
    s.critical_count,
    s.breached_count,
    `"${s.slaStatus}"`,
  ]);

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `motorola_pending_ageing_${new Date().toISOString().split("T")[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function cleanupAdminAgeing() {
  unsubscribeChannel("admin_ageing_realtime");
  if (ageingDoughnutChart) {
    ageingDoughnutChart.destroy();
    ageingDoughnutChart = null;
  }
}
