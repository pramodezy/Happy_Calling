// ============================================================================
// Motorola Admin - Intimation Calling Command Center
// Station-wise monitoring, SLA compliance, and open calls management
// ============================================================================

import { supabase } from "./supabase.js";
import { isAdmin, isBSM, getUserAssignedRegions } from "./auth.js";
import { icons, escapeHtml, formatDate, formatDateTime } from "./utils.js";
import { renderSpinner } from "../components/loading.js";
import { showToast } from "../components/toast.js";

let stationStats = [];

export async function renderAdminIntimationPage(container) {
  const isBsmUser = isBSM();
  const assignedRegions = getUserAssignedRegions();
  const title = isBsmUser ? "Regional Intimation Calling Command Center" : "Intimation Calling Administration";
  const subtitle = isBsmUser 
    ? `Monitor station-wise open calls inventory, SLA compliance, and ETR backlog for your assigned regions (${assignedRegions.join(", ") || "All Assigned"}).`
    : "Monitor station-wise open calls inventory, ageing > 3 days SLA breach, and customer ETR intimations.";

  container.innerHTML = `
    <!-- Header -->
    <div style="margin-bottom:1.5rem; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:1rem;">
      <div>
        <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
          <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary); margin:0;">${title}</h2>
          <span class="badge ${isBsmUser ? "badge-warning" : "badge-success"}" style="font-size:0.6875rem; padding:2px 8px;">
            ${isBsmUser ? "BSM REGIONAL SCOPED" : "ENTERPRISE WIDE"}
          </span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin:0;">
          ${subtitle}
        </p>
      </div>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        ${isAdmin() ? `
          <a href="#/intimation/import" class="btn-primary">
            <span>${icons.upload}</span>
            <span>Upload Open Calls File</span>
          </a>
        ` : ""}
        <button id="btn-export-intimation-admin" class="btn-secondary">
          <span>${icons.download}</span>
          <span>Export Station Report</span>
        </button>
      </div>
    </div>

    <!-- Metrics Cards Mount -->
    <div id="admin-intimation-kpi-mount" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:1rem; margin-bottom:1.75rem;">
      ${renderSpinner("Aggregating network-wide open calls...")}
    </div>

    <!-- Filter & Station Performance Card -->
    <div class="call-feedback-form-card" style="margin-bottom:2rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:1rem;">
        <div>
          <h3 style="font-size:1.1rem; font-weight:700;">Station-Wise Open Calls &amp; Intimation Backlog</h3>
          <p style="font-size:0.8rem; color:var(--text-secondary);">Stations with service orders exceeding 3-day turnaround threshold</p>
        </div>
        <div style="display:flex; gap:0.75rem; align-items:center;">
          <input type="text" id="admin-intimation-search" class="form-input" placeholder="Search Station Code or Name..." style="max-width:260px; padding:6px 12px; font-size:0.85rem;">
          <button id="btn-refresh-admin-intimation" class="btn-secondary" style="padding:6px 10px;">
            <span style="width:16px; height:16px;">${icons.refreshCw}</span>
          </button>
        </div>
      </div>

      <div id="admin-intimation-table-mount">
        ${renderSpinner("Loading station statistics...")}
      </div>
    </div>
  `;

  document.getElementById("btn-refresh-admin-intimation")?.addEventListener("click", () => loadStationData());
  document.getElementById("btn-export-intimation-admin")?.addEventListener("click", exportAdminReport);
  document.getElementById("admin-intimation-search")?.addEventListener("input", (e) => filterStationTable(e.target.value));

  await loadStationData();
}

/**
 * Load open calls and intimation records across all CCIs
 */
