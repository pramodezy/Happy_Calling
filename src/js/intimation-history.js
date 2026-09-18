// ============================================================================
// Motorola Care - Intimation History View Controller
// Displays historical customer intimation records and committed ETR dates
// ============================================================================

import { supabase, formatSupabaseError, fetchAllRows } from "./supabase.js";
import { getCurrentProfile, isAdmin, hasAdminOrBsmAccess } from "./auth.js";
import { formatDate, formatDateTime, formatMobile, escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton } from "../components/loading.js";

let currentPage = 1;
const PAGE_SIZE = 15;
let searchQuery = "";

export async function renderIntimationHistoryPage(container) {
  currentPage = 1;
  searchQuery = "";

  container.innerHTML = `
    <!-- Header with Action -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Intimation Calling History</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Historical log of all customer intimation calls and committed ETR resolution dates.</p>
      </div>

      <div style="display:flex; gap:0.5rem;">
        <button type="button" id="btn-export-intimation-csv" class="btn-secondary" style="font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.download}</span>
          <span>Export History CSV</span>
        </button>
        <a href="#/intimation/calling" class="btn-primary" style="font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.phone}</span>
          <span>Start Calling</span>
        </a>
      </div>
    </div>

    <!-- Data Table Container -->
    <div id="intimation-history-table-container">
      ${renderDataTableWrapper({
        title: "Intimation Call Log",
        searchPlaceholder: "Search SO, remarks...",
        columns: [
          { label: "Service Order" },
          { label: "Station" },
          { label: "Committed ETR" },
          { label: "Calling Outcome" },
          { label: "CCI Notes" },
          { label: "Customer Notes" },
          { label: "Call Date & Time" },
        ],
        rowsHtml: renderTableSkeleton(7, 8),
        page: currentPage,
        pageSize: PAGE_SIZE,
        totalRecords: 0,
      })}
    </div>
  `;

  document.getElementById("btn-export-intimation-csv")?.addEventListener("click", exportIntimationCsv);

  const searchInput = document.getElementById("table-search-input");
  if (searchInput) {
    searchInput.addEventListener(
      "input",
      debounce((e) => {
        searchQuery = e.target.value.trim();
        currentPage = 1;
        loadHistoryTable();
      }, 300)
    );
  }

  await loadHistoryTable();
}

export async function loadHistoryTable() {
  const tableMount = document.getElementById("intimation-history-table-container");
  if (!tableMount) return;

  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    let query = supabase
      .from("intimation_calling")
      .select("*", { count: "exact" });

    if (!hasAdminOrBsmAccess() && profile.cci_code) {
      query = query.eq("cci_code", profile.cci_code);
    }

    if (searchQuery) {
      query = query.or(`service_order.ilike.%${searchQuery}%,cci_comment.ilike.%${searchQuery}%,customer_comment.ilike.%${searchQuery}%`);
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
            No intimation call records found.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = records
        .map((r) => {
          let badge = `<span class="badge badge-success">Completed</span>`;
          if (r.calling_status === "Customer Not Reachable") {
            badge = `<span class="badge badge-warning">⚠️ Not Reachable</span>`;
          } else if (r.calling_status === "Call Back Required") {
            badge = `<span class="badge badge-info">📞 Call Back Req.</span>`;
          }

          return `
          <tr>
            <td>
              <strong style="font-family:monospace; color:var(--moto-blue-accent); font-size:0.875rem;">${escapeHtml(r.service_order)}</strong>
            </td>
            <td>
              <span class="badge badge-neutral" style="font-family:monospace;">Station ${escapeHtml(r.cci_code)}</span>
            </td>
            <td>
              <strong style="color:var(--text-primary); font-size:0.875rem;">${formatDate(r.etr_date)}</strong>
            </td>
            <td>${badge}</td>
            <td style="max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(r.cci_comment || "—")}">
              ${escapeHtml(r.cci_comment || "—")}
            </td>
            <td style="max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(r.customer_comment || "—")}">
              ${escapeHtml(r.customer_comment || "—")}
            </td>
            <td style="font-size:0.8125rem; color:var(--text-secondary);">
              ${formatDateTime(r.created_at)}
            </td>
          </tr>
        `;
        })
        .join("");
    }

    tableMount.innerHTML = renderDataTableWrapper({
      title: "Intimation Call Log",
      searchPlaceholder: "Search SO, remarks...",
      columns: [
        { label: "Service Order" },
        { label: "Station" },
        { label: "Committed ETR" },
        { label: "Calling Outcome" },
        { label: "CCI Notes" },
        { label: "Customer Notes" },
        { label: "Call Date & Time" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

    tableMount.querySelector("#btn-page-prev, #btn-prev-page")?.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        loadHistoryTable();
      }
    });

    tableMount.querySelector("#btn-page-next, #btn-next-page")?.addEventListener("click", () => {
      if (currentPage < totalPages) {
        currentPage++;
        loadHistoryTable();
      }
    });

    const searchInput = tableMount.querySelector("#table-search-input");
    if (searchInput) {
      searchInput.value = searchQuery;
      searchInput.addEventListener(
        "input",
        debounce((e) => {
          searchQuery = e.target.value.trim();
          currentPage = 1;
          loadHistoryTable();
        }, 300)
      );
    }
  } catch (err) {
    console.error("loadHistoryTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error loading history:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

async function exportIntimationCsv() {
  const profile = getCurrentProfile();
  if (!profile) return;

  try {
    const data = await fetchAllRows((from, to) => {
      let q = supabase
        .from("intimation_calling")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, to);
      if (!hasAdminOrBsmAccess() && profile.cci_code) q = q.eq("cci_code", profile.cci_code);
      return q;
    });

    if (!data || data.length === 0) {
      alert("No intimation records to export.");
      return;
    }

    const headers = ["Service Order", "Station Code", "Committed ETR Date", "Calling Status", "CCI Comment", "Customer Comment", "Created At"];
    const rows = data.map((r) => [
      `"${r.service_order}"`,
      `"${r.cci_code}"`,
      `"${r.etr_date}"`,
      `"${r.calling_status}"`,
      `"${(r.cci_comment || "").replace(/"/g, '""')}"`,
      `"${(r.customer_comment || "").replace(/"/g, '""')}"`,
      `"${r.created_at}"`,
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Motorola_Intimation_History_${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Export error:", err);
    alert("Failed to export intimation history.");
  }
}
