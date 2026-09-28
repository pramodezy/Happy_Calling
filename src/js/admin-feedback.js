// ============================================================================
// Admin: Customer Feedback & CSAT Sentiment Analysis Controller
// Route: #/admin/feedback
// ============================================================================

import { supabase, formatSupabaseError, subscribeToTable, unsubscribeChannel, fetchAllRows } from "./supabase.js";
import { icons, escapeHtml, renderRatingBadge, renderFeedbackBadge, formatDateTime, debounce, downloadCsvWithBom } from "./utils.js";
import { renderKpiCard } from "../components/kpi-card.js";
import { renderSpinner } from "../components/loading.js";
import { showToast } from "../components/toast.js";
import { isBSM, getUserAssignedRegions } from "./auth.js";
import * as XLSX from "xlsx";
import Chart from "chart.js/auto";

let feedbackDonutChart = null;
let ratingDistChart = null;
let feedbackRecords = [];
let searchQuery = "";
let filterCategory = "ALL";
let filterRating = "ALL";
let filterDateFrom = "";
let filterDateTo = "";
let periodPreset = "ALL";
let filterRegion = "";
let cachedCcis = [];
let cciRegionMap = {};
let currentPage = 1;
let pageSize = 25;
let totalFeedbackRecords = 0;
let isExporting = false;

function formatYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function applyPresetDates(preset) {
  const now = new Date();
  if (preset === "TODAY") {
    filterDateFrom = formatYMD(now);
    filterDateTo = formatYMD(now);
  } else if (preset === "YESTERDAY") {
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    filterDateFrom = formatYMD(yest);
    filterDateTo = formatYMD(yest);
  } else if (preset === "LAST_7_DAYS") {
    const past7 = new Date();
    past7.setDate(past7.getDate() - 6);
    filterDateFrom = formatYMD(past7);
    filterDateTo = formatYMD(now);
  } else if (preset === "LAST_30_DAYS") {
    const past30 = new Date();
    past30.setDate(past30.getDate() - 29);
    filterDateFrom = formatYMD(past30);
    filterDateTo = formatYMD(now);
  } else if (preset === "THIS_MONTH") {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    filterDateFrom = formatYMD(firstDay);
    filterDateTo = formatYMD(now);
  } else if (preset === "LAST_MONTH") {
    const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
    filterDateFrom = formatYMD(firstDay);
    filterDateTo = formatYMD(lastDay);
  } else if (preset === "ALL") {
    filterDateFrom = "";
    filterDateTo = "";
  }
}

function updatePeriodLabel() {
  const label = document.getElementById("feedback-active-period-label");
  if (!label) return;
  const regSuffix = filterRegion ? ` &bull; Region: <strong>${escapeHtml(filterRegion)}</strong>` : "";
  if (!filterDateFrom && !filterDateTo) {
    label.innerHTML = `Period: <strong>All Time</strong>${regSuffix}`;
  } else if (filterDateFrom && filterDateTo) {
    if (filterDateFrom === filterDateTo) {
      label.innerHTML = `Period: <strong>${escapeHtml(filterDateFrom)}</strong>${regSuffix}`;
    } else {
      label.innerHTML = `Period: <strong>${escapeHtml(filterDateFrom)}</strong> to <strong>${escapeHtml(filterDateTo)}</strong>${regSuffix}`;
    }
  } else if (filterDateFrom) {
    label.innerHTML = `Period: From <strong>${escapeHtml(filterDateFrom)}</strong>${regSuffix}`;
  } else if (filterDateTo) {
    label.innerHTML = `Period: Up to <strong>${escapeHtml(filterDateTo)}</strong>${regSuffix}`;
  }
}

function getDateFilterSuffix() {
  const regPart = filterRegion ? `_${filterRegion.toLowerCase().replace(/[^a-z0-9]/g, "_")}` : "";
  if (filterDateFrom && filterDateTo) {
    return `${filterDateFrom}_to_${filterDateTo}${regPart}`;
  } else if (filterDateFrom) {
    return `from_${filterDateFrom}${regPart}`;
  } else if (filterDateTo) {
    return `up_to_${filterDateTo}${regPart}`;
  } else {
    return `all_time_${new Date().toISOString().split("T")[0]}${regPart}`;
  }
}

/**
 * Loads CCI stations and region mapping dynamically from cci_master
 */
async function loadCciRegionMapping() {
  const isBsmUser = isBSM();
  const assignedRegions = getUserAssignedRegions();
  const regSelect = document.getElementById("feedback-filter-region");

  try {
    const { data, error } = await supabase
      .from("cci_master")
      .select("cci_code, cci_name, region")
      .order("cci_code");

    if (error) throw error;
    if (data) {
      const DEMO_CODES = new Set(["BLR01", "DEL01", "MUM01", "KOC01", "KOL01"]);
      const hasStationCodes = data.some((c) => !DEMO_CODES.has(c.cci_code));
      cachedCcis = hasStationCodes ? data.filter((c) => !DEMO_CODES.has(c.cci_code)) : data;

      if (isBsmUser && assignedRegions.length > 0) {
        const assignedSet = new Set(assignedRegions.map((r) => r.trim().toLowerCase()));
        cachedCcis = cachedCcis.filter((c) => assignedSet.has((c.region || "").trim().toLowerCase()));
      }

      cciRegionMap = {};
      cachedCcis.forEach((c) => {
        if (c.cci_code) {
          const raw = String(c.cci_code).trim();
          const reg = c.region ? c.region.trim() : "—";
          cciRegionMap[raw] = reg;
          cciRegionMap[raw.toUpperCase()] = reg;
          const unpadded = raw.replace(/^0+/, "");
          if (unpadded && !cciRegionMap[unpadded]) {
            cciRegionMap[unpadded] = reg;
            cciRegionMap[unpadded.toUpperCase()] = reg;
          }
        }
      });

      if (regSelect) {
        const currentVal = regSelect.value;
        regSelect.innerHTML = "";
        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = isBsmUser
          ? `All My Regions (${assignedRegions.join(", ") || "Assigned"})`
          : "All Regions";
        regSelect.appendChild(defaultOpt);

        let uniqueRegions = [];
        if (isBsmUser && assignedRegions.length > 0) {
          uniqueRegions = [...assignedRegions].sort();
        } else {
          uniqueRegions = Array.from(
            new Set(
              cachedCcis
                .map((c) => (c.region || "").trim())
                .filter((r) => r.length > 0)
            )
          ).sort();
        }

        uniqueRegions.forEach((reg) => {
          const opt = document.createElement("option");
          opt.value = reg;
          opt.textContent = reg;
          regSelect.appendChild(opt);
        });

        if (currentVal) regSelect.value = currentVal;
      }
    }
  } catch (err) {
    console.warn("Could not load cci_master for regions:", err);
  }
}

