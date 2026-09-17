// ============================================================================
// Motorola Care - Intimation Calling Pending & Open Calls Backlog Controller
// Displays active open calls queue with dynamic Carry-In Time ageing calculation,
// ETR expiry tracking, and 3-ETA re-intimation alert indicators
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin, hasAdminOrBsmAccess } from "./auth.js";
import { formatMobile, formatDate, formatDateTime, calculateAgeingDays, renderAgeingBadge, escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton, renderSpinner } from "../components/loading.js";
import { renderKpiCard } from "../components/kpi-card.js";

let currentPage = 1;
const PAGE_SIZE = 15;
let searchQuery = "";
let currentAgeingFilter = "OVER_3_DAYS"; // OVER_3_DAYS (default), ALL, 1_TO_3_DAYS, TODAY
let currentEtrFilter = "ALL"; // ALL, RE_INTIMATION_DUE, PENDING, COMMITTED, MAX_ETAS, NOT_REACHABLE, CALL_BACK

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
        <p style="font-size:0.875rem; color:var(--text-secondary);">Tracking active open service orders. Carry-In ageing &gt; 3 days requires mandatory customer ETR intimation (max 3 ETAs).</p>
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
          <option value="RE_INTIMATION_DUE">🚨 Expiring / Expired ETR (Re-Intimation Due)</option>
          <option value="PENDING">Pending Initial ETR</option>
          <option value="COMMITTED">Active ETR Committed</option>
          <option value="MAX_ETAS">🛑 Max 3 ETAs Reached</option>
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
          { label: "ETR Status (Max 3 ETAs)" },
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

    // Direct Supabase Query
    const nowMs = Date.now();
    const threeDaysAgoIso = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString();

    let openQuery = supabase.from("open_calls_master").select("id, service_order, carry_in_time, current_etr_date, eta_count").eq("is_open", true);
    if (!hasAdminOrBsmAccess() && profile.cci_code) {
      openQuery = openQuery.eq("cci_code", profile.cci_code);
    }
    const { data: openRows } = await openQuery;
    const activeCalls = openRows || [];

    totalOpen = activeCalls.length;
    criticalBacklog = activeCalls.filter((c) => new Date(c.carry_in_time).getTime() <= (nowMs - 3 * 24 * 60 * 60 * 1000)).length;

    // Count calls with active committed ETR vs expiring ETR
    const todayStr = new Date().toISOString().split("T")[0];
    const tomorrowStr = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    
    let expiringEtrCount = 0;
    activeCalls.forEach((c) => {
      if (c.current_etr_date && (c.current_etr_date <= tomorrowStr) && (c.eta_count < 3)) {
        expiringEtrCount++;
      }
      if (c.current_etr_date) {
        committedCount++;
      }
    });

    pendingCount = Math.max(0, criticalBacklog - committedCount);

    mount.innerHTML = `
      ${renderKpiCard({
        title: "Active Open Inventory",
        value: totalOpen.toLocaleString(),
        subtitle: "Total open service orders",
        icon: icons.database,
      })}
      ${renderKpiCard({
        title: "Ageing > 3 Days",
        value: criticalBacklog.toLocaleString(),
        subtitle: "Turnaround SLA breached",
        badge: criticalBacklog > 0 ? "Action Req." : "Good",
        badgeType: criticalBacklog > 0 ? "danger" : "success",
        icon: icons.clock,
      })}
      ${renderKpiCard({
        title: "ETR Expiring / Overdue",
        value: expiringEtrCount.toLocaleString(),
        subtitle: "Re-Intimation needed (ETA 2 or 3)",
        badge: expiringEtrCount > 0 ? "Alert" : "Clear",
        badgeType: expiringEtrCount > 0 ? "warning" : "success",
        icon: icons.alertTriangle,
      })}
      ${renderKpiCard({
        title: "Pending Intimations",
        value: pendingCount.toLocaleString(),
        subtitle: "Calls waiting for initial ETR",
        badge: pendingCount > 0 ? "Pending" : "Cleared",
        badgeType: pendingCount > 0 ? "info" : "neutral",
        icon: icons.phone,
      })}
    `;
  } catch (err) {
    console.warn("Intimation KPI error:", err);
  }
}

