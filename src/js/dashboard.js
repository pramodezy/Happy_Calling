// ============================================================================
// CCI Dashboard View Controller
// ============================================================================

import { supabase, formatSupabaseError } from "./supabase.js";
import { getCurrentProfile } from "./auth.js";
import { icons } from "./utils.js";
import { renderKpiCard } from "../components/kpi-card.js";
import { renderSpinner } from "../components/loading.js";
import Chart from "chart.js/auto";

let trendChartInstance = null;
let feedbackChartInstance = null;
let ratingChartInstance = null;
let currentTimeframe = "ALL";

export async function renderDashboardPage(container) {
  const profile = getCurrentProfile();
  if (!profile) return;

  container.innerHTML = `
    <!-- Top Action Hero Banner -->
    <div class="hero-action-panel">
      <div class="hero-action-content">
        <h2>${profile.cci_name || profile.cci_code || "CCI Partner"} Portal</h2>
        <p>Motorola Post-Service Satisfaction & Happy Calling Workflow. Promptly resolve pending customer calls to maintain 95%+ completion standards.</p>
      </div>
      <div>
        <a href="#/happy-calling" class="btn-hero-calling" id="hero-btn-start-calling">
          <span style="display:inline-block; width:22px; height:22px;">${icons.phone}</span>
          <span>Start Happy Calling</span>
        </a>
      </div>
    </div>

    <!-- Timeframe Filter Selector -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:0.75rem;">
      <h3 style="font-size:1.125rem; font-weight:700; color:var(--text-primary);">Operational Performance</h3>
      <div style="display:flex; background:var(--bg-surface); border:1px solid var(--border-medium); border-radius:var(--radius-md); padding:2px;">
        <button type="button" class="timeframe-tab-btn ${currentTimeframe === "TODAY" ? "active" : ""}" data-timeframe="TODAY" style="padding:6px 14px; font-size:0.8125rem; font-weight:600; border-radius:6px;">Today</button>
        <button type="button" class="timeframe-tab-btn ${currentTimeframe === "THIS_WEEK" ? "active" : ""}" data-timeframe="THIS_WEEK" style="padding:6px 14px; font-size:0.8125rem; font-weight:600; border-radius:6px;">This Week</button>
        <button type="button" class="timeframe-tab-btn ${currentTimeframe === "THIS_MONTH" ? "active" : ""}" data-timeframe="THIS_MONTH" style="padding:6px 14px; font-size:0.8125rem; font-weight:600; border-radius:6px;">This Month</button>
        <button type="button" class="timeframe-tab-btn ${currentTimeframe === "ALL" ? "active" : ""}" data-timeframe="ALL" style="padding:6px 14px; font-size:0.8125rem; font-weight:600; border-radius:6px;">All Time</button>
      </div>
    </div>

    <!-- KPI Cards Grid -->
    <div id="dashboard-kpi-grid" class="kpi-grid">
      ${renderSpinner("Calculating live KPIs from Supabase...")}
    </div>

    <!-- Charts Row 1: Daily Completion Trend & Feedback Distribution -->
    <div class="dashboard-row">
      <div class="chart-card">
        <div class="chart-card-header">
          <span class="chart-card-title">Daily Call Completion Trend (Last 7 Days)</span>
        </div>
        <div class="chart-container-relative">
          <canvas id="canvas-daily-trend"></canvas>
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-card-header">
          <span class="chart-card-title">Customer Feedback Split</span>
        </div>
        <div class="chart-container-relative">
          <canvas id="canvas-feedback-split"></canvas>
        </div>
      </div>
    </div>

    <!-- Charts Row 2: Pending Ageing & Rating Distribution -->
    <div class="dashboard-row equal">
      <div class="chart-card">
        <div class="chart-card-header">
          <span class="chart-card-title">Pending Calls Ageing Breakdown</span>
          <a href="#/pending" style="font-size:0.8125rem; font-weight:600;">View Pending List &rarr;</a>
        </div>
        <div id="ageing-breakdown-container" class="ageing-list">
          ${renderSpinner("Loading ageing distribution...")}
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-card-header">
          <span class="chart-card-title">Customer Rating Distribution (1 to 10)</span>
        </div>
        <div class="chart-container-relative">
          <canvas id="canvas-rating-dist"></canvas>
        </div>
      </div>
    </div>
  `;

  // Attach timeframe events
  container.querySelectorAll(".timeframe-tab-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      container.querySelectorAll(".timeframe-tab-btn").forEach((b) => {
        b.classList.remove("active");
        b.style.background = "none";
        b.style.color = "var(--text-secondary)";
      });
      const target = e.currentTarget;
      target.classList.add("active");
      target.style.background = "var(--moto-blue-accent)";
      target.style.color = "#ffffff";
      currentTimeframe = target.getAttribute("data-timeframe");
      loadDashboardMetrics();
    });
  });

  // Highlight default timeframe button
  const initialBtn = container.querySelector(`[data-timeframe="${currentTimeframe}"]`);
  if (initialBtn) {
    initialBtn.style.background = "var(--moto-blue-accent)";
    initialBtn.style.color = "#ffffff";
  }

  await loadDashboardMetrics();
}

