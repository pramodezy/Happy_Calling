// ============================================================================
// Motorola Closure Data Import Controller (XLSX, XLS, CSV & Google Sheets)
// ============================================================================

import * as XLSX from "xlsx";
import { supabase, formatSupabaseError } from "./supabase.js";
import { icons, escapeHtml, formatDate, formatDateTime, parseFlexibleDate, detectDatasetDateFormat, cleanCellVal } from "./utils.js";
import { showToast } from "../components/toast.js";
import { renderSpinner } from "../components/loading.js";
import { openModal, closeModal } from "../components/modal.js";

let parsedClosures = [];
let fileMetadata = null;

export async function renderImportPage(container) {
  parsedClosures = [];
  fileMetadata = null;

  container.innerHTML = `
    <div style="margin-bottom:1.5rem;">
      <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Motorola Closure Data Import</h2>
      <p style="font-size:0.875rem; color:var(--text-secondary);">Batch ingest Motorola service closure records from XLSX, XLS, or CSV files into Supabase.</p>
    </div>

    <!-- Import Tabs: File Upload vs Google Sheets Sync -->
    <div style="display:flex; border-bottom:1px solid var(--border-subtle); margin-bottom:1.5rem; gap:1.5rem;">
      <button type="button" id="tab-btn-file-upload" class="import-tab-btn active" style="padding:0.75rem 0.25rem; font-weight:600; border-bottom:2px solid var(--moto-blue-accent); color:var(--moto-blue-accent);">
        File Upload (Excel / CSV)
      </button>
      <button type="button" id="tab-btn-sheet-sync" class="import-tab-btn" style="padding:0.75rem 0.25rem; font-weight:600; border-bottom:2px solid transparent; color:var(--text-secondary);">
        Google Sheets Sync (Optional)
      </button>
      <button type="button" id="tab-btn-import-history" class="import-tab-btn" style="padding:0.75rem 0.25rem; font-weight:600; border-bottom:2px solid transparent; color:var(--text-secondary);">
        Import History & Audit
      </button>
    </div>

    <!-- Panel 1: File Upload -->
    <div id="panel-file-upload">
      <div class="dropzone" id="file-dropzone">
        <div style="color:var(--moto-blue-accent); width:48px; height:48px; margin:0 auto 0.75rem;">
          ${icons.upload}
        </div>
        <h4 style="font-size:1.05rem; font-weight:600; color:var(--text-primary); margin-bottom:0.25rem;">
          Drag & Drop Motorola Closure File (.xlsx, .xls, .csv)
        </h4>
        <p style="font-size:0.875rem; color:var(--text-tertiary); margin-bottom:1rem;">
          Supports Motorola standard closure dumps with automatic header mapping
        </p>
        <label for="input-file-select" class="btn-primary" style="display:inline-flex; cursor:pointer;">
          <span>Choose File</span>
        </label>
        <input type="file" id="input-file-select" accept=".xlsx,.xls,.csv" style="display:none;">
      </div>

      <!-- Preview & Validation Area -->
      <div id="import-preview-area" style="margin-top:1.5rem; display:none;"></div>
    </div>

    <!-- Panel 2: Google Sheets Sync -->
    <div id="panel-sheet-sync" style="display:none;">
      <div class="call-feedback-form-card" style="max-width:650px;">
        <h3 style="font-size:1.1rem; font-weight:700; margin-bottom:0.5rem;">Sync from Google Sheets</h3>
        <p style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:1.25rem;">
          Synchronize closures directly from a shared Google Sheet through a secure Supabase Edge Function without exposing service credentials.
        </p>

        <div class="form-group">
          <label for="gsheet-id-input" class="form-label">Google Sheet ID or Public URL</label>
          <input type="text" id="gsheet-id-input" class="form-input" placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms">
          <span style="font-size:0.75rem; color:var(--text-tertiary); display:block; margin-top:4px;">
            The Google Sheet must have "Anyone with the link can view" access.
          </span>
        </div>

        <div class="form-group">
          <label for="gsheet-range-input" class="form-label">Sheet Name & Range (Optional)</label>
          <input type="text" id="gsheet-range-input" class="form-input" placeholder="Sheet1!A1:Z5000">
        </div>

        <button type="button" id="btn-sync-gsheet" class="btn-primary" style="margin-top:0.5rem;">
          <span style="width:18px; height:18px;">${icons.refreshCw}</span>
          <span>Start Google Sheets Sync</span>
        </button>

        <div id="gsheet-sync-result" style="margin-top:1.25rem;"></div>
      </div>
    </div>

    <!-- Panel 3: Import History -->
    <div id="panel-import-history" style="display:none;">
      <div id="import-history-mount">
        ${renderSpinner("Loading past closure imports...")}
      </div>
    </div>
  `;

  initImportTabs();
  initFileUploadEvents();
  initGoogleSheetsEvents();
}

