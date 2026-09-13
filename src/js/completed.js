// ============================================================================
// Completed Calls View Controller
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile, isAdmin } from "./auth.js";
import { formatDateTime, renderStatusBadge, renderFeedbackBadge, renderRatingBadge, escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton } from "../components/loading.js";

let currentPage = 1;
const PAGE_SIZE = 12;
let searchQuery = "";
let statusFilter = "ALL";
let feedbackFilter = "ALL";

export async function renderCompletedPage(container) {
  currentPage = 1;
  searchQuery = "";
  statusFilter = "ALL";
  feedbackFilter = "ALL";

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Completed Happy Calling History</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Logged customer feedback records. Real-time synced with Supabase.</p>
      </div>

      <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
        <select id="completed-status-filter" class="form-select" style="padding:6px 12px; font-size:0.8125rem;">
          <option value="ALL">All Calling Statuses</option>
          <option value="Completed">Completed</option>
          <option value="Customer Not Reachable">Customer Not Reachable</option>
          <option value="Call Back Required">Call Back Required</option>
        </select>

        <select id="completed-feedback-filter" class="form-select" style="padding:6px 12px; font-size:0.8125rem;">
          <option value="ALL">All Feedback Categories</option>
          <option value="Happy">Happy</option>
          <option value="Neutral">Neutral</option>
          <option value="Unhappy">Unhappy</option>
        </select>

        <button type="button" id="btn-export-completed-csv" class="btn-secondary" style="padding:6px 12px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.download}</span>
          <span>Export CSV</span>
        </button>
      </div>
    </div>

    <div id="completed-table-container">
      ${renderDataTableWrapper({
        title: "Call Records",
        searchPlaceholder: "Search SO, Closure ID...",
        columns: [
          { label: "Closure ID" },
          { label: "SO Number" },
          { label: "Call Date & Time" },
          { label: "Status" },
          { label: "Rating" },
          { label: "Feedback" },
          { label: "Customer Remarks" },
        ],
        rowsHtml: renderTableSkeleton(8, 7),
        page: currentPage,
        pageSize: PAGE_SIZE,
        totalRecords: 0,
      })}
    </div>
  `;

  document.getElementById("completed-status-filter")?.addEventListener("change", (e) => {
    statusFilter = e.target.value;
    currentPage = 1;
    loadCompletedTable();
  });

  document.getElementById("completed-feedback-filter")?.addEventListener("change", (e) => {
    feedbackFilter = e.target.value;
    currentPage = 1;
    loadCompletedTable();
  });

  document.getElementById("btn-export-completed-csv")?.addEventListener("click", exportCompletedCallsToCSV);

  await loadCompletedTable();
}

/**
 * Fetch Completed calls from happy_calling table
 */
export async function loadCompletedTable() {
  const tableMount = document.getElementById("completed-table-container");
  if (!tableMount) return;

  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    let query = supabase
      .from("happy_calling")
      .select("*", { count: "exact" });

    // CCI filtering
    if (!isAdmin()) {
      query = query.eq("cci_code", profile.cci_code);
    }

    // Status filter
    if (statusFilter !== "ALL") {
      query = query.eq("calling_status", statusFilter);
    }

    // Feedback filter
    if (feedbackFilter !== "ALL") {
      query = query.eq("feedback_category", feedbackFilter);
    }

    // Search filter
    if (searchQuery) {
      query = query.or(`so_number.ilike.%${searchQuery}%,closure_id.ilike.%${searchQuery}%,customer_remarks.ilike.%${searchQuery}%`);
    }

    const fromIndex = (currentPage - 1) * PAGE_SIZE;
    const toIndex = fromIndex + PAGE_SIZE - 1;

    const { data: records, count, error } = await query
      .order("created_at", { ascending: false })
      .range(fromIndex, toIndex);

    if (error) throw error;

    const totalRecords = count || 0;
    let rowsHtml = "";

    if (!records || records.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="7" style="text-align:center; padding:2.5rem; color:var(--text-tertiary);">
            No completed calling records found.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = records
        .map((row) => `
          <tr>
            <td><strong style="font-family:monospace;">${escapeHtml(row.closure_id)}</strong></td>
            <td><span style="font-family:monospace; color:var(--moto-blue-accent);">${escapeHtml(row.so_number)}</span></td>
            <td>
              <div style="font-size:0.8125rem;">${formatDateTime(row.created_at || row.calling_date)}</div>
            </td>
            <td>${renderStatusBadge(row.calling_status)}</td>
            <td>${renderRatingBadge(row.customer_rating)}</td>
            <td>${renderFeedbackBadge(row.feedback_category)}</td>
            <td style="max-width:260px; font-size:0.8125rem; color:var(--text-secondary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${escapeHtml(row.customer_remarks || "")}">
              ${escapeHtml(row.customer_remarks || "—")}
            </td>
          </tr>
        `)
        .join("");
    }

    tableMount.innerHTML = renderDataTableWrapper({
      title: "Call Records",
      searchPlaceholder: "Search SO, Closure ID...",
      columns: [
        { label: "Closure ID" },
        { label: "SO Number" },
        { label: "Call Date & Time" },
        { label: "Status" },
        { label: "Rating" },
        { label: "Feedback" },
        { label: "Customer Remarks" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    attachTableEvents(tableMount, totalRecords);
  } catch (err) {
    console.error("loadCompletedTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error loading completed calls:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

function attachTableEvents(mount, totalRecords) {
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

  mount.querySelector("#btn-page-prev")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadCompletedTable();
    }
  });

  mount.querySelector("#btn-page-next")?.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadCompletedTable();
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
        loadCompletedTable();
      }, 300)
    );
  }
}

/**
 * Export Completed calls to CSV file directly in browser
 */
async function exportCompletedCallsToCSV() {
  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    let query = supabase
      .from("happy_calling")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(2000);

    if (!isAdmin()) {
      query = query.eq("cci_code", profile.cci_code);
    }

    const { data: rows, error } = await query;
    if (error) throw error;
    if (!rows || rows.length === 0) {
      alert("No records to export.");
      return;
    }

    const headers = ["Closure ID", "SO Number", "CCI Code", "Call Date", "Status", "Rating", "Feedback", "Customer Remarks", "CCI Remarks"];
    const csvContent = [
      headers.join(","),
      ...rows.map((r) => [
        `"${r.closure_id}"`,
        `"${r.so_number}"`,
        `"${r.cci_code}"`,
        `"${r.calling_date}"`,
        `"${r.calling_status}"`,
        `"${r.customer_rating || ""}"`,
        `"${r.feedback_category || ""}"`,
        `"${(r.customer_remarks || "").replace(/"/g, '""')}"`,
        `"${(r.cci_remarks || "").replace(/"/g, '""')}"`,
      ].join(",")),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", `Motorola_Happy_Calling_${profile.cci_code || "Records"}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (e) {
    console.error("Export error:", e);
    alert("Export failed: " + formatSupabaseError(e));
  }
}
