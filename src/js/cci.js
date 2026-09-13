// ============================================================================
// CCI Management Controller (Admin)
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton } from "../components/loading.js";
import { openModal, closeModal, confirmDialog } from "../components/modal.js";
import { showToast } from "../components/toast.js";

let currentPage = 1;
const PAGE_SIZE = 12;
let searchQuery = "";

export async function renderCciPage(container) {
  currentPage = 1;
  searchQuery = "";

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">CCI Master Management</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Manage Motorola Customer Care Centers (CCIs), regions, and operational status.</p>
      </div>

      <button type="button" id="btn-add-cci-modal" class="btn-primary" style="padding:7px 16px; font-size:0.875rem; display:flex; align-items:center; gap:0.4rem;">
        <span style="width:18px; height:18px;">${icons.mapPin}</span>
        <span>Add New CCI</span>
      </button>
    </div>

    <div id="cci-table-container">
      ${renderDataTableWrapper({
        title: "All CCI Centers",
        searchPlaceholder: "Search CCI code, name, city...",
        columns: [
          { label: "CCI Code" },
          { label: "Center Name" },
          { label: "Region" },
          { label: "City / Location" },
          { label: "Status" },
          { label: "Actions", style: "text-align:right;" },
        ],
        rowsHtml: renderTableSkeleton(6, 6),
        page: currentPage,
        pageSize: PAGE_SIZE,
        totalRecords: 0,
      })}
    </div>
  `;

  document.getElementById("btn-add-cci-modal")?.addEventListener("click", () => {
    showCciFormModal();
  });

  await loadCciTable();
}

export async function loadCciTable() {
  const tableMount = document.getElementById("cci-table-container");
  if (!tableMount) return;

  try {
    let query = supabase.from("cci_master").select("*", { count: "exact" });

    if (searchQuery) {
      query = query.or(`cci_code.ilike.%${searchQuery}%,cci_name.ilike.%${searchQuery}%,location.ilike.%${searchQuery}%,region.ilike.%${searchQuery}%`);
    }

    const fromIndex = (currentPage - 1) * PAGE_SIZE;
    const toIndex = fromIndex + PAGE_SIZE - 1;

    const { data: ccis, count, error } = await query
      .order("cci_code", { ascending: true })
      .range(fromIndex, toIndex);

    if (error) throw error;

    const totalRecords = count || 0;
    let rowsHtml = "";

    if (!ccis || ccis.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="6" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
            No CCI records found.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = ccis
        .map((c) => {
          const isAct = c.status === "ACTIVE";
          return `
          <tr>
            <td>
              <strong style="font-family:monospace; color:var(--moto-blue-accent); font-size:0.95rem;">${escapeHtml(c.cci_code)}</strong>
            </td>
            <td><strong>${escapeHtml(c.cci_name)}</strong></td>
            <td><span class="badge badge-neutral">${escapeHtml(c.region || "—")}</span></td>
            <td>${escapeHtml(c.location || "—")}</td>
            <td>
              <span class="badge ${isAct ? "badge-success" : "badge-danger"}">
                <span class="badge-dot"></span>${c.status}
              </span>
            </td>
            <td style="text-align:right;">
              <div style="display:inline-flex; gap:0.35rem;">
                <button type="button" class="btn-secondary btn-edit-cci" data-id="${c.id}" style="padding:4px 10px; font-size:0.75rem;">
                  Edit
                </button>
                <button type="button" class="btn-secondary btn-toggle-cci" data-id="${c.id}" data-status="${c.status}" style="padding:4px 10px; font-size:0.75rem;">
                  ${isAct ? "Deactivate" : "Activate"}
                </button>
              </div>
            </td>
          </tr>
        `;
        })
        .join("");
    }

    tableMount.innerHTML = renderDataTableWrapper({
      title: "All CCI Centers",
      searchPlaceholder: "Search CCI code, name, city...",
      columns: [
        { label: "CCI Code" },
        { label: "Center Name" },
        { label: "Region" },
        { label: "City / Location" },
        { label: "Status" },
        { label: "Actions", style: "text-align:right;" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    attachCciActions(tableMount, totalRecords, ccis);
  } catch (err) {
    console.error("loadCciTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

function attachCciActions(mount, totalRecords, currentCcis) {
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

  mount.querySelector("#btn-page-prev")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadCciTable();
    }
  });

  mount.querySelector("#btn-page-next")?.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadCciTable();
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
        loadCciTable();
      }, 300)
    );
  }

  // Edit CCI
  mount.querySelectorAll(".btn-edit-cci").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const record = currentCcis.find((c) => c.id === id);
      if (record) showCciFormModal(record);
    });
  });

  // Toggle status
  mount.querySelectorAll(".btn-toggle-cci").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const currentStat = btn.getAttribute("data-status");
      const newStat = currentStat === "ACTIVE" ? "INACTIVE" : "ACTIVE";

      const confirmed = await confirmDialog({
        title: `${newStat === "ACTIVE" ? "Activate" : "Deactivate"} CCI Center`,
        message: `Are you sure you want to mark this center as ${newStat}?`,
        confirmText: newStat === "ACTIVE" ? "Activate" : "Deactivate",
        isDanger: newStat === "INACTIVE",
      });

      if (confirmed) {
        try {
          const { error } = await supabase.from("cci_master").update({ status: newStat }).eq("id", id);
          if (error) throw error;
          showToast(`CCI status updated to ${newStat}.`, "success");
          loadCciTable();
        } catch (e) {
          showToast(`Update failed: ${formatSupabaseError(e)}`, "error");
        }
      }
    });
  });
}

function showCciFormModal(cci = null) {
  const isEditing = !!cci;

  const contentHtml = `
    <form id="cci-form">
      <div class="form-group">
        <label for="cci-code-input" class="form-label">CCI Code *</label>
        <input type="text" id="cci-code-input" class="form-input" style="font-family:monospace; text-transform:uppercase;" required value="${escapeHtml(cci?.cci_code || "")}" ${isEditing ? "disabled" : ""} placeholder="e.g. BLR02">
      </div>

      <div class="form-group">
        <label for="cci-name-input" class="form-label">Center Name *</label>
        <input type="text" id="cci-name-input" class="form-input" required value="${escapeHtml(cci?.cci_name || "")}" placeholder="Motorola Care Center - Koramangala">
      </div>

      <div class="form-group">
        <label for="cci-region-input" class="form-label">Region *</label>
        <select id="cci-region-input" class="form-select" required>
          <option value="North" ${cci?.region === "North" ? "selected" : ""}>North</option>
          <option value="South" ${cci?.region === "South" ? "selected" : ""}>South</option>
          <option value="East" ${cci?.region === "East" ? "selected" : ""}>East</option>
          <option value="West" ${cci?.region === "West" ? "selected" : ""}>West</option>
          <option value="Central" ${cci?.region === "Central" ? "selected" : ""}>Central</option>
        </select>
      </div>

      <div class="form-group">
        <label for="cci-location-input" class="form-label">City / Location *</label>
        <input type="text" id="cci-location-input" class="form-input" required value="${escapeHtml(cci?.location || "")}" placeholder="e.g. Bangalore">
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn-secondary" id="modal-btn-cancel">Cancel</button>
    <button type="button" class="btn-primary" id="modal-btn-save-cci">${isEditing ? "Save Changes" : "Create CCI"}</button>
  `;

  const overlay = openModal({
    title: isEditing ? `Edit CCI: ${cci.cci_code}` : "Add New CCI Center",
    contentHtml,
    footerHtml,
    size: "normal",
  });

  overlay.querySelector("#modal-btn-cancel")?.addEventListener("click", closeModal);

  overlay.querySelector("#modal-btn-save-cci")?.addEventListener("click", async () => {
    const cciCode = overlay.querySelector("#cci-code-input")?.value.trim().toUpperCase();
    const cciName = overlay.querySelector("#cci-name-input")?.value.trim();
    const region = overlay.querySelector("#cci-region-input")?.value;
    const location = overlay.querySelector("#cci-location-input")?.value.trim();

    if (!cciCode || !cciName || !location) {
      showToast("Please fill all required fields.", "warning");
      return;
    }

    try {
      if (isEditing) {
        const { error } = await supabase
          .from("cci_master")
          .update({ cci_name: cciName, region, location })
          .eq("id", cci.id);
        if (error) throw error;
        showToast("CCI updated successfully.", "success");
      } else {
        const { error } = await supabase
          .from("cci_master")
          .insert({ cci_code: cciCode, cci_name: cciName, region, location, status: "ACTIVE" });
        if (error) throw error;
        showToast(`CCI ${cciCode} created successfully.`, "success");
      }
      closeModal();
      loadCciTable();
    } catch (err) {
      showToast(`Error: ${formatSupabaseError(err)}`, "error");
    }
  });
}
