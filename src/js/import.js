// ============================================================================
// Motorola Closure Data Import Controller (XLSX, XLS, CSV & Google Sheets)
// ============================================================================

import * as XLSX from "xlsx";
import { supabase, formatSupabaseError } from "./supabase.js";
import { icons, escapeHtml, formatDate, formatDateTime } from "./utils.js";
import { showToast } from "../components/toast.js";
import { renderSpinner } from "../components/loading.js";

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
      const workbook = XLSX.read(data, { type: "array", cellDates: true });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

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
 * Automatically match headers with known Motorola variations and synonyms
 */
function mapAndPreviewRows(rawRows) {
  const previewArea = document.getElementById("import-preview-area");
  if (!previewArea) return;

  // Synonyms map
  const findValue = (row, ...synonyms) => {
    const rowKeys = Object.keys(row);
    for (const syn of synonyms) {
      const target = syn.toLowerCase().replace(/[\s_-]/g, "");
      const matchedKey = rowKeys.find((k) => k.toLowerCase().replace(/[\s_-]/g, "") === target);
      if (matchedKey && row[matchedKey] !== undefined && row[matchedKey] !== "") {
        return row[matchedKey];
      }
    }
    return "";
  };

  parsedClosures = rawRows.map((r) => {
    const closureId = String(findValue(r, "closure_id", "closure id", "closureid", "job_no", "job no", "jobid", "service order id")).trim();
    const soNumber = String(findValue(r, "so_number", "so number", "sonumber", "so", "service order", "order no")).trim();
    const cciCode = String(findValue(r, "cci_code", "cci code", "ccicode", "center code", "asc code", "service center code", "cci")).trim().toUpperCase();
    const cciName = String(findValue(r, "cci_name", "cci name", "cciname", "center name", "asc name", "service center name")).trim();
    const customerName = String(findValue(r, "customer_name", "customer name", "customer", "client name", "cust name")).trim();
    const customerMobile = String(findValue(r, "customer_mobile", "customer mobile", "mobile", "phone", "contact", "cust mobile")).trim();
    const model = String(findValue(r, "model", "model name", "product", "device", "handset model")).trim();
    const closureDate = findValue(r, "closure_date", "closure date", "closed date", "repair closure date", "date");
    const repairCompleteDate = findValue(r, "repair_complete_date", "repair complete date", "complete date", "completion date");
    const repairCreationDate = findValue(r, "repair_creation_date", "repair creation date", "creation date", "start date", "in date");

    return {
      closure_id: closureId,
      so_number: soNumber,
      cci_code: cciCode,
      cci_name: cciName || cciCode,
      customer_name: customerName || "Unknown Customer",
      customer_mobile: customerMobile || "N/A",
      model: model || "Motorola Device",
      closure_date: closureDate ? new Date(closureDate).toISOString() : new Date().toISOString(),
      repair_complete_date: repairCompleteDate ? new Date(repairCompleteDate).toISOString() : null,
      repair_creation_date: repairCreationDate ? new Date(repairCreationDate).toISOString() : null,
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
          <span style="font-size:0.8125rem; color:var(--text-secondary);">
            Total Rows: <strong>${parsedClosures.length}</strong> | 
            Valid for Ingestion: <strong style="color:var(--status-success-dot);">${validRecords.length}</strong> | 
            Missing Critical IDs: <strong style="color:var(--status-danger-dot);">${invalidRecords.length}</strong>
          </span>
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
                  <td><span style="font-family:monospace; color:var(--moto-blue-accent);">${escapeHtml(c.so_number || "MISSING")}</span></td>
                  <td><span class="badge ${c.cci_code ? "badge-info" : "badge-danger"}">${escapeHtml(c.cci_code || "MISSING")}</span></td>
                  <td>${escapeHtml(c.customer_name)}</td>
                  <td>${escapeHtml(c.customer_mobile)}</td>
                  <td>${escapeHtml(c.model)}</td>
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

        <div style="margin-top:1.25rem; display:flex; gap:0.75rem;">
          <a href="#/admin/closures" class="btn-primary">View in Closure Database</a>
          <a href="#/admin" class="btn-secondary">Return to Admin Dashboard</a>
        </div>
      </div>
    `;
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
 * Load import history from audit_log table
 */
async function loadImportHistory() {
  const historyMount = document.getElementById("import-history-mount");
  if (!historyMount) return;

  try {
    const { data: logs, error } = await supabase
      .from("audit_log")
      .select("*")
      .eq("action", "CLOSURE_IMPORT")
      .order("timestamp", { ascending: false })
      .limit(30);

    if (error) throw error;

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
          <h3 class="table-card-title">Recent Ingestion Batches</h3>
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
  } catch (err) {
    console.error("loadImportHistory error:", err);
    historyMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error loading history:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}
