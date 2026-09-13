// ============================================================================
// Pending Calls View Controller with Calling Attempt Tracking & KPI Summary
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin } from "./auth.js";
import { formatDate, formatDateTime, calculateAgeingDays, renderAgeingBadge, formatMobile, escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton, renderSpinner } from "../components/loading.js";
import { renderKpiCard } from "../components/kpi-card.js";
import { extractWarrantyAndRepair } from "./happy-calling.js";

let currentPage = 1;
const PAGE_SIZE = 12;
let searchQuery = "";
let currentAgeingFilter = "ALL";
let currentAttemptFilter = "ALL"; // ALL, FRESH, ATTEMPTED, NOT_REACHABLE, CALL_BACK

export async function renderPendingPage(container) {
  currentPage = 1;
  searchQuery = "";
  currentAgeingFilter = "ALL";
  currentAttemptFilter = "ALL";

  container.innerHTML = `
    <!-- Header with Action -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Pending Happy Calling Backlog</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Tracking pending customer calls, including uncalled closures and retry attempts.</p>
      </div>

      <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
        <select id="pending-attempt-filter" class="form-select" style="padding:6px 12px; font-size:0.8125rem;">
          <option value="ALL">All Attempt Statuses</option>
          <option value="FRESH">Fresh (Uncalled Only)</option>
          <option value="ATTEMPTED">Any Attempted (Pending Retry)</option>
          <option value="NOT_REACHABLE">⚠️ Customer Not Reachable</option>
          <option value="CALL_BACK">📞 Call Back Required</option>
        </select>

        <select id="pending-ageing-filter" class="form-select" style="padding:6px 12px; font-size:0.8125rem;">
          <option value="ALL">All Ageing Buckets</option>
          <option value="TODAY">Today (0 Days)</option>
          <option value="1DAY">1 Day Ageing</option>
          <option value="2DAYS">2 Days Ageing</option>
          <option value="3PLUS">3+ Days Critical</option>
        </select>

        <a href="#/happy-calling" class="btn-primary" style="padding:6px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.phone}</span>
          <span>Start Calling Queue</span>
        </a>
      </div>
    </div>

    <!-- Summary KPI Cards for Pending Backlog & Attempt Tracking -->
    <div id="pending-kpi-mount" class="kpi-grid" style="margin-bottom:1.25rem;">
      ${renderSpinner("Calculating pending backlog & attempt metrics...")}
    </div>

    <!-- Pending Closures Table Container -->
    <div id="pending-table-container">
      ${renderDataTableWrapper({
        title: "Pending Closures",
        searchPlaceholder: "Search SO, Closure ID, Customer, Model...",
        columns: [
          { label: "Closure ID" },
          { label: "SO Number" },
          { label: "Customer" },
          { label: "Model" },
          { label: "Closure Date" },
          { label: "Ageing" },
          { label: "Calling Attempt Status" },
          { label: "Action", style: "text-align:right;" },
        ],
        rowsHtml: renderTableSkeleton(8, 8),
        page: currentPage,
        pageSize: PAGE_SIZE,
        totalRecords: 0,
      })}
    </div>
  `;

  // Attach Filter Listeners
  document.getElementById("pending-ageing-filter")?.addEventListener("change", (e) => {
    currentAgeingFilter = e.target.value;
    currentPage = 1;
    loadPendingTable();
  });

  document.getElementById("pending-attempt-filter")?.addEventListener("change", (e) => {
    currentAttemptFilter = e.target.value;
    currentPage = 1;
    loadPendingTable();
  });

  const searchInput = document.getElementById("table-search-input");
  if (searchInput) {
    searchInput.addEventListener(
      "input",
      debounce((e) => {
        searchQuery = e.target.value.trim();
        currentPage = 1;
        loadPendingTable();
      }, 300)
    );
  }

  await loadPendingSummaryKpis();
  await loadPendingTable();
}

/**
 * Load summary KPIs for pending closures and attempted calling activities
 */
