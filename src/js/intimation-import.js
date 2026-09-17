// ============================================================================
// Motorola Open Calls Data Import Controller (XLSX, XLS, CSV)
// Batch ingests Open Calls snapshot and syncs active open queue
// ============================================================================

import * as XLSX from "xlsx";
import { supabase, formatSupabaseError } from "./supabase.js";
import { icons, escapeHtml, formatDate, formatDateTime, parseFlexibleDate, cleanCellVal } from "./utils.js";
import { showToast } from "../components/toast.js";
import { renderSpinner } from "../components/loading.js";

let parsedCalls = [];
let fileMetadata = null;

export async function renderIntimationImportPage(container) {
  parsedCalls = [];
  fileMetadata = null;

  container.innerHTML = `
    <div style="margin-bottom:1.5rem; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:1rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Open Calls Snapshot Import</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">
          Upload current Open Calls dump (<code style="background:var(--bg-surface-secondary); padding:2px 6px; border-radius:4px;">Open_Calls.csv</code> or Excel). New calls will be queued, and calls absent in this upload will be automatically marked resolved.
        </p>
      </div>
      <div style="display:flex; gap:0.5rem;">
        <a href="#/intimation/admin" class="btn-secondary">
          <span>${icons.chevronLeft}</span>
          <span>Back to Intimation Admin</span>
        </a>
      </div>
    </div>

    <!-- Snapshot Info Banner -->
    <div style="background:rgba(2, 132, 199, 0.08); border:1px solid rgba(2, 132, 199, 0.25); border-radius:var(--radius-lg); padding:1rem 1.25rem; margin-bottom:1.5rem; display:flex; gap:0.875rem; align-items:flex-start;">
      <span style="color:#0284c7; flex-shrink:0; margin-top:2px;">${icons.alertCircle}</span>
      <div style="font-size:0.875rem; line-height:1.5; color:var(--text-primary);">
        <strong>Snapshot Replacement Policy:</strong> When you upload a new open calls file, it becomes the official active open dataset. Any previously open service order that is missing in the new file will automatically be flagged as <em>closed / resolved</em> (<code style="font-size:0.8rem;">is_open = false</code>). All customer intimation history and previous ETR commitments remain permanently recorded.
      </div>
    </div>

    <!-- Upload Dropzone -->
    <div class="dropzone" id="open-calls-dropzone">
      <div style="color:var(--moto-blue-accent); width:48px; height:48px; margin:0 auto 0.75rem;">
        ${icons.upload}
      </div>
      <h4 style="font-size:1.05rem; font-weight:600; color:var(--text-primary); margin-bottom:0.25rem;">
        Drag & Drop Open Calls File (.csv, .xlsx, .xls)
      </h4>
      <p style="font-size:0.875rem; color:var(--text-tertiary); margin-bottom:1rem;">
        Supports Open_Calls.csv or Motorola CRM open dumps with automatic header mapping
      </p>
      <label for="input-open-calls-file" class="btn-primary" style="display:inline-flex; cursor:pointer;">
        <span>Choose File</span>
      </label>
      <input type="file" id="input-open-calls-file" accept=".xlsx,.xls,.csv" style="display:none;">
    </div>

    <!-- Preview & Validation Area -->
    <div id="open-calls-preview-area" style="margin-top:1.5rem; display:none;"></div>

    <!-- Active Open Calls Stats -->
    <div id="open-calls-active-stats" style="margin-top:2rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
        <h3 style="font-size:1.1rem; font-weight:700;">Current Open Calls Snapshot in Database</h3>
        <button id="btn-refresh-snapshot-stats" class="btn-secondary" style="padding:4px 10px; font-size:0.8rem;">
          <span style="width:14px; height:14px;">${icons.refreshCw}</span>
          <span>Refresh</span>
        </button>
      </div>
      <div id="snapshot-stats-cards" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1rem;">
        ${renderSpinner("Checking database snapshot...")}
      </div>
    </div>
  `;

  initFileUploadEvents();
  loadCurrentSnapshotStats();
}

/**
 * Drag and drop and file input event listeners
 */
function initFileUploadEvents() {
  const dropzone = document.getElementById("open-calls-dropzone");
  const fileInput = document.getElementById("input-open-calls-file");
  const refreshBtn = document.getElementById("btn-refresh-snapshot-stats");

  if (refreshBtn) {
    refreshBtn.addEventListener("click", loadCurrentSnapshotStats);
  }

  if (!dropzone || !fileInput) return;

  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleIncomingOpenCallsFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleIncomingOpenCallsFile(e.target.files[0]);
    }
  });
}

