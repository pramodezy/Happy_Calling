-- ============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260916000006
-- AUTO-SYNC CCI STATUS TO USERS & STRICT LOGIN/WORKFLOW BLOCK FOR INACTIVE CCIS
-- ============================================================================

-- 1. TRIGGER TO AUTO-SYNC CCI STATUS CHANGES TO USER PROFILES
CREATE OR REPLACE FUNCTION public.sync_cci_status_to_users()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE public.user_profiles
        SET status = NEW.status,
            updated_at = now()
        WHERE cci_code = NEW.cci_code AND role = 'CCI_USER';
        
        -- Log audit trail for automatic cascade
        INSERT INTO public.audit_log (
            user_id, role, cci_code, action, description, metadata
        ) VALUES (
            auth.uid(),
            'ADMIN',
            NEW.cci_code,
            'CCI_STATUS_SYNC',
            format('CCI %s status changed to %s; cascaded to all assigned user logins.', NEW.cci_code, NEW.status),
            jsonb_build_object('cci_code', NEW.cci_code, 'new_status', NEW.status)
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cci_status ON public.cci_master;
CREATE TRIGGER trg_sync_cci_status
    AFTER UPDATE OF status ON public.cci_master
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_cci_status_to_users();

-- 2. IMMEDIATELY SYNC ALL INACTIVE CCIS TO THEIR USER PROFILES
UPDATE public.user_profiles
SET status = 'INACTIVE', updated_at = now()
WHERE role = 'CCI_USER'
  AND cci_code IN (
      SELECT cci_code FROM public.cci_master WHERE status = 'INACTIVE'
  );

-- 3. UPDATE get_current_user_profile() TO INCLUDE cci_status AND ENFORCE DEACTIVATION
CREATE OR REPLACE FUNCTION public.get_current_user_profile()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile RECORD;
    v_cci_status TEXT;
BEGIN
    SELECT * INTO v_profile
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF v_profile IS NULL THEN
        RETURN NULL;
    END IF;

    -- If this is a CCI_USER, check the status of their assigned CCI center
    IF v_profile.role = 'CCI_USER' AND v_profile.cci_code IS NOT NULL THEN
        SELECT status INTO v_cci_status
        FROM public.cci_master
        WHERE cci_code = v_profile.cci_code;

        -- If the CCI center itself is inactive, enforce user profile status as INACTIVE
        IF v_cci_status = 'INACTIVE' THEN
            -- Ensure user_profiles row matches
            IF v_profile.status = 'ACTIVE' THEN
                UPDATE public.user_profiles
                SET status = 'INACTIVE', updated_at = now()
                WHERE auth_user_id = auth.uid();
                v_profile.status := 'INACTIVE';
            END IF;
        END IF;
    END IF;

    -- Update last login only if account is active
    IF v_profile.status = 'ACTIVE' THEN
        UPDATE public.user_profiles
        SET last_login = now()
        WHERE auth_user_id = auth.uid();
    END IF;

    RETURN jsonb_build_object(
        'id', v_profile.id,
        'auth_user_id', v_profile.auth_user_id,
        'user_name', v_profile.user_name,
        'role', v_profile.role,
        'cci_code', v_profile.cci_code,
        'cci_name', v_profile.cci_name,
        'status', v_profile.status,
        'cci_status', COALESCE(v_cci_status, 'ACTIVE'),
        'last_login', v_profile.last_login,
        'created_at', v_profile.created_at,
        'updated_at', v_profile.updated_at
    );
END;
$$;

-- 4. UPDATE get_next_pending_closure() TO PREVENT INACTIVE CCIS FROM WORKFLOW
CREATE OR REPLACE FUNCTION public.get_next_pending_closure()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
    v_cci TEXT;
    v_user_status TEXT;
    v_cci_status TEXT;
    v_closure RECORD;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: User is not authenticated';
    END IF;

    SELECT up.role, up.cci_code, up.status, cm.status
    INTO v_role, v_cci, v_user_status, v_cci_status
    FROM public.user_profiles up
    LEFT JOIN public.cci_master cm ON up.cci_code = cm.cci_code
    WHERE up.auth_user_id = auth.uid();

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'Forbidden: User profile not found';
    END IF;

    IF v_user_status != 'ACTIVE' THEN
        RAISE EXCEPTION 'Forbidden: This user account is deactivated';
    END IF;

    IF v_role = 'CCI_USER' AND (v_cci_status IS NULL OR v_cci_status != 'ACTIVE') THEN
        RAISE EXCEPTION 'Forbidden: Your service center (CCI %) is currently deactivated', v_cci;
    END IF;

    -- Find oldest pending closure for this user's assigned CCI
    SELECT 
        cm.id,
        cm.closure_id,
        cm.so_number,
        cm.cci_code,
        cm.cci_name,
        cm.customer_name,
        cm.customer_mobile,
        cm.model,
        cm.closure_date,
        cm.repair_complete_date,
        cm.repair_creation_date
    INTO v_closure
    FROM public.closure_master cm
    WHERE (v_role = 'ADMIN' OR cm.cci_code = v_cci)
      AND NOT EXISTS (
          SELECT 1 FROM public.happy_calling hc
          WHERE hc.closure_id = cm.closure_id
            AND hc.so_number = cm.so_number
            AND hc.cci_code = cm.cci_code
            AND hc.calling_status = 'Completed'
      )
    ORDER BY cm.closure_date ASC
    LIMIT 1;

    IF v_closure IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN to_jsonb(v_closure);
END;
$$;

-- 5. ADMIN RESET USER PASSWORD (RPC DIRECT EXECUTION, NO EDGE FUNCTION NEEDED)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION public.admin_reset_user_password(
    p_auth_user_id UUID,
    p_new_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
    v_hashed_pw TEXT;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Forbidden: Only administrators can reset user passwords';
    END IF;

    IF length(p_new_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters long';
    END IF;

    -- Generate hash resolving pgcrypto functions across schemas
    BEGIN
        v_hashed_pw := extensions.crypt(p_new_password, extensions.gen_salt('bf', 10));
    EXCEPTION WHEN OTHERS THEN
        v_hashed_pw := crypt(p_new_password, gen_salt('bf', 10));
    END;

    UPDATE auth.users
    SET encrypted_password = v_hashed_pw,
        updated_at = now()
    WHERE id = p_auth_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User account not found in Auth system';
    END IF;

    -- Audit log
    BEGIN
        INSERT INTO public.audit_log (user_id, role, action, description, metadata)
        VALUES (
            auth.uid(),
            'ADMIN',
            'PASSWORD_RESET',
            'Administrator reset password for user ID ' || p_auth_user_id::text,
            jsonb_build_object('target_user_id', p_auth_user_id)
        );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN jsonb_build_object('success', true, 'message', 'Password updated successfully');
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reset_user_password(UUID, TEXT) TO authenticated, service_role;

