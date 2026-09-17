// ============================================================================
// Client-Side Hash Router with Role-Based Route Guarding
// ============================================================================

import { getCurrentProfile, isAdmin, isBSM, hasAdminOrBsmAccess, isCCIUser, logoutUser, initializeAuth } from "./auth.js";
import { isSupabaseConfigured } from "./supabase.js";
import { renderSidebar, renderMobileBottomNav, initSidebarEvents } from "../components/sidebar.js";
import { renderNavbar, initNavbarEvents } from "../components/navbar.js";
import { renderDashboardPage } from "./dashboard.js";
import { renderHappyCallingPage } from "./happy-calling.js";
import { renderPendingPage } from "./pending.js";
import { renderCompletedPage } from "./completed.js";
import { renderPerformancePage } from "./performance.js";
import { renderAdminDashboard, cleanupAdminDashboard } from "./admin.js";
import { renderAdminPerformancePage, cleanupAdminPerformance } from "./admin-performance.js";
import { renderAdminAgeingPage, cleanupAdminAgeing } from "./admin-ageing.js";
import { renderAdminFeedbackPage, cleanupAdminFeedback } from "./admin-feedback.js";
import { renderUsersPage } from "./users.js";
import { renderCciPage } from "./cci.js";
import { renderClosuresPage } from "./closures.js";
import { renderImportPage } from "./import.js";
import { renderAuditPage } from "./audit.js";
import { renderIntimationCallingPage } from "./intimation-calling.js";
import { renderIntimationPendingPage } from "./intimation-pending.js";
import { renderIntimationHistoryPage } from "./intimation-history.js";
import { renderIntimationPerformancePage } from "./intimation-performance.js";
import { renderIntimationImportPage } from "./intimation-import.js";
import { renderAdminIntimationPage } from "./admin-intimation.js";
import { renderIntimationDashboardPage } from "./intimation-dashboard.js";
import { showToast } from "../components/toast.js";
import { getActiveWorkspace } from "./workspace.js";
import { escapeHtml, formatDateTime, icons } from "./utils.js";

/**
 * Route Configuration
 */
const routes = {
  // Public Routes
  "#/login": { render: renderLoginPage, isPublic: true },

  // Authenticated Standard Routes (CCI Users)
  "#/dashboard": { render: renderDashboardPage, requiresAuth: true },
  "#/happy-calling": { render: renderHappyCallingPage, requiresAuth: true },
  "#/pending": { render: renderPendingPage, requiresAuth: true },
  "#/completed": { render: renderCompletedPage, requiresAuth: true },
  "#/performance": { render: renderPerformancePage, requiresAuth: true },
  "#/profile": { render: renderProfilePage, requiresAuth: true },

  // Admin & Regional Manager (BSM) Routes
  "#/admin": { render: renderAdminDashboard, requiresAuth: true, adminOrBsm: true },
  "#/admin/performance": { render: renderAdminPerformancePage, requiresAuth: true, adminOrBsm: true },
  "#/admin/ageing": { render: renderAdminAgeingPage, requiresAuth: true, adminOrBsm: true },
  "#/admin/feedback": { render: renderAdminFeedbackPage, requiresAuth: true, adminOrBsm: true },
  "#/admin/closures": { render: renderClosuresPage, requiresAuth: true, adminOrBsm: true },
  "#/admin/import": { render: renderImportPage, requiresAuth: true, adminOnly: true },
  "#/admin/happy-calling": { render: renderHappyCallingPage, requiresAuth: true, adminOrBsm: true },
  "#/admin/users": { render: renderUsersPage, requiresAuth: true, adminOnly: true },
  "#/admin/cci": { render: renderCciPage, requiresAuth: true, adminOnly: true },
  "#/admin/audit": { render: renderAuditPage, requiresAuth: true, adminOnly: true },

  // Intimation Calling Routes
  "#/intimation/dashboard": { render: renderIntimationDashboardPage, requiresAuth: true },
  "#/intimation/calling": { render: renderIntimationCallingPage, requiresAuth: true },
  "#/intimation/pending": { render: renderIntimationPendingPage, requiresAuth: true },
  "#/intimation/history": { render: renderIntimationHistoryPage, requiresAuth: true },
  "#/intimation/performance": { render: renderIntimationPerformancePage, requiresAuth: true },
  "#/intimation/import": { render: renderIntimationImportPage, requiresAuth: true, adminOnly: true },
  "#/intimation/admin": { render: renderAdminIntimationPage, requiresAuth: true, adminOrBsm: true },
};

/**
 * Initialize and start routing
 */
export function initRouter() {
  window.addEventListener("hashchange", handleRouteChange);
  handleRouteChange();
}

/**
 * Handle navigation on hash change
 */