async function loadStationData() {
  const kpiMount = document.getElementById("admin-intimation-kpi-mount");
  const tableMount = document.getElementById("admin-intimation-table-mount");

  try {
    const nowMs = Date.now();
    const threeDaysAgoIso = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString();

    // Query active open calls
    const { data: openCalls, error: openErr } = await supabase
      .from("open_calls_master")
      .select("service_order, station_code, cci_code, station_name, carry_in_time")
      .eq("is_open", true);

    if (openErr) throw openErr;

    // Query intimation calling logs
    const { data: intimations, error: intimErr } = await supabase
      .from("intimation_calling")
      .select("service_order, cci_code, calling_status");

    if (intimErr) throw intimErr;

    // Build lookup for intimation status
    const completedIntimationSoSet = new Set(
      (intimations || []).filter((i) => i.calling_status === "Completed").map((i) => i.service_order)
    );

    // Group by station
    const stationMap = new Map();
    let totalOpen = 0;
    let totalCriticalOver3d = 0;
    let totalIntimated = 0;

    (openCalls || []).forEach((call) => {
      totalOpen++;
      const carryMs = new Date(call.carry_in_time).getTime();
      const isOver3d = (nowMs - carryMs) > (3 * 24 * 60 * 60 * 1000);
      const isIntimated = completedIntimationSoSet.has(call.service_order);

      if (isOver3d) {
        totalCriticalOver3d++;
      }
      if (isIntimated) {
        totalIntimated++;
      }

      const key = call.cci_code || call.station_code || "Unknown";
      if (!stationMap.has(key)) {
        stationMap.set(key, {
          cci_code: key,
          station_code: call.station_code || key,
          station_name: call.station_name || `Station ${key}`,
          total_open: 0,
          over_3d: 0,
          intimated: 0,
          pending: 0,
        });
      }

      const st = stationMap.get(key);
      st.total_open++;
      if (isOver3d) {
        st.over_3d++;
        if (isIntimated) {
          st.intimated++;
        } else {
          st.pending++;
        }
      }
    });

    stationStats = Array.from(stationMap.values()).sort((a, b) => b.over_3d - a.over_3d);

    const complianceRate = totalCriticalOver3d > 0 ? Math.round((totalIntimated / totalCriticalOver3d) * 100) : 100;

    // Render KPIs
    if (kpiMount) {
      kpiMount.innerHTML = `
        <div class="kpi-card">
          <div class="kpi-label">Total Open Inventory</div>
          <div class="kpi-value" style="color:var(--moto-blue-accent);">${totalOpen.toLocaleString()}</div>
          <div class="kpi-subtext">Calls active across all CCIs</div>
        </div>
        <div class="kpi-card" style="border-left:4px solid #ef4444;">
          <div class="kpi-label">Ageing &gt; 3 Days (Critical)</div>
          <div class="kpi-value" style="color:#ef4444;">${totalCriticalOver3d.toLocaleString()}</div>
          <div class="kpi-subtext">Turnaround SLA breached</div>
        </div>
        <div class="kpi-card" style="border-left:4px solid #10b981;">
          <div class="kpi-label">ETR Intimations Done</div>
          <div class="kpi-value" style="color:#10b981;">${totalIntimated.toLocaleString()}</div>
          <div class="kpi-subtext">ETR communicated to customer</div>
        </div>
        <div class="kpi-card" style="border-left:4px solid #6366f1;">
          <div class="kpi-label">Overall SLA Compliance</div>
          <div class="kpi-value" style="color:#6366f1;">${complianceRate}%</div>
          <div class="kpi-subtext">${stationStats.length} active service stations</div>
        </div>
      `;
    }

    renderStationTableHtml(stationStats);
  } catch (err) {
    console.error("Admin intimation error:", err);
    if (tableMount) {
      tableMount.innerHTML = `
        <div style="padding:1.5rem; background:#fee2e2; border-radius:var(--radius-lg); color:#b91c1c;">
          <strong>Error loading station metrics:</strong> ${escapeHtml(err.message)}
        </div>
      `;
    }
  }
}

/**
 * Render the station breakdown table
 */
function renderStationTableHtml(list) {
  const tableMount = document.getElementById("admin-intimation-table-mount");
  if (!tableMount) return;

  if (!list || list.length === 0) {
    tableMount.innerHTML = `
      <div style="text-align:center; padding:3rem 1rem; color:var(--text-tertiary);">
        No active open calls found.
      </div>
    `;
    return;
  }

  tableMount.innerHTML = `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Station Code</th>
            <th>Station Name</th>
            <th style="text-align:right;">Active Open</th>
            <th style="text-align:right;">Ageing &gt; 3 Days</th>
            <th style="text-align:right;">Intimations Done</th>
            <th style="text-align:right;">Pending Intimations</th>
            <th style="text-align:center;">Compliance %</th>
            <th style="text-align:center;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${list.map((st) => {
            const pct = st.over_3d > 0 ? Math.round((st.intimated / st.over_3d) * 100) : 100;
            const pctColor = pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444";

            return `
              <tr>
                <td style="font-weight:700; color:var(--moto-blue-accent);">${escapeHtml(st.station_code || st.cci_code)}</td>
                <td>
                  <div style="font-weight:600;">${escapeHtml(st.station_name)}</div>
                </td>
                <td style="text-align:right; font-weight:600;">${st.total_open}</td>
                <td style="text-align:right; font-weight:700; color:${st.over_3d > 0 ? '#ef4444' : 'var(--text-secondary)'};">
                  ${st.over_3d}
                </td>
                <td style="text-align:right; font-weight:600; color:#10b981;">${st.intimated}</td>
                <td style="text-align:right; font-weight:700; color:${st.pending > 0 ? '#f59e0b' : 'var(--text-tertiary)'};">
                  ${st.pending}
                </td>
                <td style="text-align:center;">
                  <span class="badge" style="background:${pctColor}18; color:${pctColor}; font-weight:700;">
                    ${pct}%
                  </span>
                </td>
                <td style="text-align:center;">
                  <a href="#/intimation/pending" class="btn-secondary" style="padding:4px 8px; font-size:0.75rem;" title="View Open Calls">
                    <span>View Backlog</span>
                  </a>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Live search filter for station table
 */
function filterStationTable(query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) {
    renderStationTableHtml(stationStats);
    return;
  }
  const filtered = stationStats.filter((st) =>
    (st.station_code || "").toLowerCase().includes(q) ||
    (st.station_name || "").toLowerCase().includes(q) ||
    (st.cci_code || "").toLowerCase().includes(q)
  );
  renderStationTableHtml(filtered);
}

/**
 * Export station report to CSV
 */
function exportAdminReport() {
  if (!stationStats || stationStats.length === 0) {
    showToast("No data available to export.", "warning");
    return;
  }

  const headers = ["Station Code", "Station Name", "Total Open", "Ageing > 3 Days", "Intimations Done", "Pending Intimations", "Compliance Pct"];
  const rows = stationStats.map((st) => {
    const pct = st.over_3d > 0 ? Math.round((st.intimated / st.over_3d) * 100) : 100;
    return [
      `"${st.station_code || st.cci_code}"`,
      `"${(st.station_name || '').replace(/"/g, '""')}"`,
      st.total_open,
      st.over_3d,
      st.intimated,
      st.pending,
      `"${pct}%"`,
    ].join(",");
  });

  const csvContent = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `Motorola_Intimation_Station_Report_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast("Station report exported successfully.", "success");
}
