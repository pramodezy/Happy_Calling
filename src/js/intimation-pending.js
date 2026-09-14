// ============================================================================
// Motorola Care - Intimation Calling Pending & Open Calls Backlog Controller
// Displays active open calls queue with dynamic Carry-In Time ageing calculation
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin } from "./auth.js";
import { formatMobile, formatDate, formatDateTime, calculateAgeingDays, renderAgeingBadge, escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton, renderSpinner } from "../components/loading.js";
import { renderKpiCard } from "../components/kpi-card.js";

let currentPage = 1;
const PAGE_SIZE = 15;
let searchQuery = "";
let currentAgeingFilter = "OVER_3_DAYS"; // OVER_3_DAYS (default), ALL, 1_TO_3_DAYS, TODAY
let currentEtrFilter = "ALL"; // ALL, PENDING, COMMITTED, NOT_REACHABLE, CALL_BACK

export async function renderIntimationPendingPage(container) {
  currentPage = 1;
  searchQuery = "";
  currentAgeingFilter = "OVER_3_DAYS";
  currentEtrFilter = "ALL";

  container.innerHTML = `
    <!-- Header with Action -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Open Calls &amp; ETR Intimation Backlog</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Tracking active open service orders. Carry-In ageing &gt; 3 days requires mandatory customer ETR intimation.</p>
      </div>

      <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
        <select id="open-calls-ageing-filter" class="form-select" style="padding:6px 12px; font-size:0.8125rem;">
          <option value="OVER_3_DAYS" selected>⚠️ &gt; 3 Days Critical (Action Needed)</option>
          <option value="ALL">All Active Open Calls</option>
          <option value="1_TO_3_DAYS">1 to 3 Days Ageing</option>
          <option value="TODAY">Today (&lt; 24h)</option>
        </select>

        <select id="open-calls-etr-filter" class="form-select" style="padding:6px 12px; font-size:0.8125rem;">
          <option value="ALL">All ETR Statuses</option>
          <option value="PENDING">Pending Intimation</option>
          <option value="COMMITTED">ETR Committed</option>
          <option value="NOT_REACHABLE">⚠️ Not Reachable</option>
          <option value="CALL_BACK">📞 Call Back Requested</option>
        </select>

        <a href="#/intimation/calling" class="btn-primary" style="padding:6px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.phone}</span>
          <span>Start Calling Queue</span>
        </a>
      </div>
    </div>

    <!-- Summary KPI Cards -->
    <div id="intimation-kpi-mount" class="kpi-grid" style="margin-bottom:1.25rem;">
      ${renderSpinner("Calculating open calls and ETR compliance metrics...")}
    </div>

    <!-- Data Table Container -->
    <div id="open-calls-table-container">
      ${renderDataTableWrapper({
        title: "Active Open Service Orders",
        searchPlaceholder: "Search SO, Model, Customer, Station...",
        columns: [
          { label: "Service Order" },
          { label: "Station" },
          { label: "Customer" },
          { label: "Model" },
          { label: "SO Status" },
          { label: "Carry-In & Ageing" },
          { label: "ETR Status" },
          { label: "Action", style: "text-align:right;" },
        ],
        rowsHtml: renderTableSkeleton(8, 8),
        page: currentPage,
        pageSize: PAGE_SIZE,
        totalRecords: 0,
      })}
    </div>
  `;

  // Attach filter listeners
  document.getElementById("open-calls-ageing-filter")?.addEventListener("change", (e) => {
    currentAgeingFilter = e.target.value;
    currentPage = 1;
    loadOpenCallsTable();
  });

  document.getElementById("open-calls-etr-filter")?.addEventListener("change", (e) => {
    currentEtrFilter = e.target.value;
    currentPage = 1;
    loadOpenCallsTable();
  });

  const searchInput = document.getElementById("table-search-input");
  if (searchInput) {
    searchInput.addEventListener(
      "input",
      debounce((e) => {
        searchQuery = e.target.value.trim();
        currentPage = 1;
        loadOpenCallsTable();
      }, 300)
    );
  }

  await loadIntimationKpiMetrics();
  await loadOpenCallsTable();
}

/**
 * Load live KPI metrics for open calls and ETR commitments
 */