/**
 * Returns region for a given CCI station code
 */
function getRegionForCci(code) {
  if (!code) return "—";
  const str = String(code).trim();
  if (cciRegionMap[str]) return cciRegionMap[str];
  if (cciRegionMap[str.toUpperCase()]) return cciRegionMap[str.toUpperCase()];
  const unpadded = str.replace(/^0+/, "");
  if (cciRegionMap[unpadded]) return cciRegionMap[unpadded];
  if (cciRegionMap[unpadded.toUpperCase()]) return cciRegionMap[unpadded.toUpperCase()];
  return "—";
}

/**
 * Applies region filter condition to a Supabase query
 */
function applyRegionFilterToQuery(query) {
  if (filterRegion) {
    const matchingCcis = cachedCcis
      .filter((c) => (c.region || "").trim().toLowerCase() === filterRegion.trim().toLowerCase())
      .map((c) => c.cci_code);

    if (matchingCcis.length > 0) {
      return query.in("cci_code", matchingCcis);
    } else {
      return query.eq("cci_code", "__NONE__");
    }
  }

  // If BSM user with assigned regions and no specific region selected, scope to assigned regions
  const isBsmUser = isBSM();
  const assignedRegions = getUserAssignedRegions();
  if (isBsmUser && assignedRegions.length > 0) {
    const assignedCcis = cachedCcis.map((c) => c.cci_code);
    if (assignedCcis.length > 0) {
      return query.in("cci_code", assignedCcis);
    }
  }

  return query;
}

/**
 * Parses record timestamp or calling date + time into a valid Date object
 */
