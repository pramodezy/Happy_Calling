// ============================================================================
// Intimation Calling Dashboard
// Overview of open calls ageing, SLA compliance, and customer ETR intimation
// ============================================================================

import { supabase, fetchAllRows } from "./supabase.js";
import { getCurrentProfile, isAdmin, isBSM, hasAdminOrBsmAccess } from "./auth.js";
import { icons, escapeHtml, formatDate, formatDateTime } from "./utils.js";
import { renderSpinner } from "../components/loading.js";

export async function renderIntimationDashboardPage(container) {
  const admin = isAdmin();
  const profile = getCurrentProfile() || {};

  container.innerHTML = `
    <!-- Header -->
    <div style="margin-bottom:1.75rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
      <div>
        <h2 style="font-size:1.375rem; font-weight:700; color:var(--text-primary);">Intimation Calling Dashboard</h2>
        <p style="font-size:0.875rem; color:var(--text-secondary);">
          Customer resolution intimation for Service Orders exceeding the 3-day turnaround threshold.
        </p>
      </div>
      <div style="display:flex; gap:0.75rem;">
        ${admin ? `
          <a href="#/intimation/import" class="btn-secondary">
            <span>${icons.upload}</span>
            <span>Upload Open Calls</span>
          </a>
        ` : ""}
        ${hasAdminOrBsmAccess() ? `
          <a href="#/intimation/admin" class="btn-secondary">
            <span>${icons.shield}</span>
            <span>${isBSM() ? "Regional Intimation" : "Intimation Admin"}</span>
          </a>
        ` : ""}
        <a href="#/intimation/calling" class="btn-primary">
          <span>${icons.phone}</span>
          <span>Start Calling Queue</span>
        </a>
      </div>
    </div>

    <!-- Hero CTA Card -->
    <div style="background:linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-radius:var(--radius-xl); padding:1.75rem 2rem; margin-bottom:2rem; color:#fff; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1.5rem; box-shadow:var(--shadow-md); border:1px solid rgba(255,255,255,0.1);">
      <div style="max-width:600px;">
        <div style="display:inline-flex; align-items:center; gap:0.5rem; background:rgba(239, 68, 68, 0.2); color:#fca5a5; padding:4px 10px; border-radius:20px; font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:0.75rem;">
          <span style="width:8px; height:8px; border-radius:50%; background:#ef4444; display:inline-block;"></span>
          Critical SLA Policy: Ageing &gt; 3 Days
        </div>
        <h3 style="font-size:1.4rem; font-weight:800; margin-bottom:0.5rem; color:#fff;">
          Customer ETR Intimation Workflow
        </h3>
        <p style="font-size:0.9rem; color:#cbd5e1; line-height:1.5; margin:0;">
          Service Orders carried-in over 3 days ago must be notified with an Expected Time of Resolution (ETR). Keep Motorola customers informed proactively.
        </p>
      </div>
      <div style="display:flex; flex-direction:column; gap:0.5rem; align-items:flex-end;">
        <a href="#/intimation/calling" class="btn-primary" style="background:#ef4444; border-color:#dc2626; color:#fff; font-size:1rem; padding:0.75rem 1.5rem; font-weight:700; box-shadow:0 4px 14px rgba(239,68,68,0.4);">
          <span>${icons.phone}</span>
          <span>Open Next Eligible Call</span>
        </a>
        <span style="font-size:0.75rem; color:#94a3b8;">Prioritizes oldest Carry-In dates first</span>
      </div>
    </div>

    <!-- Mount for dynamic metrics & backlog -->
    <div id="intimation-dashboard-metrics-mount">
      ${renderSpinner("Calculating open calls ageing metrics...")}
    </div>
  `;

  await loadIntimationDashboardData(container);
}

/**
 * Fetch and populate dashboard data
 */
