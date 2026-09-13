// ============================================================================
// KPI Card Component
// ============================================================================

export function renderKpiCard({ title, value, icon, colorScheme = "blue", subtitle = "", id = "" }) {
  return `
    <div class="kpi-card" ${id ? `id="${id}"` : ""}>
      <div class="kpi-card-header">
        <span class="kpi-card-title">${title}</span>
        <div class="kpi-icon-badge ${colorScheme}">
          <span style="display:block; width:20px; height:20px;">${icon}</span>
        </div>
      </div>
      <div class="kpi-card-value">${value}</div>
      ${subtitle ? `<div class="kpi-card-footer">${subtitle}</div>` : ""}
    </div>
  `;
}
