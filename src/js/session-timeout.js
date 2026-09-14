// ============================================================================
// Motorola Happy Calling - Session Inactivity Auto-Logout Manager
// Automatically logs out user after 5 minutes (300 seconds) of inactivity.
// Displays a 30-second warning countdown modal before logging out.
// Synchronizes activity across multiple browser tabs via localStorage.
// ============================================================================

import { getCurrentProfile, logoutUser } from "./auth.js";
import { openModal, closeModal } from "../components/modal.js";
import { showToast } from "../components/toast.js";
import { icons } from "./utils.js";

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (300,000 ms)
const WARNING_THRESHOLD_MS = INACTIVITY_TIMEOUT_MS - 30 * 1000; // 4 minutes 30 seconds (270,000 ms)
const CHECK_INTERVAL_MS = 1000; // 1 second ticker
const STORAGE_KEY = "__MOTO_LAST_ACTIVITY__";
const THROTTLE_MS = 1000; // Throttle activity updates to at most once per second

let checkIntervalId = null;
let lastActivityTime = Date.now();
let lastRecordTime = 0;
let isWarningModalOpen = false;
let isTrackerActive = false;

/**
 * Record user activity and synchronize with localStorage
 */
export function recordUserActivity() {
  const now = Date.now();
  // Throttle updates to minimize overhead
  if (now - lastRecordTime < THROTTLE_MS) return;

  lastRecordTime = now;
  lastActivityTime = now;

  try {
    localStorage.setItem(STORAGE_KEY, String(now));
  } catch (e) {
    // Ignore storage quota or disabled storage
  }

  // If warning modal was open and user interacts, dismiss it
  if (isWarningModalOpen) {
    closeModal();
    isWarningModalOpen = false;
  }
}

/**
 * Check inactivity status and trigger warning or logout
 */
async function checkInactivity() {
  const profile = getCurrentProfile();
  if (!profile) {
    stopInactivityTracker();
    return;
  }

  // Read latest activity from cross-tab localStorage
  try {
    const storedTime = localStorage.getItem(STORAGE_KEY);
    if (storedTime) {
      const parsed = parseInt(storedTime, 10);
      if (!isNaN(parsed) && parsed > lastActivityTime) {
        lastActivityTime = parsed;
        if (isWarningModalOpen) {
          closeModal();
          isWarningModalOpen = false;
        }
      }
    }
  } catch (e) {}

  const elapsed = Date.now() - lastActivityTime;

  // 1. Time is up (>= 5 minutes of inactivity)
  if (elapsed >= INACTIVITY_TIMEOUT_MS) {
    stopInactivityTracker();
    if (isWarningModalOpen) {
      closeModal();
      isWarningModalOpen = false;
    }

    try {
      await logoutUser("INACTIVITY");
    } catch (err) {
      console.error("Auto-logout error:", err);
    }

    window.location.hash = "#/login";
    showToast("You have been automatically logged out due to 5 minutes of inactivity.", "warning", 8000);
    return;
  }

  // 2. Warning period reached (remaining <= 30 seconds)
  if (elapsed >= WARNING_THRESHOLD_MS) {
    const remainingSeconds = Math.max(1, Math.ceil((INACTIVITY_TIMEOUT_MS - elapsed) / 1000));
    if (!isWarningModalOpen) {
      showInactivityWarningModal(remainingSeconds);
    } else {
      updateCountdownDisplay(remainingSeconds);
    }
  } else if (isWarningModalOpen) {
    closeModal();
    isWarningModalOpen = false;
  }
}

/**
 * Display the timeout warning modal with live seconds countdown
 */