function getRecordDateObj(r) {
  if (r.created_at) {
    const d = new Date(r.created_at);
    if (!isNaN(d.getTime())) return d;
  }
  if (r.calling_date) {
    const timeParts = String(r.calling_time || "00:00:00").trim().split(":");
    const dateParts = String(r.calling_date).trim().split("-");
    if (dateParts.length === 3) {
      const year = parseInt(dateParts[0], 10);
      const month = parseInt(dateParts[1], 10) - 1;
      const day = parseInt(dateParts[2], 10);
      const hour = parseInt(timeParts[0] || "0", 10);
      const min = parseInt(timeParts[1] || "0", 10);
      const sec = parseInt(timeParts[2] || "0", 10);
      const d = new Date(year, month, day, hour, min, sec);
      if (!isNaN(d.getTime())) return d;
    }
    const d = new Date(r.calling_date);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Returns formatted date and time parts for export
 */
function getRecordFormattedDateTime(r) {
  const d = getRecordDateObj(r);
  if (!d) {
    const fallbackDate = r.calling_date || "";
    const fallbackTime = r.calling_time || "";
    return {
      dateTimeStr: fallbackDate && fallbackTime ? `${fallbackDate} ${fallbackTime}` : fallbackDate || "—",
      dateStr: fallbackDate || "—",
      timeStr: fallbackTime || "—",
      dateObj: null,
    };
  }

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");

  const dateStr = `${y}-${m}-${day}`;
  const timeStr = `${hh}:${mm}:${ss}`;
  const dateTimeStr = `${dateStr} ${timeStr}`;

  return { dateTimeStr, dateStr, timeStr, dateObj: d };
}

export async function renderAdminFeedbackPage(container) {
  searchQuery = "";
  filterCategory = "ALL";
  filterRating = "ALL";
  filterDateFrom = "";
  filterDateTo = "";
  periodPreset = "ALL";
  filterRegion = "";
  currentPage = 1;
  pageSize = 25;
  totalFeedbackRecords = 0;
  isExporting = false;

  container.innerHTML = `
    <!-- Header with Breadcrumbs & Action -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Customer Feedback & CSAT Analysis</h2>
          <span class="badge badge-success" style="font-size:0.6875rem; padding:2px 8px;">VOICE OF CUSTOMER</span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Customer satisfaction ratings, sentiment breakdown, and real feedback logs across service centers.</p>
      </div>

      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <button type="button" id="btn-export-feedback-xlsx" class="btn-primary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.download}</span>
          <span id="btn-export-xlsx-label">Export Excel (.xlsx)</span>
        </button>
        <button type="button" id="btn-export-feedback-csv" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.download}</span>
          <span id="btn-export-csv-label">Export CSV</span>
        </button>
        <a href="#/admin" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.dashboard}</span>
          <span>Overview</span>
        </a>
      </div>
    </div>

    <!-- Calendar & Period Filter Toolbar -->
    <div class="filter-toolbar" style="margin-bottom:1.25rem;">
      <div class="filter-group">
        <label for="feedback-period-preset" style="font-weight:600; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.clock}</span>
          <span>Period:</span>
        </label>
        <select id="feedback-period-preset" class="filter-select" style="font-weight:500;">
          <option value="ALL">All Time</option>
          <option value="TODAY">Today</option>
          <option value="YESTERDAY">Yesterday</option>
          <option value="LAST_7_DAYS">Last 7 Days</option>
          <option value="LAST_30_DAYS">Last 30 Days</option>
          <option value="THIS_MONTH">This Month</option>
          <option value="LAST_MONTH">Last Month</option>
          <option value="CUSTOM">Custom Range</option>
        </select>
      </div>

      <div class="filter-group">
        <label for="feedback-filter-from">From:</label>
        <input type="date" id="feedback-filter-from" class="filter-select">
      </div>

      <div class="filter-group">
        <label for="feedback-filter-to">To:</label>
        <input type="date" id="feedback-filter-to" class="filter-select">
      </div>

      <div class="filter-group">
        <label for="feedback-filter-region" style="font-weight:600; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.filter}</span>
          <span>Region:</span>
        </label>
        <select id="feedback-filter-region" class="filter-select" style="font-weight:500;">
          <option value="">All Regions</option>
        </select>
      </div>

      <button type="button" id="btn-feedback-date-apply" class="btn-primary" style="padding:6px 14px; font-size:0.8125rem; font-weight:600;">
        Apply Filters
      </button>

      <button type="button" id="btn-feedback-date-reset" class="btn-secondary" style="padding:6px 14px; font-size:0.8125rem;">
        Reset
      </button>

      <div id="feedback-active-period-label" style="margin-left:auto; font-size:0.75rem; color:var(--text-secondary); background:var(--bg-surface-subtle); padding:4px 10px; border-radius:var(--radius-sm); border:1px solid var(--border-subtle); font-weight:500;">
        Period: <strong>All Time</strong>
      </div>
    </div>

    <!-- CSAT & Sentiment KPI Cards -->
    <div id="feedback-kpi-mount" class="kpi-grid">
      ${renderSpinner("Aggregating customer sentiment metrics...")}
    </div>

    <!-- Charts Row: Sentiment Donut & Rating Distribution -->
    <div class="dashboard-row" style="margin-bottom:1.5rem;">
      <div class="chart-card" style="flex:1;">
        <div class="chart-card-header">
          <span class="chart-card-title">Sentiment Category Distribution</span>
        </div>
        <div class="chart-container-relative" style="min-height:240px; display:flex; align-items:center; justify-content:center;">
          <canvas id="canvas-feedback-donut"></canvas>
        </div>
      </div>

      <div class="chart-card" style="flex:1.2;">
        <div class="chart-card-header">
          <span class="chart-card-title">10-Point Customer Rating Histogram</span>
        </div>
        <div class="chart-container-relative" style="min-height:240px;">
          <canvas id="canvas-rating-dist"></canvas>
        </div>
      </div>
    </div>

    <!-- Customer Feedback Feed / Logs -->
    <div class="table-card">
      <div class="table-card-header" style="flex-wrap:wrap; gap:0.75rem;">
        <div>
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <h3 class="table-card-title">Customer Feedback Verbatim & Logs</h3>
            <span id="feedback-count-badge" class="badge badge-info" style="font-size:0.6875rem; padding:2px 8px;">Loading...</span>
          </div>
          <span style="font-size:0.75rem; color:var(--text-tertiary);">Recent customer calling remarks, ratings, and escalation history</span>
        </div>

        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
          <input type="text" id="feedback-search-input" placeholder="Search SO, remarks, CCI..." class="form-input" style="padding:5px 10px; font-size:0.8125rem; width:200px;">
          
          <select id="feedback-category-filter" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
            <option value="ALL">All Sentiments</option>
            <option value="Happy">Happy Delighted</option>
            <option value="Neutral">Neutral</option>
            <option value="Unhappy">Unhappy / DSAT</option>
          </select>

          <select id="feedback-rating-filter" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
            <option value="ALL">All Ratings</option>
            <option value="TOP">9 - 10 (Promoters)</option>
            <option value="MID">7 - 8 (Passives)</option>
            <option value="LOW">&lt; 7 (Detractors)</option>
          </select>

          <select id="feedback-page-size-select" class="filter-select" style="font-size:0.8125rem; padding:5px 10px;">
            <option value="25" selected>25 / page</option>
            <option value="50">50 / page</option>
            <option value="100">100 / page</option>
            <option value="200">200 / page</option>
          </select>
        </div>
      </div>

      <div class="table-responsive-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date & Time</th>
              <th>SO & Closure ID</th>
              <th>CCI Station</th>
              <th>Region</th>
              <th>Rating</th>
              <th>Sentiment</th>
              <th>Survey Status</th>
              <th style="min-width:240px;">Customer Remarks</th>
              <th>Calling Status</th>
            </tr>
          </thead>
          <tbody id="feedback-table-body">
            <tr><td colspan="9">${renderSpinner("Loading customer feedback records...")}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination Footer -->
      <div id="feedback-pagination" class="pagination-container" style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem 1.25rem; border-top:1px solid var(--border-subtle); flex-wrap:wrap; gap:0.75rem;">
        <div id="feedback-pagination-info" style="font-size:0.8125rem; color:var(--text-secondary);">
          Showing <strong>0</strong> to <strong>0</strong> of <strong>0</strong> records
        </div>
        <div class="pagination-controls" style="display:flex; align-items:center; gap:0.5rem;">
          <button type="button" class="btn-page" id="btn-feedback-prev" disabled>Previous</button>
          <span id="feedback-pagination-page" style="padding:0 0.5rem; font-weight:600; font-size:0.8125rem; color:var(--text-primary);">Page 1 of 1</span>
          <button type="button" class="btn-page" id="btn-feedback-next" disabled>Next</button>
        </div>
      </div>
    </div>
  `;

  // Attach event listeners
  const presetSelect = document.getElementById("feedback-period-preset");
  const fromInput = document.getElementById("feedback-filter-from");
  const toInput = document.getElementById("feedback-filter-to");
  const regionSelect = document.getElementById("feedback-filter-region");

  presetSelect?.addEventListener("change", (e) => {
    periodPreset = e.target.value;
    if (periodPreset !== "CUSTOM") {
      applyPresetDates(periodPreset);
      if (fromInput) fromInput.value = filterDateFrom;
      if (toInput) toInput.value = filterDateTo;
      updatePeriodLabel();
      currentPage = 1;
      loadFeedbackData();
    }
  });

  fromInput?.addEventListener("change", () => {
    if (presetSelect) presetSelect.value = "CUSTOM";
    periodPreset = "CUSTOM";
  });

  toInput?.addEventListener("change", () => {
    if (presetSelect) presetSelect.value = "CUSTOM";
    periodPreset = "CUSTOM";
  });

  regionSelect?.addEventListener("change", (e) => {
    filterRegion = e.target.value;
    updatePeriodLabel();
    currentPage = 1;
    loadFeedbackData();
  });

  document.getElementById("btn-feedback-date-apply")?.addEventListener("click", () => {
    filterDateFrom = fromInput?.value || "";
    filterDateTo = toInput?.value || "";
    if (filterDateFrom && filterDateTo && filterDateFrom > filterDateTo) {
      showToast("Start date cannot be after end date.", "warning");
      return;
    }
    updatePeriodLabel();
    currentPage = 1;
    loadFeedbackData();
  });

  document.getElementById("btn-feedback-date-reset")?.addEventListener("click", () => {
    periodPreset = "ALL";
    filterDateFrom = "";
    filterDateTo = "";
    filterRegion = "";
    if (presetSelect) presetSelect.value = "ALL";
    if (fromInput) fromInput.value = "";
    if (toInput) toInput.value = "";
    if (regionSelect) regionSelect.value = "";
    updatePeriodLabel();
    currentPage = 1;
    loadFeedbackData();
  });

  const searchInput = document.getElementById("feedback-search-input");
  if (searchInput) {
    searchInput.addEventListener(
      "input",
      debounce((e) => {
        searchQuery = e.target.value.toLowerCase().trim();
        currentPage = 1;
        loadFeedbackTable();
      }, 300)
    );
  }

  document.getElementById("feedback-category-filter")?.addEventListener("change", (e) => {
    filterCategory = e.target.value;
    currentPage = 1;
    loadFeedbackTable();
  });

  document.getElementById("feedback-rating-filter")?.addEventListener("change", (e) => {
    filterRating = e.target.value;
    currentPage = 1;
    loadFeedbackTable();
  });

  document.getElementById("feedback-page-size-select")?.addEventListener("change", (e) => {
    pageSize = Number(e.target.value) || 25;
    currentPage = 1;
    loadFeedbackTable();
  });

  document.getElementById("btn-feedback-prev")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadFeedbackTable();
    }
  });

  document.getElementById("btn-feedback-next")?.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(totalFeedbackRecords / pageSize));
    if (currentPage < totalPages) {
      currentPage++;
      loadFeedbackTable();
    }
  });

  document.getElementById("btn-export-feedback-xlsx")?.addEventListener("click", () => {
    exportFeedbackXlsx();
  });

  document.getElementById("btn-export-feedback-csv")?.addEventListener("click", () => {
    exportFeedbackCsv();
  });

  await loadFeedbackData();

  subscribeToTable("admin_feedback_realtime", "happy_calling", "*", () => {
    loadFeedbackData();
  });
}

