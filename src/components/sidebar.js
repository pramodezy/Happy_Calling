// ============================================================================
// Sidebar & Mobile Bottom Navigation Component
// ============================================================================

import { icons, escapeHtml } from "../js/utils.js";
import { getCurrentProfile, isAdmin, logoutUser } from "../js/auth.js";
import { getActiveWorkspace } from "../js/workspace.js";

export function renderSidebar(currentPath = "#/dashboard", pendingBadgeCount = 0) {
  const admin = isAdmin();
  const profile = getCurrentProfile() || {};
  const workspace = getActiveWorkspace();

  // Happy Calling workspace navigation
  const happyCciNav = [
    { path: "#/dashboard", label: "Dashboard", icon: icons.dashboard },
    { path: "#/happy-calling", label: "Start Happy Calling", icon: icons.phone, badge: "Action" },
    { path: "#/pending", label: "Pending Calls", icon: icons.clock, count: pendingBadgeCount },
    { path: "#/completed", label: "Completed Calls", icon: icons.checkCircle },
    { path: "#/performance", label: "My Performance", icon: icons.award },
    { path: "#/profile", label: "My Profile", icon: icons.user },
  ];

  const happyAdminNav = [
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

  // Intimation Calling workspace navigation
  const intimationCciNav = [
    { path: "#/intimation/dashboard", label: "Intimation Overview", icon: icons.dashboard },
    { path: "#/intimation/calling", label: "ETR Calling Window", icon: icons.phone, badge: ">3d ETR" },
    { path: "#/intimation/pending", label: "Open Calls Backlog", icon: icons.clock },
    { path: "#/intimation/history", label: "Intimation History", icon: icons.checkCircle },
    { path: "#/performance", label: "My Performance", icon: icons.award },
    { path: "#/profile", label: "My Profile", icon: icons.user },
  ];

  const intimationAdminNav = [
    { section: "Intimation Analytics" },
    { path: "#/intimation/admin", label: "Intimation Admin", icon: icons.dashboard },
    { path: "#/intimation/dashboard", label: "Intimation Overview", icon: icons.award },
    { path: "#/intimation/pending", label: "Open Calls Backlog", icon: icons.clock },
    { path: "#/intimation/history", label: "Intimation History", icon: icons.fileText },
    { section: "Operations" },
    { path: "#/intimation/import", label: "Upload Open Calls", icon: icons.upload },
    { path: "#/intimation/calling", label: "ETR Calling Window", icon: icons.phone },
    { section: "Administration" },
    { path: "#/admin/users", label: "User Management", icon: icons.users },
    { path: "#/admin/cci", label: "CCI Management", icon: icons.mapPin },
    { path: "#/admin/audit", label: "Audit Log", icon: icons.fileText },
    { path: "#/profile", label: "My Profile", icon: icons.user },
  ];

  let items;
  if (workspace === "intimation") {
    items = admin ? intimationAdminNav : intimationCciNav;
  } else {
    items = admin ? happyAdminNav : happyCciNav;
  }

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

  const logoHref = workspace === "intimation"
    ? (admin ? "#/intimation/admin" : "#/intimation/dashboard")
    : (admin ? "#/admin" : "#/dashboard");

  return `
    <div class="sidebar-backdrop"></div>
    <aside class="sidebar">
      <div class="sidebar-header">
        <a href="${logoHref}" class="sidebar-logo">
          <div class="logo-icon-wrap">M</div>
          <div class="logo-text-wrap">
            <span class="logo-title">Motorola Care</span>
            <span class="logo-sub">${admin ? "Enterprise Admin" : escapeHtml(profile.cci_code || "CCI Portal")}</span>
          </div>
        </a>
      </div>

      <!-- Workspace Context Indicator -->
      <div style="padding:0.75rem 1.25rem 0.25rem;">
        <div style="font-size:0.68rem; font-weight:800; text-transform:uppercase; letter-spacing:0.8px; color:var(--text-tertiary); display:flex; align-items:center; gap:6px;">
          <span style="width:6px; height:6px; border-radius:50%; background:${workspace === 'intimation' ? '#ef4444' : 'var(--moto-blue-accent)'};"></span>
          <span>${workspace === 'intimation' ? 'Intimation Workspace' : 'Happy Calling Workspace'}</span>
        </div>
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
  const workspace = getActiveWorkspace();

  if (workspace === "intimation") {
    const homePath = admin ? "#/intimation/admin" : "#/intimation/dashboard";
    return `
      <nav class="mobile-bottom-nav">
        <a href="${homePath}" class="mobile-nav-item ${currentPath === homePath ? "active" : ""}">
          ${icons.dashboard}
          <span>Overview</span>
        </a>
        <a href="#/intimation/pending" class="mobile-nav-item ${currentPath === "#/intimation/pending" ? "active" : ""}">
          ${icons.clock}
          <span>Backlog</span>
        </a>
        <a href="#/intimation/calling" class="mobile-nav-item ${currentPath === "#/intimation/calling" ? "active" : ""}" style="color:#ef4444; font-weight:700;">
          <div style="background:#ef4444; color:#fff; border-radius:50%; width:32px; height:32px; display:flex; align-items:center; justify-content:center; margin-top:-14px; box-shadow:0 3px 8px rgba(239,68,68,0.4);">
            <span style="width:16px; height:16px;">${icons.phone}</span>
          </div>
          <span>ETR Call</span>
        </a>
        <a href="#/intimation/history" class="mobile-nav-item ${currentPath === "#/intimation/history" ? "active" : ""}">
          ${icons.checkCircle}
          <span>History</span>
        </a>
        <a href="#/profile" class="mobile-nav-item ${currentPath === "#/profile" ? "active" : ""}">
          ${icons.user}
          <span>Profile</span>
        </a>
      </nav>
    `;
  }

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
