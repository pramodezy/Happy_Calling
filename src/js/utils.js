// ============================================================================
// Motorola Happy Calling - Utilities & Helpers
// ============================================================================

/**
 * Format a Date or ISO string into a human-readable format (e.g. "12 Oct 2026, 02:30 PM")
 */
export function formatDateTime(dateInput) {
  if (!dateInput) return "—";
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Format Date only (e.g. "12 Oct 2026")
 */
export function formatDate(dateInput) {
  if (!dateInput) return "—";
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

/**
 * Strip Excel formula wrapping (e.g. ="578004" -> 578004) and quotes
 */
export function cleanCellVal(val) {
  if (val === null || val === undefined) return "";
  let s = String(val).trim();
  if (s.startsWith('="') && s.endsWith('"')) {
    s = s.slice(2, -1);
  }
  return s.replace(/^["']+|["']+$/g, "").trim();
}

/**
 * Robust date parser for Motorola CSV/Excel files:
 * 1. DD/MM/YYYY or DD/MM/YY (supports 2-digit years like 10/09/26 19:22 -> 2026)
 * 2. ISO 8601 strings (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS) - Motorola original dump
 * 3. 12-hour format with AM/PM (e.g. "12/09/2026  7:21:00 PM")
 * 4. Excel serial numbers (e.g. 45548.697)
 * 5. JavaScript Date objects
 */
export function parseFlexibleDate(rawVal, fallbackToNow = false) {
  if (rawVal === null || rawVal === undefined || rawVal === "") {
    return fallbackToNow ? new Date().toISOString() : null;
  }

  // 1. If already a valid Date object
  if (rawVal instanceof Date) {
    if (!isNaN(rawVal.getTime())) return rawVal.toISOString();
    return fallbackToNow ? new Date().toISOString() : null;
  }

  // 2. If numeric Excel timestamp (e.g. 46275.8075)
  if (typeof rawVal === "number" && !isNaN(rawVal)) {
    const jsDate = new Date(Math.round((rawVal - 25569) * 86400 * 1000));
    if (!isNaN(jsDate.getTime())) return jsDate.toISOString();
  }

  // 3. If string
  if (typeof rawVal === "string") {
    let trimmed = cleanCellVal(rawVal);
    if (!trimmed) return fallbackToNow ? new Date().toISOString() : null;

    // A. Priority 1: DD/MM/YYYY or DD/MM/YY (Indian standard & Excel local format)
    // Matches: "10/09/26 19:22", "12/09/26 19:21", "10/09/2026 19:22:55", "12/09/2026  7:21:00 PM", "12-09-2026"
    const ddmmyyRegex = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?(?:\s*(AM|PM))?$/i;
    const match = trimmed.match(ddmmyyRegex);
    if (match) {
      let day = parseInt(match[1], 10);
      let month = parseInt(match[2], 10) - 1; // 0-indexed month (0 = Jan, 8 = Sep, 11 = Dec)
      let rawYear = parseInt(match[3], 10);
      // Auto-expand 2-digit years: 26 -> 2026
      let year = rawYear < 100 ? (rawYear >= 70 ? 1900 + rawYear : 2000 + rawYear) : rawYear;
      let hour = match[4] ? parseInt(match[4], 10) : 0;
      let min = match[5] ? parseInt(match[5], 10) : 0;
      let sec = match[6] ? parseInt(match[6], 10) : 0;
      const ampm = match[7] ? match[7].toUpperCase() : null;

      if (ampm === "PM" && hour < 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;

      const parsed = new Date(year, month, day, hour, min, sec);
      if (!isNaN(parsed.getTime())) return parsed.toISOString();
    }

    // B. Priority 2: YYYY-MM-DD or YYYY/MM/DD with optional time (Motorola CRM default ISO export)
    // Matches: "2026-09-10 19:22:55", "2026-07-30 18:25:23", "2026-09-10"
    const yyyymmddRegex = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?(?:\s*(AM|PM))?$/i;
    const ymatch = trimmed.match(yyyymmddRegex);
    if (ymatch) {
      let year = parseInt(ymatch[1], 10);
      let month = parseInt(ymatch[2], 10) - 1;
      let day = parseInt(ymatch[3], 10);
      let hour = ymatch[4] ? parseInt(ymatch[4], 10) : 0;
      let min = ymatch[5] ? parseInt(ymatch[5], 10) : 0;
      let sec = ymatch[6] ? parseInt(ymatch[6], 10) : 0;
      const ampm = ymatch[7] ? ymatch[7].toUpperCase() : null;

      if (ampm === "PM" && hour < 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;

      const parsed = new Date(year, month, day, hour, min, sec);
      if (!isNaN(parsed.getTime())) return parsed.toISOString();
    }

    // C. Fallback: Standard JavaScript Date parser (for ISO-8601 timestamps, etc.)
    const fallback = new Date(trimmed);
    if (!isNaN(fallback.getTime())) return fallback.toISOString();
  }

  return fallbackToNow ? new Date().toISOString() : null;
}

/**
 * Calculate ageing days between given date and today
 */
export function calculateAgeingDays(dateInput) {
  if (!dateInput) return 0;
  const target = new Date(dateInput);
  const today = new Date();
  target.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const diffTime = today.getTime() - target.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

/**
 * Format phone number safely
 */
export function formatMobile(mobile) {
  if (!mobile) return "—";
  const cleaned = ("" + mobile).replace(/\D/g, "");
  if (cleaned.length === 10) {
    return `+91 ${cleaned.slice(0, 5)} ${cleaned.slice(5)}`;
  }
  return mobile;
}

/**
 * Debounce helper for search inputs
 */
export function debounce(func, wait = 300) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Render Calling Status Badge HTML
 */
export function renderStatusBadge(status) {
  switch (status) {
    case "Completed":
      return `<span class="badge badge-success"><span class="badge-dot"></span>Completed</span>`;
    case "Customer Not Reachable":
      return `<span class="badge badge-warning"><span class="badge-dot"></span>Not Reachable</span>`;
    case "Call Back Required":
      return `<span class="badge badge-info"><span class="badge-dot"></span>Call Back Req.</span>`;
    default:
      return `<span class="badge badge-neutral"><span class="badge-dot"></span>${status || "Pending"}</span>`;
  }
}

/**
 * Render Feedback Category Badge HTML
 */
export function renderFeedbackBadge(category) {
  switch (category) {
    case "Happy":
      return `<span class="badge badge-success"><span class="badge-dot"></span>Happy</span>`;
    case "Neutral":
      return `<span class="badge badge-neutral"><span class="badge-dot"></span>Neutral</span>`;
    case "Unhappy":
      return `<span class="badge badge-danger"><span class="badge-dot"></span>Unhappy</span>`;
    default:
      return `<span class="badge badge-neutral">—</span>`;
  }
}

/**
 * Render Ageing Badge HTML
 */
export function renderAgeingBadge(days) {
  if (days === 0) {
    return `<span class="badge badge-info">Today</span>`;
  } else if (days === 1) {
    return `<span class="badge badge-success">1 Day</span>`;
  } else if (days === 2) {
    return `<span class="badge badge-warning">2 Days</span>`;
  } else {
    return `<span class="badge badge-danger">${days} Days (3+ Days)</span>`;
  }
}

/**
 * Render Rating Pill Badge HTML
 */
export function renderRatingBadge(rating) {
  if (rating === null || rating === undefined || rating === "") return "—";
  const num = Number(rating);
  let colorClass = "badge-neutral";
  if (num >= 8) colorClass = "badge-success";
  else if (num >= 5) colorClass = "badge-warning";
  else colorClass = "badge-danger";

  return `<span class="badge ${colorClass}">⭐ ${num}/10</span>`;
}

/**
 * Escape HTML to prevent XSS in tables and forms
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * SVG Icons Set (Crisp Feather / Heroicons style)
 */
const rawIcons = {
  phone: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>`,
  dashboard: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"></rect><rect x="14" y="3" width="7" height="5"></rect><rect x="14" y="12" width="7" height="9"></rect><rect x="3" y="16" width="7" height="5"></rect></svg>`,
  clock: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  checkCircle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`,
  users: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
  database: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`,
  upload: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`,
  award: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>`,
  fileText: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
  mapPin: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`,
  logOut: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>`,
  user: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
  search: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  menu: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`,
  close: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  arrowRight: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`,
  refreshCw: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`,
  download: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  smile: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>`,
  meh: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="15" x2="16" y2="15"></line><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>`,
  frown: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M16 16s-1.5-2-4-2-4 2-4 2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>`,
  alertTriangle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
  alertCircle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
  shield: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`,
  chevronLeft: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`,
  chevronRight: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`,
  heart: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>`,
  star: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
  activity: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
  trash: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  rotateCcw: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`,
  copy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  check: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  zap: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
  filter: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>`,
};

// Wrap in safe Proxy so any missing icon returns an empty string instead of undefined
export const icons = new Proxy(rawIcons, {
  get(target, prop) {
    if (typeof prop === "string" && prop in target) {
      return target[prop];
    }
    return "";
  },
});