async function loadFeedbackData() {
  const kpiMount = document.getElementById("feedback-kpi-mount");
  if (!kpiMount) return;

  // Load CCI master and regions mapping first
  await loadCciRegionMapping();

  try {
    const { data: dashData, error: dashErr } = await supabase.rpc("get_admin_dashboard", {
      p_cci_code: null,
      p_region: filterRegion || null,
      p_date_from: filterDateFrom || null,
      p_date_to: filterDateTo || null,
    });
    if (dashErr) throw dashErr;

    const happyCount = Number(dashData?.happy_count) || 0;
    const neutralCount = Number(dashData?.neutral_count) || 0;
    const unhappyCount = Number(dashData?.unhappy_count) || 0;
    const completedCalls = Number(dashData?.completed_calls) || (happyCount + neutralCount + unhappyCount);
    const happyRate = dashData?.happy_rate || (completedCalls > 0 ? Math.round((happyCount / completedCalls) * 100) : 0);
    const avgRating = dashData?.avg_rating || 0;

    // Fetch national or regional survey metrics across records using fetchAllRows with date and region filter
    let surveyReceivedRate = 0;
    let surveySubmittedRate = 0;
    let surveyReceivedCount = 0;
    let surveySubmittedCount = 0;

    try {
      const sRows = await fetchAllRows((from, to) => {
        let q = supabase
          .from("happy_calling")
          .select("survey_email_received, survey_submitted, calling_date, cci_code")
          .eq("calling_status", "Completed")
          .range(from, to);
        if (filterDateFrom) q = q.gte("calling_date", filterDateFrom);
        if (filterDateTo) q = q.lte("calling_date", filterDateTo);
        q = applyRegionFilterToQuery(q);
        return q;
      });

      if (sRows && sRows.length > 0) {
        const tracked = sRows.filter((r) => r.survey_email_received !== null && r.survey_email_received !== undefined);
        const totalTracked = tracked.length;
        if (totalTracked > 0) {
          surveyReceivedCount = tracked.filter((r) => r.survey_email_received === "Yes").length;
          surveySubmittedCount = tracked.filter((r) => r.survey_submitted === "Yes").length;
          surveyReceivedRate = Math.round((surveyReceivedCount / totalTracked) * 100);
          surveySubmittedRate = Math.round((surveySubmittedCount / totalTracked) * 100);
        }
      }
    } catch {
      // safe fallback if survey columns not yet in DB
    }

    const regSuffix = filterRegion ? ` (${filterRegion})` : "";
    const periodSub = filterDateFrom && filterDateTo
      ? `${filterDateFrom} to ${filterDateTo}${regSuffix}`
      : filterDateFrom
      ? `From ${filterDateFrom}${regSuffix}`
      : filterDateTo
      ? `Up to ${filterDateTo}${regSuffix}`
      : filterRegion
      ? `All Time (${filterRegion})`
      : "All Time Benchmark";

    kpiMount.innerHTML = `
      ${renderKpiCard({
        title: "Happy Delighted %",
        value: `${happyRate}%`,
        icon: icons.smile,
        colorScheme: "green",
        subtitle: periodSub,
      })}
      ${renderKpiCard({
        title: "Average CSAT",
        value: `${avgRating} <span style="font-size:1.1rem; color:var(--text-tertiary);">/10</span>`,
        icon: icons.award,
        colorScheme: Number(avgRating) >= 8 ? "green" : "blue",
        subtitle: "Customer CSAT Score",
      })}
      ${renderKpiCard({
        title: "Survey Email %",
        value: `${surveyReceivedRate}%`,
        icon: icons.mail,
        colorScheme: "blue",
        subtitle: `${surveyReceivedCount.toLocaleString()} Customers Received`,
      })}
      ${renderKpiCard({
        title: "Survey Complete %",
        value: `${surveySubmittedRate}%`,
        icon: icons.clipboardCheck || icons.checkCircle,
        colorScheme: "green",
        subtitle: `${surveySubmittedCount.toLocaleString()} Surveys Completed`,
      })}
      ${renderKpiCard({
        title: "Delighted Customers",
        value: happyCount.toLocaleString(),
        icon: icons.heart || icons.smile,
        colorScheme: "green",
        subtitle: "Positive Feedback",
      })}
      ${renderKpiCard({
        title: "DSAT Escalations",
        value: unhappyCount.toLocaleString(),
        icon: icons.frown,
        colorScheme: unhappyCount > 0 ? "red" : "green",
        subtitle: "Unhappy Escalations",
      })}
    `;

    renderFeedbackDonut(happyCount, neutralCount, unhappyCount);
    renderRatingDistChart(dashData?.rating_distribution || []);

    // Load feedback table records with server-side pagination, region, and date filter
    await loadFeedbackTable();
  } catch (err) {
    console.error("loadFeedbackData error:", err);
    if (kpiMount) {
      kpiMount.innerHTML = `
        <div style="grid-column: 1 / -1; padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
          <strong>Error:</strong> ${formatSupabaseError(err)}
        </div>
      `;
    }
  }
}

