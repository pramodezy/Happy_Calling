// ============================================================================
// Motorola Open Calls Operations Tracker & Analytics Engine
// Interactive Pivot Matrix, SLA Ageing Spread & Operational Responsibility
// Sourced directly from Supabase (open_calls_master & cci_master)
// ============================================================================

import * as XLSX from "xlsx";
import { supabase, fetchAllRows } from "./supabase.js";
import { getCurrentProfile, isAdmin, isBSM, isCCIUser, getUserAssignedRegions } from "./auth.js";
import { icons, escapeHtml } from "./utils.js";
import { renderSpinner } from "../components/loading.js";
import { showToast } from "../components/toast.js";

// State
let rawRecords = [];
let finalReportData = [];
let uniqueFilterValues = {};
let selectedFilters = {};
let latestCallDateString = "Live";
let ageingReferenceDate = null;
let isPivotExpanded = false;
let isPivotStationExpanded = false;
let activeTabId = "tab-consolidated";
let activeQuickQueue = "ALL";
let currentSearchTerm = "";

const AGEING_BUCKETS = ["0-1Days", "2-4Days", "5-7Days", "8-15Days", "16-30Days", ">30days"];

/**
 * Motorola Operational Matrix: Map Service Status and Parts Status to
 * responsible channel and granular resolution phase
 */
export function getOpenCallStatus(serviceStatus, partsStatus) {
  serviceStatus = String(serviceStatus || "").trim();
  partsStatus = String(partsStatus || "").trim();

  if (serviceStatus === "In Escalation") {
    switch (partsStatus) {
      case "ASP CWH to CCI":
        return { currentStatus: "In Escalation - ASP CWH to CCI", actionableTo: "Motorola" };
      case "":
        return { currentStatus: "In Escalation - Waiting for Approval", actionableTo: "Motorola" };
      case "CCI TO ASP CWH":
        return { currentStatus: "In Escalation - CCI TO ASP CWH", actionableTo: "Motorola" };
      case "Parts in ASP CWH":
        return { currentStatus: "In Escalation - Parts in ASP CWH", actionableTo: "Motorola" };
      case "Parts in other CCI":
        return { currentStatus: "In Escalation - Parts in other CCI", actionableTo: "Motorola" };
      case "Parts in service center":
        return { currentStatus: "In Escalation - Parts in service center", actionableTo: "Motorola" };
      case "Parts shortage":
        return { currentStatus: "In Escalation - Parts shortage", actionableTo: "Motorola" };
      default:
        return { currentStatus: "In Escalation - Vendor Hub", actionableTo: "Motorola" };
    }
  }

  if (serviceStatus === "Pre Submitted") {
    return { currentStatus: "Pre Submitted", actionableTo: "CCI" };
  }

  if (serviceStatus === "Repair in progress") {
    switch (partsStatus) {
      case "ASP CWH to CCI":
        return { currentStatus: "ASP CWH to CCI", actionableTo: "CCI" };
      case "":
        return { currentStatus: "Repair In Progress - Without Parts", actionableTo: "CCI" };
      case "CCI TO ASP CWH":
      case "Parts shortage":
        return { currentStatus: "CCI to Escalate - Parts Shortage", actionableTo: "CCI" };
      case "Parts in ASP CWH":
        return { currentStatus: "Parts in ASP CWH", actionableTo: "CWH" };
      case "Parts in other CCI":
        return { currentStatus: "Parts in Other CCI", actionableTo: "CWH" };
      case "Parts in service center":
        return { currentStatus: "Parts in Service Center", actionableTo: "CCI" };
      default:
        return { currentStatus: "Repair In Progress - Vendor Hub", actionableTo: "Motorola" };
    }
  }

  if (serviceStatus === "Submitted") {
    return { currentStatus: "Submitted", actionableTo: "CCI" };
  }

  if (serviceStatus === "Waiting for pickup" || serviceStatus === "Waiting for pick up") {
    return { currentStatus: "RFPU", actionableTo: "CCI" };
  }

  return { currentStatus: serviceStatus || "Unknown", actionableTo: "Others" };
}

/**
 * Normalizes station code (removes leading zeroes and floats)
 */
function normalizeStationCode(code) {
  if (!code) return "";
  let normalized = String(code).trim();
  if (normalized.endsWith(".0")) normalized = normalized.slice(0, -2);
  normalized = normalized.replace(/^0+/, "");
  if (normalized === "") normalized = "0";
  return normalized;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseDashboardDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  if (typeof value === "number") {
    const d = new Date((value - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? null : d;
  }

  const rawStr = String(value);
  const hadComma = rawStr.includes(",");
  const cleanStr = rawStr
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/\s*,\s*/g, " ")
    .trim();

  const slashMatch = cleanStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM)?)?$/i);

  if (slashMatch) {
    const first = parseInt(slashMatch[1], 10);
    const second = parseInt(slashMatch[2], 10);
    let year = parseInt(slashMatch[3], 10);
    if (year < 100) year += 2000;

    let day, month;
    const ampm = (slashMatch[7] || "").toUpperCase();
    if (first > 12 && second <= 12) {
      day = first;
      month = second - 1;
    } else if (second > 12 && first <= 12) {
      day = second;
      month = first - 1;
    } else if (hadComma) {
      day = second;
      month = first - 1;
    } else {
      day = first;
      month = second - 1;
    }

    let hour = parseInt(slashMatch[4] || "0", 10);
    const minute = parseInt(slashMatch[5] || "0", 10);
    const secondPart = parseInt(slashMatch[6] || "0", 10);
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;

    const parsedDate = new Date(year, month, day, hour, minute, secondPart);
    if (parsedDate.getFullYear() === year && parsedDate.getMonth() === month && parsedDate.getDate() === day) {
      return parsedDate;
    }
  }

  const fallbackDate = new Date(cleanStr);
  return isNaN(fallbackDate.getTime()) ? null : fallbackDate;
}

function formatDashboardDate(value) {
  const parsedDate = parseDashboardDate(value);
  if (!parsedDate) return value || "—";

  let hour = parsedDate.getHours();
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;

  return `${pad2(parsedDate.getDate())}/${pad2(parsedDate.getMonth() + 1)}/${parsedDate.getFullYear()} ${hour}:${pad2(parsedDate.getMinutes())}:${pad2(parsedDate.getSeconds())} ${ampm}`;
}

function calculateAgeingAndBucket(carryInStr, soSubmittedStr, referenceDate) {
  let timeStr = carryInStr && String(carryInStr).trim() !== "" ? carryInStr : soSubmittedStr;
  let timeSource = carryInStr && String(carryInStr).trim() !== "" ? "Carry-In Time" : "SO Submitted Time";

  const parsedDate = parseDashboardDate(timeStr);
  if (!parsedDate || !referenceDate) {
    return { days: null, bucket: "Unknown", source: timeSource };
  }

  const timeDiff = referenceDate.getTime() - parsedDate.getTime();
  const daysDiff = Math.max(0, Math.floor(timeDiff / (1000 * 60 * 60 * 24)));

  let bucket = "";
  if (daysDiff <= 1) bucket = "0-1Days";
  else if (daysDiff <= 4) bucket = "2-4Days";
  else if (daysDiff <= 7) bucket = "5-7Days";
  else if (daysDiff <= 15) bucket = "8-15Days";
  else if (daysDiff <= 30) bucket = "16-30Days";
  else bucket = ">30days";

  return { days: daysDiff, bucket, source: timeSource };
}

/**
 * Main Page Renderer
 */
export async function renderOpenCallsTrackerPage(container) {
  const admin = isAdmin();
  const bsm = isBSM();
  const assigned = getUserAssignedRegions();

  let scopeBadge = "All India Scope";
  if (bsm) {
    scopeBadge = `Regional Scope (${assigned.join(", ") || "Assigned"})`;
  } else if (!admin) {
    scopeBadge = "Station Scoped";
  }

  container.innerHTML = `
    <!-- Top Command Header -->
    <div style="margin-bottom:1.5rem; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:1rem;">
      <div>
        <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
          <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary); margin:0;">
            Service Operations Dashboard — Motorola Open Calls Tracker
          </h2>
          <span class="badge badge-info" style="font-size:0.7rem; padding:2px 8px; text-transform:uppercase;">
            ${scopeBadge}
          </span>
        </div>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin:0;">
          Real-time network open calls inventory, SLA compliance, and operational responsibility tracking without manual uploads.
        </p>
      </div>

      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
        <div id="statusBadge" style="display:flex; align-items:center; gap:0.5rem; background:var(--bg-surface); padding:6px 12px; border-radius:var(--radius-full); border:1px solid var(--border-subtle); font-size:0.75rem; font-family:monospace;">
          <span style="width:8px; height:8px; border-radius:50%; background:#10b981;" id="statusPulse"></span>
          <span id="statusText" style="color:var(--text-secondary);">Connecting to database...</span>
        </div>
        <button id="btn-refresh-tracker" class="btn-secondary" style="padding:6px 12px; font-size:0.8125rem;">
          <span style="width:14px; height:14px;">${icons.refreshCw}</span>
          <span>Refresh Live</span>
        </button>
        ${admin ? `
          <a href="#/intimation/import" class="btn-primary" style="padding:6px 14px; font-size:0.8125rem;">
            <span>${icons.upload}</span>
            <span>Upload New Snapshot</span>
          </a>
        ` : ""}
      </div>
    </div>

    <!-- Main Container -->
    <div id="tracker-body-mount" style="display:flex; flex-direction:column; gap:1.25rem;">
      ${renderSpinner("Loading open calls and station mappings from database...")}
    </div>
  `;

  document.getElementById("btn-refresh-tracker")?.addEventListener("click", () => loadTrackerData());

  await loadTrackerData();
}