function showInactivityWarningModal(secondsRemaining) {
  isWarningModalOpen = true;

  const contentHtml = `
    <div style="text-align:center; padding:1rem 0.5rem;">
      <div style="width:54px; height:54px; background:#fffbeb; border:2px solid #fde68a; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; color:#d97706; margin-bottom:1rem;">
        <span style="width:28px; height:28px;">${icons.clock}</span>
      </div>
      <h3 style="font-size:1.15rem; font-weight:700; color:var(--text-primary); margin-bottom:0.5rem;">Session Expiring Due to Inactivity</h3>
      <p style="font-size:0.875rem; color:var(--text-secondary); line-height:1.5; margin-bottom:1.25rem;">
        You have been inactive for more than 4 minutes. For security, your session will automatically terminate in:
      </p>
      <div style="display:inline-block; padding:0.5rem 1.25rem; background:rgba(0,114,206,0.08); border:1px solid rgba(0,114,206,0.25); border-radius:8px; margin-bottom:1rem;">
        <span id="session-timeout-countdown" style="font-size:1.5rem; font-weight:800; font-family:monospace; color:var(--moto-blue-accent);">${secondsRemaining}</span>
        <span style="font-size:0.875rem; color:var(--text-secondary); font-weight:600; margin-left:4px;">seconds</span>
      </div>
    </div>
  `;

  const footerHtml = `
    <button type="button" class="btn-secondary" id="btn-timeout-logout-now" style="font-size:0.875rem;">Log Out Now</button>
    <button type="button" class="btn-primary" id="btn-timeout-stay-logged-in" style="font-size:0.875rem;">Stay Logged In</button>
  `;

  const overlay = openModal({
    title: "Inactivity Notice",
    contentHtml,
    footerHtml,
    size: "small",
    onClose: () => {
      isWarningModalOpen = false;
    },
  });

  if (overlay) {
    overlay.querySelector("#btn-timeout-stay-logged-in")?.addEventListener("click", () => {
      recordUserActivity();
      closeModal();
      isWarningModalOpen = false;
      showToast("Session extended successfully.", "success");
    });

    overlay.querySelector("#btn-timeout-logout-now")?.addEventListener("click", async () => {
      closeModal();
      isWarningModalOpen = false;
      stopInactivityTracker();
      await logoutUser();
      window.location.hash = "#/login";
      showToast("Logged out successfully.", "info");
    });
  }
}

/**
 * Update the remaining seconds text inside the modal
 */
function updateCountdownDisplay(seconds) {
  const el = document.getElementById("session-timeout-countdown");
  if (el) {
    el.textContent = String(seconds);
  }
}

// User interaction events to monitor
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"];

function handleUserActivityEvent() {
  recordUserActivity();
}

function handleStorageEvent(e) {
  if (e.key === STORAGE_KEY && e.newValue) {
    const parsed = parseInt(e.newValue, 10);
    if (!isNaN(parsed) && parsed > lastActivityTime) {
      lastActivityTime = parsed;
      if (isWarningModalOpen) {
        closeModal();
        isWarningModalOpen = false;
      }
    }
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    // When tab gains focus again, check if timeout elapsed during background
    checkInactivity();
  }
}

/**
 * Start the inactivity tracker (invoked upon user login / session restore)
 */
export function startInactivityTracker() {
  if (isTrackerActive) return;

  const now = Date.now();
  lastActivityTime = now;
  try {
    localStorage.setItem(STORAGE_KEY, String(now));
  } catch (e) {}

  ACTIVITY_EVENTS.forEach((evt) => {
    window.addEventListener(evt, handleUserActivityEvent, { passive: true });
  });

  window.addEventListener("storage", handleStorageEvent);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  if (checkIntervalId) clearInterval(checkIntervalId);
  checkIntervalId = setInterval(checkInactivity, CHECK_INTERVAL_MS);

  isTrackerActive = true;
}

/**
 * Stop the inactivity tracker (invoked upon logout)
 */
export function stopInactivityTracker() {
  if (!isTrackerActive) return;

  ACTIVITY_EVENTS.forEach((evt) => {
    window.removeEventListener(evt, handleUserActivityEvent);
  });

  window.removeEventListener("storage", handleStorageEvent);
  document.removeEventListener("visibilitychange", handleVisibilityChange);

  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }

  if (isWarningModalOpen) {
    closeModal();
    isWarningModalOpen = false;
  }

  isTrackerActive = false;
}