async function loadFeedbackTable() {
  const tbody = document.getElementById("feedback-table-body");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="9">${renderSpinner("Loading customer feedback records...")}</td></tr>`;

  try {
    let query = supabase
      .from("happy_calling")
      .select("id, closure_id, so_number, cci_code, cci_name, calling_date, calling_time, calling_status, customer_rating, feedback_category, customer_remarks, cci_remarks, survey_email_received, survey_submitted, created_at", { count: "exact" });

    if (filterDateFrom) {
      query = query.gte("calling_date", filterDateFrom);
    }
    if (filterDateTo) {
      query = query.lte("calling_date", filterDateTo);
    }

    query = applyRegionFilterToQuery(query);

    if (searchQuery) {
      query = query.or(
        `so_number.ilike.%${searchQuery}%,closure_id.ilike.%${searchQuery}%,cci_code.ilike.%${searchQuery}%,cci_name.ilike.%${searchQuery}%,customer_remarks.ilike.%${searchQuery}%`
      );
    }

    if (filterCategory !== "ALL") {
      query = query.eq("feedback_category", filterCategory);
    }

    if (filterRating === "TOP") {
      query = query.gte("customer_rating", 9);
    } else if (filterRating === "MID") {
      query = query.gte("customer_rating", 7).lte("customer_rating", 8);
    } else if (filterRating === "LOW") {
      query = query.lt("customer_rating", 7).gt("customer_rating", 0);
    }

    const fromIndex = (currentPage - 1) * pageSize;
    const toIndex = fromIndex + pageSize - 1;

    let { data: records, count, error } = await query
      .order("created_at", { ascending: false })
      .range(fromIndex, toIndex);

    // Fallback if survey columns are not present
    if (error && (error.message?.includes("survey_email_received") || error.code === "PGRST204" || error.code === "42703")) {
      console.warn("Survey columns not yet present on happy_calling table. Falling back to base query.");
      let fallbackQuery = supabase
        .from("happy_calling")
        .select("id, closure_id, so_number, cci_code, cci_name, calling_date, calling_time, calling_status, customer_rating, feedback_category, customer_remarks, cci_remarks, created_at", { count: "exact" });

      if (filterDateFrom) {
        fallbackQuery = fallbackQuery.gte("calling_date", filterDateFrom);
      }
      if (filterDateTo) {
        fallbackQuery = fallbackQuery.lte("calling_date", filterDateTo);
      }
      fallbackQuery = applyRegionFilterToQuery(fallbackQuery);
      if (searchQuery) {
        fallbackQuery = fallbackQuery.or(
          `so_number.ilike.%${searchQuery}%,closure_id.ilike.%${searchQuery}%,cci_code.ilike.%${searchQuery}%,cci_name.ilike.%${searchQuery}%,customer_remarks.ilike.%${searchQuery}%`
        );
      }
      if (filterCategory !== "ALL") {
        fallbackQuery = fallbackQuery.eq("feedback_category", filterCategory);
      }
      if (filterRating === "TOP") {
        fallbackQuery = fallbackQuery.gte("customer_rating", 9);
      } else if (filterRating === "MID") {
        fallbackQuery = fallbackQuery.gte("customer_rating", 7).lte("customer_rating", 8);
      } else if (filterRating === "LOW") {
        fallbackQuery = fallbackQuery.lt("customer_rating", 7).gt("customer_rating", 0);
      }

      const res = await fallbackQuery
        .order("created_at", { ascending: false })
        .range(fromIndex, toIndex);
      records = res.data;
      count = res.count;
      error = res.error;
    }

    if (error) throw error;

    totalFeedbackRecords = count || 0;
    feedbackRecords = records || [];

    renderFeedbackRows(feedbackRecords, totalFeedbackRecords);
    updatePaginationControls(totalFeedbackRecords);
  } catch (err) {
    console.error("loadFeedbackTable error:", err);
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="padding:1.5rem; text-align:center; color:#991b1b; background:#fef2f2;">
          <strong>Error loading feedback records:</strong> ${formatSupabaseError(err)}
        </td>
      </tr>
    `;
    updatePaginationControls(0);
  }
}

