// ============================================================================
// Pending Calls View Controller
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin } from "./auth.js";
import { formatDate, calculateAgeingDays, renderAgeingBadge, formatMobile, escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton } from "../components/loading.js";

let currentPage = 1;
const PAGE_SIZE = 12;
let searchQuery = "";
let currentAgeingFilter = "ALL";

export async function renderPendingPage(container) {
  currentPage = 1;
  searchQuery = "";
  currentAgeingFilter = "ALL";

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Pending Happy Calling List</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Oldest closed repairs sorted first. Server-side paginated.</p>
      </div>

      <div style="display:flex; gap:0.5rem; align-items:center;">
        <select id="pending-ageing-filter" class="form-select" style="padding:6px 12px; font-size:0.8125rem;">
          <option value="ALL">All Ageing Buckets</option>
          <option value="TODAY">Today (0 Days)</option>
          <option value="1DAY">1 Day Ageing</option>
          <option value="2DAYS">2 Days Ageing</option>
          <option value="3PLUS">3+ Days Critical</option>
        </select>
        <a href="#/happy-calling" class="btn-primary" style="padding:6px 14px; font-size:0.8125rem;">
          <span style="width:16px; height:16px;">${icons.phone}</span>
          <span>Start Calling Queue</span>
        </a>
      </div>
    </div>

    <div id="pending-table-container">
      ${renderDataTableWrapper({
        title: "Pending Closures",
        searchPlaceholder: "Search SO, Closure ID, Model...",
        columns: [
          { label: "Closure ID" },
          { label: "SO Number" },
          { label: "Customer" },
          { label: "Model" },
          { label: "Closure Date" },
          { label: "Ageing" },
          { label: "Action", style: "text-align:right;" },
        ],
        rowsHtml: renderTableSkeleton(8, 7),
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

  await loadPendingTable();
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
    // 1. Query closure_master
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
        repair_complete_date
      `,
        { count: "exact" }
      );

    // Apply CCI filter if not Admin
    if (!isAdmin()) {
      query = query.eq("cci_code", profile.cci_code);
    }

    // Apply search filter
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

    // Exclude completed calls via query
    // In PostgreSQL RLS environment, we order oldest first:
    const fromIndex = (currentPage - 1) * PAGE_SIZE;
    const toIndex = fromIndex + PAGE_SIZE - 1;

    const { data: rawClosures, count, error } = await query
      .order("closure_date", { ascending: true })
      .order("created_at", { ascending: true })
      .range(fromIndex, toIndex);

    if (error) throw error;

    // Filter out already completed closures for this batch
    const closureIds = (rawClosures || []).map((c) => c.closure_id);
    let completedSet = new Set();

    if (closureIds.length > 0) {
      const { data: completedList } = await supabase
        .from("happy_calling")
        .select("closure_id")
        .in("closure_id", closureIds)
        .eq("calling_status", "Completed");

      if (completedList) {
        completedSet = new Set(completedList.map((c) => c.closure_id));
      }
    }

    const pendingList = (rawClosures || []).filter((c) => !completedSet.has(c.closure_id));
    const totalRecords = count || 0;

    let rowsHtml = "";
    if (pendingList.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="7" style="text-align:center; padding:2.5rem; color:var(--text-tertiary);">
            No pending closures found matching your current filter.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = pendingList
        .map((item) => {
          const days = calculateAgeingDays(item.closure_date);
          return `
          <tr>
            <td><strong style="font-family:monospace; color:var(--text-primary);">${escapeHtml(item.closure_id)}</strong></td>
            <td><span style="font-family:monospace; color:var(--moto-blue-accent);">${escapeHtml(item.so_number)}</span></td>
            <td>
              <div style="font-weight:600;">${escapeHtml(item.customer_name)}</div>
              <div style="font-size:0.75rem; color:var(--text-tertiary);">${escapeHtml(formatMobile(item.customer_mobile))}</div>
            </td>
            <td>${escapeHtml(item.model || "—")}</td>
            <td>${formatDate(item.closure_date)}</td>
            <td>${renderAgeingBadge(days)}</td>
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
        { label: "Action", style: "text-align:right;" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    // Rebind pagination and search
    attachTableEvents(tableMount, totalRecords);
  } catch (err) {
    console.error("loadPendingTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error loading pending list:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

function attachTableEvents(mount, totalRecords) {
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

  mount.querySelector("#btn-page-prev")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadPendingTable();
    }
  });

  mount.querySelector("#btn-page-next")?.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadPendingTable();
    }
  });

  const searchInput = mount.querySelector("#table-search-input");
  if (searchInput) {
    searchInput.value = searchQuery;
    searchInput.addEventListener(
      "input",
      debounce((e) => {
        searchQuery = e.target.value.trim();
        currentPage = 1;
        loadPendingTable();
      }, 300)
    );
  }
}
