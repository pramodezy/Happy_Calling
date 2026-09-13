// ============================================================================
// Sidebar & Mobile Bottom Navigation Component
// ============================================================================

import { icons, escapeHtml } from "../js/utils.js";
import { getCurrentProfile, isAdmin, logoutUser } from "../js/auth.js";

export function renderSidebar(currentPath = "#/dashboard", pendingBadgeCount = 0) {
  const admin = isAdmin();
  const profile = getCurrentProfile() || {};

  const cciNavItems = [
    { path: "#/dashboard", label: "Dashboard", icon: icons.dashboard },
    { path: "#/happy-calling", label: "Start Happy Calling", icon: icons.phone, badge: "Action" },
    { path: "#/pending", label: "Pending Calls", icon: icons.clock, count: pendingBadgeCount },
    { path: "#/completed", label: "Completed Calls", icon: icons.checkCircle },
    { path: "#/performance", label: "My Performance", icon: icons.award },
    { path: "#/profile", label: "My Profile", icon: icons.user },
  ];

  const adminNavItems = [
    { section: "Analytics & Monitoring" },
    { path: "#/admin", label: "Admin Dashboard", icon: icons.dashboard },
    { path: "#/admin/performance", label: "CCI Performance", icon: icons.award },
    { path: "#/admin/ageing", label: "Pending Ageing", icon: icons.clock },
    { path: "#/admin/feedback", label: "Feedback Analysis", icon: icons.smile },
    { section: "Operations" },
    { path: "#/admin/closures", label: "Closure Database", icon: icons.database },
    { path: "#/admin/import", label: "Closure Import", icon: icons.upload },
    { path: "#/admin/happy-calling", label: "Happy Calling Test", icon: icons.phone },
    { section: "Administration" },
    { path: "#/admin/users", label: "User Management", icon: icons.users },
    { path: "#/admin/cci", label: "CCI Management", icon: icons.mapPin },
    { path: "#/admin/audit", label: "Audit Log", icon: icons.fileText },
    { path: "#/profile", label: "My Profile", icon: icons.user },
  ];

  const items = admin ? adminNavItems : cciNavItems;

  let menuHtml = "";
  items.forEach((item) => {
    if (item.section) {
      menuHtml += `<div class="sidebar-section-title">${item.section}</div>`;
      return;
    }
    const isActive = currentPath === item.path;
    let badgeHtml = "";
    if (item.badge) {
      badgeHtml = `<span class="sidebar-badge" style="background:var(--moto-gold); color:#000;">${item.badge}</span>`;
    } else if (item.count !== undefined && item.count > 0) {
      badgeHtml = `<span class="sidebar-badge">${item.count}</span>`;
    }

    menuHtml += `
      <li>
        <a href="${item.path}" class="sidebar-link ${isActive ? "active" : ""}">
          <span style="display:flex; align-items:center;">${item.icon}</span>
          <span>${item.label}</span>
          ${badgeHtml}
        </a>
      </li>
    `;
  });

  return `
    <div class="sidebar-backdrop"></div>
    <aside class="sidebar">
      <div class="sidebar-header">
        <a href="${admin ? "#/admin" : "#/dashboard"}" class="sidebar-logo">
          <div class="logo-icon-wrap">M</div>
          <div class="logo-text-wrap">
            <span class="logo-title">Motorola Care</span>
            <span class="logo-sub">${admin ? "Enterprise Admin" : escapeHtml(profile.cci_code || "CCI Portal")}</span>
          </div>
        </a>
      </div>

      <div class="sidebar-content">
        <ul class="sidebar-menu">
          ${menuHtml}
        </ul>
      </div>

      <div class="sidebar-footer">
        <button type="button" id="btn-sidebar-logout" class="sidebar-link" style="width:100%; border:none; text-align:left; color:#fca5a5;">
          <span style="display:flex; align-items:center;">${icons.logOut}</span>
          <span>Sign Out</span>
        </button>
      </div>
    </aside>
  `;
}

export function renderMobileBottomNav(currentPath = "#/dashboard", pendingCount = 0) {
  const admin = isAdmin();

  if (admin) {
    return `
      <nav class="mobile-bottom-nav">
        <a href="#/admin" class="mobile-nav-item ${currentPath === "#/admin" ? "active" : ""}">
          ${icons.dashboard}
          <span>Overview</span>
        </a>
        <a href="#/admin/performance" class="mobile-nav-item ${currentPath === "#/admin/performance" ? "active" : ""}">
          ${icons.award}
          <span>CCIs</span>
        </a>
        <a href="#/admin/closures" class="mobile-nav-item ${currentPath === "#/admin/closures" ? "active" : ""}">
          ${icons.database}
          <span>Closures</span>
        </a>
        <a href="#/admin/import" class="mobile-nav-item ${currentPath === "#/admin/import" ? "active" : ""}">
          ${icons.upload}
          <span>Import</span>
        </a>
        <a href="#/profile" class="mobile-nav-item ${currentPath === "#/profile" ? "active" : ""}">
          ${icons.user}
          <span>Profile</span>
        </a>
      </nav>
    `;
  }

  return `
    <nav class="mobile-bottom-nav">
      <a href="#/dashboard" class="mobile-nav-item ${currentPath === "#/dashboard" ? "active" : ""}">
        ${icons.dashboard}
        <span>Dashboard</span>
      </a>
      <a href="#/pending" class="mobile-nav-item ${currentPath === "#/pending" ? "active" : ""}">
        ${icons.clock}
        <span>Pending</span>
        ${pendingCount > 0 ? `<span class="mobile-nav-badge">${pendingCount}</span>` : ""}
      </a>
      <a href="#/happy-calling" class="mobile-nav-item ${currentPath === "#/happy-calling" ? "active" : ""}" style="color:var(--moto-blue-accent); font-weight:700;">
        <div style="background:var(--moto-blue-accent); color:#fff; border-radius:50%; width:32px; height:32px; display:flex; align-items:center; justify-content:center; margin-top:-14px; box-shadow:0 3px 8px rgba(0,114,206,0.4);">
          <span style="width:16px; height:16px;">${icons.phone}</span>
        </div>
        <span>Call</span>
      </a>
      <a href="#/completed" class="mobile-nav-item ${currentPath === "#/completed" ? "active" : ""}">
        ${icons.checkCircle}
        <span>Completed</span>
      </a>
      <a href="#/profile" class="mobile-nav-item ${currentPath === "#/profile" ? "active" : ""}">
        ${icons.user}
        <span>Profile</span>
      </a>
    </nav>
  `;
}

export function initSidebarEvents() {
  const logoutBtn = document.getElementById("btn-sidebar-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await logoutUser();
      window.location.hash = "#/login";
    });
  }

  // Close mobile sidebar on link clicks
  const sidebar = document.querySelector(".sidebar");
  const backdrop = document.querySelector(".sidebar-backdrop");
  document.querySelectorAll(".sidebar-link").forEach((link) => {
    link.addEventListener("click", () => {
      if (sidebar && backdrop && window.innerWidth < 1024) {
        sidebar.classList.remove("open");
        backdrop.classList.remove("active");
      }
    });
  });
}
