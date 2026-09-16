-- ============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260916000007
-- REGIONAL SPOKE / BSM (BUSINESS SERVICE MANAGER) ROLE & MULTI-REGION ACCESS
-- ============================================================================

-- 1. EXTEND ROLES & ADD ASSIGNED REGIONS TO USER PROFILES
ALTER TABLE public.user_profiles 
    DROP CONSTRAINT IF EXISTS user_profiles_role_check;

ALTER TABLE public.user_profiles 
    ADD CONSTRAINT user_profiles_role_check CHECK (role IN ('CCI_USER', 'ADMIN', 'BSM'));

ALTER TABLE public.user_profiles 
    ADD COLUMN IF NOT EXISTS assigned_regions TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_user_profiles_assigned_regions 
    ON public.user_profiles USING GIN (assigned_regions);

-- 2. HELPER FUNCTIONS FOR BSM CHECK AND REGIONAL ACCESS
CREATE OR REPLACE FUNCTION public.is_bsm()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE auth_user_id = auth.uid()
          AND role = 'BSM'
          AND status = 'ACTIVE'
    );
$$;

CREATE OR REPLACE FUNCTION public.get_user_assigned_regions()
RETURNS TEXT[]
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT COALESCE(assigned_regions, '{}'::text[])
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid()
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_bsm_allowed_ccis()
RETURNS TABLE (cci_code TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT cm.cci_code
    FROM public.cci_master cm
    WHERE cm.region = ANY(public.get_user_assigned_regions());
$$;

-- 3. UPDATE get_current_user_profile() TO RETURN ASSIGNED REGIONS
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

    -- If this is a CCI_USER, check center status
    IF v_profile.role = 'CCI_USER' AND v_profile.cci_code IS NOT NULL THEN
        SELECT status INTO v_cci_status
        FROM public.cci_master
        WHERE cci_code = v_profile.cci_code;

        IF v_cci_status = 'INACTIVE' THEN
            IF v_profile.status = 'ACTIVE' THEN
                UPDATE public.user_profiles
                SET status = 'INACTIVE', updated_at = now()
                WHERE auth_user_id = auth.uid();
                v_profile.status := 'INACTIVE';
            END IF;
        END IF;
    END IF;

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
        'assigned_regions', COALESCE(v_profile.assigned_regions, '{}'::text[]),
        'status', v_profile.status,
        'cci_status', COALESCE(v_cci_status, 'ACTIVE'),
        'last_login', v_profile.last_login,
        'created_at', v_profile.created_at,
        'updated_at', v_profile.updated_at
    );
END;
$$;

