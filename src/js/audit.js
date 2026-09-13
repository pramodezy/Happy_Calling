// ============================================================================
// System Audit Log View Controller (Admin)
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { formatDateTime, escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton } from "../components/loading.js";
import { openModal } from "../components/modal.js";

let currentPage = 1;
const PAGE_SIZE = 15;
let searchQuery = "";
let actionFilter = "";

export async function renderAuditPage(container) {
  currentPage = 1;
  searchQuery = "";
  actionFilter = "";

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">System Audit Trail</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Immutable security and operational compliance event log.</p>
      </div>

      <div class="filter-group">
        <label for="audit-filter-action">Action Filter:</label>
        <select id="audit-filter-action" class="filter-select">
          <option value="">All Actions</option>
          <option value="LOGIN">LOGIN</option>
          <option value="LOGOUT">LOGOUT</option>
          <option value="HAPPY_CALLING_SUBMITTED">HAPPY_CALLING_SUBMITTED</option>
          <option value="CLOSURE_IMPORT">CLOSURE_IMPORT</option>
          <option value="USER_CREATED">USER_CREATED</option>
          <option value="USER_ACTIVATED">USER_ACTIVATED</option>
          <option value="USER_DEACTIVATED">USER_DEACTIVATED</option>
          <option value="PASSWORD_RESET">PASSWORD_RESET</option>
        </select>
      </div>
    </div>

    <div id="audit-table-container">
      ${renderDataTableWrapper({
        title: "Audit Events",
        searchPlaceholder: "Search description, closure ID...",
        columns: [
          { label: "Timestamp" },
          { label: "Action" },
          { label: "Role" },
          { label: "CCI" },
          { label: "Description" },
          { label: "Metadata", style: "text-align:right;" },
        ],
        rowsHtml: renderTableSkeleton(10, 6),
        page: currentPage,
        pageSize: PAGE_SIZE,
        totalRecords: 0,
      })}
    </div>
  `;

  document.getElementById("audit-filter-action")?.addEventListener("change", (e) => {
    actionFilter = e.target.value;
    currentPage = 1;
    loadAuditTable();
  });

  await loadAuditTable();
}

export async function loadAuditTable() {
  const tableMount = document.getElementById("audit-table-container");
  if (!tableMount) return;

  try {
    let query = supabase.from("audit_log").select("*", { count: "exact" });

    if (actionFilter) query = query.eq("action", actionFilter);
    if (searchQuery) {
      query = query.or(`description.ilike.%${searchQuery}%,closure_id.ilike.%${searchQuery}%`);
    }

    const fromIndex = (currentPage - 1) * PAGE_SIZE;
    const toIndex = fromIndex + PAGE_SIZE - 1;

    const { data: logs, count, error } = await query
      .order("timestamp", { ascending: false })
      .range(fromIndex, toIndex);

    if (error) throw error;

    const totalRecords = count || 0;
    let rowsHtml = "";

    if (!logs || logs.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="6" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
            No audit records found.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = logs
        .map(
          (log) => `
        <tr>
          <td><span style="font-size:0.8125rem; font-weight:500;">${formatDateTime(log.timestamp)}</span></td>
          <td><span class="badge badge-neutral" style="font-family:monospace; font-size:0.7rem;">${escapeHtml(log.action)}</span></td>
          <td><span class="badge ${log.role === "ADMIN" ? "badge-info" : "badge-neutral"}">${escapeHtml(log.role || "SYSTEM")}</span></td>
          <td><span style="font-family:monospace; font-weight:600;">${escapeHtml(log.cci_code || "—")}</span></td>
          <td style="font-size:0.8125rem; color:var(--text-primary); max-width:320px;">${escapeHtml(log.description)}</td>
          <td style="text-align:right;">
            <button type="button" class="btn-secondary btn-view-audit-meta" data-id="${log.id}" style="padding:4px 8px; font-size:0.75rem;">
              Inspect JSON
            </button>
          </td>
        </tr>
      `
        )
        .join("");
    }

    tableMount.innerHTML = renderDataTableWrapper({
      title: "Audit Events",
      searchPlaceholder: "Search description, closure ID...",
      columns: [
        { label: "Timestamp" },
        { label: "Action" },
        { label: "Role" },
        { label: "CCI" },
        { label: "Description" },
        { label: "Metadata", style: "text-align:right;" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    attachAuditActions(tableMount, totalRecords, logs);
  } catch (err) {
    console.error("loadAuditTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

function attachAuditActions(mount, totalRecords, logs) {
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

  mount.querySelector("#btn-page-prev")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadAuditTable();
    }
  });

  mount.querySelector("#btn-page-next")?.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadAuditTable();
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
        loadAuditTable();
      }, 300)
    );
  }

  mount.querySelectorAll(".btn-view-audit-meta").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const record = logs.find((l) => l.id === id);
      if (record) {
        openModal({
          title: `Audit Payload: ${record.action}`,
          contentHtml: `
            <pre style="background:#0f172a; color:#e2e8f0; padding:1rem; border-radius:8px; font-size:0.8125rem; max-height:300px; overflow-y:auto;">${escapeHtml(JSON.stringify(record.metadata || {}, null, 2))}</pre>
          `,
          footerHtml: `<button type="button" class="btn-secondary" onclick="document.getElementById('app-modal-overlay').remove()">Close</button>`,
          size: "normal",
        });
      }
    });
  });
}
