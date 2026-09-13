import * as XLSX from "xlsx";
import { supabase, formatSupabaseError } from "./supabase.js";
import { escapeHtml, debounce, icons } from "./utils.js";
import { renderDataTableWrapper } from "../components/table.js";
import { renderTableSkeleton, renderSpinner } from "../components/loading.js";
import { openModal, closeModal, confirmDialog } from "../components/modal.js";
import { showToast } from "../components/toast.js";

let currentPage = 1;
const PAGE_SIZE = 12;
let searchQuery = "";

export async function renderCciPage(container) {
  currentPage = 1;
  searchQuery = "";

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">CCI Master Management</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">Manage Motorola Customer Care Centers (CCIs), regions, and operational status.</p>
      </div>

      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <button type="button" id="btn-upload-region-mapping" class="btn-secondary" style="padding:7px 14px; font-size:0.875rem; display:flex; align-items:center; gap:0.4rem;">
          <span style="width:18px; height:18px;">${icons.upload}</span>
          <span>Upload Region Mapping (Excel)</span>
        </button>
        <button type="button" id="btn-add-cci-modal" class="btn-primary" style="padding:7px 16px; font-size:0.875rem; display:flex; align-items:center; gap:0.4rem;">
          <span style="width:18px; height:18px;">${icons.mapPin}</span>
          <span>Add New CCI</span>
        </button>
      </div>
    </div>

    <div id="cci-table-container">
      ${renderDataTableWrapper({
        title: "All CCI Centers",
        searchPlaceholder: "Search CCI code, name, city...",
        columns: [
          { label: "CCI Code" },
          { label: "Center Name" },
          { label: "Region" },
          { label: "City / Location" },
          { label: "Status" },
          { label: "Actions", style: "text-align:right;" },
        ],
        rowsHtml: renderTableSkeleton(6, 6),
        page: currentPage,
        pageSize: PAGE_SIZE,
        totalRecords: 0,
      })}
    </div>
  `;

  document.getElementById("btn-add-cci-modal")?.addEventListener("click", () => {
    showCciFormModal();
  });

  document.getElementById("btn-upload-region-mapping")?.addEventListener("click", () => {
    showUploadRegionMappingModal();
  });

  await loadCciTable();
}

export async function loadCciTable() {
  const tableMount = document.getElementById("cci-table-container");
  if (!tableMount) return;

  try {
    let query = supabase.from("cci_master").select("*", { count: "exact" });

    if (searchQuery) {
      query = query.or(`cci_code.ilike.%${searchQuery}%,cci_name.ilike.%${searchQuery}%,location.ilike.%${searchQuery}%,region.ilike.%${searchQuery}%`);
    }

    const fromIndex = (currentPage - 1) * PAGE_SIZE;
    const toIndex = fromIndex + PAGE_SIZE - 1;

    const { data: ccis, count, error } = await query
      .order("cci_code", { ascending: true })
      .range(fromIndex, toIndex);

    if (error) throw error;

    const totalRecords = count || 0;
    let rowsHtml = "";

    if (!ccis || ccis.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="6" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
            No CCI records found.
          </td>
        </tr>
      `;
    } else {
      rowsHtml = ccis
        .map((c) => {
          const isAct = c.status === "ACTIVE";
          return `
          <tr>
            <td>
              <strong style="font-family:monospace; color:var(--moto-blue-accent); font-size:0.95rem;">${escapeHtml(c.cci_code)}</strong>
            </td>
            <td><strong>${escapeHtml(c.cci_name)}</strong></td>
            <td><span class="badge badge-neutral">${escapeHtml(c.region || "—")}</span></td>
            <td>${escapeHtml(c.location || "—")}</td>
            <td>
              <span class="badge ${isAct ? "badge-success" : "badge-danger"}">
                <span class="badge-dot"></span>${c.status}
              </span>
            </td>
            <td style="text-align:right;">
              <div style="display:inline-flex; gap:0.35rem;">
                <button type="button" class="btn-secondary btn-edit-cci" data-id="${c.id}" style="padding:4px 10px; font-size:0.75rem;">
                  Edit
                </button>
                <button type="button" class="btn-secondary btn-toggle-cci" data-id="${c.id}" data-status="${c.status}" style="padding:4px 10px; font-size:0.75rem;">
                  ${isAct ? "Deactivate" : "Activate"}
                </button>
              </div>
            </td>
          </tr>
        `;
        })
        .join("");
    }

    tableMount.innerHTML = renderDataTableWrapper({
      title: "All CCI Centers",
      searchPlaceholder: "Search CCI code, name, city...",
      columns: [
        { label: "CCI Code" },
        { label: "Center Name" },
        { label: "Region" },
        { label: "City / Location" },
        { label: "Status" },
        { label: "Actions", style: "text-align:right;" },
      ],
      rowsHtml,
      page: currentPage,
      pageSize: PAGE_SIZE,
      totalRecords,
    });

    attachCciActions(tableMount, totalRecords, ccis);
  } catch (err) {
    console.error("loadCciTable error:", err);
    tableMount.innerHTML = `
      <div style="padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

function attachCciActions(mount, totalRecords, currentCcis) {
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

  mount.querySelector("#btn-page-prev")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadCciTable();
    }
  });

  mount.querySelector("#btn-page-next")?.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadCciTable();
    }
  });

  const searchInput = mount.querySelector("#table-search-input");
  if (searchInput) {
    searchInput.value = searchQuery;
    searchInput.addEventListener(
      "input",
      debounce((e) => {
        searchQuery = e.target.value.trim();
        currentPage = 1;
        loadCciTable();
      }, 300)
    );
  }

  // Edit CCI
  mount.querySelectorAll(".btn-edit-cci").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const record = currentCcis.find((c) => c.id === id);
      if (record) showCciFormModal(record);
    });
  });

  // Toggle status
  mount.querySelectorAll(".btn-toggle-cci").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const currentStat = btn.getAttribute("data-status");
      const newStat = currentStat === "ACTIVE" ? "INACTIVE" : "ACTIVE";

      const confirmed = await confirmDialog({
        title: `${newStat === "ACTIVE" ? "Activate" : "Deactivate"} CCI Center`,
        message: `Are you sure you want to mark this center as ${newStat}?`,
        confirmText: newStat === "ACTIVE" ? "Activate" : "Deactivate",
        isDanger: newStat === "INACTIVE",
      });

      if (confirmed) {
        try {
          const { error } = await supabase.from("cci_master").update({ status: newStat }).eq("id", id);
          if (error) throw error;
          showToast(`CCI status updated to ${newStat}.`, "success");
          loadCciTable();
        } catch (e) {
          showToast(`Update failed: ${formatSupabaseError(e)}`, "error");
        }
      }
    });
  });
}

function showCciFormModal(cci = null) {
  const isEditing = !!cci;

  const contentHtml = `
    <form id="cci-form">
      <div class="form-group">
        <label for="cci-code-input" class="form-label">CCI Code *</label>
        <input type="text" id="cci-code-input" class="form-input" style="font-family:monospace; text-transform:uppercase;" required value="${escapeHtml(cci?.cci_code || "")}" ${isEditing ? "disabled" : ""} placeholder="e.g. BLR02">
      </div>

      <div class="form-group">
        <label for="cci-name-input" class="form-label">Center Name *</label>
        <input type="text" id="cci-name-input" class="form-input" required value="${escapeHtml(cci?.cci_name || "")}" placeholder="Motorola Care Center - Koramangala">
      </div>

      <div class="form-group">
        <label for="cci-region-input" class="form-label">Region *</label>
        <select id="cci-region-input" class="form-select" required>
          <option value="North" ${cci?.region === "North" ? "selected" : ""}>North</option>
          <option value="South" ${cci?.region === "South" ? "selected" : ""}>South</option>
          <option value="East" ${cci?.region === "East" ? "selected" : ""}>East</option>
          <option value="West" ${cci?.region === "West" ? "selected" : ""}>West</option>
          <option value="Central" ${cci?.region === "Central" ? "selected" : ""}>Central</option>
        </select>
      </div>

      <div class="form-group">
        <label for="cci-location-input" class="form-label">City / Location *</label>
        <input type="text" id="cci-location-input" class="form-input" required value="${escapeHtml(cci?.location || "")}" placeholder="e.g. Bangalore">
      </div>
    </form>
  `;

  const footerHtml = `
    <button type="button" class="btn-secondary" id="modal-btn-cancel">Cancel</button>
    <button type="button" class="btn-primary" id="modal-btn-save-cci">${isEditing ? "Save Changes" : "Create CCI"}</button>
  `;

  const overlay = openModal({
    title: isEditing ? `Edit CCI: ${cci.cci_code}` : "Add New CCI Center",
    contentHtml,
    footerHtml,
    size: "normal",
  });

  overlay.querySelector("#modal-btn-cancel")?.addEventListener("click", closeModal);

  overlay.querySelector("#modal-btn-save-cci")?.addEventListener("click", async () => {
    const cciCode = overlay.querySelector("#cci-code-input")?.value.trim().toUpperCase();
    const cciName = overlay.querySelector("#cci-name-input")?.value.trim();
    const region = overlay.querySelector("#cci-region-input")?.value;
    const location = overlay.querySelector("#cci-location-input")?.value.trim();

    if (!cciCode || !cciName || !location) {
      showToast("Please fill all required fields.", "warning");
      return;
    }

    try {
      if (isEditing) {
        const { error } = await supabase
          .from("cci_master")
          .update({ cci_name: cciName, region, location })
          .eq("id", cci.id);
        if (error) throw error;
        showToast("CCI updated successfully.", "success");
      } else {
        const { error } = await supabase
          .from("cci_master")
          .insert({ cci_code: cciCode, cci_name: cciName, region, location, status: "ACTIVE" });
        if (error) throw error;
        showToast(`CCI ${cciCode} created successfully.`, "success");
      }
      closeModal();
      loadCciTable();
    } catch (err) {
      showToast(`Error: ${formatSupabaseError(err)}`, "error");
    }
  });
}

/**
 * Upload and parse Region Mapping Excel/CSV file
 * Updates cci_master and creates CCI user accounts with default password Moto@123
 */
function showUploadRegionMappingModal() {
  const contentHtml = `
    <div style="display:flex; flex-direction:column; gap:1.25rem;">
      <div style="background:var(--moto-blue-light); padding:0.85rem 1rem; border-radius:var(--radius-md); border-left:4px solid var(--moto-blue-accent);">
        <p style="font-size:0.875rem; color:var(--moto-blue-primary); line-height:1.4;">
          <strong>Automatic User Generation:</strong> For each station code in the uploaded file, the system will update the CCI master record and generate a CCI agent login:
          <br>&bull; <strong>Username:</strong> <code>&lt;station_code&gt;@motorolacare.in</code>
          <br>&bull; <strong>Default Password:</strong> <code>Moto@123</code> (can later be updated by admin)
        </p>
      </div>

      <div class="dropzone" id="region-mapping-dropzone" style="padding:2rem 1rem;">
        <div style="color:var(--moto-blue-accent); width:40px; height:40px; margin:0 auto 0.5rem;">
          ${icons.upload}
        </div>
        <h4 style="font-size:0.95rem; font-weight:600; margin-bottom:0.25rem;">Select or Drop Region Mapping File (.xlsx, .xls, .csv)</h4>
        <p style="font-size:0.75rem; color:var(--text-tertiary); margin-bottom:0.75rem;">
          Must contain columns: <strong>Station Code</strong> and <strong>Region</strong>
        </p>
        <label for="input-region-file" class="btn-primary" style="padding:6px 14px; font-size:0.8125rem; display:inline-flex; cursor:pointer;">
          <span>Choose File</span>
        </label>
        <input type="file" id="input-region-file" accept=".xlsx,.xls,.csv" style="display:none;">
      </div>

      <!-- Preview Section -->
      <div id="region-preview-mount" style="display:none;"></div>
    </div>
  `;

  const overlay = openModal({
    title: "Import Station Region Mapping & Generate CCI Users",
    contentHtml,
    footerHtml: `<button type="button" class="btn-secondary" id="btn-close-region-modal">Cancel</button>`,
    size: "large",
  });

  overlay.querySelector("#btn-close-region-modal")?.addEventListener("click", closeModal);

  const fileInput = overlay.querySelector("#input-region-file");
  const dropzone = overlay.querySelector("#region-mapping-dropzone");

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
      handleRegionFile(e.dataTransfer.files[0], overlay);
    }
  });

  fileInput?.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleRegionFile(e.target.files[0], overlay);
    }
  });
}

function handleRegionFile(file, modalOverlay) {
  const mount = modalOverlay.querySelector("#region-preview-mount");
  if (!mount) return;

  mount.style.display = "block";
  mount.innerHTML = renderSpinner(`Reading ${file.name}...`);

  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      const firstSheet = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheet];
      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

      if (!rows || rows.length === 0) {
        mount.innerHTML = `<div style="padding:1rem; color:#991b1b; background:#fef2f2; border-radius:6px;">No rows found in file.</div>`;
        return;
      }

      // Helper to detect headers
      const sample = rows[0];
      const rowKeys = Object.keys(sample);

      const findKey = (...synonyms) => {
        for (const syn of synonyms) {
          const target = syn.toLowerCase().replace(/[\s_-]/g, "");
          const matched = rowKeys.find((k) => k.toLowerCase().replace(/[\s_-]/g, "") === target);
          if (matched) return matched;
        }
        return "";
      };

      const codeKey = findKey("station code", "stationcode", "station_code", "station", "station id", "stationid", "cci code", "cci_code", "cci");
      const regionKey = findKey("region", "zone", "territory", "area", "region name", "circle");
      const nameKey = findKey("station name", "stationname", "station_name", "center name", "asc name", "name", "service center");
      const locationKey = findKey("location", "city", "district", "place", "state");

      if (!codeKey || !regionKey) {
        mount.innerHTML = `
          <div style="padding:1rem; color:#991b1b; background:#fef2f2; border-radius:6px; font-size:0.875rem;">
            <strong>Could not detect required columns.</strong>
            <br>Detected Headers: <code>${rowKeys.join(", ")}</code>
            <br>Please make sure your file contains headers for <strong>Station Code</strong> and <strong>Region</strong>.
          </div>
        `;
        return;
      }

      const parsedStations = rows
        .map((r) => {
          const code = String(r[codeKey] || "").trim().toUpperCase();
          const region = String(r[regionKey] || "General").trim();
          const name = String((nameKey && r[nameKey]) || `Motorola Care - ${code}`).trim();
          const location = String((locationKey && r[locationKey]) || region).trim();

          return {
            station_code: code,
            region: region,
            station_name: name,
            location: location,
          };
        })
        .filter((s) => s.station_code);

      if (parsedStations.length === 0) {
        mount.innerHTML = `<div style="padding:1rem; color:#991b1b; background:#fef2f2; border-radius:6px;">No valid station code records found.</div>`;
        return;
      }

      mount.innerHTML = `
        <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); overflow:hidden;">
          <div style="padding:0.75rem 1rem; background:var(--bg-surface-subtle); border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:0.8125rem; font-weight:600;">Detected <strong>${parsedStations.length}</strong> Stations from "${escapeHtml(file.name)}"</span>
            <button type="button" id="btn-confirm-region-ingest" class="btn-primary" style="padding:6px 14px; font-size:0.8125rem;">
              <span>Confirm & Ingest ${parsedStations.length} Stations & Users</span>
            </button>
          </div>

          <div style="max-height:220px; overflow-y:auto;">
            <table class="data-table" style="font-size:0.8125rem;">
              <thead>
                <tr>
                  <th>Station Code</th>
                  <th>Region</th>
                  <th>Center Name</th>
                  <th>Generated Login Email</th>
                  <th>Default Password</th>
                </tr>
              </thead>
              <tbody>
                ${parsedStations
                  .slice(0, 5)
                  .map(
                    (s) => `
                  <tr>
                    <td><strong style="font-family:monospace; color:var(--moto-blue-accent);">${escapeHtml(s.station_code)}</strong></td>
                    <td><span class="badge badge-info">${escapeHtml(s.region)}</span></td>
                    <td>${escapeHtml(s.station_name)}</td>
                    <td><code>${escapeHtml(s.station_code.toLowerCase())}@motorolacare.in</code></td>
                    <td><code>Moto@123</code></td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>

          ${
            parsedStations.length > 5
              ? `<div style="padding:6px 12px; font-size:0.75rem; color:var(--text-tertiary); background:var(--bg-surface-subtle);">Showing first 5 rows of ${parsedStations.length} total stations.</div>`
              : ""
          }
        </div>

        <div id="region-ingest-status" style="margin-top:1rem;"></div>
      `;

      mount.querySelector("#btn-confirm-region-ingest")?.addEventListener("click", async () => {
        const btn = mount.querySelector("#btn-confirm-region-ingest");
        const statusDiv = mount.querySelector("#region-ingest-status");
        btn.disabled = true;
        statusDiv.innerHTML = renderSpinner(`Updating CCI records and generating user accounts...`);

        try {
          let usersCreated = 0;
          let cciCount = parsedStations.length;
          let rpcSuccess = false;

          // 1. Try atomic database RPC function bulk_create_station_cci_users
          try {
            const { data: rpcData, error: rpcError } = await supabase.rpc("bulk_create_station_cci_users", {
              p_stations: parsedStations,
              p_default_password: "Moto@123",
            });

            if (!rpcError && rpcData?.success) {
              rpcSuccess = true;
              usersCreated = rpcData.users_created || 0;
              showToast(`Created ${usersCreated} Auth users directly in Supabase!`, "success");
            }
          } catch (e) {
            console.warn("RPC bulk_create_station_cci_users not yet executed in DB:", e);
          }

          // 2. If RPC was not yet run in SQL editor, use client-side Supabase Auth registration
          if (!rpcSuccess) {
            statusDiv.innerHTML = renderSpinner(`Registering Auth users in Supabase (${parsedStations.length} stations)...`);

            // Direct upsert to cci_master
            for (const st of parsedStations) {
              await supabase.from("cci_master").upsert(
                {
                  cci_code: st.station_code,
                  cci_name: st.station_name,
                  region: st.region,
                  location: st.location,
                  status: "ACTIVE",
                },
                { onConflict: "cci_code" }
              );
            }

            // Create temporary client with persistSession: false so admin is not signed out
            const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || window.__SUPABASE_URL__ || localStorage.getItem("__MOTO_SU_URL__");
            const supabaseAnonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY || window.__SUPABASE_ANON_KEY__ || localStorage.getItem("__MOTO_SU_KEY__");

            if (supabaseUrl && supabaseAnonKey) {
              const { createClient } = await import("@supabase/supabase-js");
              const tempClient = createClient(supabaseUrl, supabaseAnonKey, {
                auth: { persistSession: false, autoRefreshToken: false },
              });

              for (const st of parsedStations) {
                const userEmail = `${st.station_code.toLowerCase()}@motorolacare.in`;
                try {
                  const { data: signData, error: signErr } = await tempClient.auth.signUp({
                    email: userEmail,
                    password: "Moto@123",
                    options: {
                      data: {
                        user_name: `CCI ${st.station_code}`,
                        role: "CCI_USER",
                        cci_code: st.station_code,
                      },
                    },
                  });

                  if (!signErr && signData?.user) {
                    usersCreated++;
                    // Insert into public.user_profiles
                    await supabase.from("user_profiles").upsert(
                      {
                        auth_user_id: signData.user.id,
                        user_name: `CCI ${st.station_code}`,
                        role: "CCI_USER",
                        cci_code: st.station_code,
                        cci_name: st.station_name,
                        status: "ACTIVE",
                      },
                      { onConflict: "auth_user_id" }
                    );
                  }
                } catch (userErr) {
                  console.warn(`User ${userEmail} registration:`, userErr);
                }
              }
            }
          }

          showToast(`Processed ${parsedStations.length} stations, created ${usersCreated} Auth accounts!`, "success");

          statusDiv.innerHTML = `
            <div style="padding:1.25rem; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:8px; color:#065f46; font-size:0.875rem;">
              <strong style="font-size:1rem;">Region Mapping & Auth Users Pushed to Supabase!</strong>
              <div style="margin-top:0.5rem; line-height:1.6;">
                &bull; Stations configured in <code>cci_master</code>: <strong>${parsedStations.length}</strong>
                <br>&bull; New Accounts in Supabase <code>auth.users</code>: <strong>${usersCreated}</strong>
                <br>&bull; Default Password: <code>Moto@123</code>
              </div>

              <div style="margin-top:1rem; padding:0.75rem; background:#ffffff; border:1px solid #a7f3d0; border-radius:6px; font-size:0.8125rem; color:#065f46;">
                <strong>Supabase SQL Helper:</strong> You can also run <a href="file:///Users/pramod47.kumar/Documents/Happy_Calling/supabase/migrations/20260913000001_bulk_create_station_cci_users.sql" target="_blank" style="text-decoration:underline; font-weight:700;">20260913000001_bulk_create_station_cci_users.sql</a> in your Supabase SQL Editor to enable instant database-level batch user generation.
              </div>

              <div style="margin-top:1rem;">
                <button type="button" class="btn-primary" id="btn-finish-region-import" style="padding:6px 16px; font-size:0.875rem;">
                  Done & Refresh CCI List
                </button>
              </div>
            </div>
          `;

          statusDiv.querySelector("#btn-finish-region-import")?.addEventListener("click", () => {
            closeModal();
            loadCciTable();
          });
        } catch (ingestErr) {
          console.error("Ingest error:", ingestErr);
          statusDiv.innerHTML = `
            <div style="padding:1rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b; font-size:0.875rem;">
              <strong>Ingestion error:</strong> ${formatSupabaseError(ingestErr)}
            </div>
          `;
          btn.disabled = false;
        }
      });
    } catch (parseErr) {
      console.error("Parse error:", parseErr);
      mount.innerHTML = `<div style="padding:1rem; color:#991b1b; background:#fef2f2; border-radius:6px;">Error parsing Excel file: ${parseErr.message}</div>`;
    }
  };

  reader.readAsArrayBuffer(file);
}
