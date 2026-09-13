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
                <button type="button" class="btn-secondary btn-pw-cci" data-code="${escapeHtml(c.cci_code)}" data-name="${escapeHtml(c.cci_name)}" style="padding:4px 8px; font-size:0.75rem;" title="Manage / Regenerate Station Password">
                  🔑 Credentials
                </button>
                <button type="button" class="btn-secondary btn-edit-cci" data-id="${c.id}" style="padding:4px 8px; font-size:0.75rem;">
                  Edit
                </button>
                <button type="button" class="btn-secondary btn-toggle-cci" data-id="${c.id}" data-status="${c.status}" style="padding:4px 8px; font-size:0.75rem;">
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

  // Manage Credentials for Station
  mount.querySelectorAll(".btn-pw-cci").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-code");
      const name = btn.getAttribute("data-name");
      showCciCredentialsModal(code, name);
    });
  });

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

      function buildSupabaseBulkSql(stations, defaultPassword = "Moto@123") {
        const jsonStations = JSON.stringify(stations).replace(/'/g, "''");
        return `-- ============================================================================
-- MOTOROLA HAPPY CALLING: DIRECT BATCH USER & CCI CREATION FOR SUPABASE
-- Paste and Run in: Supabase Dashboard -> SQL Editor -> New Query -> Run
-- Total Stations: ${stations.length} | Username: cci_<station_code> (e.g. cci_65)
-- Default Password: ${defaultPassword} (Changeable by Admin in Portal)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
DECLARE
    v_item JSONB;
    v_code TEXT;
    v_region TEXT;
    v_name TEXT;
    v_location TEXT;
    v_username TEXT;
    v_email TEXT;
    v_auth_id UUID;
    v_encrypted_pw TEXT;
    v_stations JSONB := '${jsonStations}'::jsonb;
    v_inserted_users INT := 0;
    v_existing_users INT := 0;
    v_cci_count INT := 0;
BEGIN
    v_encrypted_pw := crypt('${defaultPassword}', gen_salt('bf', 10));

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_stations)
    LOOP
        v_code := UPPER(TRIM(v_item->>'station_code'));
        v_region := TRIM(v_item->>'region');
        v_name := TRIM(v_item->>'station_name');
        v_location := TRIM(v_item->>'location');

        IF v_code IS NOT NULL AND v_code <> '' THEN
            IF v_region IS NULL OR v_region = '' THEN v_region := 'General'; END IF;
            IF v_name IS NULL OR v_name = '' THEN v_name := 'Motorola Care - ' || v_code; END IF;
            IF v_location IS NULL OR v_location = '' THEN v_location := v_region; END IF;

            -- Username format: cci_<station_code> (e.g. cci_65)
            v_username := 'cci_' || lower(regexp_replace(v_code, '^cci_?', ''));
            v_email := v_username || '@cci.local';

            -- 1. Upsert into cci_master
            INSERT INTO public.cci_master (cci_code, cci_name, region, location, status)
            VALUES (v_code, v_name, v_region, v_location, 'ACTIVE')
            ON CONFLICT (cci_code) DO UPDATE
            SET region = EXCLUDED.region,
                cci_name = EXCLUDED.cci_name,
                location = EXCLUDED.location,
                status = 'ACTIVE',
                updated_at = now();
            v_cci_count := v_cci_count + 1;

            -- 2. Check Auth User
            SELECT id INTO v_auth_id FROM auth.users 
            WHERE email = v_email 
               OR email = lower(v_code) || '@motorolacare.in' 
               OR email = v_username || '@motorolacare.in'
            LIMIT 1;

            IF v_auth_id IS NULL THEN
                v_auth_id := gen_random_uuid();

                INSERT INTO auth.users (
                    id,
                    instance_id,
                    email,
                    encrypted_password,
                    email_confirmed_at,
                    raw_app_meta_data,
                    raw_user_meta_data,
                    created_at,
                    updated_at,
                    role,
                    aud,
                    confirmation_token,
                    is_super_admin
                ) VALUES (
                    v_auth_id,
                    '00000000-0000-0000-0000-000000000000'::uuid,
                    v_email,
                    v_encrypted_pw,
                    now(),
                    '{"provider":"email","providers":["email"]}'::jsonb,
                    jsonb_build_object('username', v_username, 'user_name', v_username, 'role', 'CCI_USER', 'cci_code', v_code),
                    now(),
                    now(),
                    'authenticated',
                    'authenticated',
                    encode(gen_random_bytes(32), 'hex'),
                    false
                );

                -- 3. Register identity for Supabase GoTrue
                BEGIN
                    INSERT INTO auth.identities (
                        id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
                    ) VALUES (
                        v_auth_id, v_auth_id,
                        jsonb_build_object('sub', v_auth_id::text, 'email', v_email),
                        'email', v_email, now(), now(), now()
                    );
                EXCEPTION WHEN OTHERS THEN NULL;
                END;

                -- 4. User Profile
                INSERT INTO public.user_profiles (
                    auth_user_id, user_name, role, cci_code, cci_name, status
                ) VALUES (
                    v_auth_id, v_username, 'CCI_USER', v_code, v_name, 'ACTIVE'
                ) ON CONFLICT (auth_user_id) DO NOTHING;

                v_inserted_users := v_inserted_users + 1;
            ELSE
                -- Update password and metadata
                UPDATE auth.users
                SET encrypted_password = v_encrypted_pw,
                    email_confirmed_at = COALESCE(email_confirmed_at, now()),
                    raw_user_meta_data = jsonb_build_object('username', v_username, 'user_name', v_username, 'role', 'CCI_USER', 'cci_code', v_code),
                    updated_at = now()
                WHERE id = v_auth_id;

                INSERT INTO public.user_profiles (
                    auth_user_id, user_name, role, cci_code, cci_name, status
                ) VALUES (
                    v_auth_id, v_username, 'CCI_USER', v_code, v_name, 'ACTIVE'
                ) ON CONFLICT (auth_user_id) DO UPDATE
                SET user_name = v_username, cci_code = v_code, cci_name = v_name, role = 'CCI_USER', status = 'ACTIVE', updated_at = now();

                v_existing_users := v_existing_users + 1;
            END IF;
        END IF;
    END LOOP;

    RAISE NOTICE 'SUCCESS: % CCIs processed, % new Auth users created, % users updated.', v_cci_count, v_inserted_users, v_existing_users;
END $$;

-- 5. Helper Function: Admin Reset Password by Station Code
CREATE OR REPLACE FUNCTION public.admin_reset_cci_password(
    p_cci_code TEXT,
    p_new_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_auth_id UUID;
    v_clean_code TEXT;
    v_username TEXT;
BEGIN
    IF length(p_new_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters long';
    END IF;

    v_clean_code := UPPER(TRIM(p_cci_code));
    v_username := 'cci_' || lower(regexp_replace(v_clean_code, '^cci_?', ''));

    SELECT auth_user_id INTO v_auth_id FROM public.user_profiles WHERE cci_code = v_clean_code LIMIT 1;
    IF v_auth_id IS NULL THEN
        SELECT id INTO v_auth_id FROM auth.users WHERE email = v_username || '@cci.local' OR email = lower(v_clean_code) || '@motorolacare.in' LIMIT 1;
    END IF;

    IF v_auth_id IS NULL THEN
        RAISE EXCEPTION 'No user account found for Station Code %', p_cci_code;
    END IF;

    UPDATE auth.users SET encrypted_password = crypt(p_new_password, gen_salt('bf', 10)), updated_at = now() WHERE id = v_auth_id;

    RETURN jsonb_build_object('success', true, 'auth_user_id', v_auth_id, 'username', v_username, 'cci_code', v_clean_code);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reset_cci_password(TEXT, TEXT) TO authenticated, anon, service_role;
`;
      }

      mount.innerHTML = `
        <div style="background: linear-gradient(135deg, #1e293b, #0f172a); color: white; padding: 1rem 1.25rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid #334155;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">
            <div>
              <div style="font-weight:700; font-size:0.9375rem; color:#38bdf8; display:flex; align-items:center; gap:6px;">
                <span>✨</span> Instant Supabase Direct SQL Generator
              </div>
              <div style="font-size:0.8125rem; color:#94a3b8; margin-top:2px;">
                Detected <strong>${parsedStations.length}</strong> stations from "${escapeHtml(file.name)}". Ready to generate usernames (e.g. <code>cci_65</code>) and passwords.
              </div>
            </div>
            <div style="display:flex; gap:0.5rem;">
              <button type="button" id="btn-copy-supabase-sql" class="btn-primary" style="background:#0284c7; border:none; padding:7px 14px; font-size:0.8125rem; font-weight:600; display:flex; align-items:center; gap:6px;">
                <span>📋</span> Copy Supabase SQL
              </button>
              <button type="button" id="btn-download-supabase-sql" class="btn-secondary" style="background:#334155; color:white; border:none; padding:7px 12px; font-size:0.8125rem; display:flex; align-items:center; gap:6px;">
                <span>💾</span> Download .sql
              </button>
            </div>
          </div>
        </div>

        <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); overflow:hidden;">
          <div style="padding:0.75rem 1rem; background:var(--bg-surface-subtle); border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
            <span style="font-size:0.8125rem; font-weight:600;">Station Preview (Showing ${Math.min(5, parsedStations.length)} of ${parsedStations.length})</span>
            <button type="button" id="btn-confirm-region-ingest" class="btn-primary" style="padding:6px 14px; font-size:0.8125rem;">
              <span>⚡ Push via App & Supabase API</span>
            </button>
          </div>

          <div style="max-height:180px; overflow-y:auto;">
            <table class="data-table" style="font-size:0.8125rem;">
              <thead>
                <tr>
                  <th>Station Code</th>
                  <th>Region</th>
                  <th>Center Name</th>
                  <th>Generated Username</th>
                  <th>Default Password</th>
                </tr>
              </thead>
              <tbody>
                ${parsedStations
                  .slice(0, 5)
                  .map(
                    (s) => {
                      const uname = `cci_${s.station_code.toLowerCase().replace(/^(cci[_-]?)/i, "")}`;
                      return `
                  <tr>
                    <td><strong style="font-family:monospace; color:var(--moto-blue-accent);">${escapeHtml(s.station_code)}</strong></td>
                    <td><span class="badge badge-info">${escapeHtml(s.region)}</span></td>
                    <td>${escapeHtml(s.station_name)}</td>
                    <td><strong style="font-family:monospace; color:var(--moto-blue-primary);">${escapeHtml(uname)}</strong></td>
                    <td><code>Moto@123</code></td>
                  </tr>
                `;
                    }
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>

        <div style="margin-top:0.75rem; background:var(--bg-surface-subtle); border:1px solid var(--border-subtle); border-radius:6px; padding:0.75rem;">
          <div style="font-size:0.75rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.25rem;">
            🔑 Supabase Service Role Key (Optional — enables direct browser creation without opening Supabase SQL Editor):
          </div>
          <input type="password" id="input-service-role-key" class="form-input" style="font-size:0.75rem; padding:6px 10px;" placeholder="Paste service_role secret from Supabase Dashboard > Project Settings > API">
        </div>

        <div id="region-ingest-status" style="margin-top:1rem;"></div>
      `;

      // Copy SQL Action
      mount.querySelector("#btn-copy-supabase-sql")?.addEventListener("click", () => {
        const sql = buildSupabaseBulkSql(parsedStations);
        navigator.clipboard.writeText(sql).then(() => {
          showToast(`Copied SQL for ${parsedStations.length} stations! Paste in Supabase SQL Editor and click RUN.`, "success");
        }).catch(() => {
          showToast("Failed to copy. Please click Download .sql instead.", "error");
        });
      });

      // Download SQL Action
      mount.querySelector("#btn-download-supabase-sql")?.addEventListener("click", () => {
        const sql = buildSupabaseBulkSql(parsedStations);
        const blob = new Blob([sql], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `supabase_bulk_station_users_${parsedStations.length}.sql`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("SQL script downloaded!", "success");
      });

      // Push via App Action
      mount.querySelector("#btn-confirm-region-ingest")?.addEventListener("click", async () => {
        const btn = mount.querySelector("#btn-confirm-region-ingest");
        const statusDiv = mount.querySelector("#region-ingest-status");
        const serviceRoleKey = mount.querySelector("#input-service-role-key")?.value?.trim() || localStorage.getItem("__MOTO_SU_SERVICE_ROLE_KEY__") || "";
        btn.disabled = true;
        statusDiv.innerHTML = renderSpinner(`Pushing records to Supabase (${parsedStations.length} stations)...`);

        try {
          // 1. Always upsert stations into cci_master first
          let cciUpsertCount = 0;
          for (const st of parsedStations) {
            const { error: cciErr } = await supabase.from("cci_master").upsert(
              {
                cci_code: st.station_code,
                cci_name: st.station_name,
                region: st.region,
                location: st.location,
                status: "ACTIVE",
              },
              { onConflict: "cci_code" }
            );
            if (!cciErr) cciUpsertCount++;
          }

          let usersCreated = 0;
          let methodUsed = "";
          let errorDetail = null;

          // Method A: If service role key is provided, use Supabase Admin API directly
          if (serviceRoleKey) {
            localStorage.setItem("__MOTO_SU_SERVICE_ROLE_KEY__", serviceRoleKey);
            statusDiv.innerHTML = renderSpinner(`Creating Auth accounts via Supabase Admin API...`);
            const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL || window.__SUPABASE_URL__ || localStorage.getItem("__MOTO_SU_URL__");
            const { createClient } = await import("@supabase/supabase-js");
            const adminClient = createClient(supabaseUrl, serviceRoleKey, {
              auth: { persistSession: false, autoRefreshToken: false },
            });

            for (const st of parsedStations) {
              const username = `cci_${st.station_code.toLowerCase().replace(/^(cci[_-]?)/i, "")}`;
              const email = `${username}@cci.local`;
              try {
                const { data: userData, error: createErr } = await adminClient.auth.admin.createUser({
                  email: email,
                  password: "Moto@123",
                  email_confirm: true,
                  user_metadata: {
                    user_name: username,
                    username: username,
                    role: "CCI_USER",
                    cci_code: st.station_code,
                  },
                });

                if (userData?.user) {
                  usersCreated++;
                  await adminClient.from("user_profiles").upsert(
                    {
                      auth_user_id: userData.user.id,
                      user_name: username,
                      role: "CCI_USER",
                      cci_code: st.station_code,
                      cci_name: st.station_name,
                      status: "ACTIVE",
                    },
                    { onConflict: "auth_user_id" }
                  );
                } else if (createErr) {
                  console.warn(`Admin createUser error for ${username}:`, createErr.message);
                }
              } catch (e) {
                console.warn(`Admin createUser exception for ${username}:`, e);
              }
            }
            methodUsed = "Admin REST API (Service Role)";
          } else {
            // Method B: Try database RPC function bulk_create_station_cci_users
            try {
              const { data: rpcData, error: rpcError } = await supabase.rpc("bulk_create_station_cci_users", {
                p_stations: parsedStations,
                p_default_password: "Moto@123",
              });

              if (!rpcError && rpcData?.success) {
                usersCreated = rpcData.users_created || 0;
                methodUsed = "Database RPC Function";
              } else if (rpcError) {
                errorDetail = rpcError.message || formatSupabaseError(rpcError);
              }
            } catch (rpcEx) {
              errorDetail = rpcEx.message;
            }
          }

          if (usersCreated > 0) {
            showToast(`Success! ${usersCreated} Supabase Auth users created!`, "success");
            statusDiv.innerHTML = `
              <div style="padding:1.25rem; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:8px; color:#065f46; font-size:0.875rem;">
                <strong style="font-size:1rem;">✅ Stations & Supabase Auth Users Created Successfully!</strong>
                <div style="margin-top:0.5rem; line-height:1.6;">
                  &bull; Configured in <code>cci_master</code>: <strong>${cciUpsertCount}</strong>
                  <br>&bull; Created in Supabase <code>auth.users</code>: <strong>${usersCreated}</strong>
                  <br>&bull; Username Format: <code>cci_&lt;station_code&gt;</code> (e.g. <code>cci_65</code>)
                  <br>&bull; Default Password: <code>Moto@123</code>
                  <br>&bull; Method: <strong>${methodUsed}</strong>
                </div>
                <div style="margin-top:1rem;">
                  <button type="button" class="btn-primary" id="btn-finish-region-import" style="padding:6px 16px; font-size:0.875rem;">
                    Done & Refresh CCI List
                  </button>
                </div>
              </div>
            `;
          } else {
            statusDiv.innerHTML = `
              <div style="padding:1.25rem; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; color:#92400e; font-size:0.875rem;">
                <strong style="font-size:1rem; color:#b45309;">⚠️ Stations Saved, but Auth Users Require SQL Editor Run</strong>
                <div style="margin-top:0.5rem; line-height:1.6;">
                  &bull; <strong>${cciUpsertCount} stations</strong> were successfully updated in <code>cci_master</code>.
                  <br>&bull; Direct creation of Auth users from browser was prevented by Supabase: 
                  <code style="background:#fef3c7; padding:2px 4px; border-radius:4px;">${escapeHtml(errorDetail || "RPC function bulk_create_station_cci_users not installed in Supabase")}</code>
                </div>

                <div style="margin-top:1rem; padding:1rem; background:#ffffff; border:1px solid #fcd34d; border-radius:6px;">
                  <strong style="color:#1e293b;">👉 Complete Setup in 10 Seconds via Supabase SQL Editor:</strong>
                  <ol style="margin:0.5rem 0 0.75rem 1.25rem; line-height:1.6; color:#334155; font-size:0.8125rem;">
                    <li>Click the <strong>"Copy Supabase SQL"</strong> button below.</li>
                    <li>Go to your <strong>Supabase Dashboard &rarr; SQL Editor</strong>.</li>
                    <li>Click <strong>New Query</strong>, paste the copied SQL, and click <strong>Run</strong>.</li>
                    <li>All <strong>${parsedStations.length} users</strong> (e.g. <code>cci_65</code>) will instantly appear in Supabase <strong>Authentication &rarr; Users</strong>!</li>
                  </ol>
                  <button type="button" id="btn-copy-supabase-sql-fallback" class="btn-primary" style="background:#0284c7; border:none; padding:8px 18px; font-weight:600; font-size:0.875rem;">
                    📋 Copy Supabase SQL Script Now
                  </button>
                </div>

                <div style="margin-top:1rem;">
                  <button type="button" class="btn-secondary" id="btn-finish-region-import" style="padding:6px 16px; font-size:0.875rem;">
                    Close & View Stations
                  </button>
                </div>
              </div>
            `;

            statusDiv.querySelector("#btn-copy-supabase-sql-fallback")?.addEventListener("click", () => {
              const sql = buildSupabaseBulkSql(parsedStations);
              navigator.clipboard.writeText(sql).then(() => {
                showToast(`SQL copied! Paste in Supabase SQL Editor and click RUN.`, "success");
              });
            });
          }

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

/**
 * Manage / Regenerate Station Credentials Modal
 */
function showCciCredentialsModal(cciCode, cciName) {
  const cleanCode = cciCode.toLowerCase().replace(/^(cci[_-]?)/i, "");
  const username = `cci_${cleanCode}`;
  const defaultPw = `Moto@${Math.floor(1000 + Math.random() * 9000)}`;

  const contentHtml = `
    <div style="margin-bottom:1rem;">
      <p style="font-size:0.875rem; color:var(--text-secondary);">
        Manage portal login credentials for Station <strong>${escapeHtml(cciCode)}</strong> (${escapeHtml(cciName)}).
      </p>
    </div>

    <div class="form-group">
      <label class="form-label">Station Login Username</label>
      <input type="text" class="form-input" readonly value="${escapeHtml(username)}" style="font-family:monospace; background:var(--bg-surface-subtle); font-weight:700; color:var(--moto-blue-accent);">
      <div style="font-size:0.75rem; color:var(--text-tertiary); margin-top:2px;">
        The station user logs in directly with this username.
      </div>
    </div>

    <div class="form-group">
      <label for="input-cci-pw" class="form-label" style="display:flex; justify-content:space-between; align-items:center;">
        <span>Set / Regenerate Password *</span>
        <button type="button" id="btn-gen-cci-pw" class="btn-secondary" style="padding:2px 8px; font-size:0.75rem;">
          🎲 Generate Random
        </button>
      </label>
      <input type="text" id="input-cci-pw" class="form-input" value="${defaultPw}" minlength="6" placeholder="Min 6 characters">
    </div>

    <div id="cci-pw-result" style="margin-top:1rem;"></div>
  `;

  const footerHtml = `
    <button type="button" class="btn-secondary" id="btn-close-cci-pw">Close</button>
    <button type="button" class="btn-primary" id="btn-save-cci-pw">Update & Share Password</button>
  `;

  const overlay = openModal({
    title: `Station Credentials: ${cciCode}`,
    contentHtml,
    footerHtml,
    size: "medium",
  });

  const inputPw = overlay.querySelector("#input-cci-pw");
  const resultDiv = overlay.querySelector("#cci-pw-result");

  overlay.querySelector("#btn-gen-cci-pw")?.addEventListener("click", () => {
    inputPw.value = `Moto@${Math.floor(1000 + Math.random() * 9000)}`;
  });

  overlay.querySelector("#btn-close-cci-pw")?.addEventListener("click", closeModal);

  overlay.querySelector("#btn-save-cci-pw")?.addEventListener("click", async () => {
    const newPassword = inputPw.value.trim();
    if (!newPassword || newPassword.length < 6) {
      showToast("Password must be at least 6 characters.", "warning");
      return;
    }

    const saveBtn = overlay.querySelector("#btn-save-cci-pw");
    saveBtn.disabled = true;
    saveBtn.textContent = "Updating...";
    resultDiv.innerHTML = renderSpinner("Updating password in Supabase...");

    let success = false;
    let errorMsg = null;

    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc("admin_reset_cci_password", {
        p_cci_code: cciCode,
        p_new_password: newPassword,
      });

      if (!rpcErr && rpcData?.success) {
        success = true;
      } else if (rpcErr) {
        errorMsg = rpcErr.message;
      }
    } catch (e) {
      errorMsg = e.message;
    }

    if (success) {
      showToast(`Password updated for ${username}!`, "success");
      saveBtn.style.display = "none";

      const portalUrl = window.location.origin + window.location.pathname;
      const shareText = `📱 MOTOROLA HAPPY CALLING - STATION LOGIN CREDENTIALS
--------------------------------------------------
Portal URL:   ${portalUrl}
Username:     ${username}
Password:     ${newPassword}
Station Code: ${cciCode}
Center Name:  ${cciName}
--------------------------------------------------
Login at the portal using your Username and Password.`;

      resultDiv.innerHTML = `
        <div style="padding:1rem; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:8px; color:#065f46; font-size:0.875rem;">
          <strong style="color:#047857;">✅ Password Updated in Supabase!</strong>
          <p style="margin:0.25rem 0 0.75rem; font-size:0.8125rem; color:#065f46;">
            Copy credentials below to share with the station:
          </p>
          <pre style="background:#ffffff; border:1px solid #a7f3d0; border-radius:6px; padding:0.75rem; font-family:monospace; font-size:0.8125rem; line-height:1.5; color:#1e293b; white-space:pre-wrap;">${escapeHtml(shareText)}</pre>
          <button type="button" id="btn-copy-cci-share-creds" class="btn-primary" style="margin-top:0.75rem; width:100%; justify-content:center; padding:8px 14px; font-weight:600; font-size:0.8125rem;">
            📋 Copy Credentials to Clipboard
          </button>
        </div>
      `;

      resultDiv.querySelector("#btn-copy-cci-share-creds")?.addEventListener("click", () => {
        navigator.clipboard.writeText(shareText).then(() => {
          showToast("Credentials copied! Ready to share via WhatsApp / Email.", "success");
        });
      });
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = "Retry Update";

      resultDiv.innerHTML = `
        <div style="padding:1rem; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; color:#92400e; font-size:0.8125rem;">
          <strong>RPC Error:</strong> ${escapeHtml(errorMsg || "Function admin_reset_cci_password not found.")}
          <div style="margin-top:0.5rem; line-height:1.5;">
            Run migration <code>20260913000001_bulk_create_station_cci_users.sql</code> in Supabase SQL Editor once to enable 1-click password resets for any station.
          </div>
        </div>
      `;
    }
  });
}