function renderFeedbackRows(records, totalRecords) {
  const tbody = document.getElementById("feedback-table-body");
  if (!tbody) return;

  if (!records || records.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align:center; padding:2.5rem; color:var(--text-tertiary);">
          ${totalRecords === 0 && !searchQuery && filterCategory === "ALL" && filterRating === "ALL" && !filterDateFrom && !filterDateTo && !filterRegion
            ? "No customer feedback records logged yet."
            : "No customer feedback records matching your criteria."}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = records
    .map((r) => {
      const remarks = r.customer_remarks
        ? `<div style="font-size:0.8125rem; color:var(--text-primary); font-style:italic;">"${escapeHtml(r.customer_remarks)}"</div>`
        : `<span style="color:var(--text-tertiary); font-size:0.75rem;">No remarks provided</span>`;

      const region = getRegionForCci(r.cci_code);

      return `
        <tr>
          <td style="font-size:0.8125rem; white-space:nowrap;">${formatDateTime(r.created_at || r.calling_date)}</td>
          <td>
            <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(r.so_number)}</div>
            <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(r.closure_id)}</div>
          </td>
          <td>
            <div style="font-weight:600; font-size:0.8125rem;">${escapeHtml(r.cci_code)}</div>
            <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(r.cci_name || "—")}</div>
          </td>
          <td>
            <span class="badge badge-neutral" style="font-weight:600; font-size:0.75rem;">${escapeHtml(region)}</span>
          </td>
          <td>${renderRatingBadge(r.customer_rating)}</td>
          <td>${renderFeedbackBadge(r.feedback_category)}</td>
          <td>
            ${r.survey_email_received ? `
              <div style="display:flex; flex-direction:column; gap:2px; font-size:0.75rem;">
                <span>Email: <strong style="color:${r.survey_email_received === 'Yes' ? '#059669' : '#dc2626'}">${escapeHtml(r.survey_email_received)}</strong></span>
                <span>Sub: <strong style="color:${r.survey_submitted === 'Yes' ? '#059669' : '#dc2626'}">${escapeHtml(r.survey_submitted || '—')}</strong></span>
              </div>
            ` : '<span style="color:var(--text-tertiary); font-size:0.75rem;">—</span>'}
          </td>
          <td>${remarks}</td>
          <td><span class="badge badge-success">${escapeHtml(r.calling_status || "Completed")}</span></td>
        </tr>
      `;
    })
    .join("");
}

function updatePaginationControls(totalRecords) {
  const badge = document.getElementById("feedback-count-badge");
  if (badge) {
    badge.textContent = `${totalRecords.toLocaleString()} Records`;
  }

  const paginationInfo = document.getElementById("feedback-pagination-info");
  const pageIndicator = document.getElementById("feedback-pagination-page");
  const btnPrev = document.getElementById("btn-feedback-prev");
  const btnNext = document.getElementById("btn-feedback-next");

  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const fromRecord = totalRecords === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const toRecord = Math.min(totalRecords, currentPage * pageSize);

  if (paginationInfo) {
    paginationInfo.innerHTML = `Showing <strong>${fromRecord.toLocaleString()}</strong> to <strong>${toRecord.toLocaleString()}</strong> of <strong>${totalRecords.toLocaleString()}</strong> records`;
  }

  if (pageIndicator) {
    pageIndicator.textContent = `Page ${currentPage} of ${totalPages}`;
  }

  if (btnPrev) {
    btnPrev.disabled = currentPage <= 1;
  }

  if (btnNext) {
    btnNext.disabled = currentPage >= totalPages;
  }
}

function renderFeedbackDonut(happy, neutral, unhappy) {
  const ctx = document.getElementById("canvas-feedback-donut")?.getContext("2d");
  if (!ctx) return;

  if (feedbackDonutChart) feedbackDonutChart.destroy();

  const total = happy + neutral + unhappy;
  if (total === 0) {
    feedbackDonutChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: ["No Feedback Recorded Yet"],
        datasets: [{ data: [1], backgroundColor: ["#e2e8f0"] }],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
    return;
  }

  feedbackDonutChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Happy (Delighted)", "Neutral", "Unhappy (DSAT)"],
      datasets: [
        {
          data: [happy, neutral, unhappy],
          backgroundColor: ["#10b981", "#0072ce", "#ef4444"],
          hoverOffset: 6,
          borderWidth: 2,
          borderColor: "#ffffff",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
      },
      cutout: "68%",
    },
  });
}