async function loadIntimationDashboardData(container) {
  const mount = document.getElementById("intimation-dashboard-metrics-mount");
  if (!mount) return;

  const admin = isAdmin();
  const profile = getCurrentProfile() || {};
  const cciCode = profile.cci_code;

  try {
    const nowMs = Date.now();
    const threeDaysAgoIso = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgoIso = new Date(nowMs - 5 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgoIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Query 1: Open Calls base query - paginated to overcome PostgREST default 1,000-row limit
    const openCalls = await fetchAllRows((from, to) => {
      let q = supabase
        .from("open_calls_master")
        .select("id, service_order, carry_in_time, cci_code")
        .eq("is_open", true)
        .range(from, to);
      if (!hasAdminOrBsmAccess() && cciCode) {
        q = q.eq("cci_code", cciCode);
      }
      return q;
    });

    const totalOpen = (openCalls || []).length;
    let count3to5 = 0;
    let count5to7 = 0;
    let countOver7 = 0;
    let totalCriticalOver3d = 0;

    (openCalls || []).forEach((call) => {
      const carryMs = new Date(call.carry_in_time).getTime();
      const ageDays = (nowMs - carryMs) / (24 * 60 * 60 * 1000);
      if (ageDays > 3) {
        totalCriticalOver3d++;
        if (ageDays <= 5) count3to5++;
        else if (ageDays <= 7) count5to7++;
        else countOver7++;
      }
    });

    // Query 2: Intimation calling stats - paginated to ensure full coverage
    const intimations = await fetchAllRows((from, to) => {
      let q = supabase
        .from("intimation_calling")
        .select("id, service_order, etr_date, calling_status, created_at, cci_code")
        .range(from, to);
      if (!hasAdminOrBsmAccess() && cciCode) {
        q = q.eq("cci_code", cciCode);
      }
      return q;
    });

    const totalIntimated = (intimations || []).filter((i) => i.calling_status === "Completed").length;
    const pendingIntimationCount = Math.max(0, totalCriticalOver3d - totalIntimated);

    // Query 3: Recent intimations
    let recentQuery = supabase
      .from("intimation_calling")
      .select("id, service_order, etr_date, calling_status, cci_comment, created_at, cci_code")
      .order("created_at", { ascending: false })
      .limit(6);
    if (!hasAdminOrBsmAccess() && cciCode) {
      recentQuery = recentQuery.eq("cci_code", cciCode);
    }
    const { data: recentLogs } = await recentQuery;

    mount.innerHTML = `
      <!-- KPI Row -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:1.25rem; margin-bottom:2rem;">
        <div class="kpi-card">
          <div class="kpi-label">Active Open Inventory</div>
          <div class="kpi-value" style="color:var(--moto-blue-accent);">${totalOpen.toLocaleString()}</div>
          <div class="kpi-subtext">Total currently open service orders</div>
        </div>
        <div class="kpi-card" style="border-left:4px solid #ef4444;">
          <div class="kpi-label">Ageing &gt; 3 Days (Critical)</div>
          <div class="kpi-value" style="color:#ef4444;">${totalCriticalOver3d.toLocaleString()}</div>
          <div class="kpi-subtext">Mandatory customer intimation queue</div>
        </div>
        <div class="kpi-card" style="border-left:4px solid #10b981;">
          <div class="kpi-label">ETR Intimations Done</div>
          <div class="kpi-value" style="color:#10b981;">${totalIntimated.toLocaleString()}</div>
          <div class="kpi-subtext">Customers updated with resolution date</div>
        </div>
        <div class="kpi-card" style="border-left:4px solid #f59e0b;">
          <div class="kpi-label">Pending Intimations</div>
          <div class="kpi-value" style="color:#f59e0b;">${pendingIntimationCount.toLocaleString()}</div>
          <div class="kpi-subtext">Calls awaiting agent outreach</div>
        </div>
      </div>

      <!-- Ageing Buckets & Recent Activity -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); gap:1.5rem; margin-bottom:2rem;">
        <!-- Ageing Distribution Card -->
        <div class="call-feedback-form-card">
          <h3 style="font-size:1.1rem; font-weight:700; margin-bottom:0.25rem;">Ageing Distribution (&gt; 3 Days)</h3>
          <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:1.25rem;">
            Breakdown based on Carry-In Time
          </p>

          <div style="display:flex; flex-direction:column; gap:1.25rem;">
            <!-- 3 to 5 Days -->
            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">3 - 5 Days Ageing</span>
                <span style="font-weight:700; color:#f59e0b;">${count3to5} Calls</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${totalCriticalOver3d > 0 ? (count3to5 / totalCriticalOver3d) * 100 : 0}%; height:100%; background:#f59e0b;"></div>
              </div>
            </div>

            <!-- 5 to 7 Days -->
            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">5 - 7 Days Ageing</span>
                <span style="font-weight:700; color:#ea580c;">${count5to7} Calls</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${totalCriticalOver3d > 0 ? (count5to7 / totalCriticalOver3d) * 100 : 0}%; height:100%; background:#ea580c;"></div>
              </div>
            </div>

            <!-- > 7 Days -->
            <div>
              <div style="display:flex; justify-content:space-between; font-size:0.875rem; margin-bottom:0.25rem;">
                <span style="font-weight:600; color:var(--text-primary);">&gt; 7 Days (Severe Escalation)</span>
                <span style="font-weight:700; color:#dc2626;">${countOver7} Calls</span>
              </div>
              <div style="width:100%; height:8px; background:var(--border-subtle); border-radius:4px; overflow:hidden;">
                <div style="width:${totalCriticalOver3d > 0 ? (countOver7 / totalCriticalOver3d) * 100 : 0}%; height:100%; background:#dc2626;"></div>
              </div>
            </div>
          </div>

          <div style="margin-top:1.5rem; padding-top:1rem; border-top:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:0.8rem; color:var(--text-tertiary);">SLA Compliance Standard: 3 Days</span>
            <a href="#/intimation/pending" class="btn-secondary" style="font-size:0.8rem; padding:4px 10px;">
              <span>View Filtered List</span>
            </a>
          </div>
        </div>

        <!-- Recent Intimation Logs -->
        <div class="call-feedback-form-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
            <h3 style="font-size:1.1rem; font-weight:700;">Recent Customer Intimations</h3>
            <a href="#/intimation/history" style="font-size:0.8rem; color:var(--moto-blue-accent); font-weight:600;">View All &rarr;</a>
          </div>

          ${(!recentLogs || recentLogs.length === 0) ? `
            <div style="text-align:center; padding:2rem 1rem; color:var(--text-tertiary); font-size:0.875rem;">
              No customer intimations recorded yet.
            </div>
          ` : `
            <div style="display:flex; flex-direction:column; gap:0.75rem;">
              ${recentLogs.map((log) => `
                <div style="padding:0.75rem; background:var(--bg-surface-secondary); border-radius:var(--radius-md); border:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
                  <div>
                    <div style="font-weight:700; color:var(--text-primary); font-size:0.875rem;">
                      SO #${escapeHtml(log.service_order)}
                    </div>
                    <div style="font-size:0.75rem; color:var(--text-tertiary);">
                      Committed ETR: <strong>${formatDate(log.etr_date)}</strong> &bull; ${formatDateTime(log.created_at)}
                    </div>
                  </div>
                  <div>
                    <span class="badge" style="background:#dcfce7; color:#15803d; font-size:0.75rem;">
                      ${escapeHtml(log.calling_status)}
                    </span>
                  </div>
                </div>
              `).join("")}
            </div>
          `}
        </div>
      </div>
    `;
  } catch (err) {
    console.error("Dashboard calculation error:", err);
    mount.innerHTML = `
      <div style="padding:1.5rem; background:#fee2e2; border-radius:var(--radius-lg); color:#b91c1c;">
        <strong>Error loading dashboard:</strong> ${escapeHtml(err.message)}
      </div>
    `;
  }
}
