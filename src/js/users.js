// ============================================================================
// User Management Controller (Admin)
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { formatDateTime, escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton } from "../components/loading.js";
import { openModal, closeModal, confirmDialog } from "../components/modal.js";
import { showToast } from "../components/toast.js";

let currentPage = 1;
const PAGE_SIZE = 12;
let searchQuery = "";
let roleFilter = "";
let statusFilter = "";
let availableCcis = [];

export async function renderUsersPage(container) {
  currentPage = 1;
  searchQuery = "";
  roleFilter = "";
  statusFilter = "";

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">System User Management</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Manage CCI service agents and enterprise administrators with Supabase Auth RBAC.</p>
      </div>

      <button type="button" id="btn-create-user-modal" class="btn-primary" style="padding:7px 16px; font-size:0.875rem; display:flex; align-items:center; gap:0.4rem;">
        <span style="width:18px; height:18px;">${icons.users}</span>
        <span>Create New User</span>
      </button>
    </div>

    <!-- Filter Toolbar -->
    <div class="filter-toolbar">
      <div class="filter-group">
        <label for="users-filter-role">Role:</label>
        <select id="users-filter-role" class="filter-select">
          <option value="">All Roles</option>
          <option value="CCI_USER">CCI User</option>
          <option value="ADMIN">Admin</option>
        </select>
      </div>

      <div class="filter-group">
        <label for="users-filter-status">Status:</label>
        <select id="users-filter-status" class="filter-select">
          <option value="">All Statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </div>
    </div>

    <div id="users-table-container">
      ${renderDataTableWrapper({
        title: "User Accounts",
        searchPlaceholder: "Search by name, CCI code...",
        columns: [
          { label: "User Name" },
          { label: "Role" },
          { label: "Assigned CCI" },
          { label: "Status" },
          { label: "Last Login" },
          { label: "Created At" },
          { label: "Actions", style: "text-align:right;" },
        ],
        rowsHtml: renderTableSkeleton(6, 7),
        page: currentPage,
        pageSize: PAGE_SIZE,
        totalRecords: 0,
      })}
    </div>
  `;

  await loadCciList();

  document.getElementById("btn-create-user-modal")?.addEventListener("click", () => {
    showCreateUserModal();
  });

  document.getElementById("users-filter-role")?.addEventListener("change", (e) => {
    roleFilter = e.target.value;
    currentPage = 1;
    loadUsersTable();
  });

  document.getElementById("users-filter-status")?.addEventListener("change", (e) => {
    statusFilter = e.target.value;
    currentPage = 1;
    loadUsersTable();
  });

  await loadUsersTable();
}

async function loadCciList() {
  try {
    const { data } = await supabase.from("cci_master").select("cci_code, cci_name").eq("status", "ACTIVE").order("cci_code");
    availableCcis = data || [];
  } catch (e) {
    console.warn("Could not load CCIs:", e);
  }
}

export async function loadUsersTable() {
  const tableMount = document.getElementById("users-table-container");
  if (!tableMount) return;

  try {
    let query = supabase.from("user_profiles").select("*", { count: "exact" });

    if (roleFilter) query = query.eq("role", roleFilter);
    if (statusFilter) query = query.eq("status", statusFilter);
    if (searchQuery) {
      query = query.or(`user_name.ilike.%${searchQuery}%,cci_code.ilike.%${searchQuery}%,cci_name.ilike.%${searchQuery}%`);
    }

    const fromIndex = (currentPage - 1) * PAGE_SIZE;
    const toIndex = fromIndex + PAGE_SIZE - 1;

    const { data: users, count, error } = await query
      .order("created_at", { ascending: false })
      .range(fromIndex, toIndex);

    if (error) throw error;

    const totalRecords = count || 0;
    let rowsHtml = "";

    if (!users || users.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="7" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
            No user profiles found.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = users
        .map((u) => {
          const isAct = u.status === "ACTIVE";
          return `
          <tr>
            <td>
              <strong style="color:var(--text-primary); font-size:0.9rem;">${escapeHtml(u.user_name)}</strong>
            </td>
            <td>
              <span class="badge ${u.role === "ADMIN" ? "badge-info" : "badge-neutral"}">
                ${u.role === "ADMIN" ? "Company Admin" : "CCI Agent"}
              </span>
            </td>
            <td>
              ${
                u.cci_code
                  ? `<div><strong style="font-family:monospace; color:var(--moto-blue-accent);">${escapeHtml(u.cci_code)}</strong></div><div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(u.cci_name || "")}</div>`
                  : `<span style="color:var(--text-tertiary);">Company HQ (All)</span>`
              }
            </td>
            <td>
              <span class="badge ${isAct ? "badge-success" : "badge-danger"}">
                <span class="badge-dot"></span>${u.status}
              </span>
            </td>
            <td><span style="font-size:0.8125rem;">${formatDateTime(u.last_login)}</span></td>
            <td><span style="font-size:0.8125rem;">${formatDateTime(u.created_at)}</span></td>
            <td style="text-align:right;">
              <div style="display:inline-flex; gap:0.35rem;">
                <button type="button" class="btn-secondary btn-toggle-status" data-id="${u.id}" data-auth="${u.auth_user_id}" data-status="${u.status}" style="padding:4px 8px; font-size:0.75rem;">
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
      title: "User Accounts",
      searchPlaceholder: "Search by name, CCI code...",
      columns: [
        { label: "User Name" },
        { label: "Role" },
        { label: "Assigned CCI" },
        { label: "Status" },
        { label: "Last Login" },
        { label: "Created At" },
        { label: "Actions", style: "text-align:right;" },
      ],
      rowsHtml,
      page: currentPage,
      totalRecords,
      pageSize: PAGE_SIZE,
    });

    attachUserActions(tableMount, totalRecords);
  } catch (err) {
    tableMount.innerHTML = `
      <div style="padding:2rem; text-align:center; color:var(--text-danger);">
        <strong>Error loading users:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

function attachUserActions(mount, totalRecords) {
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

  mount.querySelector("#btn-page-prev")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadUsersTable();
    }
  });

  mount.querySelector("#btn-page-next")?.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadUsersTable();
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
        loadUsersTable();
      }, 300)
    );
  }

  // Toggle user status (Activate / Deactivate)
  mount.querySelectorAll(".btn-toggle-status").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const authUserId = btn.getAttribute("data-auth");
      const currentStatus = btn.getAttribute("data-status");
      const newStatus = currentStatus === "ACTIVE" ? "INACTIVE" : "ACTIVE";

      if (confirm(`Are you sure you want to ${newStatus === "ACTIVE" ? "activate" : "deactivate"} this user account?`)) {
        try {
          const { error } = await supabase.from("user_profiles").update({ status: newStatus }).eq("id", id);
          if (error) throw error;
          showToast(`User status updated to ${newStatus}.`, "success");
          loadUsersTable();
        } catch (err) {
          showToast(`Action failed: ${formatSupabaseError(err)}`, "error");
        }
      }
    });
  });
}

function showCreateUserModal() {
  const cciOptions = availableCcis
    .map((c) => `<option value="${c.cci_code}" data-name="${escapeHtml(c.cci_name)}">${c.cci_code} - ${escapeHtml(c.cci_name)}</option>`)
    .join("");

  const contentHtml = `
    <form id="create-user-form">
      <div class="form-group">
        <label for="new-user-name" class="form-label">Full Name *</label>
        <input type="text" id="new-user-name" class="form-input" required placeholder="e.g. Ramesh Kumar">
      </div>

      <div class="form-group">
        <label for="new-user-email" class="form-label">Email Address (Login Username) *</label>
        <input type="email" id="new-user-email" class="form-input" required placeholder="agent@motorolacare.in">
      </div>

      <div class="form-group">
        <label for="new-user-password" class="form-label">Temporary Password *</label>
        <input type="password" id="new-user-password" class="form-input" required minlength="6" placeholder="Min 6 characters">
      </div>

      <div class="form-group">
        <label for="new-user-role" class="form-label">Role *</label>
        <select id="new-user-role" class="form-select" required>
          <option value="CCI_USER" selected>CCI User (Restricted to assigned CCI)</option>
          <option value="ADMIN">ADMIN (Full access to all CCIs and Settings)</option>
        </select>
      </div>

      <div class="form-group" id="group-assign-cci">
        <label for="new-user-cci" class="form-label">Assign CCI Location *</label>
        <select id="new-user-cci" class="form-select">
          <option value="">Select CCI...</option>
          ${cciOptions}
        </select>
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn-secondary" id="modal-btn-cancel">Cancel</button>
    <button type="button" class="btn-primary" id="modal-btn-save-user">Create User</button>
  `;

  const overlay = openModal({
    title: "Create System User",
    contentHtml,
    footerHtml,
    size: "normal",
  });

  const roleSelect = overlay.querySelector("#new-user-role");
  const cciGroup = overlay.querySelector("#group-assign-cci");
  roleSelect?.addEventListener("change", (e) => {
    if (cciGroup) {
      cciGroup.style.display = e.target.value === "CCI_USER" ? "block" : "none";
    }
  });

  overlay.querySelector("#modal-btn-cancel")?.addEventListener("click", closeModal);

  overlay.querySelector("#modal-btn-save-user")?.addEventListener("click", async () => {
    const userName = overlay.querySelector("#new-user-name")?.value.trim();
    const email = overlay.querySelector("#new-user-email")?.value.trim();
    const password = overlay.querySelector("#new-user-password")?.value;
    const role = roleSelect?.value;
    const cciSelect = overlay.querySelector("#new-user-cci");
    const cciCode = cciSelect?.value;
    const cciName = cciSelect?.selectedOptions[0]?.getAttribute("data-name") || "";

    if (!userName || !email || !password || !role) {
      showToast("Please fill in all required fields.", "warning");
      return;
    }

    if (role === "CCI_USER" && !cciCode) {
      showToast("Please assign a CCI location for CCI User accounts.", "warning");
      return;
    }

    const saveBtn = overlay.querySelector("#modal-btn-save-user");
    saveBtn.disabled = true;
    saveBtn.textContent = "Creating...";

    try {
      const { data, error } = await supabase.functions.invoke("admin-users", {
        body: {
          action: "create_user",
          payload: { email, password, userName, role, cciCode, cciName },
        },
      });

      if (error) throw error;

      showToast(`User ${email} created successfully!`, "success");
      closeModal();
      loadUsersTable();
    } catch (err) {
      console.error("Create user error:", err);
      showToast(`Failed to create user: ${formatSupabaseError(err)}`, "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Create User";
    }
  });
}
