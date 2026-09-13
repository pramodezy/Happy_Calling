// ============================================================================
// KPI Card Component
// ============================================================================

export function renderKpiCard({ title, value, icon, colorScheme = "blue", subtitle = "", id = "" }) {
  // Ensure icon is never the literal string 'undefined'
  const safeIcon = icon && icon !== "undefined" ? icon : "";
  // Ensure value is never 'undefined' or null
  const safeValue = value !== undefined && value !== null && value !== "undefined" && value !== "undefined%" ? value : "0";
  // Ensure subtitle does not contain 'undefined'
  const safeSubtitle = subtitle && !subtitle.includes("undefined") ? subtitle : "";

  return `
    <div class="kpi-card" ${id ? `id="${id}"` : ""}>
      <div class="kpi-card-header">
        <span class="kpi-card-title">${title || ""}</span>
        <div class="kpi-icon-badge ${colorScheme}">
          <span style="display:block; width:20px; height:20px;">${safeIcon}</span>
        </div>
      </div>
      <div class="kpi-card-value">${safeValue}</div>
      ${safeSubtitle ? `<div class="kpi-card-footer">${safeSubtitle}</div>` : ""}
    </div>
  `;
}