/**
 * Load open calls and region mapping from Supabase
 */
async function loadTrackerData() {
  const mount = document.getElementById("tracker-body-mount");
  const statusText = document.getElementById("statusText");
  if (!mount) return;

  try {
    if (statusText) statusText.textContent = "Syncing open calls...";

    // 1. Fetch active open calls
    const callsPromise = fetchAllRows((from, to) =>
      supabase
        .from("open_calls_master")
        .select(`
          service_order,
          station_code,
          cci_code,
          station_name,
          customer_name,
          customer_mobile,
          alternate_mobile,
          model,
          so_status,
          warranty_status,
          parts_status,
          doa_status,
          carry_in_time,
          finish_repair_time,
          source_data,
          last_uploaded_at
        `)
        .eq("is_open", true)
        .order("carry_in_time", { ascending: true })
        .range(from, to)
    );

    // 2. Fetch CCI master for station & region mapping
    const cciPromise = fetchAllRows((from, to) =>
      supabase
        .from("cci_master")
        .select("cci_code, cci_name, region, location")
        .range(from, to)
    );

    const [openCalls, cciList] = await Promise.all([callsPromise, cciPromise]);

    const regionalMapping = {};
    const cciNameMapping = {};
    (cciList || []).forEach((c) => {
      const code = normalizeStationCode(c.cci_code);
      if (code) {
        if (c.region) regionalMapping[code] = c.region;
        if (c.cci_name) cciNameMapping[code] = c.cci_name;
      }
    });

    rawRecords = openCalls || [];

    // Role-based scoping
    const profile = getCurrentProfile() || {};
    const admin = isAdmin();
    const bsm = isBSM();
    const assignedRegions = getUserAssignedRegions();

    let scopedRecords = rawRecords;
    if (bsm && assignedRegions.length > 0) {
      scopedRecords = scopedRecords.filter((r) => {
        const code = normalizeStationCode(r.cci_code || r.station_code);
        const region = regionalMapping[code] || r.source_data?.region || "Unmapped";
        return assignedRegions.includes(region);
      });
    } else if (!admin && !bsm && profile.cci_code) {
      const myCode = normalizeStationCode(profile.cci_code);
      scopedRecords = scopedRecords.filter((r) => {
        return normalizeStationCode(r.cci_code) === myCode || normalizeStationCode(r.station_code) === myCode;
      });
    }

    if (scopedRecords.length === 0) {
      if (statusText) statusText.textContent = "Synced: 0 records";
      mount.innerHTML = `
        <div class="call-feedback-form-card" style="text-align:center; padding:3rem 1.5rem;">
          <div style="width:48px; height:48px; margin:0 auto 1rem; color:var(--text-tertiary);">
            ${icons.database}
          </div>
          <h3 style="font-size:1.15rem; font-weight:700; color:var(--text-primary); margin-bottom:0.5rem;">
            No Active Open Calls Found
          </h3>
          <p style="font-size:0.875rem; color:var(--text-secondary); max-width:480px; margin:0 auto 1.25rem;">
            There are currently no active open calls loaded in the database. When an administrator uploads the latest Open Calls dump, this dashboard will immediately compute operational queues and analytics.
          </p>
          ${admin ? `
            <a href="#/intimation/import" class="btn-primary">
              <span>${icons.upload}</span>
              <span>Upload Open Calls File</span>
            </a>
          ` : ""}
        </div>
      `;
      return;
    }

    // Process & compile records
    processDataEngine(scopedRecords, regionalMapping, cciNameMapping);
    initFilterSchemas();

    if (statusText) {
      statusText.textContent = `Synced: ${finalReportData.length.toLocaleString()} Open Calls`;
    }

    renderTrackerDashboardDOM(mount);
    applyGlobalFiltersAndRender();
  } catch (err) {
    console.error("Open calls tracker load error:", err);
    mount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:var(--radius-lg); color:#991b1b;">
        <h4 style="font-weight:700; margin-bottom:0.5rem;">Error loading open calls data</h4>
        <p style="font-size:0.875rem;">${escapeHtml(err.message)}</p>
      </div>
    `;
    if (statusText) statusText.textContent = "Error syncing";
  }
}

/**
 * Process Raw Records into Consolidated Report Schema
 */
function processDataEngine(records, regionalMapping, cciNameMapping) {
  finalReportData = [];
  let trackedLatestDate = null;

  records.forEach((row) => {
    const carryInVal = row.carry_in_time;
    const soSubmittedVal = row.source_data?.so_submitted_time;

    let dateToCheck = carryInVal || soSubmittedVal;
    if (dateToCheck) {
      const d = parseDashboardDate(dateToCheck);
      if (d && (!trackedLatestDate || d > trackedLatestDate)) {
        trackedLatestDate = d;
      }
    }
  });

  ageingReferenceDate = trackedLatestDate || new Date();

  records.forEach((row) => {
    const rawCode = row.station_code || row.cci_code || "";
    const cleanCode = normalizeStationCode(rawCode);

    let regionComputed = "Unmapped";
    if (regionalMapping[cleanCode]) {
      regionComputed = regionalMapping[cleanCode];
    } else if (row.source_data?.region) {
      regionComputed = row.source_data.region;
    }

    const stationNameComputed =
      row.station_name ||
      cciNameMapping[cleanCode] ||
      `Motorola Service ${cleanCode}`;

    const statusMap = getOpenCallStatus(row.so_status, row.parts_status);

    const ageingResult = calculateAgeingAndBucket(
      row.carry_in_time,
      row.source_data?.so_submitted_time,
      ageingReferenceDate
    );

    const pickupAgeing = row.finish_repair_time
      ? calculateAgeingAndBucket(null, row.finish_repair_time, ageingReferenceDate)
      : { bucket: "", source: "N/A" };

    const newRow = {
      "Service Order": row.service_order || "",
      "Station Code": rawCode,
      "Station Name": stationNameComputed,
      Model: row.model || "",
      IMEI1: row.source_data?.imei1 || "",
      IMEI2: row.source_data?.imei2 || "",
      SN: row.source_data?.sn || "",
      "Service Order Status": String(row.so_status || "").trim(),
      "Warranty Status": String(row.warranty_status || "").trim(),
      "Parts Status": String(row.parts_status || "").trim(),
      "DOA Status": String(row.doa_status || "").trim(),
      "CID Status": row.source_data?.cid_status || "",
      "SO Submitted Time": formatDashboardDate(row.source_data?.so_submitted_time),
      "Carry-In Time": formatDashboardDate(row.carry_in_time),
      "Apply for Parts Time": formatDashboardDate(row.source_data?.apply_for_parts_time),
      "Finish Repair Time": formatDashboardDate(row.finish_repair_time),
      "Parts in CCI Time": formatDashboardDate(row.source_data?.parts_in_cci_time),
      "Parts Available in Country Time": formatDashboardDate(row.source_data?.parts_available_in_country_time),
      "Parts Available in ASP Hub Time": formatDashboardDate(row.source_data?.parts_available_in_asp_hub_time),
      "Transaction Code": row.source_data?.transaction_code || "",
      "Repair Code": row.source_data?.repair_code || "",
      "Repair Code Description": row.source_data?.repair_code_description || "",
      "Repair Type": row.source_data?.repair_type || "",
      "Service Type": String(row.source_data?.service_type || "").trim(),

      "Ageing Days": ageingResult.days,
      "Open Call Ageing Bucket": ageingResult.bucket,
      "Ageing Source": ageingResult.source,
      "Waiting for pickup Ageing Bucket": pickupAgeing.bucket,
      Region: regionComputed,

      "Current Status - Open Call": statusMap.currentStatus,
      "Actionable To": statusMap.actionableTo,
    };

    finalReportData.push(newRow);
  });

  if (trackedLatestDate) {
    const pad = (n) => String(n).padStart(2, "0");
    latestCallDateString = `${pad(trackedLatestDate.getDate())}${pad(trackedLatestDate.getMonth() + 1)}${trackedLatestDate.getFullYear()}`;
  } else {
    latestCallDateString = "Live";
  }
}

/**
 * Filter schema initializer
 */
function initFilterSchemas() {
  const keysToFilter = [
    "Region",
    "Actionable To",
    "Current Status - Open Call",
    "Service Order Status",
    "Parts Status",
    "DOA Status",
    "Warranty Status",
    "Open Call Ageing Bucket",
    "Service Type",
  ];

  keysToFilter.forEach((key) => {
    let uniqueVals = [...new Set(finalReportData.map((r) => r[key]))].map((v) => String(v).trim());
    uniqueVals.sort();

    uniqueFilterValues[key] = uniqueVals;
    selectedFilters[key] = [...uniqueVals];
  });
}

/**
 * Render the static Shell HTML of the Tracker Viewport
 */
function renderTrackerDashboardDOM(container) {
  container.innerHTML = `
    <!-- 🔍 Multi-Select Filters Section -->
    <section class="crm-panel p-5 bg-white space-y-3" style="background:#fff; border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:1.25rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem; flex-wrap:wrap; gap:0.5rem;">
        <h3 style="font-size:0.875rem; font-weight:700; color:var(--text-primary); display:flex; align-items:center; gap:0.5rem; margin:0;">
          <span>${icons.filter}</span>
          <span>Multi-Select Operational Filters</span>
        </h3>
        <button id="resetFiltersBtn" type="button" class="btn-secondary" style="font-size:0.75rem; padding:4px 10px;">
          <span>${icons.rotateCcw}</span>
          <span>Reset All Filters</span>
        </button>
      </div>

      <div class="tracker-filter-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:0.625rem; align-items:end;">
        <div id="filter-Region" class="relative filter-dropdown">
          <label style="display:block; font-size:0.72rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.25rem;">Region</label>
          <button type="button" class="select-box select-btn-style">All Selected ⬇</button>
          <div class="custom-dropdown-content"></div>
        </div>
        <div id="filter-Actionable_To" class="relative filter-dropdown">
          <label style="display:block; font-size:0.72rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.25rem;">Actionable To</label>
          <button type="button" class="select-box select-btn-style">All Selected ⬇</button>
          <div class="custom-dropdown-content"></div>
        </div>
        <div id="filter-Service_Order_Status" class="relative filter-dropdown">
          <label style="display:block; font-size:0.72rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">SO Status</label>
          <button type="button" class="select-box select-btn-style">All Selected ⬇</button>
          <div class="custom-dropdown-content"></div>
        </div>
        <div id="filter-Parts_Status" class="relative filter-dropdown">
          <label style="display:block; font-size:0.72rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.25rem;">Parts Status</label>
          <button type="button" class="select-box select-btn-style">All Selected ⬇</button>
          <div class="custom-dropdown-content"></div>
        </div>
        <div id="filter-DOA_Status" class="relative filter-dropdown">
          <label style="display:block; font-size:0.72rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.25rem;">DOA Status</label>
          <button type="button" class="select-box select-btn-style">All Selected ⬇</button>
          <div class="custom-dropdown-content"></div>
        </div>
        <div id="filter-Warranty_Status" class="relative filter-dropdown">
          <label style="display:block; font-size:0.72rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.25rem;">Warranty</label>
          <button type="button" class="select-box select-btn-style">All Selected ⬇</button>
          <div class="custom-dropdown-content"></div>
        </div>
        <div id="filter-Open_Call_Ageing_Bucket" class="relative filter-dropdown">
          <label style="display:block; font-size:0.72rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.25rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Ageing Bucket</label>
          <button type="button" class="select-box select-btn-style">All Selected ⬇</button>
          <div class="custom-dropdown-content"></div>
        </div>
        <div id="filter-Service_Type" class="relative filter-dropdown">
          <label style="display:block; font-size:0.72rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.25rem;">Service Type</label>
          <button type="button" class="select-box select-btn-style">All Selected ⬇</button>
          <div class="custom-dropdown-content"></div>
        </div>
      </div>
    </section>

    <!-- 7 Core CRM KPI Micro-Cards Strip -->
    <section style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:0.75rem;">
      <div class="crm-panel p-3" style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:var(--radius-md); padding:0.875rem;">
        <span style="font-size:0.65rem; font-family:monospace; text-transform:uppercase; color:#1d4ed8; font-weight:700; letter-spacing:0.5px;">TOTAL OPEN CALLS</span>
        <p id="kpi-total-open" style="font-size:1.5rem; font-weight:900; font-family:monospace; color:#1e3a8a; margin:4px 0 0;">0</p>
      </div>

      <div class="crm-panel p-3" style="background:#fffbeb; border:1px solid #fde68a; border-radius:var(--radius-md); padding:0.875rem;">
        <span style="font-size:0.65rem; font-family:monospace; text-transform:uppercase; color:#b45309; font-weight:700; letter-spacing:0.5px;">WAITING FOR PICKUP</span>
        <p id="kpi-waiting-pickup" style="font-size:1.5rem; font-weight:900; font-family:monospace; color:#78350f; margin:4px 0 0;">0</p>
      </div>

      <div class="crm-panel p-3" style="background:#ecfdf5; border:1px solid #a7f3d0; border-radius:var(--radius-md); padding:0.875rem;">
        <span style="font-size:0.65rem; font-family:monospace; text-transform:uppercase; color:#047857; font-weight:700; letter-spacing:0.5px;">ACTIONABLE FOR CCI</span>
        <p id="kpi-actionable-cci" style="font-size:1.5rem; font-weight:900; font-family:monospace; color:#064e3b; margin:4px 0 0;">0</p>
      </div>

      <div class="crm-panel p-3" style="background:#f5f3ff; border:1px solid #ddd6fe; border-radius:var(--radius-md); padding:0.875rem;">
        <span style="font-size:0.65rem; font-family:monospace; text-transform:uppercase; color:#6d28d9; font-weight:700; letter-spacing:0.5px;">ASP CWH ACTIONABLE</span>
        <p id="kpi-asp-cwh" style="font-size:1.5rem; font-weight:900; font-family:monospace; color:#4c1d95; margin:4px 0 0;">0</p>
      </div>

      <div class="crm-panel p-3" style="background:#eef2ff; border:1px solid #c7d2fe; border-radius:var(--radius-md); padding:0.875rem;">
        <span style="font-size:0.65rem; font-family:monospace; text-transform:uppercase; color:#4338ca; font-weight:700; letter-spacing:0.5px;">IN TRANSIT TO CCI</span>
        <p id="kpi-transit-cci" style="font-size:1.5rem; font-weight:900; font-family:monospace; color:#312e81; margin:4px 0 0;">0</p>
      </div>

      <div class="crm-panel p-3" style="background:#fff1f2; border:1px solid #fecdd3; border-radius:var(--radius-md); padding:0.875rem;">
        <span style="font-size:0.65rem; font-family:monospace; text-transform:uppercase; color:#be123c; font-weight:700; letter-spacing:0.5px;">PARTS IN SERV CENTER</span>
        <p id="kpi-parts-sc" style="font-size:1.5rem; font-weight:900; font-family:monospace; color:#881337; margin:4px 0 0;">0</p>
      </div>

      <div class="crm-panel p-3" style="background:#f0fdfa; border:1px solid #99f6e4; border-radius:var(--radius-md); padding:0.875rem;">
        <span style="font-size:0.65rem; font-family:monospace; text-transform:uppercase; color:#0f766e; font-weight:700; letter-spacing:0.5px;">MOTOROLA ACTIONABLE</span>
        <p id="kpi-motorola" style="font-size:1.5rem; font-weight:900; font-family:monospace; color:#134e4a; margin:4px 0 0;">0</p>
      </div>
    </section>

    <!-- Quick Queue Responsibility Filter & Workbook Export Strip -->
    <section style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; border-bottom:1px solid var(--border-subtle); padding-bottom:0.75rem;">
      <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
        <span style="font-size:0.75rem; font-weight:700; color:var(--text-secondary); text-transform:uppercase; font-family:monospace;">Quick Queue:</span>
        <button class="queue-btn active" data-actionable="ALL">All Channels (<span id="queue-all-count">0</span>)</button>
        <button class="queue-btn" data-actionable="CCI">Actionable for CCI (<span id="queue-cci-count">0</span>)</button>
        <button class="queue-btn" data-actionable="CWH">ASP CWH Actionable (<span id="queue-cwh-count">0</span>)</button>
        <button class="queue-btn" data-actionable="Motorola">Motorola Actionable (<span id="queue-moto-count">0</span>)</button>
      </div>

      <div style="display:flex; align-items:center; gap:0.5rem;">
        <button id="exportCsvBtn" class="btn-primary" style="background:#059669; border-color:#047857; font-size:0.75rem; padding:6px 12px; gap:0.35rem;">
          <span>${icons.download}</span>
          <span>Export 4-Sheet Workbook (.xlsx)</span>
        </button>
      </div>
    </section>

    <!-- SLA Ageing & Compliance Section -->
    <section style="display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:1rem;">
      <!-- Visual SLA Spread -->
      <div class="crm-panel p-4" style="background:#fff; border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:1.25rem; grid-column:span 2;">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-subtle); padding-bottom:0.5rem; margin-bottom:0.75rem;">
          <h4 style="font-size:0.8125rem; font-weight:700; text-transform:uppercase; font-family:monospace; color:var(--text-primary); margin:0;">
            SLA Ageing Spread
          </h4>
          <span style="font-size:0.75rem; color:var(--text-tertiary); font-family:monospace;">
            Anchor: ${escapeHtml(latestCallDateString)}
          </span>
        </div>
        <div id="ageingChartContainer" style="display:flex; flex-direction:column; gap:0.625rem;"></div>
      </div>

      <!-- Governance Compliance Target -->
      <div class="crm-panel p-4" style="background:#fff; border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:1.25rem; display:flex; flex-direction:column; justify-content:space-between;">
        <div>
          <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-subtle); padding-bottom:0.5rem; margin-bottom:0.75rem;">
            <h4 style="font-size:0.8125rem; font-weight:700; text-transform:uppercase; font-family:monospace; color:var(--text-primary); margin:0;">
              SLA Governance Target
            </h4>
            <span id="slaScoreDisplay" style="font-size:0.875rem; font-weight:800; font-family:monospace; color:#059669;">0%</span>
          </div>
          <div style="margin-bottom:0.75rem;">
            <label style="display:block; font-size:0.72rem; font-weight:700; color:var(--text-secondary); text-transform:uppercase; font-family:monospace; margin-bottom:0.25rem;">
              Target SLA Cutoff
            </label>
            <select id="slaTargetSelect" class="form-input" style="width:100%; font-size:0.8125rem; padding:6px 10px; font-family:monospace;">
              <option value="1">&le; 1 Day (Critical Rapid Turnaround)</option>
              <option value="4" selected>&le; 4 Days (Standard Target SLA)</option>
              <option value="7">&le; 7 Days (Escalated Tolerance)</option>
              <option value="15">&le; 15 Days (Aging Backlog Ceiling)</option>
            </select>
          </div>
          <div style="padding:0.75rem; background:var(--bg-surface-subtle); border:1px solid var(--border-subtle); border-radius:var(--radius-md); font-family:monospace; font-size:0.8rem; display:flex; flex-direction:column; gap:0.35rem; margin-bottom:1rem;">
            <div style="display:flex; justify-content:space-between;">
              <span style="color:var(--text-secondary);">Within Target:</span>
              <span id="slaWithinCount" style="font-weight:700; color:#059669;">0</span>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span style="color:var(--text-secondary);">Breached Queue:</span>
              <span id="slaBreachedCount" style="font-weight:700; color:#dc2626;">0</span>
            </div>
          </div>
        </div>
        <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
          <div id="slaComplianceBar" style="height:100%; width:0%; background:#10b981; transition:width 0.3s ease;"></div>
        </div>
      </div>
    </section>

    <!-- Tabbed Viewport: Pivot Matrix & Master Registry Views -->
    <section class="crm-panel overflow-hidden" style="background:#fff; border:1px solid var(--border-subtle); border-radius:var(--radius-lg); overflow:hidden;">
      <!-- Navigation Tabs Strip -->
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-subtle); background:var(--bg-surface-subtle); padding:0.5rem 1rem 0; flex-wrap:wrap; gap:0.5rem;">
        <div style="display:flex; gap:0.25rem;">
          <button class="view-tab active" data-target="tab-consolidated">
            Consolidated Pivot
          </button>
          <button class="view-tab" data-target="tab-hierarchy">
            Regional Tree Pivot
          </button>
          <button class="view-tab" data-target="tab-station">
            Station Matrix Pivot
          </button>
          <button class="view-tab" data-target="tab-raw">
            Master Ticket Registry
          </button>
        </div>

        <div id="tabActionContainer" style="padding-bottom:0.25rem;"></div>
      </div>

      <div style="padding:1rem;">
        <!-- Tab 1: Consolidated Pivot -->
        <div id="tab-consolidated" class="tab-pane">
          <div class="pivot-viewport" id="pivotAgeingContainer"></div>
        </div>

        <!-- Tab 2: Regional Hierarchy Pivot -->
        <div id="tab-hierarchy" class="tab-pane" style="display:none;">
          <div class="pivot-viewport" id="pivotHierarchicalContainer"></div>
        </div>

        <!-- Tab 3: Station Matrix Pivot -->
        <div id="tab-station" class="tab-pane" style="display:none;">
          <div class="pivot-viewport" id="pivotStationContainer"></div>
        </div>

        <!-- Tab 4: Master Raw Record Table -->
        <div id="tab-raw" class="tab-pane" style="display:none; display:flex; flex-direction:column; gap:0.75rem;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span style="font-size:0.75rem; font-family:monospace; color:var(--text-secondary);" id="tableRecordCount">
                Displaying 0 records
              </span>
              <input type="text" id="masterTableSearch" class="form-input" placeholder="Search SO, Station, Model..." style="max-width:240px; padding:4px 8px; font-size:0.75rem;">
            </div>
            <span style="font-size:0.75rem; color:var(--text-tertiary);">Master Operational Ledger</span>
          </div>
          <div class="pivot-viewport" style="max-height:540px;">
            <table id="masterTable">
              <thead>
                <tr id="masterTableHead"></tr>
              </thead>
              <tbody id="masterTableBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  `;

  // Attach event hooks
  initTrackerDOMEvents();
}

