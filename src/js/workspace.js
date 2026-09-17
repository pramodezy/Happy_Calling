// ============================================================================
// Motorola Care - Workspace State Manager
// Switches between "happy" (Happy Calling) and "intimation" (Intimation Calling)
// ============================================================================

import { isAdmin, hasAdminOrBsmAccess } from "./auth.js";

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

  const isExec = hasAdminOrBsmAccess();
  if (workspace === "intimation") {
    window.location.hash = isExec ? "#/intimation/admin" : "#/intimation/dashboard";
  } else {
    window.location.hash = isExec ? "#/admin" : "#/dashboard";
  }
}