/**
 * Load open calls table with server-side filtering & pagination
 */
async function loadOpenCallsTable() {
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
        finish_repair_time,
        current_etr_date,
        eta_count,
        etr_status
      `,
        { count: "exact" }
      )
      .eq("is_open", true);

    if (!hasAdminOrBsmAccess() && profile.cci_code) {
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

    // Fetch latest intimation status & attempt counts for this batch
    const soList = (rawCalls || []).map((c) => c.service_order);
    let etrMap = new Map();

    if (soList.length > 0) {
      const { data: intimationRows } = await supabase
        .from("intimation_calling")
        .select("service_order, etr_date, calling_status, cci_comment, customer_comment, eta_number, created_at")
        .in("service_order", soList)
        .order("created_at", { ascending: false });

      (intimationRows || []).forEach((row) => {
        if (!etrMap.has(row.service_order)) {
          etrMap.set(row.service_order, row);
        }
      });
    }

    const todayStr = new Date().toISOString().split("T")[0];
    const tomorrowStr = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    let displayCalls = (rawCalls || []).map((item) => {
      const etrRecord = etrMap.get(item.service_order);
      const committedEtr = item.current_etr_date || (etrRecord?.calling_status === "Completed" ? etrRecord.etr_date : null);
      const etaCount = item.eta_count || (etrRecord?.eta_number || (committedEtr ? 1 : 0));

      let isExpired = false;
      let isExpiringSoon = false;
      let isMaxEtas = etaCount >= 3;

      if (committedEtr) {
        isExpired = committedEtr < todayStr;
        isExpiringSoon = committedEtr <= tomorrowStr && !isExpired;
      }

      return {
        ...item,
        etrRecord,
        committedEtr,
        etaCount,
        isExpired,
        isExpiringSoon,
        isMaxEtas,
        isReintimationDue: (isExpired || isExpiringSoon) && !isMaxEtas,
      };
    });

    // Client-side Filter by ETR status if selected
    if (currentEtrFilter === "RE_INTIMATION_DUE") {
      displayCalls = displayCalls.filter((c) => c.isReintimationDue);
    } else if (currentEtrFilter === "PENDING") {
      displayCalls = displayCalls.filter((c) => !c.committedEtr && (!c.etrRecord || c.etrRecord.calling_status !== "Completed"));
    } else if (currentEtrFilter === "COMMITTED") {
      displayCalls = displayCalls.filter((c) => c.committedEtr && !c.isExpired && !c.isExpiringSoon && !c.isMaxEtas);
    } else if (currentEtrFilter === "MAX_ETAS") {
      displayCalls = displayCalls.filter((c) => c.isMaxEtas);
    } else if (currentEtrFilter === "NOT_REACHABLE") {
      displayCalls = displayCalls.filter((c) => c.etrRecord && c.etrRecord.calling_status === "Customer Not Reachable");
    } else if (currentEtrFilter === "CALL_BACK") {
      displayCalls = displayCalls.filter((c) => c.etrRecord && c.etrRecord.calling_status === "Call Back Required");
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

          let etrBadgeHtml = `<span class="badge badge-warning" style="font-size:0.75rem;">Pending Initial ETR</span>`;

          if (item.isMaxEtas) {
            etrBadgeHtml = `
              <div>
                <span class="badge" style="background:#fee2e2; color:#991b1b; border:1px solid #f87171; font-size:0.75rem; font-weight:800;">
                  🛑 ETA #3 (Max Limit Reached)
                </span>
                <div style="font-size:0.7rem; color:#b91c1c; margin-top:2px; font-weight:600;">Committed: ${formatDate(item.committedEtr)} &bull; Escalate</div>
              </div>
            `;
          } else if (item.isExpired) {
            etrBadgeHtml = `
              <div>
                <span class="badge" style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-size:0.75rem; font-weight:700;">
                  🔴 ETA #${item.etaCount || 1} Expired (${formatDate(item.committedEtr)})
                </span>
                <div style="font-size:0.7rem; color:#dc2626; margin-top:2px; font-weight:600;">Re-Intimation Needed &rarr; ETA #${(item.etaCount || 1) + 1}</div>
              </div>
            `;
          } else if (item.isExpiringSoon) {
            etrBadgeHtml = `
              <div>
                <span class="badge" style="background:#fef3c7; color:#92400e; border:1px solid #fcd34d; font-size:0.75rem; font-weight:700;">
                  🟡 ETA #${item.etaCount || 1} Expiring (${formatDate(item.committedEtr)})
                </span>
                <div style="font-size:0.7rem; color:#b45309; margin-top:2px; font-weight:600;">Call Today &bull; Provide ETA #${(item.etaCount || 1) + 1}</div>
              </div>
            `;
          } else if (item.committedEtr) {
            etrBadgeHtml = `
              <div>
                <span class="badge badge-success" style="font-size:0.75rem; font-weight:700;">
                  🟢 ETA #${item.etaCount || 1}: ${formatDate(item.committedEtr)}
                </span>
                <div style="font-size:0.7rem; color:var(--text-tertiary); margin-top:2px;">Active &bull; Within Window</div>
              </div>
            `;
          } else if (item.etrRecord?.calling_status === "Customer Not Reachable") {
            etrBadgeHtml = `
              <div>
                <span class="badge badge-warning" style="font-size:0.75rem;">⚠️ Not Reachable</span>
                <div style="font-size:0.7rem; color:var(--text-tertiary); margin-top:2px;">Last: ${formatDate(item.etrRecord.created_at)}</div>
              </div>
            `;
          } else if (item.etrRecord?.calling_status === "Call Back Required") {
            etrBadgeHtml = `
              <div>
                <span class="badge badge-info" style="font-size:0.75rem;">📞 Call Back Req.</span>
                <div style="font-size:0.7rem; color:var(--text-tertiary); margin-top:2px;">Last: ${formatDate(item.etrRecord.created_at)}</div>
              </div>
            `;
          }

          const ageingBadge = isCritical
            ? `<span class="badge" style="background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; font-weight:700; font-size:0.75rem;">⚠️ ${days} Days (&gt;3d)</span>`
            : `<span class="badge badge-neutral" style="font-size:0.75rem;">${days} Day${days === 1 ? "" : "s"}</span>`;

          const actionLabel = item.isMaxEtas
            ? "View / Escalate"
            : item.isReintimationDue
            ? `Re-Intimate (ETA #${(item.etaCount || 1) + 1})`
            : item.committedEtr
            ? "Update ETR"
            : "Call Customer";

          const actionBtnClass = item.isReintimationDue ? "btn-primary" : "btn-secondary";

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
              <a href="#/intimation/calling?so=${encodeURIComponent(item.service_order)}" class="${actionBtnClass}" style="padding:4px 10px; font-size:0.75rem; display:inline-flex; align-items:center; gap:4px; ${item.isReintimationDue ? 'background:#ef4444; border-color:#dc2626; color:#fff;' : ''}">
                <span style="width:14px; height:14px;">${icons.phone}</span>
                <span>${actionLabel}</span>
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
        { label: "ETR Status (Max 3 ETAs)" },
        { label: "Action", style: "text-align:right;" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    // Re-bind search input with existing search query and autofocus if user was searching
    const searchInput = document.getElementById("table-search-input");
    if (searchInput) {
      searchInput.value = searchQuery;
      searchInput.addEventListener(
        "input",
        debounce((e) => {
          searchQuery = e.target.value.trim();
          currentPage = 1;
          loadOpenCallsTable();
        }, 300)
      );
    }

    // FIX: Match IDs with table.js ('btn-page-prev' and 'btn-page-next')
    const prevBtn = document.getElementById("btn-page-prev");
    const nextBtn = document.getElementById("btn-page-next");

    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (currentPage > 1) {
          currentPage--;
          loadOpenCallsTable();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        const maxPage = Math.ceil(totalRecords / PAGE_SIZE);
        if (currentPage < maxPage) {
          currentPage++;
          loadOpenCallsTable();
        }
      });
    }
  } catch (err) {
    console.error("loadOpenCallsTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error loading open calls queue:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}
