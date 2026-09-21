// ============================================================================
// Admin: Customer Feedback & CSAT Sentiment Analysis Controller
// Route: #/admin/feedback
// ============================================================================

import { supabase, formatSupabaseError, subscribeToTable, unsubscribeChannel } from "./supabase.js";
import { icons, escapeHtml, renderRatingBadge, renderFeedbackBadge, formatDateTime } from "./utils.js";
import { renderKpiCard } from "../components/kpi-card.js";
import { renderSpinner } from "../components/loading.js";
import Chart from "chart.js/auto";

let feedbackDonutChart = null;
let ratingDistChart = null;
let feedbackRecords = [];
let searchQuery = "";
let filterCategory = "ALL";
let filterRating = "ALL";

export async function renderAdminFeedbackPage(container) {
  searchQuery = "";
  filterCategory = "ALL";
  filterRating = "ALL";

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
        <button type="button" id="btn-export-feedback-csv" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.download}</span>
          <span>Export Feedback CSV</span>
        </button>
        <a href="#/admin" class="btn-secondary" style="padding:7px 14px; font-size:0.8125rem; display:flex; align-items:center; gap:0.35rem;">
          <span style="width:16px; height:16px;">${icons.dashboard}</span>
          <span>Overview</span>
        </a>
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
          <h3 class="table-card-title">Customer Feedback Verbatim & Logs</h3>
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
        </div>
      </div>

      <div class="table-responsive-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date & Time</th>
              <th>SO & Closure ID</th>
              <th>CCI Station</th>
              <th>Rating</th>
              <th>Sentiment</th>
              <th>Survey Status</th>
              <th style="min-width:240px;">Customer Remarks</th>
              <th>Calling Status</th>
            </tr>
          </thead>
          <tbody id="feedback-table-body">
            <tr><td colspan="8">${renderSpinner("Loading customer feedback records...")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Attach event listeners
  document.getElementById("feedback-search-input")?.addEventListener("input", (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderFilteredFeedbackTable();
  });

  document.getElementById("feedback-category-filter")?.addEventListener("change", (e) => {
    filterCategory = e.target.value;
    renderFilteredFeedbackTable();
  });

  document.getElementById("feedback-rating-filter")?.addEventListener("change", (e) => {
    filterRating = e.target.value;
    renderFilteredFeedbackTable();
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

  try {
    const { data: dashData, error: dashErr } = await supabase.rpc("get_admin_dashboard");
    if (dashErr) throw dashErr;

    const happyCount = Number(dashData?.happy_count) || 0;
    const neutralCount = Number(dashData?.neutral_count) || 0;
    const unhappyCount = Number(dashData?.unhappy_count) || 0;
    const completedCalls = Number(dashData?.completed_calls) || (happyCount + neutralCount + unhappyCount);
    const happyRate = dashData?.happy_rate || (completedCalls > 0 ? Math.round((happyCount / completedCalls) * 100) : 0);
    const avgRating = dashData?.avg_rating || 0;

    kpiMount.innerHTML = `
      ${renderKpiCard({
        title: "Happy Delighted %",
        value: `${happyRate}%`,
        icon: icons.smile,
        colorScheme: "green",
        subtitle: "Delighted Customer Benchmark",
      })}
      ${renderKpiCard({
        title: "Average CSAT",
        value: `${avgRating} <span style="font-size:1.1rem; color:var(--text-tertiary);">/10</span>`,
        icon: icons.award,
        colorScheme: Number(avgRating) >= 8 ? "green" : "blue",
        subtitle: "National CSAT Score",
      })}
      ${renderKpiCard({
        title: "Delighted Customers",
        value: happyCount.toLocaleString(),
        icon: icons.heart || icons.smile,
        colorScheme: "green",
        subtitle: "Positive Feedback",
      })}
      ${renderKpiCard({
        title: "Neutral Feedback",
        value: neutralCount.toLocaleString(),
        icon: icons.meh,
        colorScheme: "blue",
        subtitle: "Satisfied / Neutral",
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

    // Fetch recent calling records from happy_calling
    const { data: records, error: recErr } = await supabase
      .from("happy_calling")
      .select("id, closure_id, so_number, cci_code, cci_name, calling_date, calling_time, calling_status, customer_rating, feedback_category, customer_remarks, cci_remarks, survey_email_received, survey_submitted, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (recErr) throw recErr;
    feedbackRecords = records || [];
    renderFilteredFeedbackTable();
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

  // Create labels 1 to 10
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
    if (star >= 9) return "#10b981"; // Green
    if (star >= 7) return "#0072ce"; // Blue
    if (star >= 5) return "#f59e0b"; // Amber
    return "#ef4444"; // Red
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

function renderFilteredFeedbackTable() {
  const tbody = document.getElementById("feedback-table-body");
  if (!tbody) return;

  let filtered = [...feedbackRecords];

  if (searchQuery) {
    filtered = filtered.filter(
      (r) =>
        (r.so_number && r.so_number.toLowerCase().includes(searchQuery)) ||
        (r.closure_id && r.closure_id.toLowerCase().includes(searchQuery)) ||
        (r.cci_code && r.cci_code.toLowerCase().includes(searchQuery)) ||
        (r.cci_name && r.cci_name.toLowerCase().includes(searchQuery)) ||
        (r.customer_remarks && r.customer_remarks.toLowerCase().includes(searchQuery))
    );
  }

  if (filterCategory !== "ALL") {
    filtered = filtered.filter((r) => r.feedback_category === filterCategory);
  }

  if (filterRating === "TOP") {
    filtered = filtered.filter((r) => Number(r.customer_rating) >= 9);
  } else if (filterRating === "MID") {
    filtered = filtered.filter((r) => Number(r.customer_rating) >= 7 && Number(r.customer_rating) <= 8);
  } else if (filterRating === "LOW") {
    filtered = filtered.filter((r) => Number(r.customer_rating) < 7 && Number(r.customer_rating) > 0);
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center; padding:2rem; color:var(--text-tertiary);">
          No customer feedback records matching your criteria.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered
    .map((r) => {
      const remarks = r.customer_remarks
        ? `<div style="font-size:0.8125rem; color:var(--text-primary); font-style:italic;">"${escapeHtml(r.customer_remarks)}"</div>`
        : `<span style="color:var(--text-tertiary); font-size:0.75rem;">No remarks provided</span>`;

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

function exportFeedbackCsv() {
  if (!feedbackRecords || feedbackRecords.length === 0) return;

  const headers = ["Date", "SO Number", "Closure ID", "CCI Code", "CCI Name", "Rating", "Sentiment", "Survey Email Received", "Survey Submitted", "Customer Remarks", "Status"];
  const rows = feedbackRecords.map((r) => [
    `"${(r.calling_date || "").replace(/"/g, '""')}"`,
    `"${(r.so_number || "").replace(/"/g, '""')}"`,
    `"${(r.closure_id || "").replace(/"/g, '""')}"`,
    `"${(r.cci_code || "").replace(/"/g, '""')}"`,
    `"${(r.cci_name || "").replace(/"/g, '""')}"`,
    r.customer_rating,
    `"${(r.feedback_category || "").replace(/"/g, '""')}"`,
    `"${(r.survey_email_received || "").replace(/"/g, '""')}"`,
    `"${(r.survey_submitted || "").replace(/"/g, '""')}"`,
    `"${(r.customer_remarks || "").replace(/"/g, '""')}"`,
    `"${(r.calling_status || "").replace(/"/g, '""')}"`,
  ]);

  const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `motorola_feedback_logs_${new Date().toISOString().split("T")[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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