/**
 * Attach UI events (filters, tabs, quick queue, export)
 */
function initTrackerDOMEvents() {
  // Tabs switching
  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
      this.classList.add("active");

      const targetId = this.getAttribute("data-target");
      activeTabId = targetId;

      document.querySelectorAll(".tab-pane").forEach((p) => (p.style.display = "none"));
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.style.display = targetId === "tab-raw" ? "flex" : "block";

      renderTabActions(targetId);
    });
  });

  // Quick Queue buttons
  document.querySelectorAll(".queue-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".queue-btn").forEach((b) => b.classList.remove("active"));
      this.classList.add("active");

      const selectedChannel = this.getAttribute("data-actionable");
      activeQuickQueue = selectedChannel;

      if (selectedChannel === "ALL") {
        selectedFilters["Actionable To"] = [...uniqueFilterValues["Actionable To"]];
      } else {
        selectedFilters["Actionable To"] = [selectedChannel];
      }

      renderFilterDropdownUI("Actionable To");
      applyGlobalFiltersAndRender();
    });
  });

  // Reset Filters
  document.getElementById("resetFiltersBtn")?.addEventListener("click", resetAllFilters);

  // SLA Cutoff Select
  document.getElementById("slaTargetSelect")?.addEventListener("change", () => {
    const filtered = getFilteredReportData();
    calculateSLACompliance(filtered);
  });

  // Export 4-sheet Excel
  document.getElementById("exportCsvBtn")?.addEventListener("click", exportToExcel);

  // Global click to close filter dropdowns
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".filter-dropdown")) {
      document.querySelectorAll(".custom-dropdown-content").forEach((d) => d.classList.remove("show"));
    }
  });

  // Master Table Search
  document.getElementById("masterTableSearch")?.addEventListener("input", (e) => {
    currentSearchTerm = e.target.value.toLowerCase().trim();
    const filtered = getFilteredReportData();
    renderMasterTableUI(filtered);
  });

  // Populate filter dropdowns
  Object.keys(uniqueFilterValues).forEach((key) => renderFilterDropdownUI(key));
}

