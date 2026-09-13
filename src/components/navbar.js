// ============================================================================
// Topbar / Navbar Component
// ============================================================================

import { icons, escapeHtml } from "../js/utils.js";
import { getCurrentProfile, logoutUser } from "../js/auth.js";

export function renderNavbar() {
  const profile = getCurrentProfile() || {};
  const initials = profile.user_name ? profile.user_name.substring(0, 2).toUpperCase() : "MO";
  const roleLabel = profile.role === "ADMIN" ? "Company Administrator" : `${profile.cci_code || "CCI"} Partner`;

  return `
    <header class="topbar">
      <div class="topbar-left">
        <button type="button" id="btn-sidebar-toggle" class="mobile-only" style="padding:6px; color:var(--text-primary);" aria-label="Toggle Navigation">
          <span style="display:block; width:22px; height:22px;">${icons.menu}</span>
        </button>
        <div class="topbar-brand-title">
          <span>Motorola Happy Calling</span>
          <span class="topbar-subtitle">CCI Service Portal</span>
        </div>
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

  const logoutBtn = document.getElementById("btn-topbar-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await logoutUser();
      window.location.hash = "#/login";
    });
  }
}
