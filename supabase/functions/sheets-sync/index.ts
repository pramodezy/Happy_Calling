// Supabase Edge Function: sheets-sync
// Optional backend synchronization for Google Sheets closure data.
// Reads sheet rows via Google Sheets API (or public CSV export), maps columns,
// and invokes public.import_closures_batch() atomically.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    // Authenticate caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Verify Admin role
    const { data: profile } = await adminClient
      .from("user_profiles")
      .select("role")
      .eq("auth_user_id", user.id)
      .single();

    if (!profile || profile.role !== "ADMIN") {
      return new Response(JSON.stringify({ error: "Forbidden: Admin required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const sheetId = body.sheetId || Deno.env.get("GOOGLE_SHEET_ID");
    const apiKey = Deno.env.get("GOOGLE_SHEETS_API_KEY");

    if (!sheetId) {
      throw new Error("Missing Google Sheet ID parameter or GOOGLE_SHEET_ID secret.");
    }

    // Fetch from Google Sheets API or published CSV feed
    let rows: Record<string, string>[] = [];
    if (apiKey) {
      const range = body.range || "Sheet1!A1:Z5000";
      const gUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?key=${apiKey}`;
      const gRes = await fetch(gUrl);
      if (!gRes.ok) {
        throw new Error(`Google Sheets API responded with status ${gRes.status}`);
      }
      const gData = await gRes.json();
      const rawRows: string[][] = gData.values || [];
      if (rawRows.length > 1) {
        const headers = rawRows[0].map((h) => h.trim().toLowerCase());
        rows = rawRows.slice(1).map((r) => {
          const item: Record<string, string> = {};
          headers.forEach((h, idx) => {
            item[h] = r[idx] ?? "";
          });
          return item;
        });
      }
    } else {
      // Fallback to published CSV if API Key is not configured
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
      const csvRes = await fetch(csvUrl);
      if (!csvRes.ok) {
        throw new Error("Unable to fetch sheet. Check sheet sharing permissions (Must be Viewer with link).");
      }
      const text = await csvRes.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 1) {
        const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim().toLowerCase());
        rows = lines.slice(1).map((line) => {
          const cols = line.split(",").map((c) => c.replace(/"/g, "").trim());
          const item: Record<string, string> = {};
          headers.forEach((h, idx) => {
            item[h] = cols[idx] ?? "";
          });
          return item;
        });
      }
    }

    // Map headers flexibly to standard fields
    const closures = rows.map((r) => {
      const getVal = (...keys: string[]) => {
        for (const k of keys) {
          if (r[k]) return r[k];
        }
        return "";
      };

      return {
        closure_id: getVal("closure_id", "closure id", "closureid", "job_no", "job no"),
        so_number: getVal("so_number", "so number", "sonumber", "so", "service order"),
        cci_code: getVal("cci_code", "cci code", "ccicode", "center code", "asc code"),
        cci_name: getVal("cci_name", "cci name", "cciname", "center name", "asc name"),
        customer_name: getVal("customer_name", "customer name", "customer", "client name"),
        customer_mobile: getVal("customer_mobile", "customer mobile", "mobile", "phone", "contact"),
        model: getVal("model", "product", "device", "model name"),
        closure_date: getVal("closure_date", "closure date", "closed_date", "date"),
        repair_complete_date: getVal("repair_complete_date", "complete date", "repair date"),
        repair_creation_date: getVal("repair_creation_date", "creation date", "start date"),
        source_data: r,
      };
    }).filter((c) => c.closure_id && c.so_number && c.cci_code);

    if (closures.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No valid closure records found to sync.", count: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Call stored procedure
    const { data: importResult, error: importError } = await adminClient.rpc("import_closures_batch", {
      p_closures: closures,
    });

    if (importError) throw importError;

    return new Response(JSON.stringify({ success: true, result: importResult }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
