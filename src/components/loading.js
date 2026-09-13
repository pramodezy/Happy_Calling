// ============================================================================
// Loading & Skeleton Components
// ============================================================================

export function renderSpinner(text = "Loading...") {
  return `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:3rem 1rem; color:var(--text-secondary); gap:0.75rem;">
      <div style="width:36px; height:36px; border:3px solid var(--border-medium); border-top-color:var(--moto-blue-accent); border-radius:50%; animation:spin 0.8s linear infinite;"></div>
      <div style="font-size:0.875rem; font-weight:500;">${text}</div>
      <style>
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      </style>
    </div>
  `;
}

export function renderTableSkeleton(rows = 5, cols = 6) {
  let rowsHtml = "";
  for (let r = 0; r < rows; r++) {
    let cellsHtml = "";
    for (let c = 0; c < cols; c++) {
      cellsHtml += `<td><div class="skeleton" style="height: 18px; width: ${60 + (c * 10) % 40}%;"></div></td>`;
    }
    rowsHtml += `<tr>${cellsHtml}</tr>`;
  }
  return rowsHtml;
}

export function renderKpiSkeleton(count = 4) {
  let cards = "";
  for (let i = 0; i < count; i++) {
    cards += `
      <div class="kpi-card">
        <div class="kpi-card-header">
          <div class="skeleton" style="height:14px; width:60%;"></div>
          <div class="skeleton" style="height:36px; width:36px; border-radius:8px;"></div>
        </div>
        <div class="skeleton" style="height:32px; width:45%; margin:8px 0;"></div>
        <div class="skeleton" style="height:12px; width:80%;"></div>
      </div>
    `;
  }
  return cards;
}