/**
 * Handle Tab navigation
 */
function initImportTabs() {
  const tabUpload = document.getElementById("tab-btn-file-upload");
  const tabSheet = document.getElementById("tab-btn-sheet-sync");
  const tabHistory = document.getElementById("tab-btn-import-history");

  const panelUpload = document.getElementById("panel-file-upload");
  const panelSheet = document.getElementById("panel-sheet-sync");
  const panelHistory = document.getElementById("panel-import-history");

  function setTab(activeTab, activePanel) {
    [tabUpload, tabSheet, tabHistory].forEach((t) => {
      t.style.borderBottomColor = "transparent";
      t.style.color = "var(--text-secondary)";
      t.classList.remove("active");
    });
    [panelUpload, panelSheet, panelHistory].forEach((p) => (p.style.display = "none"));

    activeTab.style.borderBottomColor = "var(--moto-blue-accent)";
    activeTab.style.color = "var(--moto-blue-accent)";
    activeTab.classList.add("active");
    activePanel.style.display = "block";
  }

  tabUpload?.addEventListener("click", () => setTab(tabUpload, panelUpload));
  tabSheet?.addEventListener("click", () => setTab(tabSheet, panelSheet));
  tabHistory?.addEventListener("click", () => {
    setTab(tabHistory, panelHistory);
    loadImportHistory();
  });
}

/**
 * File upload, drag-and-drop, and parsing
 */
function initFileUploadEvents() {
  const dropzone = document.getElementById("file-dropzone");
  const fileInput = document.getElementById("input-file-select");

  dropzone?.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone?.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone?.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleIncomingFile(e.dataTransfer.files[0]);
    }
  });

  fileInput?.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleIncomingFile(e.target.files[0]);
    }
  });
}

/**
 * Read and parse XLSX / XLS / CSV using SheetJS
 */
function handleIncomingFile(file) {
  const previewArea = document.getElementById("import-preview-area");
  if (!previewArea) return;

  const validExts = [".xlsx", ".xls", ".csv"];
  const fileName = file.name.toLowerCase();
  const isValid = validExts.some((ext) => fileName.endsWith(ext));

  if (!isValid) {
    showToast("Please select a valid Excel (.xlsx, .xls) or CSV file.", "error");
    return;
  }

  previewArea.style.display = "block";
  previewArea.innerHTML = renderSpinner(`Reading and parsing "${file.name}"...`);

  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      // Use raw: true and cellDates: false to prevent SheetJS from internally guessing US MM/DD/YY dates on CSV files
      const workbook = XLSX.read(data, { type: "array", raw: true, cellDates: false });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: true });

      if (!rawRows || rawRows.length === 0) {
        previewArea.innerHTML = `
          <div style="padding:1rem; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; color:#92400e;">
            The selected file contains no data rows.
          </div>
        `;
        return;
      }

      fileMetadata = {
        name: file.name,
        sizeBytes: file.size,
        totalRows: rawRows.length,
      };

      mapAndPreviewRows(rawRows);
    } catch (err) {
      console.error("File parse error:", err);
      previewArea.innerHTML = `
        <div style="padding:1rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
          <strong>Failed to parse file:</strong> ${err.message}
        </div>
      `;
    }
  };

  reader.readAsArrayBuffer(file);
}

/**
 * Safely parse date from Excel/CSV (handles 2-digit years, 4-digit years, ISO strings, AM/PM, and serial dates)
 */
function parseClosureDate(rawVal, formatHint = null) {
  return parseFlexibleDate(rawVal, true, formatHint);
}

/**
 * Automatically match headers with known Motorola variations and synonyms
 */
