// ============================================================================
// Toast Notification Component
// ============================================================================

import { icons } from "../js/utils.js";

const TOAST_DURATION = 4000;

export function showToast(message, type = "info", duration = TOAST_DURATION) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  let iconHtml = icons.checkCircle;
  if (type === "error") iconHtml = icons.close;
  if (type === "warning") iconHtml = icons.clock;

  toast.innerHTML = `
    <div style="flex-shrink:0; color:inherit; width:20px; height:20px;">
      ${iconHtml}
    </div>
    <div style="flex:1; line-height: 1.4;">${message}</div>
    <button type="button" style="color:var(--text-tertiary); font-size:16px; margin-left:8px; line-height:1;" aria-label="Close">
      &times;
    </button>
  `;

  const closeBtn = toast.querySelector("button");
  const removeToast = () => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    toast.style.transition = "all 0.2s ease";
    setTimeout(() => toast.remove(), 200);
  };

  closeBtn.addEventListener("click", removeToast);
  const timer = setTimeout(removeToast, duration);

  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => setTimeout(removeToast, 2000));

  container.appendChild(toast);
}
