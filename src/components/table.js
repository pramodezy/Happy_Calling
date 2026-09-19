// ============================================================================
// Reusable Data Table Component with Pagination and Search
// ============================================================================

import { icons } from "../js/utils.js";

export function renderDataTableWrapper({
  title,
  searchPlaceholder = "Search...",
  actionsHtml = "",
  filterPillsHtml = "",
  columns,
  rowsHtml,
  page = 1,
  pageSize = 10,
  totalRecords = 0,
}) {
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const fromRecord = totalRecords === 0 ? 0 : (page - 1) * pageSize + 1;
  const toRecord = Math.min(totalRecords, page * pageSize);

  const headerCells = columns
    .map((col) => `<th style="${col.style || ""}">${col.label}</th>`)
    .join("");

  return `
    <div class="table-card">
      <div class="table-card-header" style="flex-direction:column; align-items:stretch; gap:0.75rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">
          <h3 class="table-card-title">${title}</h3>
          <div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">
            ${
              searchPlaceholder
                ? `
              <div style="position:relative; width:240px;">
                <span style="position:absolute; left:10px; top:50%; transform:translateY(-50%); width:16px; height:16px; color:var(--text-tertiary); pointer-events:none;">
                  ${icons.search}
                </span>
                <input type="text" id="table-search-input" class="form-input" style="padding-left:32px; padding-top:6px; padding-bottom:6px; font-size:0.8125rem;" placeholder="${searchPlaceholder}">
              </div>
            `
                : ""
            }
            ${actionsHtml}
          </div>
        </div>
        ${filterPillsHtml ? `<div class="filter-pills-bar">${filterPillsHtml}</div>` : ""}
      </div>

      <div class="table-responsive-wrapper">
        <table class="data-table">
          <thead>
            <tr>${headerCells}</tr>
          </thead>
          <tbody id="table-body-content">
            ${rowsHtml}
          </tbody>
        </table>
      </div>

      <div class="pagination-container">
        <div>
          Showing <strong>${fromRecord}</strong> to <strong>${toRecord}</strong> of <strong>${totalRecords}</strong> records
        </div>
        <div class="pagination-controls">
          <button type="button" class="btn-page" id="btn-page-prev" data-action="prev-page" ${page <= 1 ? "disabled" : ""}>Previous</button>
          <span style="padding:0 0.5rem; font-weight:600;">Page ${page} of ${totalPages}</span>
          <button type="button" class="btn-page" id="btn-page-next" data-action="next-page" ${page >= totalPages ? "disabled" : ""}>Next</button>
        </div>
      </div>
    </div>
  `;
}