/**
 * Fetch fresh data via RPC and update charts & KPI cards
 */
export async function loadDashboardMetrics() {
  const kpiGrid = document.getElementById("dashboard-kpi-grid");
  const ageingContainer = document.getElementById("ageing-breakdown-container");
  if (!kpiGrid) return;

  const profile = getCurrentProfile() || {};

  try {
    const { data, error } = await supabase.rpc("get_cci_dashboard", {
      p_timeframe: currentTimeframe,
    });

    if (error) throw error;
    if (!data) return;

    // Render 8 Required KPI Cards:
    // 1. Total Closures
    // 2. Completed Calls
    // 3. Pending Calls
    // 4. Completion %
    // 5. Happy %
    // 6. Neutral %
    // 7. Unhappy %
    // 8. Average Rating
    const totalClosures = Number(data.total_closures) || 0;
    const completedCalls = Number(data.completed_calls) || 0;
    const pendingCalls = Number(data.pending_calls) || 0;
    const completionRate = data.completion_rate !== undefined && data.completion_rate !== null ? data.completion_rate : 0;
    const happyRate = data.happy_rate !== undefined && data.happy_rate !== null ? data.happy_rate : 0;
    const neutralRate = data.neutral_rate !== undefined && data.neutral_rate !== null ? data.neutral_rate : 0;
    const unhappyRate = data.unhappy_rate !== undefined && data.unhappy_rate !== null ? data.unhappy_rate : 0;
    const happyCount = Number(data.happy_count) || 0;
    const neutralCount = Number(data.neutral_count) || 0;
    const unhappyCount = Number(data.unhappy_count) || 0;
    const avgRating = data.avg_rating !== undefined && data.avg_rating !== null ? data.avg_rating : 0;

    // Fetch survey confirmation metrics for this scope
    let surveyReceivedRate = 0;
    let surveySubmittedRate = 0;
    let surveyReceivedCount = 0;
    let surveySubmittedCount = 0;

    try {
      let sq = supabase
        .from("happy_calling")
        .select("survey_email_received, survey_submitted")
        .eq("calling_status", "Completed");

      if (!isAdmin() && profile.cci_code) {
        sq = sq.eq("cci_code", profile.cci_code);
      }

      const { data: sRows, error: sErr } = await sq;
      if (!sErr && sRows && sRows.length > 0) {
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
      // safe fallback if columns not yet migrated
    }

    kpiGrid.innerHTML = `
      ${renderKpiCard({
        title: "Total Closures",
        value: totalClosures.toLocaleString(),
        icon: icons.database,
        colorScheme: "blue",
        subtitle: "Motorola Closed Jobs",
      })}
      ${renderKpiCard({
        title: "Completed Calls",
        value: completedCalls.toLocaleString(),
        icon: icons.checkCircle,
        colorScheme: "green",
        subtitle: "Verified Happy Calls",
      })}
      ${renderKpiCard({
        title: "Pending Calls",
        value: pendingCalls.toLocaleString(),
        icon: icons.clock,
        colorScheme: "amber",
        subtitle: "Awaiting Feedback",
      })}
      ${renderKpiCard({
        title: "Completion %",
        value: `${completionRate}%`,
        icon: icons.award,
        colorScheme: Number(completionRate) >= 90 ? "green" : "purple",
        subtitle: "Target: 95%+",
      })}
      ${renderKpiCard({
        title: "Survey Email %",
        value: `${surveyReceivedRate}%`,
        icon: icons.mail,
        colorScheme: "blue",
        subtitle: `${surveyReceivedCount.toLocaleString()} Received Email`,
      })}
      ${renderKpiCard({
        title: "Survey Complete %",
        value: `${surveySubmittedRate}%`,
        icon: icons.clipboardCheck || icons.checkCircle,
        colorScheme: "green",
        subtitle: `${surveySubmittedCount.toLocaleString()} Surveys Submitted`,
      })}
      ${renderKpiCard({
        title: "Happy %",
        value: `${happyRate}%`,
        icon: icons.smile,
        colorScheme: "green",
        subtitle: `${happyCount.toLocaleString()} Happy Customers`,
      })}
      ${renderKpiCard({
        title: "Neutral %",
        value: `${neutralRate}%`,
        icon: icons.meh,
        colorScheme: "blue",
        subtitle: `${neutralCount.toLocaleString()} Neutral Feedback`,
      })}
      ${renderKpiCard({
        title: "Unhappy %",
        value: `${unhappyRate}%`,
        icon: icons.frown,
        colorScheme: "red",
        subtitle: `${unhappyCount.toLocaleString()} Dissatisfied (DSAT)`,
      })}
      ${renderKpiCard({
        title: "Average Rating",
        value: `${avgRating} <span style="font-size:1.1rem; color:var(--text-tertiary);">/10</span>`,
        icon: icons.award,
        colorScheme: Number(avgRating) >= 8 ? "green" : "amber",
        subtitle: "Customer CSAT Score",
      })}
    `;

    // Render Ageing breakdown
    const ageing = data.ageing || {};
    const totalPending = data.pending_calls || 1;
    if (ageingContainer) {
      ageingContainer.innerHTML = `
        <div class="ageing-item">
          <div class="ageing-label-row">
            <span>Today (0 Days)</span>
            <strong>${ageing.today || 0} (${Math.round(((ageing.today || 0) / totalPending) * 100)}%)</strong>
          </div>
          <div class="ageing-progress-track">
            <div class="ageing-progress-fill green" style="width: ${((ageing.today || 0) / totalPending) * 100}%;"></div>
          </div>
        </div>

        <div class="ageing-item">
          <div class="ageing-label-row">
            <span>1 Day Ageing</span>
            <strong>${ageing.day1 || 0} (${Math.round(((ageing.day1 || 0) / totalPending) * 100)}%)</strong>
          </div>
          <div class="ageing-progress-track">
            <div class="ageing-progress-fill yellow" style="width: ${((ageing.day1 || 0) / totalPending) * 100}%;"></div>
          </div>
        </div>

        <div class="ageing-item">
          <div class="ageing-label-row">
            <span>2 Days Ageing</span>
            <strong>${ageing.day2 || 0} (${Math.round(((ageing.day2 || 0) / totalPending) * 100)}%)</strong>
          </div>
          <div class="ageing-progress-track">
            <div class="ageing-progress-fill orange" style="width: ${((ageing.day2 || 0) / totalPending) * 100}%;"></div>
          </div>
        </div>

        <div class="ageing-item">
          <div class="ageing-label-row">
            <span>3+ Days Critical Ageing</span>
            <strong style="color:var(--status-danger-dot);">${ageing.day3plus || 0} (${Math.round(((ageing.day3plus || 0) / totalPending) * 100)}%)</strong>
          </div>
          <div class="ageing-progress-track">
            <div class="ageing-progress-fill red" style="width: ${((ageing.day3plus || 0) / totalPending) * 100}%;"></div>
          </div>
        </div>
      `;
    }

    // Render Charts
    renderDailyTrendChart(data.daily_trend || []);
    renderFeedbackChart(data.happy_count, data.neutral_count, data.unhappy_count);
    renderRatingDistributionChart(data.rating_distribution || []);
  } catch (err) {
    console.error("loadDashboardMetrics error:", err);
    kpiGrid.innerHTML = `
      <div style="grid-column: 1 / -1; padding:1.5rem; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; color:#991b1b;">
        <strong>Error loading metrics:</strong> ${formatSupabaseError(err)}
      </div>
    `;
  }
}

function renderDailyTrendChart(trendData) {
  const ctx = document.getElementById("canvas-daily-trend")?.getContext("2d");
  if (!ctx) return;

  if (trendChartInstance) trendChartInstance.destroy();

  const labels = trendData.map((d) => d.day_label);
  const counts = trendData.map((d) => d.completed_count);

  trendChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Completed Calls",
          data: counts,
          borderColor: "#0072ce",
          backgroundColor: "rgba(0, 114, 206, 0.08)",
          fill: true,
          tension: 0.35,
          pointRadius: 5,
          pointHoverRadius: 7,
          pointBackgroundColor: "#0072ce",
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
        x: {
          grid: { display: false },
        },
      },
    },
  });
}

