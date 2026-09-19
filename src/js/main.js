// ============================================================================
// Motorola Happy Calling - Application Entry Point
// ============================================================================

import { initializeAuth, onAuthStateChanged } from "./auth.js";
import { initRouter } from "./router.js";
import { startInactivityTracker, stopInactivityTracker } from "./session-timeout.js";
import { showToast } from "../components/toast.js";

// Automatic Session Timeout: 5 minutes of inactivity for any logged-in user
onAuthStateChanged((profile) => {
  if (profile) {
    startInactivityTracker();
  } else {
    stopInactivityTracker();
  }
});

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

// Boot the portal safely even if DOM is already parsed
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApplication);
} else {
  startApplication();
}