/**
 * Parse incoming Excel or CSV file
 */
function handleIncomingOpenCallsFile(file) {
  const previewArea = document.getElementById("open-calls-preview-area");
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

      mapAndPreviewOpenCalls(rawRows);
    } catch (err) {
      console.error("Open calls parse error:", err);
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
 * Parse date strings or Excel values into ISO-8601 string (handles 2-digit years, 4-digit years, ISO strings, AM/PM)
 */
function parseDateTimeVal(rawVal) {
  return parseFlexibleDate(rawVal, false);
}

/**
 * Map raw rows from CSV / Excel to Open Calls schema
 */
function mapAndPreviewOpenCalls(rawRows) {
  const previewArea = document.getElementById("open-calls-preview-area");
  if (!previewArea) return;

  const findKey = (row, ...synonyms) => {
    const rowKeys = Object.keys(row);
    for (const syn of synonyms) {
      const target = syn.toLowerCase().replace(/[\s_-]/g, "");
      const matchedKey = rowKeys.find((k) => k.toLowerCase().replace(/[\s_-]/g, "") === target);
      if (matchedKey) return matchedKey;
    }
    return "";
  };

  const sample = rawRows[0] || {};
  const soKey = findKey(sample, "Service Order", "ServiceOrder", "SO Number", "SONumber", "Job No", "SO");
  const stationCodeKey = findKey(sample, "Station Code", "StationCode", "Station ID", "CCI Code", "CCICode", "Station");
  const stationNameKey = findKey(sample, "Station Name", "StationName", "CCI Name", "CCIName", "Centre Name");
  const modelKey = findKey(sample, "Model", "Model Name", "Device Model", "Product");
  const soStatusKey = findKey(sample, "Service Order Status", "SO Status", "Status", "Job Status");
  const warrantyKey = findKey(sample, "Warranty Status", "Warranty", "Warranty Type");
  const partsKey = findKey(sample, "Parts Status", "Part Status", "Parts");
  const doaKey = findKey(sample, "DOA Status", "DOA");
  const carryInKey = findKey(sample, "Carry-In Time", "Carry In Time", "CarryInTime", "Inward Date", "Creation Time");
  const finishRepairKey = findKey(sample, "Finish Repair Time", "FinishRepairTime", "Repair End Time", "Completion Date");
  const custNameKey = findKey(sample, "Customer Name", "CustomerName", "Client Name", "Name");
  const custPhoneKey = findKey(sample, "Customer Telephone", "Customer Phone", "Mobile", "Contact", "Phone");
  const altPhoneKey = findKey(sample, "Alternate Phone", "Alt Phone", "Secondary Phone");
  const regionKey = findKey(sample, "Region", "Zone");
  const stateKey = findKey(sample, "State", "Province");
  const cityKey = findKey(sample, "City", "Location");

  if (!soKey || !stationCodeKey) {
    previewArea.innerHTML = `
      <div style="padding:1.25rem; background:#fef2f2; border:1px solid #fecaca; border-radius:var(--radius-lg); color:#991b1b;">
        <h4 style="font-weight:700; margin-bottom:0.5rem;">Missing Required Column Headers</h4>
        <p style="font-size:0.875rem; margin-bottom:0.75rem;">
          Could not identify <strong>"Service Order"</strong> and/or <strong>"Station Code"</strong> columns in your file.
        </p>
        <div style="font-size:0.8rem; background:#fff; padding:0.75rem; border-radius:4px; border:1px solid #fee2e2;">
          <strong>Detected headers:</strong> ${Object.keys(sample).slice(0, 15).join(", ")} ...
        </div>
      </div>
    `;
    return;
  }

  const nowMs = Date.now();
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  let qualifiedAgeingCount = 0;

  parsedCalls = rawRows.map((row, idx) => {
    const rawSo = cleanCellVal(row[soKey]);
    const rawStationCode = cleanCellVal(row[stationCodeKey]);
    // Normalize station code: e.g. "070" -> "70" or preserve exact match
    let cleanCode = rawStationCode.replace(/^0+/, "");
    if (!cleanCode) cleanCode = rawStationCode;

    const carryInIso = parseDateTimeVal(row[carryInKey]) || new Date().toISOString();
    const finishRepairIso = parseDateTimeVal(row[finishRepairKey]);

    const carryInDate = new Date(carryInIso);
    const ageingDays = Math.max(0, Math.floor((nowMs - carryInDate.getTime()) / (24 * 60 * 60 * 1000)));
    const isOver3Days = (nowMs - carryInDate.getTime()) > threeDaysMs;

    if (isOver3Days) {
      qualifiedAgeingCount++;
    }

    return {
      service_order: rawSo,
      station_code: rawStationCode,
      cci_code: cleanCode,
      station_name: cleanCellVal(row[stationNameKey]) || `Motorola Service ${cleanCode}`,
      customer_name: cleanCellVal(row[custNameKey]) || "Customer",
      customer_mobile: cleanCellVal(row[custPhoneKey]),
      alternate_mobile: cleanCellVal(row[altPhoneKey]),
      model: cleanCellVal(row[modelKey]),
      so_status: cleanCellVal(row[soStatusKey]),
      warranty_status: cleanCellVal(row[warrantyKey]),
      parts_status: cleanCellVal(row[partsKey]),
      doa_status: cleanCellVal(row[doaKey]),
      carry_in_time: carryInIso,
      finish_repair_time: finishRepairIso,
      ageing_days: ageingDays,
      is_over_3_days: isOver3Days,
      source_data: {
        region: cleanCellVal(row[regionKey]),
        state: cleanCellVal(row[stateKey]),
        city: cleanCellVal(row[cityKey]),
      },
    };
  }).filter((c) => c.service_order && c.cci_code);

  const totalCalls = parsedCalls.length;
  const sampleRows = parsedCalls.slice(0, 5);

  previewArea.innerHTML = `
    <div class="call-feedback-form-card" style="margin-bottom:1.5rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:1rem;">
        <div>
          <h3 style="font-size:1.15rem; font-weight:700;">File Ready for Ingestion</h3>
          <p style="font-size:0.875rem; color:var(--text-secondary);">
            <strong>${escapeHtml(fileMetadata.name)}</strong> (${totalCalls.toLocaleString()} valid open calls parsed)
          </p>
        </div>
        <div style="display:flex; gap:0.75rem;">
          <button type="button" id="btn-cancel-import" class="btn-secondary">Cancel</button>
          <button type="button" id="btn-start-open-calls-import" class="btn-primary">
            <span>${icons.upload}</span>
            <span>Confirm & Replace Snapshot (${totalCalls.toLocaleString()} Calls)</span>
          </button>
        </div>
      </div>

      <!-- Quick Analysis Cards -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1rem; margin-bottom:1.25rem;">
        <div class="kpi-card" style="padding:1rem;">
          <div class="kpi-label">Total Open Calls</div>
          <div class="kpi-value" style="font-size:1.5rem; color:var(--text-primary);">${totalCalls.toLocaleString()}</div>
          <div style="font-size:0.75rem; color:var(--text-tertiary);">In this upload file</div>
        </div>
        <div class="kpi-card" style="padding:1rem; border-left:4px solid #ef4444;">
          <div class="kpi-label">Ageing &gt; 3 Days</div>
          <div class="kpi-value" style="font-size:1.5rem; color:#ef4444;">${qualifiedAgeingCount.toLocaleString()}</div>
          <div style="font-size:0.75rem; color:var(--text-tertiary);">${Math.round((qualifiedAgeingCount / (totalCalls || 1)) * 100)}% qualify for Intimation</div>
        </div>
        <div class="kpi-card" style="padding:1rem; border-left:4px solid #10b981;">
          <div class="kpi-label">Ageing &le; 3 Days</div>
          <div class="kpi-value" style="font-size:1.5rem; color:#10b981;">${(totalCalls - qualifiedAgeingCount).toLocaleString()}</div>
          <div style="font-size:0.75rem; color:var(--text-tertiary);">Within SLA window</div>
        </div>
      </div>

      <!-- Sample Preview Table -->
      <h4 style="font-size:0.95rem; font-weight:600; margin-bottom:0.5rem;">Data Preview (First 5 records):</h4>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>SO Number</th>
              <th>Station</th>
              <th>Model</th>
              <th>Status</th>
              <th>Warranty</th>
              <th>Parts</th>
              <th>Carry-In Time</th>
              <th>Ageing</th>
            </tr>
          </thead>
          <tbody>
            ${sampleRows.map((r) => `
              <tr>
                <td style="font-weight:700; color:var(--moto-blue-accent);">${escapeHtml(r.service_order)}</td>
                <td>
                  <div style="font-weight:600;">${escapeHtml(r.station_name)}</div>
                  <div style="font-size:0.75rem; color:var(--text-tertiary);">Code: ${escapeHtml(r.station_code)}</div>
                </td>
                <td>${escapeHtml(r.model || "N/A")}</td>
                <td><span class="badge" style="background:#e0f2fe; color:#0369a1;">${escapeHtml(r.so_status || "Open")}</span></td>
                <td>${escapeHtml(r.warranty_status || "N/A")}</td>
                <td>${escapeHtml(r.parts_status || "N/A")}</td>
                <td>${formatDateTime(r.carry_in_time)}</td>
                <td>
                  ${r.is_over_3_days
                    ? `<span class="badge" style="background:#fee2e2; color:#b91c1c; font-weight:700;">${r.ageing_days}d (&gt;3d)</span>`
                    : `<span class="badge" style="background:#dcfce7; color:#15803d;">${r.ageing_days}d</span>`
                  }
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>

      <div id="import-progress-container" style="margin-top:1.5rem; display:none;"></div>
    </div>
  `;

  document.getElementById("btn-cancel-import")?.addEventListener("click", () => {
    previewArea.style.display = "none";
    parsedCalls = [];
  });

  document.getElementById("btn-start-open-calls-import")?.addEventListener("click", startBatchUpload);
}

/**
 * Execute batch upload to Supabase with chunking
 */
async function startBatchUpload() {
  const startBtn = document.getElementById("btn-start-open-calls-import");
  const cancelBtn = document.getElementById("btn-cancel-import");
  const progressContainer = document.getElementById("import-progress-container");

  if (!startBtn || !progressContainer || parsedCalls.length === 0) return;

  startBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;

  progressContainer.style.display = "block";
  progressContainer.innerHTML = `
    <div style="padding:1.25rem; background:var(--bg-surface-secondary); border-radius:var(--radius-md); border:1px solid var(--border-subtle);">
      <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem; font-size:0.875rem;">
        <span id="import-progress-text" style="font-weight:600;">Preparing batch upload...</span>
        <span id="import-progress-pct" style="font-weight:700; color:var(--moto-blue-accent);">0%</span>
      </div>
      <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
        <div id="import-progress-bar" style="width:0%; height:100%; background:var(--moto-blue-accent); transition:width 0.3s ease;"></div>
      </div>
      <div id="import-chunk-details" style="font-size:0.75rem; color:var(--text-tertiary); margin-top:0.5rem;"></div>
    </div>
  `;

  const progressText = document.getElementById("import-progress-text");
  const progressPct = document.getElementById("import-progress-pct");
  const progressBar = document.getElementById("import-progress-bar");
  const progressDetails = document.getElementById("import-chunk-details");

  const sessionId = "upload_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
  const CHUNK_SIZE = 300;
  const totalChunks = Math.ceil(parsedCalls.length / CHUNK_SIZE);

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalClosed = 0;
  let totalRejected = 0;
  let errors = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunk = parsedCalls.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const isFirstChunk = (i === 0);
    const isLastChunk = (i === totalChunks - 1);

    const pct = Math.round(((i + 1) / totalChunks) * 100);
    if (progressText) progressText.textContent = `Uploading chunk ${i + 1} of ${totalChunks}...`;
    if (progressPct) progressPct.textContent = `${pct}%`;
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressDetails) progressDetails.textContent = `Processed ${(i * CHUNK_SIZE) + chunk.length} of ${parsedCalls.length} records...`;

    try {
      const { data, error } = await supabase.rpc("import_open_calls_batch", {
        p_calls: chunk,
        p_session_id: sessionId,
        p_is_first_chunk: isFirstChunk,
        p_is_last_chunk: isLastChunk,
      });

      if (error) {
        throw error;
      }

      if (data) {
        totalInserted += (data.inserted || 0);
        totalUpdated += (data.updated || 0);
        totalClosed += (data.closed || 0);
        totalRejected += (data.rejected || 0);
        if (data.rejections && data.rejections.length > 0) {
          errors.push(...data.rejections);
        }
      }
    } catch (err) {
      console.error("Chunk upload error:", err);
      showToast(`Chunk ${i + 1} error: ${err.message}`, "error");
      progressContainer.innerHTML = `
        <div style="padding:1rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b; margin-top:1rem;">
          <strong>Upload aborted on chunk ${i + 1}:</strong> ${escapeHtml(err.message)}
        </div>
      `;
      startBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      return;
    }
  }

  // Upload complete!
  showToast("Open Calls snapshot updated successfully!", "success");

  progressContainer.innerHTML = `
    <div style="padding:1.5rem; background:rgba(16, 185, 129, 0.08); border:1px solid rgba(16, 185, 129, 0.3); border-radius:var(--radius-lg); margin-top:1.25rem;">
      <div style="display:flex; align-items:center; gap:0.75rem; color:#065f46; font-size:1.1rem; font-weight:700; margin-bottom:0.75rem;">
        <span style="width:24px; height:24px;">${icons.checkCircle}</span>
        <span>Snapshot Ingestion Completed Successfully!</span>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:1rem; margin-bottom:1rem;">
        <div style="background:#fff; padding:0.75rem; border-radius:6px; border:1px solid #e5e7eb;">
          <div style="font-size:0.75rem; color:#6b7280;">New Open Calls Added</div>
          <div style="font-size:1.35rem; font-weight:700; color:#10b981;">+${totalInserted.toLocaleString()}</div>
        </div>
        <div style="background:#fff; padding:0.75rem; border-radius:6px; border:1px solid #e5e7eb;">
          <div style="font-size:0.75rem; color:#6b7280;">Existing Open Calls Refreshed</div>
          <div style="font-size:1.35rem; font-weight:700; color:#0284c7;">${totalUpdated.toLocaleString()}</div>
        </div>
        <div style="background:#fff; padding:0.75rem; border-radius:6px; border:1px solid #e5e7eb;">
          <div style="font-size:0.75rem; color:#6b7280;">Calls Flagged Closed (Resolved)</div>
          <div style="font-size:1.35rem; font-weight:700; color:#6366f1;">${totalClosed.toLocaleString()}</div>
        </div>
        <div style="background:#fff; padding:0.75rem; border-radius:6px; border:1px solid #e5e7eb;">
          <div style="font-size:0.75rem; color:#6b7280;">Rejected / Errors</div>
          <div style="font-size:1.35rem; font-weight:700; color:${totalRejected > 0 ? '#ef4444' : '#6b7280'};">${totalRejected}</div>
        </div>
      </div>
      <div style="display:flex; gap:0.75rem;">
        <a href="#/intimation/calling" class="btn-primary">
          <span>${icons.phone}</span>
          <span>Go to Intimation Calling Queue</span>
        </a>
        <a href="#/intimation/pending" class="btn-secondary">
          <span>View Open Calls Backlog</span>
        </a>
      </div>
    </div>
  `;

  loadCurrentSnapshotStats();
}

/**
 * Fetch and render current snapshot stats from open_calls_master
 */
async function loadCurrentSnapshotStats() {
  const mount = document.getElementById("snapshot-stats-cards");
  if (!mount) return;

  try {
    const [totalRes, over3dRes, cciCountRes] = await Promise.all([
      supabase.from("open_calls_master").select("id", { count: "exact", head: true }).eq("is_open", true),
      supabase.from("open_calls_master").select("id", { count: "exact", head: true }).eq("is_open", true).lte("carry_in_time", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()),
      supabase.from("open_calls_master").select("cci_code").eq("is_open", true),
    ]);

    const totalOpen = totalRes.count || 0;
    const over3d = over3dRes.count || 0;
    const distinctCcis = new Set((cciCountRes.data || []).map((d) => d.cci_code)).size;

    mount.innerHTML = `
      <div class="kpi-card" style="padding:1.25rem;">
        <div class="kpi-label">Active Open Calls</div>
        <div class="kpi-value" style="color:var(--moto-blue-accent);">${totalOpen.toLocaleString()}</div>
        <div style="font-size:0.75rem; color:var(--text-tertiary);">Currently open in system</div>
      </div>
      <div class="kpi-card" style="padding:1.25rem; border-left:4px solid #ef4444;">
        <div class="kpi-label">Ageing &gt; 3 Days (Critical)</div>
        <div class="kpi-value" style="color:#ef4444;">${over3d.toLocaleString()}</div>
        <div style="font-size:0.75rem; color:var(--text-tertiary);">Must be intimated to customer</div>
      </div>
      <div class="kpi-card" style="padding:1.25rem; border-left:4px solid #10b981;">
        <div class="kpi-label">Ageing &le; 3 Days</div>
        <div class="kpi-value" style="color:#10b981;">${(totalOpen - over3d).toLocaleString()}</div>
        <div style="font-size:0.75rem; color:var(--text-tertiary);">Fresh calls within threshold</div>
      </div>
      <div class="kpi-card" style="padding:1.25rem;">
        <div class="kpi-label">Active Service Centres</div>
        <div class="kpi-value" style="color:var(--text-primary);">${distinctCcis}</div>
        <div style="font-size:0.75rem; color:var(--text-tertiary);">CCIs with open inventory</div>
      </div>
    `;
  } catch (err) {
    console.error("Failed to load snapshot stats:", err);
    mount.innerHTML = `
      <div style="grid-column:1/-1; padding:1rem; background:#fee2e2; border-radius:8px; color:#b91c1c;">
        Failed to load snapshot metrics: ${escapeHtml(err.message)}
      </div>
    `;
  }
}