function renderRatingDistChart(distribution) {
  const ctx = document.getElementById("canvas-rating-dist")?.getContext("2d");
  if (!ctx) return;

  if (ratingDistChart) ratingDistChart.destroy();

  const labels = ["1★", "2★", "3★", "4★", "5★", "6★", "7★", "8★", "9★", "10★"];
  const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  distribution.forEach((item) => {
    const r = Number(item.rating);
    if (r >= 1 && r <= 10) {
      counts[r - 1] = Number(item.count) || 0;
    }
  });

  const backgroundColors = labels.map((_, idx) => {
    const star = idx + 1;
    if (star >= 9) return "#10b981";
    if (star >= 7) return "#0072ce";
    if (star >= 5) return "#f59e0b";
    return "#ef4444";
  });

  ratingDistChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Number of Customers",
          data: counts,
          backgroundColor: backgroundColors,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0 },
          grid: { color: "#e2e8f0" },
        },
        x: { grid: { display: false } },
      },
    },
  });
}

/**
 * Shared fetch routine across Excel and CSV exports
 */
async function fetchAllFeedbackForExport() {
  const queryBuilder = (from, to) => {
    let q = supabase
      .from("happy_calling")
      .select("id, closure_id, so_number, cci_code, cci_name, calling_date, calling_time, calling_status, customer_rating, feedback_category, customer_remarks, cci_remarks, survey_email_received, survey_submitted, created_at")
      .order("created_at", { ascending: false })
      .range(from, to);

    if (filterDateFrom) q = q.gte("calling_date", filterDateFrom);
    if (filterDateTo) q = q.lte("calling_date", filterDateTo);
    q = applyRegionFilterToQuery(q);

    if (searchQuery) {
      q = q.or(
        `so_number.ilike.%${searchQuery}%,closure_id.ilike.%${searchQuery}%,cci_code.ilike.%${searchQuery}%,cci_name.ilike.%${searchQuery}%,customer_remarks.ilike.%${searchQuery}%`
      );
    }
    if (filterCategory !== "ALL") {
      q = q.eq("feedback_category", filterCategory);
    }
    if (filterRating === "TOP") {
      q = q.gte("customer_rating", 9);
    } else if (filterRating === "MID") {
      q = q.gte("customer_rating", 7).lte("customer_rating", 8);
    } else if (filterRating === "LOW") {
      q = q.lt("customer_rating", 7).gt("customer_rating", 0);
    }
    return q;
  };

  try {
    return await fetchAllRows(queryBuilder, 1000);
  } catch (fetchErr) {
    if (fetchErr && (fetchErr.message?.includes("survey_email_received") || fetchErr.code === "PGRST204" || fetchErr.code === "42703")) {
      console.warn("Survey columns not found on export, falling back to base query");
      return await fetchAllRows((from, to) => {
        let q = supabase
          .from("happy_calling")
          .select("id, closure_id, so_number, cci_code, cci_name, calling_date, calling_time, calling_status, customer_rating, feedback_category, customer_remarks, cci_remarks, created_at")
          .order("created_at", { ascending: false })
          .range(from, to);

        if (filterDateFrom) q = q.gte("calling_date", filterDateFrom);
        if (filterDateTo) q = q.lte("calling_date", filterDateTo);
        q = applyRegionFilterToQuery(q);

        if (searchQuery) {
          q = q.or(
            `so_number.ilike.%${searchQuery}%,closure_id.ilike.%${searchQuery}%,cci_code.ilike.%${searchQuery}%,cci_name.ilike.%${searchQuery}%,customer_remarks.ilike.%${searchQuery}%`
          );
        }
        if (filterCategory !== "ALL") {
          q = q.eq("feedback_category", filterCategory);
        }
        if (filterRating === "TOP") {
          q = q.gte("customer_rating", 9);
        } else if (filterRating === "MID") {
          q = q.gte("customer_rating", 7).lte("customer_rating", 8);
        } else if (filterRating === "LOW") {
          q = q.lt("customer_rating", 7).gt("customer_rating", 0);
        }
        return q;
      }, 1000);
    }
    throw fetchErr;
  }
}

/**
 * Native Microsoft Excel (.xlsx) Export with true date cells,
 * AutoFilter grouping (Year -> Month -> Day), time formatting, and Region column.
 */