function mapAndPreviewRows(rawRows) {
  const previewArea = document.getElementById("import-preview-area");
  if (!previewArea) return;

  // Helper to find matching header key
  const findKey = (row, ...synonyms) => {
    const rowKeys = Object.keys(row);
    for (const syn of synonyms) {
      const target = syn.toLowerCase().replace(/[\s_-]/g, "");
      const matchedKey = rowKeys.find((k) => k.toLowerCase().replace(/[\s_-]/g, "") === target);
      if (matchedKey) return matchedKey;
    }
    return "";
  };

  const sampleRow = rawRows[0] || {};
  const detectedCciKey = findKey(
    sampleRow,
    "station code",
    "stationcode",
    "station_code",
    "station",
    "station id",
    "stationid",
    "cci code",
    "cci_code",
    "ccicode",
    "asc code",
    "asccode",
    "center code",
    "centercode",
    "service center code",
    "cci"
  );

  const detectedSoKey = findKey(
    sampleRow,
    "so number",
    "sonumber",
    "so_number",
    "so",
    "service order",
    "service order no",
    "service order number",
    "order no",
    "order number"
  );

  const detectedClosureIdKey = findKey(
    sampleRow,
    "closure id",
    "closure_id",
    "closureid",
    "job no",
    "job_no",
    "jobid",
    "job id",
    "call no",
    "call id",
    "repair id",
    "sr no",
    "sr_no",
    "service request id",
    "incident id"
  );

  const detectedNameKey = findKey(
    sampleRow,
    "customer name",
    "customer_name",
    "customername",
    "customer",
    "client name",
    "client",
    "cust name",
    "cust_name"
  );

  const detectedMobileKey = findKey(
    sampleRow,
    "mobile no",
    "mobile number",
    "mobileno",
    "mobile_no",
    "customer mobile",
    "customer_mobile",
    "contact no",
    "contact number",
    "contactno",
    "contact",
    "phone no",
    "phoneno",
    "phone number",
    "phone",
    "telephone",
    "mobile",
    "cust mobile",
    "cust phone",
    "cell",
    "cell phone",
    "primary phone"
  );

  const detectedModelKey = findKey(
    sampleRow,
    "model",
    "model name",
    "model_name",
    "product",
    "device",
    "handset model",
    "handset",
    "item model"
  );

  const detectedDateKey = findKey(
    sampleRow,
    "so close time",
    "soclosetime",
    "so_close_time",
    "so close date",
    "soclosedate",
    "so_close_date",
    "so closed time",
    "so closed date",
    "close time",
    "closetime",
    "close_time",
    "closure time",
    "closuretime",
    "closure_time",
    "closure date",
    "closure_date",
    "closuredate",
    "closed date",
    "closed time",
    "closeddate",
    "closedtime",
    "repair close time",
    "repair closure date",
    "repair completion time",
    "repair completion date",
    "repair complete date",
    "repair complete time",
    "complete date",
    "complete time",
    "date"
  );

  const detectedRepairCompleteKey = findKey(
    sampleRow,
    "repair complete date",
    "repair complete time",
    "repair completed date",
    "repair completed time",
    "repair completion date",
    "repair completion time"
  );

  const detectedRepairCreationKey = findKey(
    sampleRow,
    "repair creation date",
    "repair creation time",
    "repair create date",
    "repair create time",
    "call reg date",
    "call registration date",
    "creation date",
    "booking date"
  );

  const detectedCciNameKey = findKey(
    sampleRow,
    "station name",
    "stationname",
    "station_name",
    "center name",
    "center_name",
    "asc name",
    "asc_name",
    "cci name",
    "cci_name",
    "service center name"
  );

  const detectedWarrantyKey = findKey(
    sampleRow,
    "warranty status",
    "warrantystatus",
    "warranty_status",
    "warranty",
    "warranty type",
    "warrantytype",
    "warranty condition",
    "warranty condition code",
    "warranty category",
    "iw oow",
    "iw/oow",
    "in warranty",
    "out of warranty",
    "warranty desc",
    "warranty description"
  );

  const detectedRepairTypeKey = findKey(
    sampleRow,
    "repair type",
    "repairtype",
    "repair_type",
    "job type",
    "jobtype",
    "type of repair",
    "repair nature",
    "service type",
    "servicetype",
    "action taken",
    "repair category",
    "repair description",
    "fault type",
    "defect type",
    "repair action",
    "repair status"
  );

  const detectedDateFormat = detectDatasetDateFormat(rawRows, [
    detectedDateKey,
    detectedRepairCompleteKey,
    detectedRepairCreationKey,
  ]);

  parsedClosures = rawRows.map((r) => {
    const soNumber = cleanCellVal(detectedSoKey && r[detectedSoKey]);
    // Use detected closure_id, or fall back to SO Number if no separate Closure ID column exists
    const rawClosureId = cleanCellVal(detectedClosureIdKey && r[detectedClosureIdKey]);
    const closureId = rawClosureId || soNumber;

    const rawCciCode = cleanCellVal(detectedCciKey && r[detectedCciKey]).toUpperCase();
    // Normalize station code (e.g. "062" -> "62", "018" -> "18") to match cci_master
    let cciCode = rawCciCode.replace(/^0+/, "");
    if (!cciCode) cciCode = rawCciCode;
    const cciName = cleanCellVal(detectedCciNameKey && r[detectedCciNameKey]) || cciCode;
    const customerName = cleanCellVal(detectedNameKey && r[detectedNameKey]) || "Valued Customer";
    const customerMobile = cleanCellVal(detectedMobileKey && r[detectedMobileKey]) || "N/A";
    const model = cleanCellVal(detectedModelKey && r[detectedModelKey]) || "Motorola Device";
    
    // Extract closure date from "SO Close Time"
    const rawClosureDate = detectedDateKey ? r[detectedDateKey] : null;
    const closureDateIso = parseClosureDate(rawClosureDate, detectedDateFormat);

    const rawCompleteDate = detectedRepairCompleteKey ? r[detectedRepairCompleteKey] : null;
    const completeDateIso = rawCompleteDate ? parseClosureDate(rawCompleteDate, detectedDateFormat) : null;

    const rawCreationDate = detectedRepairCreationKey ? r[detectedRepairCreationKey] : null;
    const creationDateIso = rawCreationDate ? parseClosureDate(rawCreationDate, detectedDateFormat) : null;

    const warrantyStatus = detectedWarrantyKey ? cleanCellVal(r[detectedWarrantyKey]) : null;
    const repairType = detectedRepairTypeKey ? cleanCellVal(r[detectedRepairTypeKey]) : null;

    return {
      closure_id: closureId,
      so_number: soNumber,
      cci_code: cciCode,
      cci_name: cciName || cciCode,
      customer_name: customerName,
      customer_mobile: customerMobile,
      model: model,
      closure_date: closureDateIso,
      repair_complete_date: completeDateIso,
      repair_creation_date: creationDateIso,
      warranty_status: warrantyStatus,
      repair_type: repairType,
      source_data: r,
    };
  });

  // Check valid records vs missing required keys
  const validRecords = parsedClosures.filter((c) => c.closure_id && c.so_number && c.cci_code);
  const invalidRecords = parsedClosures.filter((c) => !c.closure_id || !c.so_number || !c.cci_code);

  const previewSample = parsedClosures.slice(0, 5);

  previewArea.innerHTML = `
    <div class="table-card">
      <div class="table-card-header">
        <div>
          <h3 class="table-card-title">Parsed File Summary: ${escapeHtml(fileMetadata.name)}</h3>
          <div style="font-size:0.8125rem; color:var(--text-secondary); margin-top:2px;">
            Total Rows: <strong>${parsedClosures.length}</strong> | 
            Valid for Ingestion: <strong style="color:var(--status-success-dot);">${validRecords.length}</strong> | 
            Missing Critical IDs: <strong style="color:var(--status-danger-dot);">${invalidRecords.length}</strong> | 
            Close Date Column: <strong style="color:var(--moto-blue-accent);">${escapeHtml(detectedDateKey || "Not found (Upload Time)")}</strong> |
            Date Format: <strong style="color:var(--text-primary);">${detectedDateFormat === "MDY" ? "M/D/Y (Motorola CRM)" : detectedDateFormat === "DMY" ? "D/M/Y (Indian)" : "Auto-detected"}</strong>
          </div>
        </div>

        <button type="button" id="btn-execute-import" class="btn-primary" ${validRecords.length === 0 ? "disabled" : ""}>
          <span style="width:18px; height:18px;">${icons.checkCircle}</span>
          <span>Confirm & Ingest ${validRecords.length} Closures</span>
        </button>
      </div>

      <div class="table-responsive-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Closure ID</th>
              <th>SO Number</th>
              <th>CCI Code</th>
              <th>Customer</th>
              <th>Mobile</th>
              <th>Model</th>
              <th>Warranty</th>
              <th>Repair Type</th>
              <th>Closure Date</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${previewSample
              .map((c) => {
                const isValid = c.closure_id && c.so_number && c.cci_code;
                return `
                <tr style="${isValid ? "" : "background:#fef2f2;"}">
                  <td><strong style="font-family:monospace;">${escapeHtml(c.closure_id || "MISSING")}</strong></td>
                  <td><span style="font-family:monospace; color:var(--moto-blue-accent); font-weight:600;">${escapeHtml(c.so_number || "MISSING")}</span></td>
                  <td><span class="badge ${c.cci_code ? "badge-info" : "badge-danger"}">${escapeHtml(c.cci_code || "MISSING")}</span></td>
                  <td>${escapeHtml(c.customer_name)}</td>
                  <td>${escapeHtml(c.customer_mobile)}</td>
                  <td>${escapeHtml(c.model)}</td>
                  <td><span class="badge badge-neutral" style="font-size:0.75rem;">${escapeHtml(c.warranty_status || "N/A")}</span></td>
                  <td><span class="badge badge-neutral" style="font-size:0.75rem;">${escapeHtml(c.repair_type || "N/A")}</span></td>
                  <td>${formatDate(c.closure_date)}</td>
                  <td>${isValid ? '<span class="badge badge-success">Valid</span>' : '<span class="badge badge-danger">Incomplete</span>'}</td>
                </tr>
              `;
              })
              .join("")}
          </tbody>
        </table>
      </div>

      ${
        parsedClosures.length > 5
          ? `
        <div style="padding:0.75rem 1.25rem; font-size:0.75rem; color:var(--text-tertiary); background:var(--bg-surface-subtle); border-top:1px solid var(--border-subtle);">
          Showing first 5 rows of ${parsedClosures.length} total parsed records.
        </div>
      `
          : ""
      }
    </div>

    <!-- Live Execution Status Container -->
    <div id="import-execution-status" style="margin-top:1rem;"></div>
  `;

  document.getElementById("btn-execute-import")?.addEventListener("click", () => {
    executeBatchIngestion(validRecords);
  });
}