function renderFeedbackChart(happy, neutral, unhappy) {
  const ctx = document.getElementById("canvas-feedback-split")?.getContext("2d");
  if (!ctx) return;

  if (feedbackChartInstance) feedbackChartInstance.destroy();

  const hasData = happy + neutral + unhappy > 0;

  feedbackChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Happy", "Neutral", "Unhappy"],
      datasets: [
        {
          data: hasData ? [happy, neutral, unhappy] : [1, 0, 0],
          backgroundColor: hasData
            ? ["#10b981", "#94a3b8", "#ef4444"]
            : ["#e2e8f0", "#e2e8f0", "#e2e8f0"],
          borderWidth: 2,
          borderColor: "#ffffff",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: { boxWidth: 14, font: { size: 12 } },
        },
      },
      cutout: "68%",
    },
  });
}

function renderRatingDistributionChart(ratingsData) {
  const ctx = document.getElementById("canvas-rating-dist")?.getContext("2d");
  if (!ctx) return;

  if (ratingChartInstance) ratingChartInstance.destroy();

  const labels = ratingsData.map((r) => `${r.rating}★`);
  const values = ratingsData.map((r) => r.count);

  ratingChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Customers",
          data: values,
          backgroundColor: ratingsData.map((r) => {
            if (r.rating >= 8) return "#10b981";
            if (r.rating >= 5) return "#f59e0b";
            return "#ef4444";
          }),
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
        x: {
          grid: { display: false },
        },
      },
    },
  });
}
