// ============================================================================
// Motorola Happy Calling - Multi-Select Checkbox Dropdown Component
// Reusable UI component with search, select-all/clear, and badge counts
// ============================================================================

import { escapeHtml } from "../js/utils.js";

/**
 * Initializes an enterprise multi-select checkbox dropdown
 * @param {Object} config
 * @param {HTMLElement} config.container - Mount element
 * @param {string} config.labelPrefix - Prefix for label (e.g. "Region")
 * @param {string} config.defaultPlaceholder - Text when nothing or all selected (e.g. "All Regions")
 * @param {Array<string>} config.options - List of option strings
 * @param {Array<string>|Set<string>} config.selected - Initially selected options
 * @param {Function} config.onChange - Callback with array of selected values
 * @returns {Object} Controller with getSelected(), setSelected(), reset(), setOptions(), destroy()
 */
export function initMultiSelectDropdown({
  container,
  labelPrefix = "Region",
  defaultPlaceholder = "All Regions",
  options = [],
  selected = [],
  onChange = () => {},
}) {
  if (!container) return null;

  let currentOptions = [...options];
  let selectedSet = new Set(selected ? Array.from(selected) : []);
  let isOpen = false;

  const instanceId = `ms_${Math.random().toString(36).substring(2, 9)}`;

  function updateTriggerText() {
    const triggerLabel = container.querySelector(".trigger-label");
    const triggerCount = container.querySelector(".trigger-count");
    if (!triggerLabel) return;

    if (selectedSet.size === 0) {
      triggerLabel.textContent = `${labelPrefix}: ${defaultPlaceholder}`;
      if (triggerCount) triggerCount.style.display = "none";
    } else if (selectedSet.size === 1) {
      const val = Array.from(selectedSet)[0];
      triggerLabel.textContent = `${labelPrefix}: ${val}`;
      if (triggerCount) triggerCount.style.display = "none";
    } else if (selectedSet.size === currentOptions.length && currentOptions.length > 1) {
      triggerLabel.textContent = `${labelPrefix}: All Selected`;
      if (triggerCount) {
        triggerCount.textContent = `${selectedSet.size}`;
        triggerCount.style.display = "inline-block";
      }
    } else {
      const arr = Array.from(selectedSet);
      if (arr.length <= 2) {
        triggerLabel.textContent = `${labelPrefix}: ${arr.join(", ")}`;
      } else {
        triggerLabel.textContent = `${labelPrefix}: ${arr.slice(0, 2).join(", ")} +${arr.length - 2}`;
      }
      if (triggerCount) {
        triggerCount.textContent = `${selectedSet.size}`;
        triggerCount.style.display = "inline-block";
      }
    }
  }

  function renderOptionsList(filterQuery = "") {
    const listEl = container.querySelector(".multi-select-options");
    if (!listEl) return;

    const query = filterQuery.toLowerCase().trim();
    const visibleOptions = query
      ? currentOptions.filter((opt) => opt.toLowerCase().includes(query))
      : currentOptions;

    if (visibleOptions.length === 0) {
      listEl.innerHTML = `
        <div style="padding:0.75rem 0.5rem; text-align:center; font-size:0.75rem; color:var(--text-tertiary);">
          No matching options found
        </div>
      `;
      return;
    }

    listEl.innerHTML = visibleOptions
      .map((opt) => {
        const isChecked = selectedSet.has(opt);
        const optId = `${instanceId}_opt_${opt.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        return `
          <label class="multi-select-option">
            <input type="checkbox" id="${optId}" value="${escapeHtml(opt)}" ${isChecked ? "checked" : ""}>
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(opt)}</span>
          </label>
        `;
      })
      .join("");

    listEl.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
      chk.addEventListener("change", (e) => {
        const val = e.target.value;
        if (e.target.checked) {
          selectedSet.add(val);
        } else {
          selectedSet.delete(val);
        }
        updateTriggerText();
        onChange(Array.from(selectedSet));
      });
    });
  }

  function renderComponent() {
    container.innerHTML = `
      <div class="multi-select-container" id="${instanceId}">
        <button type="button" class="multi-select-trigger" aria-haspopup="true" aria-expanded="false">
          <span class="trigger-label">${labelPrefix}: ${defaultPlaceholder}</span>
          <span class="trigger-count" style="display:none;">0</span>
          <svg style="width:12px; height:12px; flex-shrink:0; margin-left:auto; transition:transform 0.15s ease;" class="trigger-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>

        <div class="multi-select-dropdown">
          <div class="multi-select-actions">
            <span style="font-weight:600; color:var(--text-secondary); font-size:0.75rem;">Select ${labelPrefix}</span>
            <div style="display:flex; gap:0.5rem;">
              <button type="button" class="multi-select-action-btn btn-select-all">Select All</button>
              <button type="button" class="multi-select-action-btn btn-clear-all" style="color:var(--text-tertiary);">Clear</button>
            </div>
          </div>

          ${
            currentOptions.length > 5
              ? `<input type="text" class="multi-select-search" placeholder="Filter ${labelPrefix.toLowerCase()}..." autocomplete="off">`
              : ""
          }

          <div class="multi-select-options"></div>
        </div>
      </div>
    `;

    updateTriggerText();
    renderOptionsList();

    const triggerBtn = container.querySelector(".multi-select-trigger");
    const dropdownEl = container.querySelector(".multi-select-dropdown");
    const caretEl = container.querySelector(".trigger-caret");
    const searchInput = container.querySelector(".multi-select-search");
    const selectAllBtn = container.querySelector(".btn-select-all");
    const clearBtn = container.querySelector(".btn-clear-all");

    function openDropdown() {
      // Close other open multi-selects first
      document.querySelectorAll(".multi-select-dropdown.open").forEach((el) => {
        if (el !== dropdownEl) el.classList.remove("open");
      });
      dropdownEl.classList.add("open");
      triggerBtn.setAttribute("aria-expanded", "true");
      if (caretEl) caretEl.style.transform = "rotate(180deg)";
      isOpen = true;

      // Smart alignment: if trigger button is near right viewport edge, align to right: 0
      const rect = triggerBtn.getBoundingClientRect();
      const dropdownWidth = 260;
      if (rect.right + 20 > window.innerWidth || rect.left + dropdownWidth > window.innerWidth) {
        dropdownEl.style.left = "auto";
        dropdownEl.style.right = "0";
      } else {
        dropdownEl.style.left = "0";
        dropdownEl.style.right = "auto";
      }

      if (searchInput) {
        searchInput.value = "";
        renderOptionsList("");
        setTimeout(() => searchInput.focus(), 50);
      }
    }

    function closeDropdown() {
      dropdownEl.classList.remove("open");
      triggerBtn.setAttribute("aria-expanded", "false");
      if (caretEl) caretEl.style.transform = "rotate(0deg)";
      isOpen = false;
    }

    triggerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isOpen) {
        closeDropdown();
      } else {
        openDropdown();
      }
    });

    // Stop propagation inside dropdown to prevent closing on checkbox clicks
    dropdownEl.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        renderOptionsList(e.target.value);
      });
    }

    selectAllBtn?.addEventListener("click", () => {
      currentOptions.forEach((opt) => selectedSet.add(opt));
      container.querySelectorAll('.multi-select-options input[type="checkbox"]').forEach((chk) => {
        chk.checked = true;
      });
      updateTriggerText();
      onChange(Array.from(selectedSet));
    });

    clearBtn?.addEventListener("click", () => {
      selectedSet.clear();
      container.querySelectorAll('.multi-select-options input[type="checkbox"]').forEach((chk) => {
        chk.checked = false;
      });
      updateTriggerText();
      onChange([]);
    });
  }

  renderComponent();

  // Document click listener to close on outside clicks
  function handleDocumentClick(e) {
    if (!container.contains(e.target)) {
      const dropdownEl = container.querySelector(".multi-select-dropdown");
      const triggerBtn = container.querySelector(".multi-select-trigger");
      const caretEl = container.querySelector(".trigger-caret");
      if (dropdownEl && dropdownEl.classList.contains("open")) {
        dropdownEl.classList.remove("open");
        triggerBtn?.setAttribute("aria-expanded", "false");
        if (caretEl) caretEl.style.transform = "rotate(0deg)";
        isOpen = false;
      }
    }
  }

  function handleDocumentKeydown(e) {
    if (e.key === "Escape" && isOpen) {
      const dropdownEl = container.querySelector(".multi-select-dropdown");
      const triggerBtn = container.querySelector(".multi-select-trigger");
      const caretEl = container.querySelector(".trigger-caret");
      if (dropdownEl) {
        dropdownEl.classList.remove("open");
        triggerBtn?.setAttribute("aria-expanded", "false");
        if (caretEl) caretEl.style.transform = "rotate(0deg)";
        isOpen = false;
        triggerBtn?.focus();
      }
    }
  }

  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleDocumentKeydown);

  return {
    getSelected: () => Array.from(selectedSet),
    setSelected: (newValues) => {
      selectedSet = new Set(newValues || []);
      updateTriggerText();
      container.querySelectorAll('.multi-select-options input[type="checkbox"]').forEach((chk) => {
        chk.checked = selectedSet.has(chk.value);
      });
    },
    reset: () => {
      selectedSet.clear();
      updateTriggerText();
      container.querySelectorAll('.multi-select-options input[type="checkbox"]').forEach((chk) => {
        chk.checked = false;
      });
    },
    setOptions: (newOptions) => {
      currentOptions = [...newOptions];
      // Keep only selected items that still exist in newOptions
      const validSet = new Set(newOptions);
      selectedSet = new Set(Array.from(selectedSet).filter((v) => validSet.has(v)));
      renderComponent();
    },
    destroy: () => {
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleDocumentKeydown);
    },
  };
}