async function exportFeedbackXlsx() {
  if (isExporting) return;

  const btn = document.getElementById("btn-export-feedback-xlsx");
  const originalBtnHtml = btn ? btn.innerHTML : "";

  try {
    isExporting = true;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `
        <span class="spinner" style="width:14px; height:14px; border-width:2px; display:inline-block; vertical-align:middle;"></span>
        <span>Exporting Excel...</span>
      `;
    }

    const regDesc = filterRegion ? ` (${filterRegion})` : "";
    const periodDesc = filterDateFrom && filterDateTo
      ? `from ${filterDateFrom} to ${filterDateTo}${regDesc}`
      : filterDateFrom
      ? `from ${filterDateFrom}${regDesc}`
      : filterDateTo
      ? `up to ${filterDateTo}${regDesc}`
      : `all time${regDesc}`;

    showToast(`Retrieving customer feedback records (${periodDesc}) for Excel export...`, "info");

    const allRows = await fetchAllFeedbackForExport();

    if (!allRows || allRows.length === 0) {
      showToast("No customer feedback records found to export for the selected period/filters.", "warning");
      return;
    }

    const headers = [
      "Call Date & Time",
      "Call Date",
      "Call Time",
      "Region",
      "CCI Code",
      "CCI Name",
      "SO Number",
      "Closure ID",
      "Customer Rating",
      "Sentiment",
      "Survey Email Received",
      "Survey Submitted",
      "Customer Remarks",
      "CCI Remarks",
      "Calling Status",
    ];

    const dataRows = allRows.map((r) => {
      const { dateTimeStr, dateStr, timeStr, dateObj } = getRecordFormattedDateTime(r);
      const region = getRegionForCci(r.cci_code);

      return [
        dateObj || dateTimeStr,
        dateStr,
        timeStr,
        region,
        r.cci_code || "",
        r.cci_name || "",
        r.so_number || "",
        r.closure_id || "",
        r.customer_rating !== null && r.customer_rating !== undefined ? Number(r.customer_rating) : "",
        r.feedback_category || "",
        r.survey_email_received || "",
        r.survey_submitted || "",
        r.customer_remarks || "",
        r.cci_remarks || "",
        r.calling_status || "",
      ];
    });

    const worksheetData = [headers, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(worksheetData, {
      cellDates: true,
      dateNF: "yyyy-mm-dd hh:mm:ss",
    });

    // Explicitly format date cells in Column A so Excel displays time and enables AutoFilter hierarchy
    if (ws["!ref"]) {
      const range = XLSX.utils.decode_range(ws["!ref"]);
      for (let R = 1; R <= range.e.r; ++R) {
        const cellAddress = XLSX.utils.encode_cell({ r: R, c: 0 });
        const cell = ws[cellAddress];
        if (cell && (cell.t === "d" || cell.v instanceof Date)) {
          cell.z = "yyyy-mm-dd hh:mm:ss";
        }
      }

      // AutoFilter on the entire dataset header
      ws["!autofilter"] = { ref: ws["!ref"] };
    }

    // Practical column widths
    ws["!cols"] = [
      { wch: 21 }, // Call Date & Time
      { wch: 13 }, // Call Date
      { wch: 11 }, // Call Time
      { wch: 14 }, // Region
      { wch: 12 }, // CCI Code
      { wch: 25 }, // CCI Name
      { wch: 16 }, // SO Number
      { wch: 16 }, // Closure ID
      { wch: 15 }, // Customer Rating
      { wch: 14 }, // Sentiment
      { wch: 20 }, // Survey Email Received
      { wch: 18 }, // Survey Submitted
      { wch: 45 }, // Customer Remarks
      { wch: 30 }, // CCI Remarks
      { wch: 16 }, // Calling Status
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Customer Feedback");

    const filename = `motorola_feedback_logs_${getDateFilterSuffix()}.xlsx`;
    XLSX.writeFile(wb, filename);

    showToast(`Successfully exported ${allRows.length.toLocaleString()} record(s) to Excel (.xlsx)!`, "success");
  } catch (err) {
    console.error("exportFeedbackXlsx error:", err);
    showToast(`Excel export failed: ${formatSupabaseError(err)}`, "error");
  } finally {
    isExporting = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalBtnHtml;
    }
  }
}

/**
 * Standard CSV Export with BOM encoding, Region, and Date + Time columns.
 */
async function exportFeedbackCsv() {
  if (isExporting) return;

  const btn = document.getElementById("btn-export-feedback-csv");
  const originalBtnHtml = btn ? btn.innerHTML : "";

  try {
    isExporting = true;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `
        <span class="spinner" style="width:14px; height:14px; border-width:2px; display:inline-block; vertical-align:middle;"></span>
        <span>Exporting CSV...</span>
      `;
    }

    const regDesc = filterRegion ? ` (${filterRegion})` : "";
    const periodDesc = filterDateFrom && filterDateTo
      ? `from ${filterDateFrom} to ${filterDateTo}${regDesc}`
      : filterDateFrom
      ? `from ${filterDateFrom}${regDesc}`
      : filterDateTo
      ? `up to ${filterDateTo}${regDesc}`
      : `all time${regDesc}`;

    showToast(`Retrieving customer feedback records (${periodDesc}) for CSV export...`, "info");

    const allRows = await fetchAllFeedbackForExport();

    if (!allRows || allRows.length === 0) {
      showToast("No customer feedback records found to export for the selected period/filters.", "warning");
      return;
    }

    const headers = [
      "Call Date & Time",
      "Call Date",
      "Call Time",
      "Region",
      "CCI Code",
      "CCI Name",
      "SO Number",
      "Closure ID",
      "Customer Rating",
      "Sentiment",
      "Survey Email Received",
      "Survey Submitted",
      "Customer Remarks",
      "CCI Remarks",
      "Calling Status",
    ];

    const rows = allRows.map((r) => {
      const { dateTimeStr, dateStr, timeStr } = getRecordFormattedDateTime(r);
      const region = getRegionForCci(r.cci_code);

      return [
        `"${dateTimeStr}"`,
        `"${dateStr}"`,
        `"${timeStr}"`,
        `"${region.replace(/"/g, '""')}"`,
        `"${(r.cci_code || "").replace(/"/g, '""')}"`,
        `"${(r.cci_name || "").replace(/"/g, '""')}"`,
        `"${(r.so_number || "").replace(/"/g, '""')}"`,
        `"${(r.closure_id || "").replace(/"/g, '""')}"`,
        r.customer_rating !== null && r.customer_rating !== undefined ? r.customer_rating : "",
        `"${(r.feedback_category || "").replace(/"/g, '""')}"`,
        `"${(r.survey_email_received || "").replace(/"/g, '""')}"`,
        `"${(r.survey_submitted || "").replace(/"/g, '""')}"`,
        `"${(r.customer_remarks || "").replace(/"/g, '""')}"`,
        `"${(r.cci_remarks || "").replace(/"/g, '""')}"`,
        `"${(r.calling_status || "").replace(/"/g, '""')}"`,
      ];
    });

    const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
    const filename = `motorola_feedback_logs_${getDateFilterSuffix()}.csv`;
    downloadCsvWithBom(csvContent, filename);

    showToast(`Successfully exported ${allRows.length.toLocaleString()} customer feedback record(s) to CSV!`, "success");
  } catch (err) {
    console.error("exportFeedbackCsv error:", err);
    showToast(`Export failed: ${formatSupabaseError(err)}`, "error");
  } finally {
    isExporting = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalBtnHtml;
    }
  }
}

export function cleanupAdminFeedback() {
  unsubscribeChannel("admin_feedback_realtime");
  if (feedbackDonutChart) {
    feedbackDonutChart.destroy();
    feedbackDonutChart = null;
  }
  if (ratingDistChart) {
    ratingDistChart.destroy();
    ratingDistChart = null;
  }
}