async function loadPendingSummaryKpis() {
  const kpiMount = document.getElementById("pending-kpi-mount");
  if (!kpiMount) return;

  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    // 1. Get total closures for scope
    let totalClosuresQuery = supabase.from("closure_master").select("id", { count: "exact", head: true });
    if (!isAdmin()) totalClosuresQuery = totalClosuresQuery.eq("cci_code", profile.cci_code);
    const { count: totalClosuresCount } = await totalClosuresQuery;

    // 2. Get completed calls
    let completedQuery = supabase.from("happy_calling").select("id", { count: "exact", head: true }).eq("calling_status", "Completed");
    if (!isAdmin()) completedQuery = completedQuery.eq("cci_code", profile.cci_code);
    const { count: completedCount } = await completedQuery;

    const totalPending = Math.max(0, (totalClosuresCount || 0) - (completedCount || 0));

    // 3. Get non-completed attempts
    let attemptsQuery = supabase.from("happy_calling").select("calling_status");
    if (!isAdmin()) attemptsQuery = attemptsQuery.eq("cci_code", profile.cci_code);
    const { data: attemptRows } = await attemptsQuery.in("calling_status", ["Customer Not Reachable", "Call Back Required"]);

    let notReachableCount = 0;
    let callBackCount = 0;
    (attemptRows || []).forEach((r) => {
      if (r.calling_status === "Customer Not Reachable") notReachableCount++;
      if (r.calling_status === "Call Back Required") callBackCount++;
    });

    const totalAttempted = notReachableCount + callBackCount;
    const freshCount = Math.max(0, totalPending - totalAttempted);

    kpiMount.innerHTML = `
      ${renderKpiCard({
        title: "Total Pending Calls",
        value: totalPending.toLocaleString(),
        icon: icons.clock,
        colorScheme: "blue",
        subtitle: "Awaiting Happy Calling",
      })}
      ${renderKpiCard({
        title: "Fresh (Uncalled)",
        value: freshCount.toLocaleString(),
        icon: icons.checkCircle,
        colorScheme: "green",
        subtitle: "No Attempt Made Yet",
      })}
      ${renderKpiCard({
        title: "Not Reachable",
        value: notReachableCount.toLocaleString(),
        icon: icons.alertTriangle,
        colorScheme: "amber",
        subtitle: "Switched off / Busy / No Reply",
      })}
      ${renderKpiCard({
        title: "Call Back Required",
        value: callBackCount.toLocaleString(),
        icon: icons.phone,
        colorScheme: "purple",
        subtitle: "Customer Requested Later",
      })}
    `;
  } catch (err) {
    console.warn("Could not load pending summary KPIs:", err);
  }
}

/**
 * Fetch pending closures with server-side pagination & filtering
 */