export async function handleRouteChange() {
  cleanupAdminDashboard();
  cleanupAdminPerformance();
  cleanupAdminAgeing();
  cleanupAdminFeedback();

  let hash = window.location.hash || "";
  if (!hash || hash === "#" || hash === "#/") {
    const profile = getCurrentProfile();
    const ws = getActiveWorkspace();
    if (ws === "intimation") {
      hash = profile ? (hasAdminOrBsmAccess() ? "#/intimation/admin" : "#/intimation/dashboard") : "#/login";
    } else {
      hash = profile ? (hasAdminOrBsmAccess() ? "#/admin" : "#/dashboard") : "#/login";
    }
    window.location.hash = hash;
    return;
  }

  const routePath = hash.split("?")[0];
  const route = routes[routePath] || routes["#/dashboard"];
  const appRoot = document.getElementById("app");
  if (!appRoot) return;

  const profile = getCurrentProfile();

  // Guard: If not authenticated and route is protected -> redirect to login
  if (route.requiresAuth && !profile) {
    window.location.hash = "#/login";
    return;
  }

  // Guard: If authenticated and trying to access login -> redirect to home
  if (route.isPublic && profile) {
    window.location.hash = hasAdminOrBsmAccess() ? "#/admin" : "#/dashboard";
    return;
  }

  // Guard: Admin-only route guard
  if (route.adminOnly && !isAdmin()) {
    showToast("Unauthorized access. Super Administrator privileges required.", "error");
    window.location.hash = hasAdminOrBsmAccess() ? "#/admin" : "#/dashboard";
    return;
  }

  // Guard: Admin or Regional Manager (BSM) route guard
  if (route.adminOrBsm && !hasAdminOrBsmAccess()) {
    showToast("Unauthorized access. Regional Manager or Admin privileges required.", "error");
    window.location.hash = "#/dashboard";
    return;
  }

  // Render Login layout or Authenticated Enterprise Shell layout
  if (routePath === "#/login") {
    appRoot.innerHTML = `<div id="login-viewport" style="min-height:100vh; width:100%;"></div>`;
    const loginMount = document.getElementById("login-viewport");
    renderLoginPage(loginMount);
  } else {
    // Authenticated Shell with Sidebar, Topbar, Mobile Nav, and Content Viewport
    appRoot.innerHTML = `
      ${renderSidebar(routePath)}
      <div class="layout-main">
        ${renderNavbar()}
        <main class="content-viewport" id="content-mount"></main>
      </div>
      ${renderMobileBottomNav(routePath)}
    `;

    initSidebarEvents();
    initNavbarEvents();

    const mount = document.getElementById("content-mount");
    if (mount && typeof route.render === "function") {
      await route.render(mount);
    }
  }
}

/**
 * Render Login Page View
 */
function renderLoginPage(container) {
  const isConfigured = isSupabaseConfigured();

  container.innerHTML = `
    <div style="min-height:100vh; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg, #001435 0%, #0a2550 100%); padding:1.25rem;">
      <div style="width:100%; max-width:440px; background:var(--bg-surface); border-radius:var(--radius-xl); padding:2.25rem; box-shadow:var(--shadow-xl);">
        <!-- Motorola Brand Header -->
        <div style="text-align:center; margin-bottom:1.75rem;">
          <div style="width:52px; height:52px; background:var(--moto-blue-primary); border-radius:var(--radius-lg); display:inline-flex; align-items:center; justify-content:center; margin-bottom:0.75rem;">
            <span style="color:#ffffff; font-weight:900; font-size:1.6rem; letter-spacing:-1px;">M</span>
          </div>
          <h2 style="font-size:1.4rem; font-weight:800; color:var(--moto-blue-primary);">Motorola Happy Calling</h2>
          <p style="font-size:0.875rem; color:var(--text-secondary); margin-top:0.25rem;">CCI Service Portal & Operations Center</p>
        </div>

        ${
          !isConfigured
            ? `
          <div style="padding:1rem; background:#fffbeb; border:1px solid #fde68a; border-radius:var(--radius-md); margin-bottom:1.25rem; font-size:0.8125rem; color:#92400e;">
            <strong>Supabase Setup Note:</strong> Configure <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in your environment or enter them below to connect.
            <div style="margin-top:0.5rem;">
              <input type="text" id="manual-supabase-url" class="form-input" style="font-size:0.75rem; margin-bottom:4px;" placeholder="https://xyz.supabase.co">
              <input type="text" id="manual-supabase-key" class="form-input" style="font-size:0.75rem;" placeholder="anon-key...">
              <button type="button" id="btn-save-manual-creds" class="btn-primary" style="margin-top:6px; font-size:0.75rem; padding:4px 8px; width:100%; justify-content:center;">Connect</button>
            </div>
          </div>
        `
            : ""
        }

        <!-- Login Form -->
        <form id="login-form" novalidate>
          <div class="form-group">
            <label for="login-email" class="form-label">Username / Station Code / Email</label>
            <input type="text" id="login-email" class="form-input" required placeholder="e.g. cci_65 or admin@motorolacare.in" autocomplete="username">
            <div style="font-size:0.75rem; color:var(--text-tertiary); margin-top:4px;">
              CCI Centers: Enter your station username (e.g. <code>cci_65</code>)
            </div>
          </div>

          <div class="form-group">
            <label for="login-password" class="form-label" style="display:flex; justify-content:space-between;">
              <span>Password</span>
            </label>
            <input type="password" id="login-password" class="form-input" required placeholder="••••••••" autocomplete="current-password">
          </div>

          <button type="submit" id="btn-login-submit" class="btn-primary" style="width:100%; justify-content:center; padding:0.85rem; font-size:1rem; margin-top:0.5rem;">
            <span>Sign In to Service Portal</span>
          </button>
        </form>

        <!-- Security Footer Notice -->
        <div style="margin-top:1.75rem; text-align:center; border-top:1px solid var(--border-subtle); padding-top:1rem; font-size:0.75rem; color:var(--text-tertiary);">
          Protected by Supabase Auth & PostgreSQL Row Level Security (RLS). Unauthorized access is logged and audited.
        </div>
      </div>
    </div>
  `;

  // Manual Credentials helper if running before .env is populated
  document.getElementById("btn-save-manual-creds")?.addEventListener("click", () => {
    const url = document.getElementById("manual-supabase-url")?.value.trim();
    const key = document.getElementById("manual-supabase-key")?.value.trim();
    if (url && key) {
      window.__SUPABASE_URL__ = url;
      window.__SUPABASE_ANON_KEY__ = key;
      localStorage.setItem("__MOTO_SU_URL__", url);
      localStorage.setItem("__MOTO_SU_KEY__", key);
      window.location.reload();
    }
  });

  // Login Form Submission
  const form = document.getElementById("login-form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email")?.value.trim();
    const password = document.getElementById("login-password")?.value;
    const submitBtn = document.getElementById("btn-login-submit");

    if (!email || !password) {
      showToast("Please enter both email and password.", "warning");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = `Signing In...`;

    try {
      const { loginWithEmail } = await import("./auth.js");
      const { profile } = await loginWithEmail(email, password);

      showToast(`Welcome back, ${profile.user_name}!`, "success");
      window.location.hash = profile.role === "ADMIN" ? "#/admin" : "#/dashboard";
    } catch (err) {
      console.error("Login failed:", err);
      showToast(err.message, "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<span>Sign In to Service Portal</span>`;
    }
  });
}

