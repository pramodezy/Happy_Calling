// ============================================================================
// Topbar / Navbar Component
// ============================================================================

import { icons, escapeHtml } from "../js/utils.js";
import { getCurrentProfile, logoutUser } from "../js/auth.js";
import { getActiveWorkspace, setActiveWorkspace } from "../js/workspace.js";

export function renderNavbar() {
  const profile = getCurrentProfile() || {};
  const initials = profile.user_name ? profile.user_name.substring(0, 2).toUpperCase() : "MO";
  const roleLabel = profile.role === "ADMIN" ? "Company Administrator" : `${profile.cci_code || "CCI"} Partner`;
  const activeWorkspace = getActiveWorkspace();

  return `
    <header class="topbar">
      <div class="topbar-left">
        <button type="button" id="btn-sidebar-toggle" class="mobile-only" style="padding:6px; color:var(--text-primary);" aria-label="Toggle Navigation">
          <span style="display:block; width:22px; height:22px;">${icons.menu}</span>
        </button>
        <div class="topbar-brand-title">
          <span>Motorola Care</span>
          <span class="topbar-subtitle">Operations Portal</span>
        </div>
      </div>

      <!-- Top Tab Workspace Switcher -->
      <div class="topbar-workspace-switcher" role="tablist" aria-label="Application Workspace">
        <button type="button" id="ws-tab-happy" class="ws-tab-btn ${activeWorkspace === 'happy' ? 'active' : ''}" role="tab" aria-selected="${activeWorkspace === 'happy'}">
          <span class="ws-tab-icon">${icons.phone}</span>
          <span class="ws-tab-label">Happy Calling</span>
        </button>
        <button type="button" id="ws-tab-intimation" class="ws-tab-btn ${activeWorkspace === 'intimation' ? 'active' : ''}" role="tab" aria-selected="${activeWorkspace === 'intimation'}">
          <span class="ws-tab-icon">${icons.clock}</span>
          <span class="ws-tab-label">Intimation Calling</span>
          <span class="ws-tab-badge">&gt;3d ETR</span>
        </button>
      </div>

      <div class="topbar-right">
        <div class="topbar-user-badge">
          <div class="user-avatar-circle">${initials}</div>
          <div class="user-info-text">
            <span class="user-name-line">${escapeHtml(profile.user_name || "User")}</span>
            <span class="user-role-line">${roleLabel}</span>
          </div>
        </div>
        <button type="button" id="btn-topbar-logout" style="color:var(--text-secondary); padding:6px;" title="Logout">
          <span style="display:block; width:20px; height:20px;">${icons.logOut}</span>
        </button>
      </div>
    </header>
  `;
}

export function initNavbarEvents() {
  const toggleBtn = document.getElementById("btn-sidebar-toggle");
  const sidebar = document.querySelector(".sidebar");
  const backdrop = document.querySelector(".sidebar-backdrop");

  if (toggleBtn && sidebar && backdrop) {
    toggleBtn.addEventListener("click", () => {
      sidebar.classList.toggle("open");
      backdrop.classList.toggle("active");
    });

    backdrop.addEventListener("click", () => {
      sidebar.classList.remove("open");
      backdrop.classList.remove("active");
    });
  }

  const tabHappy = document.getElementById("ws-tab-happy");
  const tabIntimation = document.getElementById("ws-tab-intimation");

  if (tabHappy) {
    tabHappy.addEventListener("click", () => {
      setActiveWorkspace("happy");
    });
  }

  if (tabIntimation) {
    tabIntimation.addEventListener("click", () => {
      setActiveWorkspace("intimation");
    });
  }

  const logoutBtn = document.getElementById("btn-topbar-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await logoutUser();
      window.location.hash = "#/login";
    });
  }
}