-- 4. UPDATE get_admin_dashboard() TO SUPPORT BSM MULTI-REGION SCOPING
CREATE OR REPLACE FUNCTION public.get_admin_dashboard(
    p_cci_code TEXT DEFAULT NULL,
    p_region TEXT DEFAULT NULL,
    p_date_from DATE DEFAULT NULL,
    p_date_to DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_role TEXT;
    v_bsm_regions TEXT[];
    v_effective_region TEXT;
    v_total_closures INT := 0;
    v_completed_calls INT := 0;
    v_pending_calls INT := 0;
    v_completion_rate NUMERIC := 0;
    v_happy_count INT := 0;
    v_neutral_count INT := 0;
    v_unhappy_count INT := 0;
    v_happy_rate NUMERIC := 0;
    v_neutral_rate NUMERIC := 0;
    v_unhappy_rate NUMERIC := 0;
    v_avg_rating NUMERIC := 0;
    v_cci_performance JSONB;
    v_daily_trend JSONB;
    v_ageing_summary JSONB;
    v_rating_distribution JSONB;
BEGIN
    -- Verify caller is either ADMIN or BSM
    SELECT role, COALESCE(assigned_regions, '{}'::text[])
    INTO v_caller_role, v_bsm_regions
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid() AND status = 'ACTIVE';

    IF v_caller_role IS NULL OR v_caller_role NOT IN ('ADMIN', 'BSM') THEN
        RAISE EXCEPTION 'Forbidden: Administrator or Regional Manager (BSM) access required';
    END IF;

    -- Security Guard for BSM: enforce assigned regions
    IF v_caller_role = 'BSM' THEN
        IF p_region IS NOT NULL AND p_region <> '' THEN
            IF NOT (p_region = ANY(v_bsm_regions)) THEN
                RAISE EXCEPTION 'Forbidden: You do not have authorization for region %', p_region;
            END IF;
            v_effective_region := p_region;
        ELSE
            v_effective_region := NULL;
        END IF;
    ELSE
        v_effective_region := p_region;
    END IF;

    -- 1. Total closures
    SELECT COUNT(*) INTO v_total_closures
    FROM public.closure_master cm
    JOIN public.cci_master c ON cm.cci_code = c.cci_code
    WHERE (p_cci_code IS NULL OR cm.cci_code = p_cci_code)
      AND (
          CASE 
              WHEN v_caller_role = 'BSM' THEN
                  (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                  OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
              ELSE
                  (v_effective_region IS NULL OR c.region = v_effective_region)
          END
      )
      AND (p_date_from IS NULL OR cm.closure_date::date >= p_date_from)
      AND (p_date_to IS NULL OR cm.closure_date::date <= p_date_to);

    -- 2. Completed calls
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE hc.feedback_category = 'Happy'),
        COUNT(*) FILTER (WHERE hc.feedback_category = 'Neutral'),
        COUNT(*) FILTER (WHERE hc.feedback_category = 'Unhappy'),
        COALESCE(ROUND(AVG(hc.customer_rating)::numeric, 2), 0)
    INTO 
        v_completed_calls,
        v_happy_count,
        v_neutral_count,
        v_unhappy_count,
        v_avg_rating
    FROM public.happy_calling hc
    JOIN public.cci_master c ON hc.cci_code = c.cci_code
    WHERE hc.calling_status = 'Completed'
      AND (p_cci_code IS NULL OR hc.cci_code = p_cci_code)
      AND (
          CASE 
              WHEN v_caller_role = 'BSM' THEN
                  (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                  OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
              ELSE
                  (v_effective_region IS NULL OR c.region = v_effective_region)
          END
      )
      AND (p_date_from IS NULL OR hc.calling_date >= p_date_from)
      AND (p_date_to IS NULL OR hc.calling_date <= p_date_to);

    -- 3. Pending calls
    SELECT COUNT(*) INTO v_pending_calls
    FROM public.closure_master cm
    JOIN public.cci_master c ON cm.cci_code = c.cci_code
    WHERE (p_cci_code IS NULL OR cm.cci_code = p_cci_code)
      AND (
          CASE 
              WHEN v_caller_role = 'BSM' THEN
                  (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                  OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
              ELSE
                  (v_effective_region IS NULL OR c.region = v_effective_region)
          END
      )
      AND (p_date_from IS NULL OR cm.closure_date::date >= p_date_from)
      AND (p_date_to IS NULL OR cm.closure_date::date <= p_date_to)
      AND NOT EXISTS (
          SELECT 1 FROM public.happy_calling hc
          WHERE hc.closure_id = cm.closure_id
            AND hc.so_number = cm.so_number
            AND hc.cci_code = cm.cci_code
            AND hc.calling_status = 'Completed'
      );

    -- Rates calculation
    IF (v_completed_calls + v_pending_calls) > 0 THEN
        v_completion_rate := ROUND((v_completed_calls::numeric / (v_completed_calls + v_pending_calls)::numeric) * 100, 1);
    END IF;

    IF v_completed_calls > 0 THEN
        v_happy_rate := ROUND((v_happy_count::numeric / v_completed_calls::numeric) * 100, 1);
        v_neutral_rate := ROUND((v_neutral_count::numeric / v_completed_calls::numeric) * 100, 1);
        v_unhappy_rate := ROUND((v_unhappy_count::numeric / v_completed_calls::numeric) * 100, 1);
    END IF;

    -- 4. CCI Performance Table
    SELECT COALESCE(jsonb_agg(perf), '[]'::jsonb) INTO v_cci_performance
    FROM (
        SELECT 
            c.cci_code,
            c.cci_name,
            c.region,
            c.location,
            COUNT(DISTINCT cm.id) as total_closures,
            COUNT(DISTINCT hc.id) as completed_calls,
            (COUNT(DISTINCT cm.id) - COUNT(DISTINCT hc.id)) as pending_calls,
            CASE 
                WHEN COUNT(DISTINCT cm.id) > 0 
                THEN ROUND((COUNT(DISTINCT hc.id)::numeric / COUNT(DISTINCT cm.id)::numeric) * 100, 1) 
                ELSE 0 
            END as completion_rate,
            CASE 
                WHEN COUNT(DISTINCT hc.id) > 0 
                THEN ROUND((COUNT(DISTINCT hc.id) FILTER (WHERE hc.feedback_category = 'Happy')::numeric / COUNT(DISTINCT hc.id)::numeric) * 100, 1) 
                ELSE 0 
            END as happy_rate,
            CASE 
                WHEN COUNT(DISTINCT hc.id) > 0 
                THEN ROUND((COUNT(DISTINCT hc.id) FILTER (WHERE hc.feedback_category = 'Unhappy')::numeric / COUNT(DISTINCT hc.id)::numeric) * 100, 1) 
                ELSE 0 
            END as dsat_rate,
            COALESCE(ROUND(AVG(hc.customer_rating)::numeric, 2), 0) as avg_rating
        FROM public.cci_master c
        LEFT JOIN public.closure_master cm ON cm.cci_code = c.cci_code
        LEFT JOIN public.happy_calling hc 
          ON hc.closure_id = cm.closure_id 
         AND hc.so_number = cm.so_number 
         AND hc.cci_code = cm.cci_code
         AND hc.calling_status = 'Completed'
        WHERE c.status = 'ACTIVE'
          AND (p_cci_code IS NULL OR c.cci_code = p_cci_code)
          AND (
              CASE 
                  WHEN v_caller_role = 'BSM' THEN
                      (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                      OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
                  ELSE
                      (v_effective_region IS NULL OR c.region = v_effective_region)
              END
          )
        GROUP BY c.cci_code, c.cci_name, c.region, c.location
        ORDER BY completion_rate DESC, happy_rate DESC
    ) perf;

    -- 5. Daily Trend
    SELECT COALESCE(jsonb_agg(d), '[]'::jsonb) INTO v_daily_trend
    FROM (
        SELECT 
            to_char(calendar_day::date, 'Mon DD') as day_label,
            calendar_day::date as call_date,
            COUNT(hc.id) as completed_count,
            COUNT(hc.id) FILTER (WHERE hc.feedback_category = 'Happy') as happy_count,
            COUNT(hc.id) FILTER (WHERE hc.feedback_category = 'Unhappy') as unhappy_count
        FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') calendar_day
        LEFT JOIN public.happy_calling hc 
          ON hc.calling_date = calendar_day::date 
         AND hc.calling_status = 'Completed'
         AND (p_cci_code IS NULL OR hc.cci_code = p_cci_code)
         AND (
             CASE 
                 WHEN v_caller_role = 'BSM' THEN
                     hc.cci_code IN (SELECT get_bsm_allowed_ccis())
                 ELSE TRUE
             END
         )
        GROUP BY calendar_day
        ORDER BY calendar_day ASC
    ) d;

    -- 6. Rating Distribution
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rating_distribution
    FROM (
        SELECT 
            s.rating,
            COUNT(hc.id) as count
        FROM generate_series(1, 10) s(rating)
        LEFT JOIN public.happy_calling hc 
          ON hc.customer_rating = s.rating
         AND hc.calling_status = 'Completed'
         AND (p_cci_code IS NULL OR hc.cci_code = p_cci_code)
         AND (
             CASE 
                 WHEN v_caller_role = 'BSM' THEN
                     hc.cci_code IN (SELECT get_bsm_allowed_ccis())
                 ELSE TRUE
             END
         )
        GROUP BY s.rating
        ORDER BY s.rating ASC
    ) r;

    -- 7. Ageing Summary
    SELECT jsonb_build_object(
        'today', COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date = 0),
        'day1', COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date = 1),
        'day2', COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date = 2),
        'day3plus', COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date >= 3)
    ) INTO v_ageing_summary
    FROM public.closure_master cm
    JOIN public.cci_master c ON cm.cci_code = c.cci_code
    WHERE (p_cci_code IS NULL OR cm.cci_code = p_cci_code)
      AND (
          CASE 
              WHEN v_caller_role = 'BSM' THEN
                  (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                  OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
              ELSE
                  (v_effective_region IS NULL OR c.region = v_effective_region)
          END
      )
      AND NOT EXISTS (
          SELECT 1 FROM public.happy_calling hc
          WHERE hc.closure_id = cm.closure_id
            AND hc.so_number = cm.so_number
            AND hc.cci_code = cm.cci_code
            AND hc.calling_status = 'Completed'
      );

    RETURN jsonb_build_object(
        'total_closures', v_total_closures,
        'completed_calls', v_completed_calls,
        'pending_calls', v_pending_calls,
        'completion_rate', v_completion_rate,
        'happy_count', v_happy_count,
        'neutral_count', v_neutral_count,
        'unhappy_count', v_unhappy_count,
        'happy_rate', v_happy_rate,
        'neutral_rate', v_neutral_rate,
        'unhappy_rate', v_unhappy_rate,
        'avg_rating', v_avg_rating,
        'cci_performance', v_cci_performance,
        'daily_trend', v_daily_trend,
        'ageing_summary', v_ageing_summary,
        'rating_distribution', v_rating_distribution,
        'caller_role', v_caller_role,
        'assigned_regions', v_bsm_regions
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_dashboard(TEXT, TEXT, DATE, DATE) TO authenticated, service_role;

-- 5. RLS POLICIES FOR BSM MULTI-REGION VISIBILITY
-- cci_master
DROP POLICY IF EXISTS "BSM and User read cci_master" ON public.cci_master;
CREATE POLICY "BSM and User read cci_master" ON public.cci_master
    FOR SELECT
    TO authenticated
    USING (
        public.is_admin()
        OR (public.is_bsm() AND region = ANY(public.get_user_assigned_regions()))
        OR cci_code = (SELECT cci_code FROM public.user_profiles WHERE auth_user_id = auth.uid())
    );

-- closure_master
DROP POLICY IF EXISTS "BSM read closure_master" ON public.closure_master;
CREATE POLICY "BSM read closure_master" ON public.closure_master
    FOR SELECT
    TO authenticated
    USING (
        public.is_admin()
        OR (public.is_bsm() AND cci_code IN (SELECT get_bsm_allowed_ccis()))
        OR cci_code = (SELECT cci_code FROM public.user_profiles WHERE auth_user_id = auth.uid())
    );

-- happy_calling
DROP POLICY IF EXISTS "BSM read happy_calling" ON public.happy_calling;
CREATE POLICY "BSM read happy_calling" ON public.happy_calling
    FOR SELECT
    TO authenticated
    USING (
        public.is_admin()
        OR (public.is_bsm() AND cci_code IN (SELECT get_bsm_allowed_ccis()))
        OR cci_code = (SELECT cci_code FROM public.user_profiles WHERE auth_user_id = auth.uid())
    );

-- 6. ADMIN CREATE SYSTEM USER (DIRECT RPC FOR CCI_USER, BSM, ADMIN)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION public.admin_create_system_user(
    p_email TEXT,
    p_password TEXT,
    p_user_name TEXT,
    p_role TEXT,
    p_cci_code TEXT DEFAULT NULL,
    p_assigned_regions TEXT[] DEFAULT '{}'::text[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
    v_user_id UUID := gen_random_uuid();
    v_hashed_pw TEXT;
    v_cci_name TEXT := NULL;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Forbidden: Only administrators can create users';
    END IF;

    IF p_role NOT IN ('CCI_USER', 'ADMIN', 'BSM') THEN
        RAISE EXCEPTION 'Invalid role: %', p_role;
    END IF;

    p_email := LOWER(TRIM(p_email));
    IF p_email IS NULL OR p_email = '' THEN
        RAISE EXCEPTION 'Email cannot be empty';
    END IF;

    IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_email) THEN
        RAISE EXCEPTION 'User with email % already exists', p_email;
    END IF;

    IF length(p_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters long';
    END IF;

    BEGIN
        v_hashed_pw := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
    EXCEPTION WHEN OTHERS THEN
        v_hashed_pw := crypt(p_password, gen_salt('bf', 10));
    END;

    IF p_role = 'CCI_USER' AND p_cci_code IS NOT NULL THEN
        SELECT cci_name INTO v_cci_name FROM public.cci_master WHERE cci_code = p_cci_code;
    END IF;

    -- Insert into auth.users
    INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, recovery_token,
        email_change_token_new, email_change
    ) VALUES (
        '00000000-0000-0000-0000-000000000000',
        v_user_id,
        'authenticated',
        'authenticated',
        p_email,
        v_hashed_pw,
        now(),
        jsonb_build_object('provider', 'email', 'providers', array['email']),
        jsonb_build_object('user_name', p_user_name, 'role', p_role, 'cci_code', p_cci_code),
        now(), now(), '', '', '', ''
    );

    -- Insert into public.user_profiles
    INSERT INTO public.user_profiles (
        auth_user_id, user_name, role, cci_code, cci_name, assigned_regions, status
    ) VALUES (
        v_user_id,
        p_user_name,
        p_role,
        CASE WHEN p_role = 'CCI_USER' THEN p_cci_code ELSE NULL END,
        CASE WHEN p_role = 'CCI_USER' THEN v_cci_name ELSE NULL END,
        CASE WHEN p_role = 'BSM' THEN COALESCE(p_assigned_regions, '{}'::text[]) ELSE '{}'::text[] END,
        'ACTIVE'
    );

    -- Audit log
    BEGIN
        INSERT INTO public.audit_log (user_id, role, action, description, metadata)
        VALUES (
            auth.uid(),
            'ADMIN',
            'USER_CREATED',
            format('Admin created %s user "%s" (%s)', p_role, p_user_name, p_email),
            jsonb_build_object('email', p_email, 'role', p_role, 'assigned_regions', p_assigned_regions)
        );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN jsonb_build_object('success', true, 'user_id', v_user_id, 'email', p_email);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_create_system_user(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO authenticated, service_role;

