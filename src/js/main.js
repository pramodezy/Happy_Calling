// ============================================================================
// Motorola Happy Calling - Application Entry Point
// ============================================================================

import { initializeAuth } from "./auth.js";
import { initRouter } from "./router.js";
import { showToast } from "../components/toast.js";

// Restore stored credentials if entered in browser setup fallback
if (!window.__SUPABASE_URL__ && localStorage.getItem("__MOTO_SU_URL__")) {
  window.__SUPABASE_URL__ = localStorage.getItem("__MOTO_SU_URL__");
  window.__SUPABASE_ANON_KEY__ = localStorage.getItem("__MOTO_SU_KEY__");
}

async function startApplication() {
  try {
    // 1. Initialize Supabase Auth & load profile
    await initializeAuth();

    // 2. Initialize Client Hash Router
    initRouter();
  } catch (err) {
    console.error("Initialization error:", err);
    showToast("Failed to initialize application session.", "error");
  }
}

// Global Network and Error Handlers
window.addEventListener("online", () => {
  showToast("Network connection restored.", "success");
});

window.addEventListener("offline", () => {
  showToast("Network connection lost. Please check internet access.", "warning");
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled Rejection:", event.reason);
  // Prevent noisy default alert if handled gracefully
});

// Boot the portal
document.addEventListener("DOMContentLoaded", startApplication);
