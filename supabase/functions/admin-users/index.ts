// Supabase Edge Function: admin-users
// Handles privileged user management tasks (create user, reset password, toggle status)
// securely on the server using SUPABASE_SERVICE_ROLE_KEY.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase configuration in environment.");
    }

    // 1. Verify caller's JWT authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Client for checking caller identity
    const clientCaller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user: callerUser }, error: callerError } = await clientCaller.auth.getUser();
    if (callerError || !callerUser) {
      return new Response(JSON.stringify({ error: "Invalid caller authentication session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Client with service-role permissions for admin tasks
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // 2. Verify caller has ADMIN role in public.user_profiles
    const { data: callerProfile, error: profileError } = await adminClient
      .from("user_profiles")
      .select("role, user_name")
      .eq("auth_user_id", callerUser.id)
      .eq("status", "ACTIVE")
      .single();

    if (profileError || !callerProfile || callerProfile.role !== "ADMIN") {
      return new Response(JSON.stringify({ error: "Forbidden: Admin privileges required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Parse Request
    const body = await req.json();
    const { action, payload } = body;

    let result = {};

    switch (action) {
      case "create_user": {
        const { email, password, userName, role, cciCode, cciName } = payload;
        if (!email || !password || !userName || !role) {
          throw new Error("Email, password, user name, and role are required.");
        }

        // Create Auth User
        const { data: newUser, error: createAuthError } = await adminClient.auth.admin.createUser({
          email: email.trim().toLowerCase(),
          password,
          email_confirm: true,
          user_metadata: { user_name: userName, role, cci_code: cciCode },
        });

        if (createAuthError) throw createAuthError;

        // Insert into public.user_profiles
        const { data: newProfile, error: profileInsertError } = await adminClient
          .from("user_profiles")
          .insert({
            auth_user_id: newUser.user.id,
            user_name: userName,
            role,
            cci_code: role === "CCI_USER" ? cciCode : null,
            cci_name: role === "CCI_USER" ? cciName : null,
            status: "ACTIVE",
          })
          .select()
          .single();

        if (profileInsertError) throw profileInsertError;

        // Audit Log
        await adminClient.from("audit_log").insert({
          user_id: callerUser.id,
          role: "ADMIN",
          action: "USER_CREATED",
          description: `Admin created user ${email} with role ${role} (${cciCode || "N/A"})`,
          metadata: { new_user_id: newUser.user.id, email, role, cci_code: cciCode },
        });

        result = { user: newProfile };
        break;
      }

      case "reset_password": {
        const { authUserId, newPassword } = payload;
        if (!authUserId || !newPassword) {
          throw new Error("Target user ID and new password are required.");
        }

        const { error: resetError } = await adminClient.auth.admin.updateUserById(authUserId, {
          password: newPassword,
        });

        if (resetError) throw resetError;

        // Audit Log
        await adminClient.from("audit_log").insert({
          user_id: callerUser.id,
          role: "ADMIN",
          action: "PASSWORD_RESET",
          description: `Admin reset password for user ${authUserId}`,
          metadata: { target_auth_id: authUserId },
        });

        result = { success: true, message: "Password updated successfully." };
        break;
      }

      case "update_user": {
        const { id, authUserId, userName, role, cciCode, cciName, status, email } = payload;
        if (!id) throw new Error("Profile ID is required.");

        const updates: Record<string, unknown> = {
          user_name: userName,
          role,
          cci_code: role === "CCI_USER" ? cciCode : null,
          cci_name: role === "CCI_USER" ? cciName : null,
          status,
          updated_at: new Date().toISOString(),
        };

        const { data: updatedProfile, error: updateErr } = await adminClient
          .from("user_profiles")
          .update(updates)
          .eq("id", id)
          .select()
          .single();

        if (updateErr) throw updateErr;

        if (email && authUserId) {
          await adminClient.auth.admin.updateUserById(authUserId, { email: email.trim().toLowerCase() });
        }

        // Audit Log
        await adminClient.from("audit_log").insert({
          user_id: callerUser.id,
          role: "ADMIN",
          action: "USER_UPDATED",
          description: `Admin updated user profile ${userName} (${id})`,
          metadata: updates,
        });

        result = { user: updatedProfile };
        break;
      }

      case "toggle_status": {
        const { id, authUserId, newStatus } = payload;
        if (!id || !newStatus) throw new Error("Profile ID and new status are required.");

        const { data: updatedProfile, error: statusErr } = await adminClient
          .from("user_profiles")
          .update({ status: newStatus, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();

        if (statusErr) throw statusErr;

        // Audit Log
        await adminClient.from("audit_log").insert({
          user_id: callerUser.id,
          role: "ADMIN",
          action: newStatus === "ACTIVE" ? "USER_ACTIVATED" : "USER_DEACTIVATED",
          description: `Admin set status to ${newStatus} for user ${id}`,
          metadata: { authUserId, newStatus },
        });

        result = { user: updatedProfile };
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify(result), {
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