function renderTabActions(targetId) {
  const container = document.getElementById("tabActionContainer");
  if (!container) return;

  if (targetId === "tab-hierarchy") {
    container.innerHTML = `
      <button id="btn-toggle-tree" class="btn-secondary" style="font-size:0.75rem; padding:4px 10px; font-family:monospace;">
        <span>${isPivotExpanded ? "– Collapse All" : "+ Expand All"}</span>
      </button>
    `;
    document.getElementById("btn-toggle-tree")?.addEventListener("click", () => {
      isPivotExpanded = !isPivotExpanded;
      renderTabActions("tab-hierarchy");
      const filtered = getFilteredReportData();
      renderHierarchicalPivot(filtered);
    });
  } else if (targetId === "tab-station") {
    container.innerHTML = `
      <button id="btn-toggle-station-tree" class="btn-secondary" style="font-size:0.75rem; padding:4px 10px; font-family:monospace;">
        <span>${isPivotStationExpanded ? "– Collapse All" : "+ Expand All"}</span>
      </button>
    `;
    document.getElementById("btn-toggle-station-tree")?.addEventListener("click", () => {
      isPivotStationExpanded = !isPivotStationExpanded;
      renderTabActions("tab-station");
      const filtered = getFilteredReportData();
      renderStationPivot(filtered);
    });
  } else {
    container.innerHTML = "";
  }
}

/**
 * Filter Dropdowns
 */
function renderFilterDropdownUI(key) {
  const containerId = `filter-${key.replace(/ /g, "_")}`;
  const dropdownContainer = document.getElementById(containerId);
  if (!dropdownContainer) return;

  const contentDiv = dropdownContainer.querySelector(".custom-dropdown-content");
  const selectBtn = dropdownContainer.querySelector(".select-box");
  if (!contentDiv || !selectBtn) return;

  let html = `
    <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--border-subtle); padding-bottom:6px; margin-bottom:6px; font-family:monospace; font-size:0.7rem;">
      <button class="select-all-btn" style="background:none; border:none; color:var(--moto-blue-accent); font-weight:700; cursor:pointer;" type="button">ALL</button>
      <button class="clear-all-btn" style="background:none; border:none; color:var(--text-tertiary); font-weight:700; cursor:pointer;" type="button">CLEAR</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:2px; max-height:180px; overflow-y:auto;">
  `;

  (uniqueFilterValues[key] || []).forEach((val) => {
    const isChecked = (selectedFilters[key] || []).includes(val) ? "checked" : "";
    html += `
      <label style="display:flex; align-items:center; gap:6px; font-size:0.75rem; font-family:monospace; color:var(--text-primary); padding:3px 4px; border-radius:4px; cursor:pointer;" class="filter-item-label">
        <input type="checkbox" value="${escapeHtml(val)}" ${isChecked} class="item-checkbox" style="cursor:pointer;">
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${val === "" ? "(Blank)" : escapeHtml(val)}</span>
      </label>
    `;
  });

  html += `</div>`;
  contentDiv.innerHTML = html;

  updateDropdownButtonLabel(key, selectBtn);

  selectBtn.onclick = function (e) {
    e.stopPropagation();
    const isShown = contentDiv.classList.contains("show");
    document.querySelectorAll(".custom-dropdown-content").forEach((d) => d.classList.remove("show"));
    if (!isShown) contentDiv.classList.add("show");
  };

  contentDiv.querySelectorAll(".item-checkbox").forEach((cb) => {
    cb.onchange = function () {
      if (this.checked) {
        if (!selectedFilters[key].includes(this.value)) selectedFilters[key].push(this.value);
      } else {
        selectedFilters[key] = selectedFilters[key].filter((v) => v !== this.value);
      }
      updateDropdownButtonLabel(key, selectBtn);
      applyGlobalFiltersAndRender();
    };
  });

  contentDiv.querySelector(".select-all-btn").onclick = function () {
    selectedFilters[key] = [...uniqueFilterValues[key]];
    contentDiv.querySelectorAll(".item-checkbox").forEach((cb) => (cb.checked = true));
    updateDropdownButtonLabel(key, selectBtn);
    applyGlobalFiltersAndRender();
  };

  contentDiv.querySelector(".clear-all-btn").onclick = function () {
    selectedFilters[key] = [];
    contentDiv.querySelectorAll(".item-checkbox").forEach((cb) => (cb.checked = false));
    updateDropdownButtonLabel(key, selectBtn);
    applyGlobalFiltersAndRender();
  };
}

