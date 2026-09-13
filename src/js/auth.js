// ============================================================================
// Motorola Happy Calling - Supabase Authentication & Profile Management
// ============================================================================

import { supabase, formatSupabaseError, isSupabaseConfigured } from "./supabase.js";

// Cached in-memory user profile
let currentUserProfile = null;
let currentAuthUser = null;
const authListeners = new Set();

/**
 * Register auth state change listener
 */
export function onAuthStateChanged(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function notifyAuthListeners() {
  authListeners.forEach((fn) => {
    try {
      fn(currentUserProfile, currentAuthUser);
    } catch (e) {
      console.error("Auth listener error:", e);
    }
  });
}

/**
 * Check and restore existing session on app startup
 */
export async function initializeAuth() {
  if (!isSupabaseConfigured() || !supabase) {
    return { authenticated: false, reason: "NOT_CONFIGURED" };
  }

  try {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      currentUserProfile = null;
      currentAuthUser = null;
      notifyAuthListeners();
      return { authenticated: false };
    }

    currentAuthUser = session.user;
    // Retrieve validated server-side profile
    const profile = await fetchCurrentUserProfile();
    notifyAuthListeners();
    return { authenticated: !!profile, user: currentAuthUser, profile };
  } catch (err) {
    console.error("Initialize Auth Error:", err);
    currentUserProfile = null;
    currentAuthUser = null;
    notifyAuthListeners();
    return { authenticated: false, error: err };
  }
}

/**
 * Fetch verified server-side user profile via get_current_user_profile() RPC
 * Never trust browser localStorage for role or CCI code!
 */
export async function fetchCurrentUserProfile() {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc("get_current_user_profile");
    if (error || !data) {
      console.warn("Could not retrieve user profile:", error);
      currentUserProfile = null;
      return null;
    }

    currentUserProfile = data;
    return currentUserProfile;
  } catch (err) {
    console.error("fetchCurrentUserProfile error:", err);
    currentUserProfile = null;
    return null;
  }
}

/**
 * Authenticate user with Username (e.g. cci_65) or Email & Password via Supabase Auth
 */
export async function loginWithEmail(identifier, password) {
  if (!isSupabaseConfigured() || !supabase) {
    throw new Error("Supabase is not configured. Please supply VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }

  const raw = identifier.trim();
  const candidates = [];

  if (raw.includes("@")) {
    candidates.push(raw);
  } else {
    // Support username format: 'cci_65', '65', 'BLR01', etc.
    const cleanCode = raw.toLowerCase().replace(/^(cci[_-]?)/i, "");
    candidates.push(`cci_${cleanCode}@cci.local`);
    candidates.push(`cci_${cleanCode}@happycalling.local`);
    candidates.push(`cci_${cleanCode}@motorolacare.in`);
    candidates.push(`${cleanCode}@motorolacare.in`);
    candidates.push(`${raw.toLowerCase()}@cci.local`);
  }

  let lastError = null;
  let authData = null;

  for (const candidateEmail of candidates) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: candidateEmail,
      password: password,
    });

    if (!error && data?.user) {
      authData = data;
      break;
    }
    lastError = error;
  }

  if (!authData) {
    throw new Error(formatSupabaseError(lastError || "Invalid username or password."));
  }

  currentAuthUser = authData.user;
  const profile = await fetchCurrentUserProfile();

  if (!profile) {
    await supabase.auth.signOut();
    throw new Error("Account authenticated, but no active Motorola user profile was found. Please contact an Administrator.");
  }

  if (profile.status !== "ACTIVE") {
    await supabase.auth.signOut();
    throw new Error("This account is currently deactivated. Please contact your Service Manager.");
  }

  // Insert Audit Log for login
  try {
    await supabase.from("audit_log").insert({
      user_id: currentAuthUser.id,
      role: profile.role,
      cci_code: profile.cci_code,
      action: "LOGIN",
      description: `User ${profile.user_name} (${profile.role}) logged in successfully.`,
      metadata: { email: currentAuthUser.email, timestamp: new Date().toISOString() },
    });
  } catch (auditErr) {
    console.warn("Audit log error:", auditErr);
  }

  notifyAuthListeners();
  return { user: currentAuthUser, profile };
}

/**
 * Logout current user and clear session
 */
export async function logoutUser() {
  if (!supabase) return;

  try {
    if (currentAuthUser && currentUserProfile) {
      await supabase.from("audit_log").insert({
        user_id: currentAuthUser.id,
        role: currentUserProfile.role,
        cci_code: currentUserProfile.cci_code,
        action: "LOGOUT",
        description: `User ${currentUserProfile.user_name} logged out.`,
      });
    }
  } catch (e) {
    // ignore audit failure on logout
  }

  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.error("Sign out error:", err);
  } finally {
    currentUserProfile = null;
    currentAuthUser = null;
    notifyAuthListeners();
  }
}

/**
 * Request password reset link via Supabase Auth
 */
export async function requestPasswordReset(email) {
  if (!supabase) throw new Error("Supabase not configured");
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: window.location.origin + window.location.pathname + "#/reset-password",
  });
  if (error) throw new Error(formatSupabaseError(error));
  return true;
}

/**
 * Get current cached profile
 */
export function getCurrentProfile() {
  return currentUserProfile;
}

/**
 * Get current Auth user
 */
export function getCurrentAuthUser() {
  return currentAuthUser;
}

/**
 * Check if current user is an Admin
 */
export function isAdmin() {
  return currentUserProfile && currentUserProfile.role === "ADMIN";
}

/**
 * Check if current user is a CCI User
 */
export function isCCIUser() {
  return currentUserProfile && currentUserProfile.role === "CCI_USER";
}