export async function loadPendingTable() {
  const tableMount = document.getElementById("pending-table-container");
  if (!tableMount) return;

  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    let query = supabase
      .from("closure_master")
      .select(
        `
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
        warranty_status,
        repair_type,
        source_data
      `,
        { count: "exact" }
      );

    if (!isAdmin()) {
      query = query.eq("cci_code", profile.cci_code);
    }

    if (searchQuery) {
      query = query.or(`so_number.ilike.%${searchQuery}%,closure_id.ilike.%${searchQuery}%,customer_name.ilike.%${searchQuery}%,model.ilike.%${searchQuery}%`);
    }

    // Ageing filter calculation
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (currentAgeingFilter === "TODAY") {
      const todayISO = today.toISOString();
      query = query.gte("closure_date", todayISO);
    } else if (currentAgeingFilter === "1DAY") {
      const day1Start = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const todayISO = today.toISOString();
      query = query.gte("closure_date", day1Start).lt("closure_date", todayISO);
    } else if (currentAgeingFilter === "2DAYS") {
      const day2Start = new Date(today.getTime() - 48 * 60 * 60 * 1000).toISOString();
      const day1Start = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString();
      query = query.gte("closure_date", day2Start).lt("closure_date", day1Start);
    } else if (currentAgeingFilter === "3PLUS") {
      const day2Start = new Date(today.getTime() - 48 * 60 * 60 * 1000).toISOString();
      query = query.lt("closure_date", day2Start);
    }

    const fromIndex = (currentPage - 1) * PAGE_SIZE;
    const toIndex = fromIndex + PAGE_SIZE - 1;

    const { data: rawClosures, count, error } = await query
      .order("closure_date", { ascending: true })
      .order("created_at", { ascending: true })
      .range(fromIndex, toIndex);

    if (error) throw error;

    // Filter out already completed closures & track attempts
    const closureIds = (rawClosures || []).map((c) => c.closure_id);
    let completedSet = new Set();
    let attemptsMap = new Map();

    if (closureIds.length > 0) {
      const { data: allCallingRecords } = await supabase
        .from("happy_calling")
        .select("closure_id, calling_status, customer_remarks, cci_remarks, created_at, calling_date, calling_time")
        .in("closure_id", closureIds)
        .order("created_at", { ascending: false });

      if (allCallingRecords) {
        allCallingRecords.forEach((rec) => {
          if (rec.calling_status === "Completed") {
            completedSet.add(rec.closure_id);
          } else {
            if (!attemptsMap.has(rec.closure_id)) {
              attemptsMap.set(rec.closure_id, {
                count: 1,
                lastStatus: rec.calling_status,
                lastTime: rec.created_at || `${rec.calling_date} ${rec.calling_time}`,
                lastRemarks: rec.customer_remarks || rec.cci_remarks || "",
              });
            } else {
              const existing = attemptsMap.get(rec.closure_id);
              existing.count += 1;
            }
          }
        });
      }
    }

    let pendingList = (rawClosures || []).filter((c) => !completedSet.has(c.closure_id));

    // Filter by calling attempt status if selected
    if (currentAttemptFilter === "FRESH") {
      pendingList = pendingList.filter((c) => !attemptsMap.has(c.closure_id));
    } else if (currentAttemptFilter === "ATTEMPTED") {
      pendingList = pendingList.filter((c) => attemptsMap.has(c.closure_id));
    } else if (currentAttemptFilter === "NOT_REACHABLE") {
      pendingList = pendingList.filter((c) => attemptsMap.has(c.closure_id) && attemptsMap.get(c.closure_id).lastStatus === "Customer Not Reachable");
    } else if (currentAttemptFilter === "CALL_BACK") {
      pendingList = pendingList.filter((c) => attemptsMap.has(c.closure_id) && attemptsMap.get(c.closure_id).lastStatus === "Call Back Required");
    }

    const totalRecords = count || 0;
    let rowsHtml = "";

    if (pendingList.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="8" style="text-align:center; padding:2.5rem; color:var(--text-tertiary);">
            No pending closures found matching your current filter.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = pendingList
        .map((item) => {
          const days = calculateAgeingDays(item.closure_date);
          const att = attemptsMap.get(item.closure_id);

          let attemptBadgeHtml = `<span class="badge badge-neutral" style="font-size:0.75rem;">Fresh (Uncalled)</span>`;
          if (att) {
            if (att.lastStatus === "Customer Not Reachable") {
              attemptBadgeHtml = `
                <div>
                  <span class="badge badge-warning" style="display:inline-flex; align-items:center; gap:4px; font-size:0.75rem;">
                    <span>⚠️ Not Reachable</span>
                    ${att.count > 1 ? `<strong style="font-size:0.7rem;">(${att.count}x)</strong>` : ""}
                  </span>
                  <div style="font-size:0.7rem; color:var(--text-tertiary); margin-top:2px;">Last: ${formatDateTime(att.lastTime)}</div>
                  ${att.lastRemarks ? `<div style="font-size:0.75rem; color:var(--text-secondary); font-style:italic; max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(att.lastRemarks)}">"${escapeHtml(att.lastRemarks)}"</div>` : ""}
                </div>
              `;
            } else if (att.lastStatus === "Call Back Required") {
              attemptBadgeHtml = `
                <div>
                  <span class="badge badge-info" style="display:inline-flex; align-items:center; gap:4px; font-size:0.75rem;">
                    <span>📞 Call Back Req.</span>
                    ${att.count > 1 ? `<strong style="font-size:0.7rem;">(${att.count}x)</strong>` : ""}
                  </span>
                  <div style="font-size:0.7rem; color:var(--text-tertiary); margin-top:2px;">Last: ${formatDateTime(att.lastTime)}</div>
                  ${att.lastRemarks ? `<div style="font-size:0.75rem; color:var(--text-secondary); font-style:italic; max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(att.lastRemarks)}">"${escapeHtml(att.lastRemarks)}"</div>` : ""}
                </div>
              `;
            }
          }

          const { warrantyStatus, repairType } = extractWarrantyAndRepair(item);
          let warrantyRepairPills = "";
          if (warrantyStatus !== "N/A" || repairType !== "N/A") {
            warrantyRepairPills = `<div style="display:flex; gap:4px; margin-top:3px; flex-wrap:wrap;">`;
            if (warrantyStatus !== "N/A") {
              const isOut = warrantyStatus.toUpperCase().includes("OUT") || warrantyStatus.toUpperCase().includes("OOW");
              warrantyRepairPills += `<span class="badge ${isOut ? "badge-warning" : "badge-success"}" style="font-size:0.65rem; padding:1px 5px;">${escapeHtml(warrantyStatus)}</span>`;
            }
            if (repairType !== "N/A") {
              warrantyRepairPills += `<span class="badge badge-neutral" style="font-size:0.65rem; padding:1px 5px; color:var(--text-secondary);">${escapeHtml(repairType)}</span>`;
            }
            warrantyRepairPills += `</div>`;
          }

          return `
          <tr>
            <td><strong style="font-family:monospace; color:var(--text-primary);">${escapeHtml(item.closure_id)}</strong></td>
            <td>
              <span style="font-family:monospace; color:var(--moto-blue-accent); font-weight:600;">${escapeHtml(item.so_number)}</span>
              ${warrantyRepairPills}
            </td>
            <td>
              <div style="font-weight:600;">${escapeHtml(item.customer_name)}</div>
              <div style="font-size:0.75rem; color:var(--text-tertiary);">${escapeHtml(formatMobile(item.customer_mobile))}</div>
            </td>
            <td>${escapeHtml(item.model || "—")}</td>
            <td>${formatDate(item.closure_date)}</td>
            <td>${renderAgeingBadge(days)}</td>
            <td>${attemptBadgeHtml}</td>
            <td style="text-align:right;">
              <a href="#/happy-calling" class="btn-secondary" style="padding:4px 10px; font-size:0.75rem; display:inline-flex; align-items:center; gap:4px;">
                <span style="width:14px; height:14px;">${icons.phone}</span>
                <span>Call Now</span>
              </a>
            </td>
          </tr>
        `;
        })
        .join("");
    }

    tableMount.innerHTML = renderDataTableWrapper({
      title: "Pending Closures",
      searchPlaceholder: "Search SO, Closure ID, Customer, Model...",
      columns: [
        { label: "Closure ID" },
        { label: "SO Number" },
        { label: "Customer" },
        { label: "Model" },
        { label: "Closure Date" },
        { label: "Ageing" },
        { label: "Calling Attempt Status" },
        { label: "Action", style: "text-align:right;" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    // Reattach Pagination Listeners
    document.getElementById("btn-prev-page")?.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        loadPendingTable();
      }
    });

    document.getElementById("btn-next-page")?.addEventListener("click", () => {
      const maxPage = Math.ceil(totalRecords / PAGE_SIZE);
      if (currentPage < maxPage) {
        currentPage++;
        loadPendingTable();
      }
    });
  } catch (err) {
    console.error("loadPendingTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Failed to load pending queue:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}
