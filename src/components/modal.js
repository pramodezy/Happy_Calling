// ============================================================================
// Modal Component
// ============================================================================

import { icons } from "../js/utils.js";

let activeModalOverlay = null;

export function openModal({ title, contentHtml, footerHtml = "", onClose = null, size = "normal" }) {
  closeModal();

  const container = document.getElementById("modal-container");
  if (!container) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay active";
  overlay.id = "app-modal-overlay";

  const maxWidthStyle = size === "large" ? "max-width: 850px;" : size === "small" ? "max-width: 420px;" : "max-width: 600px;";

  overlay.innerHTML = `
    <div class="modal-dialog" style="${maxWidthStyle}">
      <div class="modal-header">
        <h3 class="modal-title">${title}</h3>
        <button type="button" class="modal-close-btn" style="color:var(--text-tertiary); padding:4px;" aria-label="Close modal">
          <span style="display:block; width:20px; height:20px;">${icons.close}</span>
        </button>
      </div>
      <div class="modal-body">
        ${contentHtml}
      </div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ""}
    </div>
  `;

  const closeBtn = overlay.querySelector(".modal-close-btn");
  closeBtn.addEventListener("click", () => {
    closeModal();
    if (typeof onClose === "function") onClose();
  });

  // Close on backdrop click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      closeModal();
      if (typeof onClose === "function") onClose();
    }
  });

  // Close on Escape key
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      closeModal();
      if (typeof onClose === "function") onClose();
      document.removeEventListener("keydown", onKeyDown);
    }
  };
  document.addEventListener("keydown", onKeyDown);

  container.appendChild(overlay);
  activeModalOverlay = overlay;

  return overlay;
}

export function closeModal() {
  if (activeModalOverlay) {
    activeModalOverlay.classList.remove("active");
    setTimeout(() => {
      if (activeModalOverlay) {
        activeModalOverlay.remove();
        activeModalOverlay = null;
      }
    }, 150);
  }
}

/**
 * Confirmation Dialog Promise Helper
 */
export function confirmDialog({ title, message, confirmText = "Confirm", cancelText = "Cancel", isDanger = false }) {
  return new Promise((resolve) => {
    const footerHtml = `
      <button type="button" class="btn-secondary modal-cancel-btn">${cancelText}</button>
      <button type="button" class="btn-primary ${isDanger ? "btn-danger" : ""} modal-confirm-btn" ${isDanger ? 'style="background:var(--status-danger-dot);"' : ""}>
        ${confirmText}
      </button>
    `;

    const overlay = openModal({
      title,
      contentHtml: `<p style="font-size:0.95rem; color:var(--text-secondary); line-height:1.5;">${message}</p>`,
      footerHtml,
      size: "small",
      onClose: () => resolve(false),
    });

    if (overlay) {
      overlay.querySelector(".modal-cancel-btn")?.addEventListener("click", () => {
        closeModal();
        resolve(false);
      });
      overlay.querySelector(".modal-confirm-btn")?.addEventListener("click", () => {
        closeModal();
        resolve(true);
      });
    }
  });
}
