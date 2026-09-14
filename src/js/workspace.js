// ============================================================================
// Motorola Care - Workspace State Manager
// Switches between "happy" (Happy Calling) and "intimation" (Intimation Calling)
// ============================================================================

import { isAdmin } from "./auth.js";

const WORKSPACE_STORAGE_KEY = "__MOTO_ACTIVE_WORKSPACE__";

export function getActiveWorkspace() {
  const hash = window.location.hash || "";
  if (hash.startsWith("#/intimation")) {
    return "intimation";
  }
  return localStorage.getItem(WORKSPACE_STORAGE_KEY) || "happy";
}

export function setActiveWorkspace(workspace) {
  if (workspace !== "happy" && workspace !== "intimation") {
    workspace = "happy";
  }
  localStorage.setItem(WORKSPACE_STORAGE_KEY, workspace);

  const admin = isAdmin();
  if (workspace === "intimation") {
    window.location.hash = admin ? "#/intimation/admin" : "#/intimation/calling";
  } else {
    window.location.hash = admin ? "#/admin" : "#/dashboard";
  }
}