/**
 * Execute batch ingestion via RPC import_closures_batch()
 */
async function executeBatchIngestion(records) {
  const statusContainer = document.getElementById("import-execution-status");
  const executeBtn = document.getElementById("btn-execute-import");
  if (!statusContainer || !executeBtn) return;

  executeBtn.disabled = true;
  statusContainer.innerHTML = renderSpinner(`Ingesting ${records.length} records into Supabase PostgreSQL...`);

  try {
    // 1. Initialize batch tracking entry for auditable revert capabilities
    let batchId = null;
    try {
      const { data: bId, error: bErr } = await supabase.rpc("create_closure_import_batch", {
        p_file_name: fileMetadata?.name || "Uploaded Closure Batch",
        p_total_rows: records.length,
        p_metadata: {
          file_name: fileMetadata?.name,
          size_bytes: fileMetadata?.sizeBytes,
          total_rows: records.length,
        },
      });
      if (bErr) {
        console.error("Batch creation failed:", bErr);
        showToast(`Batch tracking notice: ${formatSupabaseError(bErr)}`, "warning");
      } else if (bId) {
        batchId = bId;
      }
    } catch (bErr) {
      console.error("Batch creation notice:", bErr);
    }

    // Ingest in chunks of 500 records to maintain optimal transaction size
    const CHUNK_SIZE = 500;
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalRejected = 0;
    let allRejections = [];

    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      const { data, error } = await supabase.rpc("import_closures_batch", {
        p_closures: chunk,
        p_batch_id: batchId,
      });

      if (error) throw error;

      if (data) {
        totalInserted += data.inserted || 0;
        totalUpdated += data.updated || 0;
        totalRejected += data.rejected || 0;
        if (data.rejections && data.rejections.length > 0) {
          allRejections.push(...data.rejections);
        }
      }
    }

    showToast(`Import completed! ${totalInserted} inserted, ${totalUpdated} updated.`, "success");

    statusContainer.innerHTML = `
      <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); padding:1.5rem; box-shadow:var(--shadow-md);">
        <div style="display:flex; align-items:center; gap:0.5rem; color:var(--status-success-dot); margin-bottom:1rem;">
          <span style="width:24px; height:24px;">${icons.checkCircle}</span>
          <h3 style="font-size:1.15rem; font-weight:700; color:var(--text-primary);">Ingestion Process Finished Successfully</h3>
        </div>

        <div class="kpi-grid" style="margin-bottom:1rem;">
          <div class="kpi-card">
            <span class="kpi-card-title">New Closures Inserted</span>
            <span class="kpi-card-value" style="color:var(--status-success-dot);">${totalInserted}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-card-title">Existing Closures Updated</span>
            <span class="kpi-card-value" style="color:var(--moto-blue-accent);">${totalUpdated}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-card-title">Rejected / Skipped</span>
            <span class="kpi-card-value" style="color:${totalRejected > 0 ? "var(--status-danger-dot)" : "var(--text-secondary)"};">${totalRejected}</span>
          </div>
        </div>

        ${
          allRejections.length > 0
            ? `
          <div style="margin-top:1rem; padding:1rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px;">
            <h4 style="font-size:0.875rem; font-weight:700; color:#991b1b; margin-bottom:0.5rem;">Rejection Details (${allRejections.length}):</h4>
            <ul style="font-size:0.8125rem; color:#991b1b; padding-left:1.25rem;">
              ${allRejections.slice(0, 10).map((rej) => `<li>SO: ${escapeHtml(rej.record?.so_number || "N/A")} — Reason: ${escapeHtml(rej.reason)}</li>`).join("")}
            </ul>
          </div>
        `
            : ""
        }

        <div style="margin-top:1.25rem; display:flex; gap:0.75rem; flex-wrap:wrap;">
          <a href="#/admin/closures" class="btn-primary">View in Closure Database</a>
          <button type="button" id="btn-goto-import-history" class="btn-secondary">View Import History & Batches</button>
          <a href="#/admin" class="btn-secondary">Return to Admin Dashboard</a>
        </div>
      </div>
    `;

    document.getElementById("btn-goto-import-history")?.addEventListener("click", () => {
      document.getElementById("tab-btn-import-history")?.click();
    });
  } catch (err) {
    console.error("executeBatchIngestion error:", err);
    statusContainer.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Import Error:</strong> ${formatSupabaseError(err)}
      </div>
    `;
    executeBtn.disabled = false;
  }
}

/**
 * Handle Google Sheets synchronization via Edge Function
 */
function initGoogleSheetsEvents() {
  const syncBtn = document.getElementById("btn-sync-gsheet");
  const resultDiv = document.getElementById("gsheet-sync-result");

  syncBtn?.addEventListener("click", async () => {
    let rawSheetId = document.getElementById("gsheet-id-input")?.value.trim();
    const range = document.getElementById("gsheet-range-input")?.value.trim() || undefined;

    if (!rawSheetId) {
      showToast("Please enter a Google Sheet ID or URL.", "warning");
      return;
    }

    // Extract ID if URL pasted
    if (rawSheetId.includes("/spreadsheets/d/")) {
      const match = rawSheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match) rawSheetId = match[1];
    }

    syncBtn.disabled = true;
    if (resultDiv) {
      resultDiv.innerHTML = renderSpinner("Invoking secure sheets-sync edge function...");
    }

    try {
      const { data, error } = await supabase.functions.invoke("sheets-sync", {
        body: { sheetId: rawSheetId, range },
      });

      if (error) throw error;

      if (resultDiv) {
        resultDiv.innerHTML = `
          <div style="padding:1rem; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:8px; color:#065f46;">
            <strong>Google Sheet Synchronized Successfully!</strong>
            <div style="font-size:0.875rem; margin-top:4px;">
              Inserted: ${data?.result?.inserted || 0}, Updated: ${data?.result?.updated || 0}, Rejected: ${data?.result?.rejected || 0}
            </div>
          </div>
        `;
      }
      showToast("Google Sheets synchronization completed!", "success");
    } catch (err) {
      console.error("Sheet sync error:", err);
      if (resultDiv) {
        resultDiv.innerHTML = `
          <div style="padding:1rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
            <strong>Sync Failed:</strong> ${formatSupabaseError(err)}
          </div>
        `;
      }
    } finally {
      syncBtn.disabled = false;
    }
  });
}

/**
 * Load import history from closure_import_batches (with legacy audit_log fallback)
 */
async function loadImportHistory() {
  const historyMount = document.getElementById("import-history-mount");
  if (!historyMount) return;

  historyMount.innerHTML = renderSpinner("Loading past closure imports...");

  try {
    const { data: batches, error } = await supabase
      .from("closure_import_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      console.warn("closure_import_batches query warning:", error);
    }

    // Fallback to legacy audit_log if closure_import_batches has no data yet
    if (!batches || batches.length === 0) {
      const { data: logs } = await supabase
        .from("audit_log")
        .select("*")
        .eq("action", "CLOSURE_IMPORT")
        .order("timestamp", { ascending: false })
        .limit(30);

      if (!logs || logs.length === 0) {
        historyMount.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">${icons.upload}</div>
            <h3>No Import History</h3>
            <p>No closure batch uploads have been recorded yet.</p>
          </div>
        `;
        return;
      }

      historyMount.innerHTML = `
        <div class="table-card">
          <div class="table-card-header">
            <h3 class="table-card-title">Recent Ingestion Batches (Audit Log)</h3>
            <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:2px;">
              Legacy audit view. Ensure migration 20260926000013 is applied in your Supabase SQL Editor to enable full 1-click batch revert.
            </p>
          </div>
          <div class="table-responsive-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Date & Time</th>
                  <th>Description</th>
                  <th>Inserted</th>
                  <th>Updated</th>
                  <th>Rejected</th>
                </tr>
              </thead>
              <tbody>
                ${logs
                  .map(
                    (log) => `
                  <tr>
                    <td>${formatDateTime(log.timestamp)}</td>
                    <td>${escapeHtml(log.description)}</td>
                    <td><span class="badge badge-success">${log.metadata?.inserted || 0}</span></td>
                    <td><span class="badge badge-info">${log.metadata?.updated || 0}</span></td>
                    <td><span class="badge ${log.metadata?.rejected > 0 ? "badge-danger" : "badge-neutral"}">${log.metadata?.rejected || 0}</span></td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
      return;
    }

    historyMount.innerHTML = `
      <div class="table-card">
        <div class="table-card-header" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <div>
            <h3 class="table-card-title">Recent Ingestion Batches</h3>
            <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:2px;">
              Track batch uploads and safely revert accidental uploads with calling protection.
            </p>
          </div>
          <button type="button" id="btn-refresh-import-history" class="btn-secondary" style="padding:6px 12px; font-size:0.75rem; display:flex; align-items:center; gap:4px;">
            <span style="width:14px; height:14px;">${icons.refreshCw}</span>
            <span>Refresh</span>
          </button>
        </div>
        <div class="table-responsive-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date & Time</th>
                <th>File / Source</th>
                <th>Total Rows</th>
                <th>Inserted</th>
                <th>Updated</th>
                <th>Status</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${batches
                .map((b) => {
                  const isReverted = b.status === "REVERTED";
                  const isProcessing = b.status === "PROCESSING";

                  let statusBadge = `<span class="badge badge-success"><span class="badge-dot"></span>Active</span>`;
                  if (isReverted) {
                    statusBadge = `<span class="badge badge-danger" title="Reverted on ${formatDateTime(b.reverted_at)}"><span class="badge-dot"></span>Reverted</span>`;
                  } else if (isProcessing) {
                    statusBadge = `<span class="badge badge-warning"><span class="badge-dot"></span>Processing</span>`;
                  }

                  let actionBtn = "";
                  if (isReverted) {
                    actionBtn = `
                      <span style="font-size:0.75rem; color:var(--text-tertiary);" title="Reverted on ${formatDateTime(b.reverted_at)}">
                        ${b.reverted_count || 0} removed
                      </span>
                    `;
                  } else {
                    actionBtn = `
                      <button type="button" class="btn-secondary btn-revert-batch" data-id="${b.id}" data-name="${escapeHtml(b.file_name)}" style="padding:4px 10px; font-size:0.75rem; color:var(--status-danger-dot); border-color:rgba(239, 68, 68, 0.4); display:inline-flex; align-items:center; gap:4px;">
                        <span style="width:14px; height:14px;">${icons.rotateCcw}</span>
                        <span>Revert Batch</span>
                      </button>
                    `;
                  }

                  return `
                    <tr style="${isReverted ? "opacity:0.65; background:var(--bg-surface-subtle);" : ""}">
                      <td>${formatDateTime(b.created_at)}</td>
                      <td>
                        <strong style="color:var(--text-primary); font-size:0.875rem;">${escapeHtml(b.file_name)}</strong>
                      </td>
                      <td>${b.total_rows || (b.inserted_count + b.updated_count + b.rejected_count)}</td>
                      <td><span class="badge badge-success">${b.inserted_count || 0}</span></td>
                      <td><span class="badge badge-info">${b.updated_count || 0}</span></td>
                      <td>${statusBadge}</td>
                      <td style="text-align:right;">${actionBtn}</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById("btn-refresh-import-history")?.addEventListener("click", () => {
      loadImportHistory();
    });

    historyMount.querySelectorAll(".btn-revert-batch").forEach((btn) => {
      btn.addEventListener("click", () => {
        const batchId = btn.getAttribute("data-id");
        const batchName = btn.getAttribute("data-name");
        openRevertBatchModal(batchId, batchName);
      });
    });
  } catch (err) {
    console.error("loadImportHistory error:", err);
    historyMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error loading history:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

/**
 * Modal dialog for inspecting and safely executing batch revert
 */
async function openRevertBatchModal(batchId, batchName) {
  // Pre-flight inspection modal
  openModal({
    title: `Revert Batch Inspection`,
    contentHtml: `
      <div style="padding:1.5rem 0; text-align:center;">
        ${renderSpinner("Checking batch status and scanning calling activity...")}
      </div>
    `,
    footerHtml: `<button type="button" class="btn-secondary" id="btn-modal-cancel">Cancel</button>`,
    size: "normal",
  });

  document.getElementById("btn-modal-cancel")?.addEventListener("click", closeModal);

  try {
    const { data: status, error } = await supabase.rpc("check_closure_batch_status", {
      p_batch_id: batchId,
    });

    if (error) throw error;

    const totalInMaster = status.total_current_in_master || 0;
    const calledCount = status.called_count || 0;
    const safeToDelete = status.safe_to_delete_count || 0;

    let warningNotice = "";
    if (calledCount > 0) {
      warningNotice = `
        <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:0.875rem; margin-top:1rem; color:#92400e; font-size:0.8125rem; display:flex; gap:0.5rem; align-items:flex-start;">
          <span style="width:20px; height:20px; flex-shrink:0;">${icons.alertTriangle}</span>
          <div>
            <strong>Safety Protection Active:</strong>
            <p style="margin:4px 0 0 0;">
              <strong>${calledCount} closure(s)</strong> in this batch have already been called by CCI agents. To protect customer feedback, ratings, and audit compliance, <strong>these records will NOT be deleted</strong>.
            </p>
            <p style="margin:4px 0 0 0;">
              Only the <strong>${safeToDelete} uncalled closure(s)</strong> will be deleted from the database.
            </p>
          </div>
        </div>
      `;
    } else {
      warningNotice = `
        <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:0.875rem; margin-top:1rem; color:#991b1b; font-size:0.8125rem; display:flex; gap:0.5rem; align-items:flex-start;">
          <span style="width:20px; height:20px; flex-shrink:0;">${icons.alertTriangle}</span>
          <div>
            <strong>Permanent Deletion:</strong>
            <p style="margin:4px 0 0 0;">
              None of the closures in this batch have been called yet. All <strong>${safeToDelete} closure(s)</strong> will be permanently removed from the master database.
            </p>
          </div>
        </div>
      `;
    }

    const modalBody = `
      <div style="display:flex; flex-direction:column; gap:1rem;">
        <p style="font-size:0.875rem; color:var(--text-secondary);">
          You are about to revert the ingestion batch: <strong style="color:var(--text-primary);">${escapeHtml(batchName)}</strong>.
        </p>

        <div class="kpi-grid" style="grid-template-columns:repeat(3, 1fr); margin-top:0.25rem;">
          <div class="kpi-card" style="padding:0.75rem;">
            <span class="kpi-card-title">In Database</span>
            <span class="kpi-card-value" style="font-size:1.25rem;">${totalInMaster}</span>
          </div>
          <div class="kpi-card" style="padding:0.75rem;">
            <span class="kpi-card-title">Will Be Deleted</span>
            <span class="kpi-card-value" style="font-size:1.25rem; color:var(--status-danger-dot);">${safeToDelete}</span>
          </div>
          <div class="kpi-card" style="padding:0.75rem;">
            <span class="kpi-card-title">Called (Preserved)</span>
            <span class="kpi-card-value" style="font-size:1.25rem; color:var(--status-success-dot);">${calledCount}</span>
          </div>
        </div>

        ${warningNotice}

        <div style="font-size:0.75rem; color:var(--text-tertiary); margin-top:0.5rem;">
          Batch ID: <code style="background:var(--bg-surface-subtle); padding:2px 4px; border-radius:4px;">${batchId}</code>
        </div>
      </div>
    `;

    openModal({
      title: `Confirm Revert: ${escapeHtml(batchName)}`,
      contentHtml: modalBody,
      footerHtml: `
        <div style="display:flex; justify-content:flex-end; gap:0.75rem; width:100%;">
          <button type="button" class="btn-secondary" id="btn-cancel-revert">Cancel</button>
          <button type="button" class="btn-primary" id="btn-execute-revert-confirm" style="background:var(--status-danger-dot); border-color:var(--status-danger-dot);">
            <span style="width:16px; height:16px;">${icons.rotateCcw}</span>
            <span>${safeToDelete > 0 ? `Confirm Revert (${safeToDelete} Records)` : `Mark Batch as Reverted`}</span>
          </button>
        </div>
      `,
      size: "normal",
    });

    document.getElementById("btn-cancel-revert")?.addEventListener("click", closeModal);
    document.getElementById("btn-execute-revert-confirm")?.addEventListener("click", async () => {
      const confirmBtn = document.getElementById("btn-execute-revert-confirm");
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = `<span>Reverting records...</span>`;
      }

      try {
        const { data: revResult, error: revErr } = await supabase.rpc("revert_closure_batch", {
          p_batch_id: batchId,
        });

        if (revErr) throw revErr;

        closeModal();
        showToast(
          `Batch reverted! ${revResult?.deleted_count || 0} uncalled closures deleted, ${revResult?.protected_count || 0} preserved.`,
          "success"
        );
        loadImportHistory();
      } catch (e) {
        console.error("Revert error:", e);
        showToast(`Failed to revert batch: ${formatSupabaseError(e)}`, "error");
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = `<span>Retry Revert</span>`;
        }
      }
    });
  } catch (err) {
    console.error("check_closure_batch_status error:", err);
    const errMessage = formatSupabaseError(err);
    const isPermissionError =
      err?.message?.includes("permission denied") ||
      err?.code === "42501" ||
      errMessage.includes("permission") ||
      errMessage.includes("Access denied");

    openModal({
      title: `Batch Inspection Notice`,
      contentHtml: `
        <div style="padding:0.5rem 0;">
          <div style="display:flex; align-items:flex-start; gap:0.75rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:1rem; color:#991b1b;">
            <span style="width:24px; height:24px; flex-shrink:0;">${icons.alertTriangle}</span>
            <div>
              <strong style="font-size:0.95rem;">Unable to Inspect Ingestion Batch</strong>
              <p style="margin:6px 0 0 0; font-size:0.85rem; color:#b91c1c;">
                ${escapeHtml(errMessage)}
              </p>
              ${
                isPermissionError
                  ? `
                <div style="margin-top:10px; padding:10px; background:#fff; border:1px solid #fca5a5; border-radius:6px; font-size:0.8125rem; color:#7f1d1d;">
                  <strong>Required Supabase SQL Migration:</strong>
                  <p style="margin:4px 0 0 0;">
                    Your database needs migration <code>20260926000013_fix_closure_batch_revert_permissions.sql</code> to grant execute permissions.
                  </p>
                  <p style="margin:6px 0 0 0; font-weight:600;">
                    Please run this SQL in your Supabase Dashboard &rarr; SQL Editor.
                  </p>
                </div>
              `
                  : ""
              }
            </div>
          </div>
        </div>
      `,
      footerHtml: `
        <div style="display:flex; justify-content:flex-end; width:100%;">
          <button type="button" class="btn-secondary" id="btn-modal-close-err">Close</button>
        </div>
      `,
      size: "normal",
    });

    document.getElementById("btn-modal-close-err")?.addEventListener("click", closeModal);
    showToast(`Inspection failed: ${errMessage}`, "error");
  }
}