async function loadIntimationKpiMetrics() {
  const mount = document.getElementById("intimation-kpi-mount");
  if (!mount) return;

  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    let totalOpen = 0;
    let criticalBacklog = 0;
    let committedCount = 0;
    let pendingCount = 0;

    // 1. Try RPC get_intimation_dashboard
    let rpcSuccess = false;
    try {
      const { data, error } = await supabase.rpc("get_intimation_dashboard", {
        p_cci_code: isAdmin() ? null : profile.cci_code,
      });
      if (!error && data) {
        totalOpen = data.total_open || 0;
        criticalBacklog = data.critical_backlog || 0;
        committedCount = data.intimated_count || 0;
        pendingCount = data.pending_intimation || 0;
        rpcSuccess = true;
      }
    } catch (e) {}

    // 2. Direct Query Fallback
    if (!rpcSuccess) {
      let openQ = supabase.from("open_calls_master").select("id, carry_in_time", { count: "exact" }).eq("is_open", true);
      if (!isAdmin()) openQ = openQ.eq("cci_code", profile.cci_code);
      const { data: openRows, count: openCount } = await openQ;

      totalOpen = openCount || 0;
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      (openRows || []).forEach((r) => {
        if (new Date(r.carry_in_time).getTime() <= threeDaysAgo) {
          criticalBacklog++;
        }
      });

      let intimationQ = supabase.from("intimation_calling").select("service_order", { count: "exact" }).eq("calling_status", "Completed");
      if (!isAdmin()) intimationQ = intimationQ.eq("cci_code", profile.cci_code);
      const { count: cCount } = await intimationQ;
      committedCount = cCount || 0;
      pendingCount = Math.max(0, criticalBacklog - committedCount);
    }

    mount.innerHTML = `
      ${renderKpiCard({
        title: "Active Open Calls",
        value: totalOpen.toLocaleString(),
        icon: icons.database,
        colorScheme: "blue",
        subtitle: "Currently in Service Center",
      })}
      ${renderKpiCard({
        title: "> 3 Days Critical Ageing",
        value: criticalBacklog.toLocaleString(),
        icon: icons.alertTriangle,
        colorScheme: criticalBacklog > 0 ? "red" : "green",
        subtitle: "Mandatory Customer Intimation",
      })}
      ${renderKpiCard({
        title: "ETR Committed",
        value: committedCount.toLocaleString(),
        icon: icons.checkCircle,
        colorScheme: "green",
        subtitle: "Customer Intimated with Date",
      })}
      ${renderKpiCard({
        title: "Pending Intimation",
        value: pendingCount.toLocaleString(),
        icon: icons.clock,
        colorScheme: pendingCount > 0 ? "amber" : "green",
        subtitle: "Action Required by Station",
      })}
    `;
  } catch (err) {
    console.warn("loadIntimationKpiMetrics error:", err);
  }
}

/**
 * Load open calls table with server-side filtering & pagination
 */
