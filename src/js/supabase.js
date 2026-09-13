// ============================================================================
// Motorola Happy Calling - Supabase Client Initialization & Realtime
// ============================================================================

import { createClient } from "@supabase/supabase-js";

// Retrieve environment variables configured at Vite build time, window, or localStorage
const getEnvVar = (key) => {
  try {
    if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env[key]) {
      return import.meta.env[key];
    }
  } catch (e) {}
  return null;
};

// Default Supabase project credentials for Motorola Happy Calling Portal
const DEFAULT_SUPABASE_URL = "https://fmvgnbaakgdbzbqgbmmh.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_H7JNZqFemNhOrq4ZQfhddA_lAx0h9MI";

const SUPABASE_URL =
  getEnvVar("VITE_SUPABASE_URL") ||
  window.__SUPABASE_URL__ ||
  localStorage.getItem("__MOTO_SU_URL__") ||
  DEFAULT_SUPABASE_URL;

const SUPABASE_ANON_KEY =
  getEnvVar("VITE_SUPABASE_ANON_KEY") ||
  window.__SUPABASE_ANON_KEY__ ||
  localStorage.getItem("__MOTO_SU_KEY__") ||
  DEFAULT_SUPABASE_ANON_KEY;

// Helper to check if credentials are set
export function isSupabaseConfigured() {
  return (
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes("your-project-id") &&
    !SUPABASE_ANON_KEY.includes("your-anon-key")
  );
}

// Create and export singleton Supabase client
export const supabase = isSupabaseConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

/**
 * Handle Supabase errors cleanly without revealing internal schemas
 */
export function formatSupabaseError(error) {
  if (!error) return "An unexpected error occurred.";
  if (typeof error === "string") return error;
  if (error.message) {
    if (error.message.includes("duplicate key") || error.message.includes("unique constraint")) {
      return "A record with these unique identifiers already exists in the system.";
    }
    if (error.message.includes("permission denied") || error.message.includes("Row Level Security")) {
      return "Access denied. You do not have permission to view or modify this record.";
    }
    if (error.message.includes("JWT")) {
      return "Your session has expired. Please log in again.";
    }
    return error.message;
  }
  return "Unable to complete request. Please verify network connection and try again.";
}

/**
 * Active Realtime Channels Registry
 */
const activeChannels = new Map();

/**
 * Subscribe to Supabase Realtime changes on a specific table
 * @param {string} channelKey Unique identifier for this subscription
 * @param {string} table Table name
 * @param {string} event 'INSERT' | 'UPDATE' | 'DELETE' | '*'
 * @param {Function} callback Callback with payload
 */
export function subscribeToTable(channelKey, table, event, callback) {
  if (!supabase) return null;

  // Cleanup existing channel if already active
  unsubscribeChannel(channelKey);

  const channel = supabase
    .channel(channelKey)
    .on(
      "postgres_changes",
      { event, schema: "public", table },
      (payload) => {
        if (typeof callback === "function") {
          callback(payload);
        }
      }
    )
    .subscribe();

  activeChannels.set(channelKey, channel);
  return channel;
}

/**
 * Unsubscribe a specific Realtime channel
 */
export function unsubscribeChannel(channelKey) {
  if (activeChannels.has(channelKey)) {
    const channel = activeChannels.get(channelKey);
    if (supabase && channel) {
      supabase.removeChannel(channel);
    }
    activeChannels.delete(channelKey);
  }
}

/**
 * Cleanup all active Realtime subscriptions (called on logout or route transition)
 */
export function cleanupAllSubscriptions() {
  if (supabase) {
    activeChannels.forEach((channel) => {
      supabase.removeChannel(channel);
    });
  }
  activeChannels.clear();
}
