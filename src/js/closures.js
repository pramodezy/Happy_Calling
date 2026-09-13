// ============================================================================
// Closure Database View Controller (Admin)
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { formatDate, formatDateTime, formatMobile, escapeHtml, debounce, icons, renderStatusBadge } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton } from "../components/loading.js";
import { openModal } from "../components/modal.js";

let currentPage = 1;
const PAGE_SIZE = 15;
let searchQuery = "";
let cciFilter = "";

export async function renderClosuresPage(container) {
  currentPage = 1;
  searchQuery = "";
  cciFilter = "";

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Motorola Closure Master Database</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Complete source record of service closures across all authorized partner centers.</p>
      </div>

      <div style="display:flex; gap:0.5rem; align-items:center;">
        <select id="closures-cci-filter" class="form-select" style="padding:6px 12px; font-size:0.8125rem;">
          <option value="">All CCIs</option>
        </select>

        <a href="#/admin/import" class="btn-primary" style="padding:6px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.upload}</span>
          <span>Upload Closures</span>
        </a>
      </div>
    </div>

    <div id="closures-table-container">
      ${renderDataTableWrapper({
        title: "All Closures",
        searchPlaceholder: "Search SO, Closure ID, Customer, Model...",
        columns: [
          { label: "Closure ID" },
          { label: "SO Number" },
          { label: "CCI Code" },
          { label: "Customer Name" },
          { label: "Mobile" },
          { label: "Model" },
          { label: "Closure Date" },
          { label: "Actions", style: "text-align:right;" },
        ],
        rowsHtml: renderTableSkeleton(10, 8),
        page: currentPage,
        pageSize: PAGE_SIZE,
        totalRecords: 0,
      })}
    </div>
  `;

  await populateCciOptions();

  document.getElementById("closures-cci-filter")?.addEventListener("change", (e) => {
    cciFilter = e.target.value;
    currentPage = 1;
    loadClosuresTable();
  });

  await loadClosuresTable();
}

async function populateCciOptions() {
  const select = document.getElementById("closures-cci-filter");
  if (!select) return;

  try {
    const { data } = await supabase.from("cci_master").select("cci_code, cci_name").order("cci_code");
    if (data) {
      const DEMO_CODES = new Set(["BLR01", "DEL01", "MUM01", "KOC01", "KOL01"]);
      const hasStationCodes = data.some((c) => !DEMO_CODES.has(c.cci_code));
      const activeData = hasStationCodes ? data.filter((c) => !DEMO_CODES.has(c.cci_code)) : data;

      activeData.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.cci_code;
        opt.textContent = `${c.cci_code} - ${c.cci_name}`;
        select.appendChild(opt);
      });
    }
  } catch (e) {
    console.warn("CCI dropdown load warning:", e);
  }
}

export async function loadClosuresTable() {
  const tableMount = document.getElementById("closures-table-container");
  if (!tableMount) return;

  try {
    let query = supabase
      .from("closure_master")
      .select("*", { count: "exact" });

    if (cciFilter) {
      query = query.eq("cci_code", cciFilter);
    }

    if (searchQuery) {
      query = query.or(
        `closure_id.ilike.%${searchQuery}%,so_number.ilike.%${searchQuery}%,customer_name.ilike.%${searchQuery}%,customer_mobile.ilike.%${searchQuery}%,model.ilike.%${searchQuery}%`
      );
    }

    const fromIndex = (currentPage - 1) * PAGE_SIZE;
    const toIndex = fromIndex + PAGE_SIZE - 1;

    const { data: records, count, error } = await query
      .order("closure_date", { ascending: false })
      .range(fromIndex, toIndex);

    if (error) throw error;

    const totalRecords = count || 0;
    let rowsHtml = "";

    if (!records || records.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="8" style="text-align:center; padding:2.5rem; color:var(--text-tertiary);">
            No closures found matching your query.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = records
        .map(
          (row) => `
        <tr>
          <td><strong style="font-family:monospace;">${escapeHtml(row.closure_id)}</strong></td>
          <td><span style="font-family:monospace; color:var(--moto-blue-accent);">${escapeHtml(row.so_number)}</span></td>
          <td><span class="badge badge-neutral">${escapeHtml(row.cci_code)}</span></td>
          <td>${escapeHtml(row.customer_name)}</td>
          <td>${escapeHtml(formatMobile(row.customer_mobile))}</td>
          <td>${escapeHtml(row.model)}</td>
          <td>${formatDate(row.closure_date)}</td>
          <td style="text-align:right;">
            <button type="button" class="btn-secondary btn-view-closure" data-id="${row.id}" style="padding:4px 10px; font-size:0.75rem;">
              View Details
            </button>
          </td>
        </tr>
      `
        )
        .join("");
    }

    tableMount.innerHTML = renderDataTableWrapper({
      title: "All Closures",
      searchPlaceholder: "Search SO, Closure ID, Customer, Model...",
      columns: [
        { label: "Closure ID" },
        { label: "SO Number" },
        { label: "CCI Code" },
        { label: "Customer Name" },
        { label: "Mobile" },
        { label: "Model" },
        { label: "Closure Date" },
        { label: "Actions", style: "text-align:right;" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    attachTableEvents(tableMount, totalRecords, records);
  } catch (err) {
    console.error("loadClosuresTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error loading closures:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

function attachTableEvents(mount, totalRecords, currentRecords) {
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

  mount.querySelector("#btn-page-prev")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadClosuresTable();
    }
  });

  mount.querySelector("#btn-page-next")?.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadClosuresTable();
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
        loadClosuresTable();
      }, 300)
    );
  }

  mount.querySelectorAll(".btn-view-closure").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const record = currentRecords.find((r) => r.id === id);
      if (record) {
        showClosureDetailModal(record);
      }
    });
  });
}

function showClosureDetailModal(closure) {
  const contentHtml = `
    <div style="display:flex; flex-direction:column; gap:1rem;">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; background:var(--bg-surface-subtle); padding:1rem; border-radius:var(--radius-md);">
        <div><span style="color:var(--text-tertiary); font-size:0.75rem;">Closure ID:</span> <strong style="display:block;">${escapeHtml(closure.closure_id)}</strong></div>
        <div><span style="color:var(--text-tertiary); font-size:0.75rem;">SO Number:</span> <strong style="display:block; color:var(--moto-blue-accent);">${escapeHtml(closure.so_number)}</strong></div>
        <div><span style="color:var(--text-tertiary); font-size:0.75rem;">CCI Code & Name:</span> <strong style="display:block;">${escapeHtml(closure.cci_code)} - ${escapeHtml(closure.cci_name)}</strong></div>
        <div><span style="color:var(--text-tertiary); font-size:0.75rem;">Model:</span> <strong style="display:block;">${escapeHtml(closure.model)}</strong></div>
        <div><span style="color:var(--text-tertiary); font-size:0.75rem;">Customer:</span> <strong style="display:block;">${escapeHtml(closure.customer_name)}</strong></div>
        <div><span style="color:var(--text-tertiary); font-size:0.75rem;">Mobile:</span> <strong style="display:block;">${escapeHtml(closure.customer_mobile)}</strong></div>
        <div><span style="color:var(--text-tertiary); font-size:0.75rem;">Closure Date:</span> <span style="display:block;">${formatDateTime(closure.closure_date)}</span></div>
        <div><span style="color:var(--text-tertiary); font-size:0.75rem;">Repair Completed:</span> <span style="display:block;">${formatDateTime(closure.repair_complete_date)}</span></div>
      </div>

      <div>
        <h4 style="font-size:0.875rem; font-weight:700; margin-bottom:0.5rem;">Raw Motorola Source Data (JSONB):</h4>
        <pre style="background:#0f172a; color:#e2e8f0; padding:0.75rem; border-radius:6px; font-size:0.75rem; max-height:200px; overflow-y:auto;">${escapeHtml(JSON.stringify(closure.source_data || {}, null, 2))}</pre>
      </div>
    </div>
  `;

  openModal({
    title: `Closure Details: SO ${closure.so_number}`,
    contentHtml,
    footerHtml: `<button type="button" class="btn-secondary" onclick="document.getElementById('app-modal-overlay').remove()">Close</button>`,
    size: "normal",
  });
}