export async function loadOpenCallsTable() {
  const tableMount = document.getElementById("open-calls-table-container");
  if (!tableMount) return;

  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    let query = supabase
      .from("open_calls_master")
      .select(
        `
        id,
        service_order,
        station_code,
        cci_code,
        station_name,
        customer_name,
        customer_mobile,
        alternate_mobile,
        model,
        so_status,
        warranty_status,
        parts_status,
        doa_status,
        carry_in_time,
        finish_repair_time
      `,
        { count: "exact" }
      )
      .eq("is_open", true);

    if (!isAdmin()) {
      query = query.eq("cci_code", profile.cci_code);
    }

    if (searchQuery) {
      query = query.or(`service_order.ilike.%${searchQuery}%,model.ilike.%${searchQuery}%,customer_name.ilike.%${searchQuery}%,station_name.ilike.%${searchQuery}%,station_code.ilike.%${searchQuery}%`);
    }

    // Ageing Filter calculation
    const nowMs = Date.now();
    const oneDayAgoIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const threeDaysAgoIso = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString();

    if (currentAgeingFilter === "OVER_3_DAYS") {
      query = query.lte("carry_in_time", threeDaysAgoIso);
    } else if (currentAgeingFilter === "1_TO_3_DAYS") {
      query = query.lte("carry_in_time", oneDayAgoIso).gt("carry_in_time", threeDaysAgoIso);
    } else if (currentAgeingFilter === "TODAY") {
      query = query.gt("carry_in_time", oneDayAgoIso);
    }

    const fromIndex = (currentPage - 1) * PAGE_SIZE;
    const toIndex = fromIndex + PAGE_SIZE - 1;

    const { data: rawCalls, count, error } = await query
      .order("carry_in_time", { ascending: true })
      .range(fromIndex, toIndex);

    if (error) throw error;

    // Fetch ETR status for this batch of service orders
    const soList = (rawCalls || []).map((c) => c.service_order);
    let etrMap = new Map();

    if (soList.length > 0) {
      const { data: intimationRows } = await supabase
        .from("intimation_calling")
        .select("service_order, etr_date, calling_status, cci_comment, customer_comment, created_at")
        .in("service_order", soList)
        .order("created_at", { ascending: false });

      (intimationRows || []).forEach((row) => {
        if (!etrMap.has(row.service_order)) {
          etrMap.set(row.service_order, row);
        }
      });
    }

    let displayCalls = rawCalls || [];

    // Filter by ETR status if selected
    if (currentEtrFilter === "PENDING") {
      displayCalls = displayCalls.filter((c) => !etrMap.has(c.service_order) || etrMap.get(c.service_order).calling_status !== "Completed");
    } else if (currentEtrFilter === "COMMITTED") {
      displayCalls = displayCalls.filter((c) => etrMap.has(c.service_order) && etrMap.get(c.service_order).calling_status === "Completed");
    } else if (currentEtrFilter === "NOT_REACHABLE") {
      displayCalls = displayCalls.filter((c) => etrMap.has(c.service_order) && etrMap.get(c.service_order).calling_status === "Customer Not Reachable");
    } else if (currentEtrFilter === "CALL_BACK") {
      displayCalls = displayCalls.filter((c) => etrMap.has(c.service_order) && etrMap.get(c.service_order).calling_status === "Call Back Required");
    }

    const totalRecords = count || 0;
    let rowsHtml = "";

    if (displayCalls.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="8" style="text-align:center; padding:2.5rem; color:var(--text-tertiary);">
            No open calls found matching your current filter.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = displayCalls
        .map((item) => {
          const days = calculateAgeingDays(item.carry_in_time);
          const isCritical = days >= 3;
          const etrRecord = etrMap.get(item.service_order);

          let etrBadgeHtml = `<span class="badge badge-warning" style="font-size:0.75rem;">Pending Intimation</span>`;
          if (etrRecord) {
            if (etrRecord.calling_status === "Completed") {
              etrBadgeHtml = `
                <div>
                  <span class="badge badge-success" style="font-size:0.75rem; font-weight:700;">
                    ✓ ETR: ${formatDate(etrRecord.etr_date)}
                  </span>
                  <div style="font-size:0.7rem; color:var(--text-tertiary); margin-top:2px;">Logged: ${formatDate(etrRecord.created_at)}</div>
                </div>
              `;
            } else if (etrRecord.calling_status === "Customer Not Reachable") {
              etrBadgeHtml = `
                <div>
                  <span class="badge badge-warning" style="font-size:0.75rem;">⚠️ Not Reachable</span>
                  <div style="font-size:0.7rem; color:var(--text-tertiary); margin-top:2px;">Last: ${formatDate(etrRecord.created_at)}</div>
                </div>
              `;
            } else if (etrRecord.calling_status === "Call Back Required") {
              etrBadgeHtml = `
                <div>
                  <span class="badge badge-info" style="font-size:0.75rem;">📞 Call Back Req.</span>
                  <div style="font-size:0.7rem; color:var(--text-tertiary); margin-top:2px;">Last: ${formatDate(etrRecord.created_at)}</div>
                </div>
              `;
            }
          }

          const ageingBadge = isCritical
            ? `<span class="badge" style="background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; font-weight:700; font-size:0.75rem;">⚠️ ${days} Days (&gt;3d)</span>`
            : `<span class="badge badge-neutral" style="font-size:0.75rem;">${days} Day${days === 1 ? "" : "s"}</span>`;

          return `
          <tr>
            <td>
              <strong style="font-family:monospace; color:var(--moto-blue-accent); font-size:0.875rem;">${escapeHtml(item.service_order)}</strong>
            </td>
            <td>
              <div style="font-weight:600; font-size:0.8125rem;">${escapeHtml(item.station_name || "Station")}</div>
              <div style="font-size:0.7rem; color:var(--text-tertiary); font-family:monospace;">Code: ${escapeHtml(item.station_code || item.cci_code)}</div>
            </td>
            <td>
              <div style="font-weight:600;">${escapeHtml(item.customer_name || "Valued Customer")}</div>
              <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(formatMobile(item.customer_mobile))}</div>
            </td>
            <td>${escapeHtml(item.model || "—")}</td>
            <td>
              <span class="badge badge-neutral" style="font-size:0.75rem;">${escapeHtml(item.so_status || "In Progress")}</span>
            </td>
            <td>
              <div>${formatDate(item.carry_in_time)}</div>
              <div style="margin-top:2px;">${ageingBadge}</div>
            </td>
            <td>${etrBadgeHtml}</td>
            <td style="text-align:right;">
              <a href="#/intimation/calling?so=${encodeURIComponent(item.service_order)}" class="btn-primary" style="padding:4px 10px; font-size:0.75rem; display:inline-flex; align-items:center; gap:4px;">
                <span style="width:14px; height:14px;">${icons.phone}</span>
                <span>Call Customer</span>
              </a>
            </td>
          </tr>
        `;
        })
        .join("");
    }

    tableMount.innerHTML = renderDataTableWrapper({
      title: "Active Open Service Orders",
      searchPlaceholder: "Search SO, Model, Customer, Station...",
      columns: [
        { label: "Service Order" },
        { label: "Station" },
        { label: "Customer" },
        { label: "Model" },
        { label: "SO Status" },
        { label: "Carry-In & Ageing" },
        { label: "ETR Status" },
        { label: "Action", style: "text-align:right;" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    // Pagination listeners
    document.getElementById("btn-prev-page")?.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        loadOpenCallsTable();
      }
    });

    document.getElementById("btn-next-page")?.addEventListener("click", () => {
      const maxPage = Math.ceil(totalRecords / PAGE_SIZE);
      if (currentPage < maxPage) {
        currentPage++;
        loadOpenCallsTable();
      }
    });
  } catch (err) {
    console.error("loadOpenCallsTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error loading open calls queue:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}