/**
 * Render Profile Page View
 */
function renderProfilePage(container) {
  const profile = getCurrentProfile() || {};

  container.innerHTML = `
    <div style="max-width:650px; margin:0 auto;">
      <div style="margin-bottom:1.5rem;">
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">User Profile & Preferences</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Your Motorola Service Portal account details.</p>
      </div>

      <div class="customer-detail-card">
        <div style="display:flex; align-items:center; gap:1rem; margin-bottom:1.25rem;">
          <div class="user-avatar-circle" style="width:52px; height:52px; font-size:1.25rem;">
            ${profile.user_name ? profile.user_name.substring(0, 2).toUpperCase() : "M"}
          </div>
          <div>
            <h3 style="font-size:1.15rem; font-weight:700;">${escapeHtml(profile.user_name || "User")}</h3>
            <span class="badge ${profile.role === "ADMIN" ? "badge-info" : profile.role === "BSM" ? "badge-warning" : "badge-neutral"}">
              ${profile.role === "ADMIN" ? "Enterprise Administrator" : profile.role === "BSM" ? "Regional Manager (BSM)" : "CCI Partner Agent"}
            </span>
          </div>
        </div>

        <div class="customer-meta-grid">
          ${
            profile.role === "BSM"
              ? `
            <div class="customer-meta-item" style="grid-column: 1 / -1;">
              <span class="meta-label">Assigned Operating Regions</span>
              <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:4px;">
                ${
                  Array.isArray(profile.assigned_regions) && profile.assigned_regions.length > 0
                    ? profile.assigned_regions.map(r => `<span class="badge badge-info" style="font-size:0.75rem; padding:2px 8px;">${escapeHtml(r)}</span>`).join("")
                    : `<span style="color:var(--text-tertiary); font-style:italic;">No regions assigned</span>`
                }
              </div>
            </div>
          `
              : `
            <div class="customer-meta-item">
              <span class="meta-label">Assigned CCI Code</span>
              <span class="meta-value" style="font-family:monospace; color:var(--moto-blue-accent);">${escapeHtml(profile.cci_code || "National HQ")}</span>
            </div>

            <div class="customer-meta-item">
              <span class="meta-label">CCI Location Name</span>
              <span class="meta-value">${escapeHtml(profile.cci_name || "Enterprise All")}</span>
            </div>
          `
          }

          <div class="customer-meta-item">
            <span class="meta-label">Account Status</span>
            <span class="meta-value" style="color:var(--status-success-dot);">Active</span>
          </div>

          <div class="customer-meta-item">
            <span class="meta-label">Last Login</span>
            <span class="meta-value">${formatDateTime(profile.last_login)}</span>
          </div>
        </div>

        <div style="margin-top:1.5rem; pt:1rem; border-top:1px solid var(--border-subtle); display:flex; justify-content:flex-end;">
          <button type="button" id="btn-profile-logout" class="btn-secondary" style="color:var(--status-danger-dot);">
            <span>Sign Out of Account</span>
          </button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("btn-profile-logout")?.addEventListener("click", async () => {
    await logoutUser();
    window.location.hash = "#/login";
  });
}