function updateDropdownButtonLabel(key, buttonEl) {
  const selectedCount = (selectedFilters[key] || []).length;
  const totalCount = (uniqueFilterValues[key] || []).length;
  if (selectedCount === totalCount) {
    buttonEl.innerText = "All Selected ⬇";
  } else if (selectedCount === 0) {
    buttonEl.innerText = "None (0) ⬇";
  } else {
    buttonEl.innerText = `Selected (${selectedCount}) ⬇`;
  }
}

function resetAllFilters() {
  Object.keys(uniqueFilterValues).forEach((key) => {
    selectedFilters[key] = [...uniqueFilterValues[key]];
    renderFilterDropdownUI(key);
  });
  document.querySelectorAll(".queue-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector('.queue-btn[data-actionable="ALL"]')?.classList.add("active");
  document.querySelectorAll(".custom-dropdown-content").forEach((d) => d.classList.remove("show"));
  currentSearchTerm = "";
  const searchInput = document.getElementById("masterTableSearch");
  if (searchInput) searchInput.value = "";
  applyGlobalFiltersAndRender();
}

function getFilteredReportData() {
  return finalReportData.filter((row) => {
    for (const key in selectedFilters) {
      const cellVal = String(row[key] || "").trim();
      if (!selectedFilters[key].includes(cellVal)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Filter Engine & Re-render Controller
 */
function applyGlobalFiltersAndRender() {
  const filteredData = getFilteredReportData();

  calculateKPIMetrics(filteredData);
  renderAgeingChart(filteredData);
  calculateSLACompliance(filteredData);
  renderAgeingPivot(filteredData);
  renderHierarchicalPivot(filteredData);
  renderStationPivot(filteredData);
  renderMasterTableUI(filteredData);
}

function calculateKPIMetrics(data) {
  let totalOpen = data.length;
  let waitingPickup = 0;
  let actionableCCI = 0;
  let aspCwh = 0;
  let transitCCI = 0;
  let partsServiceCenter = 0;
  let motorolaActionable = 0;

  data.forEach((row) => {
    const currentStatus = row["Current Status - Open Call"];
    const actionableTo = row["Actionable To"];

    if (currentStatus === "RFPU") waitingPickup++;
    if (actionableTo === "CCI") actionableCCI++;
    if (actionableTo === "CWH") aspCwh++;
    if (currentStatus === "ASP CWH to CCI") transitCCI++;
    if (currentStatus === "Parts in Service Center") partsServiceCenter++;
    if (actionableTo === "Motorola") motorolaActionable++;
  });

  const setT = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = val.toLocaleString();
  };

  setT("kpi-total-open", totalOpen);
  setT("kpi-waiting-pickup", waitingPickup);
  setT("kpi-actionable-cci", actionableCCI);
  setT("kpi-asp-cwh", aspCwh);
  setT("kpi-transit-cci", transitCCI);
  setT("kpi-parts-sc", partsServiceCenter);
  setT("kpi-motorola", motorolaActionable);

  setT("queue-all-count", totalOpen);
  setT("queue-cci-count", actionableCCI);
  setT("queue-cwh-count", aspCwh);
  setT("queue-moto-count", motorolaActionable);
}

function renderAgeingChart(data) {
  const container = document.getElementById("ageingChartContainer");
  if (!container) return;

  if (data.length === 0) {
    container.innerHTML = `<p style="font-family:monospace; font-size:0.75rem; color:var(--text-tertiary); text-align:center; padding:1.5rem 0;">No operational records match selected filters.</p>`;
    return;
  }

  const bucketCounts = {};
  AGEING_BUCKETS.forEach((b) => (bucketCounts[b] = 0));
  data.forEach((r) => {
    const b = r["Open Call Ageing Bucket"];
    if (bucketCounts[b] !== undefined) bucketCounts[b]++;
  });

  const maxVal = Math.max(...Object.values(bucketCounts), 1);
  const total = data.length;

  let html = "";
  AGEING_BUCKETS.forEach((bucket) => {
    const count = bucketCounts[bucket];
    const pct = ((count / total) * 100).toFixed(1);
    const barWidth = Math.max((count / maxVal) * 100, count > 0 ? 3 : 0);

    let barColor = "var(--moto-blue-accent)";
    if (bucket === "8-15Days") barColor = "#f59e0b";
    if (bucket === "16-30Days" || bucket === ">30days") barColor = "#ef4444";

    html += `
      <div>
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; font-family:monospace; margin-bottom:3px;">
          <span style="font-weight:700; color:var(--text-primary);">${bucket}</span>
          <span style="color:var(--text-secondary);">${count.toLocaleString()} calls <span style="color:var(--text-tertiary);">(${pct}%)</span></span>
        </div>
        <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
          <div style="width:${barWidth}%; height:100%; background:${barColor}; transition:width 0.3s ease;"></div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function calculateSLACompliance(data) {
  const targetSelect = document.getElementById("slaTargetSelect");
  const targetDays = targetSelect ? parseInt(targetSelect.value, 10) : 4;

  const withinEl = document.getElementById("slaWithinCount");
  const breachedEl = document.getElementById("slaBreachedCount");
  const scoreEl = document.getElementById("slaScoreDisplay");
  const barEl = document.getElementById("slaComplianceBar");

  if (data.length === 0) {
    if (withinEl) withinEl.innerText = "0";
    if (breachedEl) breachedEl.innerText = "0";
    if (scoreEl) scoreEl.innerText = "0%";
    if (barEl) barEl.style.width = "0%";
    return;
  }

  let withinSLA = 0;
  let breachedSLA = 0;

  data.forEach((r) => {
    const days = r["Ageing Days"];
    if (days !== null && days !== undefined) {
      if (days <= targetDays) {
        withinSLA++;
      } else {
        breachedSLA++;
      }
    } else {
      withinSLA++;
    }
  });

  const total = data.length;
  const rate = ((withinSLA / total) * 100).toFixed(1);

  if (withinEl) withinEl.innerText = withinSLA.toLocaleString();
  if (breachedEl) breachedEl.innerText = breachedSLA.toLocaleString();
  if (scoreEl) scoreEl.innerText = `${rate}%`;
  if (barEl) barEl.style.width = `${rate}%`;
}

/**
 * Tab 1: Consolidated Pivot
 */
function renderAgeingPivot(data) {
  const container = document.getElementById("pivotAgeingContainer");
  if (!container) return;

  if (data.length === 0) {
    container.innerHTML = `<p style="font-family:monospace; font-size:0.75rem; color:var(--text-tertiary); text-align:center; padding:2rem 0;">No matching records found.</p>`;
    return;
  }

  const ageingBuckets = AGEING_BUCKETS;
  const pivotData = {};

  data.forEach((row) => {
    const actionableTo = row["Actionable To"] || "Unknown";
    const currentStatus = row["Current Status - Open Call"] || "Unknown";
    const key = `${actionableTo}|||${currentStatus}`;
    const bucket = row["Open Call Ageing Bucket"] || "Unknown";

    if (!pivotData[key]) {
      pivotData[key] = {
        actionableTo,
        currentStatus,
        buckets: {},
      };
      ageingBuckets.forEach((b) => (pivotData[key].buckets[b] = 0));
    }

    if (pivotData[key].buckets[bucket] !== undefined) {
      pivotData[key].buckets[bucket]++;
    }
  });

  const groupedData = {};
  Object.values(pivotData).forEach((item) => {
    if (!groupedData[item.actionableTo]) groupedData[item.actionableTo] = [];
    groupedData[item.actionableTo].push(item);
  });

  Object.keys(groupedData).forEach((key) => {
    groupedData[key].sort((a, b) => a.currentStatus.localeCompare(b.currentStatus));
  });

  const sortedActionableKeys = Object.keys(groupedData).sort();
  const grandTotals = {};
  ageingBuckets.forEach((b) => (grandTotals[b] = 0));
  let overallTotal = 0;

  Object.values(pivotData).forEach((item) => {
    ageingBuckets.forEach((bucket) => {
      grandTotals[bucket] += item.buckets[bucket] || 0;
      overallTotal += item.buckets[bucket] || 0;
    });
  });

  let html = `
    <table>
      <thead>
        <tr>
          <th class="sticky-col-1-header">Actionable Channel / Status</th>
  `;

  ageingBuckets.forEach((bucket) => {
    html += `<th style="text-align:center; font-family:monospace;">${bucket}</th>`;
  });

  html += `
          <th style="text-align:center; font-family:monospace;" class="grand-total-col">Subtotal</th>
        </tr>
      </thead>
      <tbody>
  `;

  sortedActionableKeys.forEach((actionableTo) => {
    const statuses = groupedData[actionableTo];
    let actionableTotal = 0;
    const actionableTotals = {};
    ageingBuckets.forEach((b) => (actionableTotals[b] = 0));

    statuses.forEach((item) => {
      ageingBuckets.forEach((bucket) => {
        actionableTotals[bucket] += item.buckets[bucket] || 0;
        actionableTotal += item.buckets[bucket] || 0;
      });
    });

    if (actionableTotal > 0) {
      html += `<tr class="parent-row">`;
      html += `<td class="sticky-col-1 font-mono-data" style="font-weight:700;">${actionableTo}</td>`;
      ageingBuckets.forEach((bucket) => {
        const val = actionableTotals[bucket] || 0;
        html += `<td style="text-align:center; font-family:monospace; font-weight:700;">${val > 0 ? val.toLocaleString() : "—"}</td>`;
      });
      html += `<td style="text-align:center; font-family:monospace; font-weight:900;" class="grand-total-col">${actionableTotal.toLocaleString()}</td>`;
      html += `</tr>`;

      statuses.forEach((item) => {
        const itemTotal = ageingBuckets.reduce((sum, b) => sum + (item.buckets[b] || 0), 0);
        if (itemTotal === 0) return;

        html += `<tr>`;
        html += `<td class="sticky-col-1 child-row">${escapeHtml(item.currentStatus)}</td>`;
        ageingBuckets.forEach((bucket) => {
          const val = item.buckets[bucket] || 0;
          html += `<td style="text-align:center; font-family:monospace; color:${val > 0 ? "var(--text-primary)" : "var(--text-tertiary)"};">${val > 0 ? val.toLocaleString() : "0"}</td>`;
        });
        html += `<td style="text-align:center; font-family:monospace; font-weight:600;" class="grand-total-col">${itemTotal.toLocaleString()}</td>`;
        html += `</tr>`;
      });
    }
  });

  html += `<tr class="grand-total-row">`;
  html += `<td class="sticky-col-1 font-mono-data" style="font-weight:800; text-transform:uppercase;">Grand Total</td>`;
  ageingBuckets.forEach((bucket) => {
    html += `<td style="text-align:center; font-family:monospace; font-weight:900;">${grandTotals[bucket].toLocaleString()}</td>`;
  });
  html += `<td style="text-align:center; font-family:monospace; font-weight:900;" class="grand-total-col">${overallTotal.toLocaleString()}</td>`;
  html += `</tr></tbody></table>`;

  container.innerHTML = html;
}

/**
 * Tab 2: Regional Tree Pivot
 */
function renderHierarchicalPivot(data) {
  const container = document.getElementById("pivotHierarchicalContainer");
  if (!container) return;

  if (data.length === 0) {
    container.innerHTML = `<p style="font-family:monospace; font-size:0.75rem; color:var(--text-tertiary); text-align:center; padding:2rem 0;">No matching records found.</p>`;
    return;
  }

  const ageingBuckets = AGEING_BUCKETS;
  const tree = {};

  data.forEach((row) => {
    const region = row["Region"] || "Unmapped";
    const actionableTo = row["Actionable To"] || "Unknown";
    const currentStatus = row["Current Status - Open Call"] || "Unknown";
    const bucket = row["Open Call Ageing Bucket"] || "Unknown";

    if (!tree[region]) tree[region] = {};
    if (!tree[region][actionableTo]) tree[region][actionableTo] = {};
    if (!tree[region][actionableTo][currentStatus]) {
      tree[region][actionableTo][currentStatus] = {};
      ageingBuckets.forEach((b) => (tree[region][actionableTo][currentStatus][b] = 0));
    }

    if (tree[region][actionableTo][currentStatus][bucket] !== undefined) {
      tree[region][actionableTo][currentStatus][bucket]++;
    }
  });

  let html = `
    <table>
      <thead>
        <tr>
          <th class="sticky-col-1-header">Territory Hierarchy Tree</th>
  `;

  ageingBuckets.forEach((bucket) => {
    html += `<th style="text-align:center; font-family:monospace;">${bucket}</th>`;
  });

  html += `
          <th style="text-align:center; font-family:monospace;" class="grand-total-col">Subtotal</th>
        </tr>
      </thead>
      <tbody>
  `;

  const sortedRegions = Object.keys(tree).sort();
  const grandTotals = {};
  ageingBuckets.forEach((b) => (grandTotals[b] = 0));
  let overallTotal = 0;

  const hiddenStyle = isPivotExpanded ? "" : "display:none;";
  const symbol = isPivotExpanded ? "–" : "+";

  sortedRegions.forEach((region, rIdx) => {
    const regData = tree[region];
    const regionTotals = {};
    ageingBuckets.forEach((b) => (regionTotals[b] = 0));
    let regionTotal = 0;

    Object.values(regData).forEach((actData) => {
      Object.values(actData).forEach((statusData) => {
        ageingBuckets.forEach((b) => {
          const count = statusData[b] || 0;
          regionTotals[b] += count;
          regionTotal += count;
          grandTotals[b] += count;
          overallTotal += count;
        });
      });
    });

    if (regionTotal === 0) return;

    const regRowId = `p-reg-${rIdx}`;

    html += `<tr class="parent-row" data-tree-toggle="${regRowId}">`;
    html += `<td class="sticky-col-1 font-mono-data" style="font-weight:700;"><span id="icon-${regRowId}" style="margin-right:8px; color:var(--moto-blue-accent); font-weight:800;">${symbol}</span>${escapeHtml(region)}</td>`;
    ageingBuckets.forEach((bucket) => {
      const val = regionTotals[bucket];
      html += `<td style="text-align:center; font-family:monospace; font-weight:700;">${val > 0 ? val.toLocaleString() : "—"}</td>`;
    });
    html += `<td style="text-align:center; font-family:monospace; font-weight:900;" class="grand-total-col">${regionTotal.toLocaleString()}</td>`;
    html += `</tr>`;

    const sortedActionables = Object.keys(regData).sort();
    sortedActionables.forEach((actionableTo, aIdx) => {
      const actData = regData[actionableTo];
      const actTotals = {};
      ageingBuckets.forEach((b) => (actTotals[b] = 0));
      let actTotal = 0;

      Object.values(actData).forEach((statusData) => {
        ageingBuckets.forEach((b) => {
          const count = statusData[b] || 0;
          actTotals[b] += count;
          actTotal += count;
        });
      });

      if (actTotal === 0) return;

      const actRowId = `p-act-${rIdx}-${aIdx}`;

      html += `<tr class="sub-parent-row ${regRowId}" style="${hiddenStyle}" data-tree-toggle="${actRowId}">`;
      html += `<td class="sticky-col-1 child-row font-mono-data"><span id="icon-${actRowId}" style="margin-right:8px; color:var(--text-tertiary); font-weight:700;">${symbol}</span><span style="font-weight:600;">${actionableTo}</span></td>`;
      ageingBuckets.forEach((bucket) => {
        const val = actTotals[bucket];
        html += `<td style="text-align:center; font-family:monospace; font-weight:600;">${val > 0 ? val.toLocaleString() : "—"}</td>`;
      });
      html += `<td style="text-align:center; font-family:monospace; font-weight:700;" class="grand-total-col">${actTotal.toLocaleString()}</td>`;
      html += `</tr>`;

      const sortedStatuses = Object.keys(actData).sort();
      sortedStatuses.forEach((status) => {
        const statusData = actData[status];
        const statusTotal = ageingBuckets.reduce((sum, b) => sum + (statusData[b] || 0), 0);

        if (statusTotal === 0) return;

        html += `<tr class="${regRowId} ${actRowId}" style="${hiddenStyle}">`;
        html += `<td class="sticky-col-1 deep-child-row">${escapeHtml(status)}</td>`;
        ageingBuckets.forEach((bucket) => {
          const val = statusData[bucket] || 0;
          html += `<td style="text-align:center; font-family:monospace; font-size:0.75rem; color:${val > 0 ? "var(--text-primary)" : "var(--text-tertiary)"};">${val > 0 ? val.toLocaleString() : "0"}</td>`;
        });
        html += `<td style="text-align:center; font-family:monospace; font-size:0.75rem; font-weight:500;" class="grand-total-col">${statusTotal.toLocaleString()}</td>`;
        html += `</tr>`;
      });
    });
  });

  html += `<tr class="grand-total-row">`;
  html += `<td class="sticky-col-1 font-mono-data" style="font-weight:800; text-transform:uppercase;">Grand Total</td>`;
  ageingBuckets.forEach((bucket) => {
    html += `<td style="text-align:center; font-family:monospace; font-weight:900;">${grandTotals[bucket].toLocaleString()}</td>`;
  });
  html += `<td style="text-align:center; font-family:monospace; font-weight:900;" class="grand-total-col">${overallTotal.toLocaleString()}</td>`;
  html += `</tr></tbody></table>`;

  container.innerHTML = html;

  // Toggle rows
  container.querySelectorAll("[data-tree-toggle]").forEach((rowEl) => {
    rowEl.addEventListener("click", () => {
      const groupId = rowEl.getAttribute("data-tree-toggle");
      const childRows = container.querySelectorAll(`.${groupId}`);
      const icon = document.getElementById(`icon-${groupId}`);
      let isHiding = false;

      childRows.forEach((r) => {
        if (r.style.display === "none") {
          r.style.display = "";
        } else {
          r.style.display = "none";
          isHiding = true;
        }
      });

      if (icon) icon.innerText = isHiding ? "+" : "–";
    });
  });
}

/**
 * Tab 3: Station Matrix Pivot
 */
function renderStationPivot(data) {
  const container = document.getElementById("pivotStationContainer");
  if (!container) return;

  if (data.length === 0) {
    container.innerHTML = `<p style="font-family:monospace; font-size:0.75rem; color:var(--text-tertiary); text-align:center; padding:2rem 0;">No matching records found.</p>`;
    return;
  }

  const statusColumns = [...new Set(data.map((r) => r["Current Status - Open Call"] || "Unknown"))].sort();
  const tree = {};

  data.forEach((row) => {
    const region = row["Region"] || "Unmapped";
    const stationCode = row["Station Code"] || "Unknown";
    const stationName = row["Station Name"] || "Unknown";
    const status = row["Current Status - Open Call"] || "Unknown";

    if (!tree[region]) tree[region] = {};
    if (!tree[region][stationCode]) tree[region][stationCode] = {};
    if (!tree[region][stationCode][stationName]) {
      tree[region][stationCode][stationName] = {};
      statusColumns.forEach((s) => (tree[region][stationCode][stationName][s] = 0));
    }

    if (tree[region][stationCode][stationName][status] !== undefined) {
      tree[region][stationCode][stationName][status]++;
    }
  });

  let html = `
    <table>
      <thead>
        <tr>
          <th class="sticky-col-1-header">Region</th>
          <th style="font-family:monospace; text-align:center;">Code</th>
          <th style="font-family:monospace; text-align:left;">Facility Name</th>
  `;

  statusColumns.forEach((status) => {
    html += `<th style="text-align:center; font-family:monospace;">${escapeHtml(status)}</th>`;
  });

  html += `
          <th style="text-align:center; font-family:monospace;" class="grand-total-col">Subtotal</th>
        </tr>
      </thead>
      <tbody>
  `;

  const sortedRegions = Object.keys(tree).sort();
  const grandTotals = {};
  statusColumns.forEach((s) => (grandTotals[s] = 0));
  let overallTotal = 0;

  const hiddenStyle = isPivotStationExpanded ? "" : "display:none;";
  const symbol = isPivotStationExpanded ? "–" : "+";

  sortedRegions.forEach((region, rIdx) => {
    const regData = tree[region];
    const regionTotals = {};
    statusColumns.forEach((s) => (regionTotals[s] = 0));
    let regionTotal = 0;

    Object.values(regData).forEach((codeObj) => {
      Object.values(codeObj).forEach((statusCounts) => {
        statusColumns.forEach((s) => {
          const count = statusCounts[s] || 0;
          regionTotals[s] += count;
          regionTotal += count;
          grandTotals[s] += count;
          overallTotal += count;
        });
      });
    });

    if (regionTotal === 0) return;

    const regRowId = `st-reg-${rIdx}`;

    html += `<tr class="parent-row" data-station-toggle="${regRowId}">`;
    html += `<td colspan="3" class="sticky-col-1 font-mono-data" style="font-weight:700;"><span id="icon-${regRowId}" style="margin-right:8px; color:var(--moto-blue-accent); font-weight:800;">${symbol}</span>${escapeHtml(region)}</td>`;
    statusColumns.forEach((status) => {
      const val = regionTotals[status];
      html += `<td style="text-align:center; font-family:monospace; font-weight:700;">${val > 0 ? val.toLocaleString() : "—"}</td>`;
    });
    html += `<td style="text-align:center; font-family:monospace; font-weight:900;" class="grand-total-col">${regionTotal.toLocaleString()}</td>`;
    html += `</tr>`;

    const sortedCodes = Object.keys(regData).sort();
    sortedCodes.forEach((stationCode) => {
      const codeObj = regData[stationCode];
      const sortedNames = Object.keys(codeObj).sort();

      sortedNames.forEach((stationName) => {
        const statusCounts = codeObj[stationName];
        const stationTotal = statusColumns.reduce((sum, s) => sum + (statusCounts[s] || 0), 0);

        if (stationTotal === 0) return;

        html += `<tr class="${regRowId}" style="${hiddenStyle}">`;
        html += `<td class="sticky-col-1 font-mono-data" style="font-size:0.75rem; color:var(--text-tertiary); font-style:italic;">${escapeHtml(region)}</td>`;
        html += `<td style="font-family:monospace; font-size:0.75rem; text-align:center; font-weight:600; color:var(--text-primary);">${escapeHtml(stationCode)}</td>`;
        html += `<td style="font-size:0.75rem; color:var(--text-secondary); max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(stationName)}</td>`;

        statusColumns.forEach((status) => {
          const val = statusCounts[status] || 0;
          html += `<td style="text-align:center; font-family:monospace; font-size:0.75rem; color:${val > 0 ? "var(--text-primary)" : "var(--text-tertiary)"};">${val > 0 ? val.toLocaleString() : "0"}</td>`;
        });
        html += `<td style="text-align:center; font-family:monospace; font-size:0.75rem; font-weight:700;" class="grand-total-col">${stationTotal.toLocaleString()}</td>`;
        html += `</tr>`;
      });
    });
  });

  html += `<tr class="grand-total-row">`;
  html += `<td colspan="3" class="sticky-col-1 font-mono-data" style="font-weight:800; text-transform:uppercase;">Grand Total</td>`;
  statusColumns.forEach((status) => {
    html += `<td style="text-align:center; font-family:monospace; font-weight:900;">${grandTotals[status].toLocaleString()}</td>`;
  });
  html += `<td style="text-align:center; font-family:monospace; font-weight:900;" class="grand-total-col">${overallTotal.toLocaleString()}</td>`;
  html += `</tr></tbody></table>`;

  container.innerHTML = html;

  container.querySelectorAll("[data-station-toggle]").forEach((rowEl) => {
    rowEl.addEventListener("click", () => {
      const groupId = rowEl.getAttribute("data-station-toggle");
      const childRows = container.querySelectorAll(`.${groupId}`);
      const icon = document.getElementById(`icon-${groupId}`);
      let isHiding = false;

      childRows.forEach((r) => {
        if (r.style.display === "none") {
          r.style.display = "";
        } else {
          r.style.display = "none";
          isHiding = true;
        }
      });

      if (icon) icon.innerText = isHiding ? "+" : "–";
    });
  });
}

/**
 * Tab 4: Master Table Registry
 */
function renderMasterTableUI(data) {
  const columnsToLoad = [
    "Service Order",
    "Station Code",
    "Station Name",
    "Model",
    "IMEI1",
    "Service Order Status",
    "Warranty Status",
    "Parts Status",
    "DOA Status",
    "Carry-In Time",
    "Ageing Days",
    "Open Call Ageing Bucket",
    "Region",
    "Current Status - Open Call",
    "Actionable To",
  ];

  const headerRow = document.getElementById("masterTableHead");
  const bodyRow = document.getElementById("masterTableBody");
  const countEl = document.getElementById("tableRecordCount");
  if (!headerRow || !bodyRow) return;

  headerRow.innerHTML = columnsToLoad
    .map((col) => `<th style="padding:8px 12px; font-family:monospace; font-size:0.7rem; font-weight:600; text-transform:uppercase; color:var(--text-secondary); background:var(--bg-surface-subtle); border-bottom:1px solid var(--border-subtle);">${col}</th>`)
    .join("");

  let displayData = data;
  if (currentSearchTerm) {
    displayData = displayData.filter((r) => {
      return (
        String(r["Service Order"]).toLowerCase().includes(currentSearchTerm) ||
        String(r["Station Code"]).toLowerCase().includes(currentSearchTerm) ||
        String(r["Station Name"]).toLowerCase().includes(currentSearchTerm) ||
        String(r["Model"]).toLowerCase().includes(currentSearchTerm) ||
        String(r["Region"]).toLowerCase().includes(currentSearchTerm)
      );
    });
  }

  if (countEl) countEl.innerText = `${displayData.length.toLocaleString()} Operational Records`;

  if (displayData.length === 0) {
    bodyRow.innerHTML = `<tr><td colspan="${columnsToLoad.length}" style="text-align:center; padding:2rem; font-family:monospace; font-size:0.75rem; color:var(--text-tertiary);">No operational records match selected filters or search.</td></tr>`;
    return;
  }

  // Render top 250 rows for snappy DOM responsiveness
  const sliceRows = displayData.slice(0, 250);

  bodyRow.innerHTML = sliceRows
    .map((row) => {
      return (
        `<tr>` +
        columnsToLoad
          .map((col) => {
            const cellVal = row[col] === "" || row[col] === null || row[col] === undefined ? "—" : row[col];
            return `<td style="padding:6px 12px; font-family:monospace; font-size:0.75rem; color:var(--text-primary); border-bottom:1px solid #f1f5f9; white-space:nowrap; max-width:200px; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(cellVal)}</td>`;
          })
          .join("") +
        `</tr>`
      );
    })
    .join("");
}

/**
 * Excel 4-Sheet Workbook Exporter
 */
function exportToExcel() {
  const filteredData = getFilteredReportData();
  if (filteredData.length === 0) {
    showToast("No operational records match the current filter selection.", "warning");
    return;
  }

  try {
    const wb = XLSX.utils.book_new();

    // 1. Consolidated Pivot
    const pivot1AOA = buildAgeingPivotSheet(filteredData);
    const ws1 = XLSX.utils.aoa_to_sheet(pivot1AOA);
    XLSX.utils.book_append_sheet(wb, ws1, "Consolidated Pivot");

    // 2. Regional Hierarchy
    const pivot2AOA = buildHierarchicalPivotSheet(filteredData);
    const ws2 = XLSX.utils.aoa_to_sheet(pivot2AOA);
    XLSX.utils.book_append_sheet(wb, ws2, "Regional Hierarchy");

    // 3. Station Matrix
    const pivot3AOA = buildStationPivotSheet(filteredData);
    const ws3 = XLSX.utils.aoa_to_sheet(pivot3AOA);
    XLSX.utils.book_append_sheet(wb, ws3, "Station Matrix");

    // 4. Master Open Calls
    const columnsToLoad = [
      "Service Order",
      "Station Code",
      "Station Name",
      "Model",
      "IMEI1",
      "IMEI2",
      "SN",
      "Service Order Status",
      "Warranty Status",
      "Parts Status",
      "DOA Status",
      "CID Status",
      "SO Submitted Time",
      "Carry-In Time",
      "Apply for Parts Time",
      "Finish Repair Time",
      "Parts in CCI Time",
      "Parts Available in Country Time",
      "Parts Available in ASP Hub Time",
      "Transaction Code",
      "Repair Code",
      "Repair Code Description",
      "Repair Type",
      "Service Type",
      "Ageing Days",
      "Open Call Ageing Bucket",
      "Ageing Source",
      "Waiting for pickup Ageing Bucket",
      "Region",
      "Current Status - Open Call",
      "Actionable To",
    ];

    const masterRows = filteredData.map((r) => {
      const rowObj = {};
      columnsToLoad.forEach((col) => {
        rowObj[col] = r[col] || "";
      });
      return rowObj;
    });

    const ws4 = XLSX.utils.json_to_sheet(masterRows, { header: columnsToLoad });
    XLSX.utils.book_append_sheet(wb, ws4, "Master Open Calls");

    const filename = `Motorola_Open_Calls_Consolidated_Report_${latestCallDateString}.xlsx`;
    XLSX.writeFile(wb, filename);

    showToast("4-Sheet Workbook exported successfully!", "success");
  } catch (err) {
    console.error("Export error:", err);
    showToast(`Export failed: ${err.message}`, "error");
  }
}

function buildAgeingPivotSheet(data) {
  const ageingBuckets = AGEING_BUCKETS;
  const pivotData = {};

  data.forEach((row) => {
    const actionableTo = row["Actionable To"] || "Unknown";
    const currentStatus = row["Current Status - Open Call"] || "Unknown";
    const key = `${actionableTo}|||${currentStatus}`;
    const bucket = row["Open Call Ageing Bucket"] || "Unknown";

    if (!pivotData[key]) {
      pivotData[key] = {
        actionableTo,
        currentStatus,
        buckets: {},
      };
      ageingBuckets.forEach((b) => (pivotData[key].buckets[b] = 0));
    }

    if (pivotData[key].buckets[bucket] !== undefined) {
      pivotData[key].buckets[bucket]++;
    }
  });

  const groupedData = {};
  Object.values(pivotData).forEach((item) => {
    if (!groupedData[item.actionableTo]) groupedData[item.actionableTo] = [];
    groupedData[item.actionableTo].push(item);
  });

  const sortedActionableKeys = Object.keys(groupedData).sort();
  const aoa = [["Current Status - Open Call", ...ageingBuckets, "Total"]];
  const grandTotals = {};
  ageingBuckets.forEach((b) => (grandTotals[b] = 0));
  let overallTotal = 0;

  sortedActionableKeys.forEach((actionableTo) => {
    const statuses = groupedData[actionableTo];
    let actionableTotal = 0;
    const actionableTotals = {};
    ageingBuckets.forEach((b) => (actionableTotals[b] = 0));

    statuses.forEach((item) => {
      ageingBuckets.forEach((bucket) => {
        actionableTotals[bucket] += item.buckets[bucket] || 0;
        actionableTotal += item.buckets[bucket] || 0;
      });
    });

    if (actionableTotal > 0) {
      const parentRow = [actionableTo];
      ageingBuckets.forEach((bucket) => {
        const val = actionableTotals[bucket] || 0;
        parentRow.push(val);
        grandTotals[bucket] += val;
        overallTotal += val;
      });
      parentRow.push(actionableTotal);
      aoa.push(parentRow);

      statuses.forEach((item) => {
        const itemTotal = ageingBuckets.reduce((sum, b) => sum + (item.buckets[b] || 0), 0);
        if (itemTotal > 0) {
          const childRow = [item.currentStatus];
          ageingBuckets.forEach((bucket) => {
            childRow.push(item.buckets[bucket] || 0);
          });
          childRow.push(itemTotal);
          aoa.push(childRow);
        }
      });
    }
  });

  const grandTotalRow = ["Grand Total"];
  ageingBuckets.forEach((bucket) => grandTotalRow.push(grandTotals[bucket]));
  grandTotalRow.push(overallTotal);
  aoa.push(grandTotalRow);

  return aoa;
}

function buildHierarchicalPivotSheet(data) {
  const ageingBuckets = AGEING_BUCKETS;
  const tree = {};

  data.forEach((row) => {
    const region = row["Region"] || "Unmapped";
    const actionableTo = row["Actionable To"] || "Unknown";
    const currentStatus = row["Current Status - Open Call"] || "Unknown";
    const bucket = row["Open Call Ageing Bucket"] || "Unknown";

    if (!tree[region]) tree[region] = {};
    if (!tree[region][actionableTo]) tree[region][actionableTo] = {};
    if (!tree[region][actionableTo][currentStatus]) {
      tree[region][actionableTo][currentStatus] = {};
      ageingBuckets.forEach((b) => (tree[region][actionableTo][currentStatus][b] = 0));
    }

    if (tree[region][actionableTo][currentStatus][bucket] !== undefined) {
      tree[region][actionableTo][currentStatus][bucket]++;
    }
  });

  const aoa = [["Region / Actionable To / Current Status", ...ageingBuckets, "Total"]];
  const grandTotals = {};
  ageingBuckets.forEach((b) => (grandTotals[b] = 0));
  let overallTotal = 0;

  const sortedRegions = Object.keys(tree).sort();

  sortedRegions.forEach((region) => {
    const regData = tree[region];
    const regionTotals = {};
    ageingBuckets.forEach((b) => (regionTotals[b] = 0));
    let regionTotal = 0;

    Object.values(regData).forEach((actData) => {
      Object.values(actData).forEach((statusData) => {
        ageingBuckets.forEach((b) => {
          const count = statusData[b] || 0;
          regionTotals[b] += count;
          regionTotal += count;
        });
      });
    });

    if (regionTotal === 0) return;

    const regionRow = [region];
    ageingBuckets.forEach((bucket) => {
      regionRow.push(regionTotals[bucket] || 0);
      grandTotals[bucket] += regionTotals[bucket] || 0;
    });
    regionRow.push(regionTotal);
    overallTotal += regionTotal;
    aoa.push(regionRow);

    const sortedActionables = Object.keys(regData).sort();
    sortedActionables.forEach((actionableTo) => {
      const actData = regData[actionableTo];
      const actTotals = {};
      ageingBuckets.forEach((b) => (actTotals[b] = 0));
      let actTotal = 0;

      Object.values(actData).forEach((statusData) => {
        ageingBuckets.forEach((b) => {
          const count = statusData[b] || 0;
          actTotals[b] += count;
          actTotal += count;
        });
      });

      if (actTotal === 0) return;

      const actRow = [`  ${actionableTo}`];
      ageingBuckets.forEach((bucket) => actRow.push(actTotals[bucket] || 0));
      actRow.push(actTotal);
      aoa.push(actRow);

      const sortedStatuses = Object.keys(actData).sort();
      sortedStatuses.forEach((status) => {
        const statusData = actData[status];
        const statusTotal = ageingBuckets.reduce((sum, b) => sum + (statusData[b] || 0), 0);

        if (statusTotal === 0) return;

        const statusRow = [`    ${status}`];
        ageingBuckets.forEach((bucket) => statusRow.push(statusData[bucket] || 0));
        statusRow.push(statusTotal);
        aoa.push(statusRow);
      });
    });
  });

  const grandTotalRow = ["Grand Total"];
  ageingBuckets.forEach((bucket) => grandTotalRow.push(grandTotals[bucket]));
  grandTotalRow.push(overallTotal);
  aoa.push(grandTotalRow);

  return aoa;
}

function buildStationPivotSheet(data) {
  const statusColumns = [...new Set(data.map((r) => r["Current Status - Open Call"] || "Unknown"))].sort();
  const tree = {};

  data.forEach((row) => {
    const region = row["Region"] || "Unmapped";
    const stationCode = row["Station Code"] || "Unknown";
    const stationName = row["Station Name"] || "Unknown";
    const status = row["Current Status - Open Call"] || "Unknown";

    if (!tree[region]) tree[region] = {};
    if (!tree[region][stationCode]) tree[region][stationCode] = {};
    if (!tree[region][stationCode][stationName]) {
      tree[region][stationCode][stationName] = {};
      statusColumns.forEach((s) => (tree[region][stationCode][stationName][s] = 0));
    }

    if (tree[region][stationCode][stationName][status] !== undefined) {
      tree[region][stationCode][stationName][status]++;
    }
  });

  const aoa = [["Region", "Station Code", "Station Name", ...statusColumns, "Total"]];
  const grandTotals = {};
  statusColumns.forEach((s) => (grandTotals[s] = 0));
  let overallTotal = 0;

  const sortedRegions = Object.keys(tree).sort();

  sortedRegions.forEach((region) => {
    const regData = tree[region];
    const regionTotals = {};
    statusColumns.forEach((s) => (regionTotals[s] = 0));
    let regionTotal = 0;

    Object.values(regData).forEach((codeObj) => {
      Object.values(codeObj).forEach((statusCounts) => {
        statusColumns.forEach((s) => {
          const count = statusCounts[s] || 0;
          regionTotals[s] += count;
          regionTotal += count;
          grandTotals[s] += count;
          overallTotal += count;
        });
      });
    });

    if (regionTotal === 0) return;

    const regionRow = [region, "", ""];
    statusColumns.forEach((status) => {
      regionRow.push(regionTotals[status] || 0);
      grandTotals[status] += regionTotals[status] || 0;
    });
    regionRow.push(regionTotal);
    overallTotal += regionTotal;
    aoa.push(regionRow);

    const sortedCodes = Object.keys(regData).sort();
    sortedCodes.forEach((stationCode) => {
      const codeObj = regData[stationCode];
      const sortedNames = Object.keys(codeObj).sort();

      sortedNames.forEach((stationName) => {
        const statusCounts = codeObj[stationName];
        const stationTotal = statusColumns.reduce((sum, s) => sum + (statusCounts[s] || 0), 0);

        if (stationTotal === 0) return;

        const detailRow = [region, stationCode, stationName];
        statusColumns.forEach((status) => detailRow.push(statusCounts[status] || 0));
        detailRow.push(stationTotal);
        aoa.push(detailRow);
      });
    });
  });

  const grandTotalRow = ["Grand Total", "", ""];
  statusColumns.forEach((status) => grandTotalRow.push(grandTotals[status]));
  grandTotalRow.push(overallTotal);
  aoa.push(grandTotalRow);

  return aoa;
}
