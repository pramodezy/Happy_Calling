-- ============================================================================
-- MOTOROLA HAPPY CALLING - CCI SERVICE PORTAL
-- Complete Database Schema, RLS, Indexes, Triggers, and Stored Procedures
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. TABLE DEFINITIONS
-- ============================================================================

-- 1.1 CCI MASTER
CREATE TABLE IF NOT EXISTS public.cci_master (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cci_code TEXT UNIQUE NOT NULL,
    cci_name TEXT NOT NULL,
    region TEXT NOT NULL,
    location TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.2 USER PROFILES
CREATE TABLE IF NOT EXISTS public.user_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    user_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('CCI_USER', 'ADMIN')),
    cci_code TEXT REFERENCES public.cci_master(cci_code) ON UPDATE CASCADE ON DELETE SET NULL,
    cci_name TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.3 CLOSURE MASTER (Motorola Source Closures)
CREATE TABLE IF NOT EXISTS public.closure_master (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    closure_id TEXT NOT NULL,
    so_number TEXT NOT NULL,
    cci_code TEXT NOT NULL REFERENCES public.cci_master(cci_code) ON UPDATE CASCADE,
    cci_name TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_mobile TEXT NOT NULL,
    model TEXT NOT NULL,
    repair_creation_date TIMESTAMPTZ,
    repair_complete_date TIMESTAMPTZ,
    closure_date TIMESTAMPTZ NOT NULL,
    source_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_closure_record UNIQUE (closure_id, so_number, cci_code)
);

-- 1.4 HAPPY CALLING (CCI Calling Activity)
CREATE TABLE IF NOT EXISTS public.happy_calling (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    closure_id TEXT NOT NULL,
    so_number TEXT NOT NULL,
    cci_code TEXT NOT NULL REFERENCES public.cci_master(cci_code) ON UPDATE CASCADE,
    cci_name TEXT NOT NULL,
    calling_date DATE NOT NULL DEFAULT CURRENT_DATE,
    calling_time TIME NOT NULL DEFAULT CURRENT_TIME,
    calling_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    calling_status TEXT NOT NULL CHECK (calling_status IN ('Completed', 'Customer Not Reachable', 'Call Back Required')),
    customer_rating INT CHECK (customer_rating BETWEEN 1 AND 10),
    feedback_category TEXT CHECK (feedback_category IN ('Happy', 'Neutral', 'Unhappy')),
    customer_remarks TEXT,
    cci_remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.5 AUDIT LOG
CREATE TABLE IF NOT EXISTS public.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id UUID,
    role TEXT,
    cci_code TEXT,
    action TEXT NOT NULL,
    closure_id TEXT,
    description TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. CONSTRAINTS & DUPLICATE PROTECTION
-- ============================================================================

-- Ensure each closure can only have one 'Completed' Happy Calling record
CREATE UNIQUE INDEX IF NOT EXISTS uq_happy_calling_completed 
ON public.happy_calling (closure_id, so_number, cci_code) 
WHERE (calling_status = 'Completed');

-- ============================================================================
-- 3. INDEXES FOR PERFORMANCE & HIGH CONCURRENCY
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_cci_master_code ON public.cci_master(cci_code);
CREATE INDEX IF NOT EXISTS idx_cci_master_status ON public.cci_master(status);
CREATE INDEX IF NOT EXISTS idx_user_profiles_auth_id ON public.user_profiles(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_cci_code ON public.user_profiles(cci_code);
CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON public.user_profiles(role);

CREATE INDEX IF NOT EXISTS idx_closure_id ON public.closure_master(closure_id);
CREATE INDEX IF NOT EXISTS idx_closure_so_number ON public.closure_master(so_number);
CREATE INDEX IF NOT EXISTS idx_closure_cci_code ON public.closure_master(cci_code);
CREATE INDEX IF NOT EXISTS idx_closure_date ON public.closure_master(closure_date);
CREATE INDEX IF NOT EXISTS idx_repair_complete_date ON public.closure_master(repair_complete_date);
CREATE INDEX IF NOT EXISTS idx_repair_creation_date ON public.closure_master(repair_creation_date);
CREATE INDEX IF NOT EXISTS idx_closure_composite_lookup ON public.closure_master(cci_code, closure_date ASC, repair_complete_date ASC);

CREATE INDEX IF NOT EXISTS idx_happy_calling_closure_id ON public.happy_calling(closure_id);
CREATE INDEX IF NOT EXISTS idx_happy_calling_so_number ON public.happy_calling(so_number);
CREATE INDEX IF NOT EXISTS idx_happy_calling_cci_code ON public.happy_calling(cci_code);
CREATE INDEX IF NOT EXISTS idx_happy_calling_calling_date ON public.happy_calling(calling_date);
CREATE INDEX IF NOT EXISTS idx_happy_calling_calling_user ON public.happy_calling(calling_user_id);
CREATE INDEX IF NOT EXISTS idx_happy_calling_status ON public.happy_calling(calling_status);
CREATE INDEX IF NOT EXISTS idx_happy_calling_feedback ON public.happy_calling(feedback_category);
CREATE INDEX IF NOT EXISTS idx_happy_calling_rating ON public.happy_calling(customer_rating);
CREATE INDEX IF NOT EXISTS idx_happy_calling_composite ON public.happy_calling(cci_code, calling_status, calling_date);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON public.audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON public.audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_cci_code ON public.audit_log(cci_code);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON public.audit_log(action);

-- ============================================================================
-- 4. HELPER FUNCTIONS FOR RLS & SECURITY
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_user_profile()
RETURNS TABLE (
    id UUID,
    auth_user_id UUID,
    user_name TEXT,
    role TEXT,
    cci_code TEXT,
    cci_name TEXT,
    status TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT id, auth_user_id, user_name, role, cci_code, cci_name, status
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid()
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT role FROM public.user_profiles WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_user_cci()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT cci_code FROM public.user_profiles WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE auth_user_id = auth.uid() AND role = 'ADMIN' AND status = 'ACTIVE'
    );
$$;

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cci_master_updated_at ON public.cci_master;
CREATE TRIGGER trg_cci_master_updated_at BEFORE UPDATE ON public.cci_master
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_user_profiles_updated_at ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_updated_at BEFORE UPDATE ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_closure_master_updated_at ON public.closure_master;
CREATE TRIGGER trg_closure_master_updated_at BEFORE UPDATE ON public.closure_master
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_happy_calling_updated_at ON public.happy_calling;
CREATE TRIGGER trg_happy_calling_updated_at BEFORE UPDATE ON public.happy_calling
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 5. ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

ALTER TABLE public.cci_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closure_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.happy_calling ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- 5.1 CCI MASTER RLS
DROP POLICY IF EXISTS "cci_master_admin_all" ON public.cci_master;
CREATE POLICY "cci_master_admin_all" ON public.cci_master
FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "cci_master_user_select" ON public.cci_master;
CREATE POLICY "cci_master_user_select" ON public.cci_master
FOR SELECT TO authenticated
USING (status = 'ACTIVE');

-- 5.2 USER PROFILES RLS
DROP POLICY IF EXISTS "user_profiles_admin_all" ON public.user_profiles;
CREATE POLICY "user_profiles_admin_all" ON public.user_profiles
FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "user_profiles_own_select" ON public.user_profiles;
CREATE POLICY "user_profiles_own_select" ON public.user_profiles
FOR SELECT TO authenticated
USING (auth_user_id = auth.uid());

DROP POLICY IF EXISTS "user_profiles_own_update" ON public.user_profiles;
CREATE POLICY "user_profiles_own_update" ON public.user_profiles
FOR UPDATE TO authenticated
USING (auth_user_id = auth.uid())
WITH CHECK (auth_user_id = auth.uid());

-- 5.3 CLOSURE MASTER RLS
DROP POLICY IF EXISTS "closure_master_admin_all" ON public.closure_master;
CREATE POLICY "closure_master_admin_all" ON public.closure_master
FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "closure_master_cci_select" ON public.closure_master;
CREATE POLICY "closure_master_cci_select" ON public.closure_master
FOR SELECT TO authenticated
USING (cci_code = public.current_user_cci());

-- 5.4 HAPPY CALLING RLS
DROP POLICY IF EXISTS "happy_calling_admin_all" ON public.happy_calling;
CREATE POLICY "happy_calling_admin_all" ON public.happy_calling
FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "happy_calling_cci_select" ON public.happy_calling;
CREATE POLICY "happy_calling_cci_select" ON public.happy_calling
FOR SELECT TO authenticated
USING (cci_code = public.current_user_cci());

DROP POLICY IF EXISTS "happy_calling_cci_insert" ON public.happy_calling;
CREATE POLICY "happy_calling_cci_insert" ON public.happy_calling
FOR INSERT TO authenticated
WITH CHECK (cci_code = public.current_user_cci());

DROP POLICY IF EXISTS "happy_calling_cci_update" ON public.happy_calling;
CREATE POLICY "happy_calling_cci_update" ON public.happy_calling
FOR UPDATE TO authenticated
USING (cci_code = public.current_user_cci())
WITH CHECK (cci_code = public.current_user_cci());

-- 5.5 AUDIT LOG RLS
DROP POLICY IF EXISTS "audit_log_admin_all" ON public.audit_log;
CREATE POLICY "audit_log_admin_all" ON public.audit_log
FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "audit_log_cci_select" ON public.audit_log;
CREATE POLICY "audit_log_cci_select" ON public.audit_log
FOR SELECT TO authenticated
USING (cci_code = public.current_user_cci());

DROP POLICY IF EXISTS "audit_log_user_insert" ON public.audit_log;
CREATE POLICY "audit_log_user_insert" ON public.audit_log
FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- 6. BUSINESS LOGIC STORED PROCEDURES & RPC FUNCTIONS
-- ============================================================================

-- 6.1 GET CURRENT USER PROFILE (RPC)
CREATE OR REPLACE FUNCTION public.get_current_user_profile()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile RECORD;
BEGIN
    SELECT * INTO v_profile
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF v_profile IS NULL THEN
        RETURN NULL;
    END IF;

    -- Update last login
    UPDATE public.user_profiles
    SET last_login = now()
    WHERE auth_user_id = auth.uid();

    RETURN to_jsonb(v_profile);
END;
$$;

-- 6.2 GET NEXT PENDING CLOSURE (RPC)
-- Returns the single oldest pending closure for the authenticated user's CCI.
-- Pending = No 'Completed' Happy Calling record exists.
CREATE OR REPLACE FUNCTION public.get_next_pending_closure()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
    v_cci TEXT;
    v_closure RECORD;
BEGIN
    -- Verify authenticated user
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: User is not authenticated';
    END IF;

    SELECT role, cci_code INTO v_role, v_cci
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid() AND status = 'ACTIVE';

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'Forbidden: User profile not found or inactive';
    END IF;

    -- Find oldest pending closure for this user's assigned CCI
    -- (or any CCI if ADMIN is testing)
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
    ORDER BY 
        cm.closure_date ASC,
        cm.repair_complete_date ASC,
        cm.created_at ASC
    LIMIT 1;

    IF v_closure IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    RETURN jsonb_build_object(
        'found', true,
        'closure', to_jsonb(v_closure)
    );
END;
$$;

-- 6.3 SUBMIT HAPPY CALLING (RPC)
-- Validates caller, checks duplicate, stores record, and logs audit atomically.
CREATE OR REPLACE FUNCTION public.submit_happy_calling(
    p_closure_id TEXT,
    p_so_number TEXT,
    p_cci_code TEXT,
    p_calling_status TEXT,
    p_customer_rating INT DEFAULT NULL,
    p_feedback_category TEXT DEFAULT NULL,
    p_customer_remarks TEXT DEFAULT NULL,
    p_cci_remarks TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_id UUID;
    v_role TEXT;
    v_user_cci TEXT;
    v_user_name TEXT;
    v_closure RECORD;
    v_new_id UUID;
    v_already_completed BOOLEAN;
BEGIN
    v_auth_id := auth.uid();
    IF v_auth_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: User is not authenticated';
    END IF;

    -- Retrieve caller profile
    SELECT role, cci_code, user_name INTO v_role, v_user_cci, v_user_name
    FROM public.user_profiles
    WHERE auth_user_id = v_auth_id AND status = 'ACTIVE';

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'Forbidden: User profile not active or not found';
    END IF;

    -- Validate CCI authorization
    IF v_role = 'CCI_USER' AND v_user_cci <> p_cci_code THEN
        RAISE EXCEPTION 'Forbidden: User belongs to CCI % and cannot submit for CCI %', v_user_cci, p_cci_code;
    END IF;

    -- Verify closure exists in closure_master
    SELECT * INTO v_closure
    FROM public.closure_master
    WHERE closure_id = p_closure_id
      AND so_number = p_so_number
      AND cci_code = p_cci_code;

    IF v_closure IS NULL THEN
        RAISE EXCEPTION 'Not Found: Closure record not found for Closure ID %, SO %', p_closure_id, p_so_number;
    END IF;

    -- Validate input rules
    IF p_calling_status NOT IN ('Completed', 'Customer Not Reachable', 'Call Back Required') THEN
        RAISE EXCEPTION 'Invalid calling status: %', p_calling_status;
    END IF;

    IF p_calling_status = 'Completed' THEN
        IF p_customer_rating IS NULL OR p_customer_rating < 1 OR p_customer_rating > 10 THEN
            RAISE EXCEPTION 'Customer rating between 1 and 10 is required for Completed calls';
        END IF;

        IF p_feedback_category NOT IN ('Happy', 'Neutral', 'Unhappy') THEN
            RAISE EXCEPTION 'Valid feedback category (Happy, Neutral, Unhappy) is required for Completed calls';
        END IF;

        -- Check duplicate completion
        SELECT EXISTS (
            SELECT 1 FROM public.happy_calling
            WHERE closure_id = p_closure_id
              AND so_number = p_so_number
              AND cci_code = p_cci_code
              AND calling_status = 'Completed'
        ) INTO v_already_completed;

        IF v_already_completed THEN
            RAISE EXCEPTION 'Duplicate submission: Closure % is already marked Completed', p_closure_id;
        END IF;
    END IF;

    -- Insert Happy Calling Record
    INSERT INTO public.happy_calling (
        closure_id,
        so_number,
        cci_code,
        cci_name,
        calling_date,
        calling_time,
        calling_user_id,
        calling_status,
        customer_rating,
        feedback_category,
        customer_remarks,
        cci_remarks
    ) VALUES (
        p_closure_id,
        p_so_number,
        p_cci_code,
        v_closure.cci_name,
        CURRENT_DATE,
        CURRENT_TIME,
        v_auth_id,
        p_calling_status,
        p_customer_rating,
        p_feedback_category,
        p_customer_remarks,
        p_cci_remarks
    ) RETURNING id INTO v_new_id;

    -- Insert Audit Log Entry
    INSERT INTO public.audit_log (
        user_id,
        role,
        cci_code,
        action,
        closure_id,
        description,
        metadata
    ) VALUES (
        v_auth_id,
        v_role,
        p_cci_code,
        'HAPPY_CALLING_SUBMITTED',
        p_closure_id,
        format('Happy calling record submitted with status: %s', p_calling_status),
        jsonb_build_object(
            'happy_calling_id', v_new_id,
            'calling_status', p_calling_status,
            'customer_rating', p_customer_rating,
            'feedback_category', p_feedback_category,
            'user_name', v_user_name
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'id', v_new_id,
        'closure_id', p_closure_id,
        'calling_status', p_calling_status
    );
END;
$$;

-- 6.4 GET CCI DASHBOARD (RPC)
-- Aggregates real-time metrics for a specific CCI or the caller's assigned CCI
CREATE OR REPLACE FUNCTION public.get_cci_dashboard(
    p_timeframe TEXT DEFAULT 'ALL' -- 'TODAY', 'THIS_WEEK', 'THIS_MONTH', 'ALL'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
    v_cci TEXT;
    v_date_start TIMESTAMPTZ;
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
    v_ageing_today INT := 0;
    v_ageing_1day INT := 0;
    v_ageing_2days INT := 0;
    v_ageing_3plus INT := 0;
    v_daily_trend JSONB;
    v_rating_distribution JSONB;
BEGIN
    -- Authenticate
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    SELECT role, cci_code INTO v_role, v_cci
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid() AND status = 'ACTIVE';

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'Profile not found';
    END IF;

    -- Calculate timeframe filter for calling activities
    IF p_timeframe = 'TODAY' THEN
        v_date_start := date_trunc('day', now());
    ELSIF p_timeframe = 'THIS_WEEK' THEN
        v_date_start := date_trunc('week', now());
    ELSIF p_timeframe = 'THIS_MONTH' THEN
        v_date_start := date_trunc('month', now());
    ELSE
        v_date_start := '1970-01-01'::timestamptz;
    END IF;

    -- Total closures for this CCI
    SELECT COUNT(*) INTO v_total_closures
    FROM public.closure_master cm
    WHERE (v_role = 'ADMIN' OR cm.cci_code = v_cci);

    -- Completed calls for this CCI
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
    WHERE (v_role = 'ADMIN' OR hc.cci_code = v_cci)
      AND hc.calling_status = 'Completed'
      AND hc.created_at >= v_date_start;

    -- Pending calls (closures that do not have Completed happy calling)
    SELECT COUNT(*) INTO v_pending_calls
    FROM public.closure_master cm
    WHERE (v_role = 'ADMIN' OR cm.cci_code = v_cci)
      AND NOT EXISTS (
          SELECT 1 FROM public.happy_calling hc
          WHERE hc.closure_id = cm.closure_id
            AND hc.so_number = cm.so_number
            AND hc.cci_code = cm.cci_code
            AND hc.calling_status = 'Completed'
      );

    -- Percentages
    IF (v_completed_calls + v_pending_calls) > 0 THEN
        v_completion_rate := ROUND((v_completed_calls::numeric / (v_completed_calls + v_pending_calls)::numeric) * 100, 1);
    END IF;

    IF v_completed_calls > 0 THEN
        v_happy_rate := ROUND((v_happy_count::numeric / v_completed_calls::numeric) * 100, 1);
        v_neutral_rate := ROUND((v_neutral_count::numeric / v_completed_calls::numeric) * 100, 1);
        v_unhappy_rate := ROUND((v_unhappy_count::numeric / v_completed_calls::numeric) * 100, 1);
    END IF;

    -- Pending Ageing Breakdown
    -- Today = 0 days difference from closure_date
    -- 1 Day = 1 day difference
    -- 2 Days = 2 days difference
    -- 3+ Days = >= 3 days difference
    SELECT
        COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date = 0),
        COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date = 1),
        COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date = 2),
        COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date >= 3)
    INTO
        v_ageing_today,
        v_ageing_1day,
        v_ageing_2days,
        v_ageing_3plus
    FROM public.closure_master cm
    WHERE (v_role = 'ADMIN' OR cm.cci_code = v_cci)
      AND NOT EXISTS (
          SELECT 1 FROM public.happy_calling hc
          WHERE hc.closure_id = cm.closure_id
            AND hc.so_number = cm.so_number
            AND hc.cci_code = cm.cci_code
            AND hc.calling_status = 'Completed'
      );

    -- Daily completion trend (last 7 days)
    SELECT COALESCE(jsonb_agg(d), '[]'::jsonb) INTO v_daily_trend
    FROM (
        SELECT 
            to_char(calendar_day::date, 'Mon DD') as day_label,
            calendar_day::date as call_date,
            COUNT(hc.id) as completed_count
        FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') calendar_day
        LEFT JOIN public.happy_calling hc 
          ON hc.calling_date = calendar_day::date 
         AND hc.calling_status = 'Completed'
         AND (v_role = 'ADMIN' OR hc.cci_code = v_cci)
        GROUP BY calendar_day
        ORDER BY calendar_day ASC
    ) d;

    -- Rating distribution (1 to 10)
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rating_distribution
    FROM (
        SELECT 
            s.rating,
            COUNT(hc.id) as count
        FROM generate_series(1, 10) s(rating)
        LEFT JOIN public.happy_calling hc 
          ON hc.customer_rating = s.rating
         AND hc.calling_status = 'Completed'
         AND (v_role = 'ADMIN' OR hc.cci_code = v_cci)
         AND hc.created_at >= v_date_start
        GROUP BY s.rating
        ORDER BY s.rating ASC
    ) r;

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
        'ageing', jsonb_build_object(
            'today', v_ageing_today,
            'day1', v_ageing_1day,
            'day2', v_ageing_2days,
            'day3plus', v_ageing_3plus
        ),
        'daily_trend', v_daily_trend,
        'rating_distribution', v_rating_distribution
    );
END;
$$;

-- 6.5 GET ADMIN DASHBOARD (RPC)
-- Comprehensive company-wide overview with filters
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
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Forbidden: Admin access required';
    END IF;

    -- Total closures matching filters
    SELECT COUNT(*) INTO v_total_closures
    FROM public.closure_master cm
    JOIN public.cci_master c ON cm.cci_code = c.cci_code
    WHERE (p_cci_code IS NULL OR cm.cci_code = p_cci_code)
      AND (p_region IS NULL OR c.region = p_region)
      AND (p_date_from IS NULL OR cm.closure_date::date >= p_date_from)
      AND (p_date_to IS NULL OR cm.closure_date::date <= p_date_to);

    -- Completed calls matching filters
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
      AND (p_region IS NULL OR c.region = p_region)
      AND (p_date_from IS NULL OR hc.calling_date >= p_date_from)
      AND (p_date_to IS NULL OR hc.calling_date <= p_date_to);

    -- Pending calls
    SELECT COUNT(*) INTO v_pending_calls
    FROM public.closure_master cm
    JOIN public.cci_master c ON cm.cci_code = c.cci_code
    WHERE (p_cci_code IS NULL OR cm.cci_code = p_cci_code)
      AND (p_region IS NULL OR c.region = p_region)
      AND (p_date_from IS NULL OR cm.closure_date::date >= p_date_from)
      AND (p_date_to IS NULL OR cm.closure_date::date <= p_date_to)
      AND NOT EXISTS (
          SELECT 1 FROM public.happy_calling hc
          WHERE hc.closure_id = cm.closure_id
            AND hc.so_number = cm.so_number
            AND hc.cci_code = cm.cci_code
            AND hc.calling_status = 'Completed'
      );

    -- Percentages
    IF (v_completed_calls + v_pending_calls) > 0 THEN
        v_completion_rate := ROUND((v_completed_calls::numeric / (v_completed_calls + v_pending_calls)::numeric) * 100, 1);
    END IF;

    IF v_completed_calls > 0 THEN
        v_happy_rate := ROUND((v_happy_count::numeric / v_completed_calls::numeric) * 100, 1);
        v_neutral_rate := ROUND((v_neutral_count::numeric / v_completed_calls::numeric) * 100, 1);
        v_unhappy_rate := ROUND((v_unhappy_count::numeric / v_completed_calls::numeric) * 100, 1);
    END IF;

    -- CCI Performance comparison table
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
          AND (p_region IS NULL OR c.region = p_region)
        GROUP BY c.cci_code, c.cci_name, c.region, c.location
        ORDER BY completion_rate DESC, happy_rate DESC
    ) perf;

    -- Daily Trend (last 14 days)
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
        GROUP BY calendar_day
        ORDER BY calendar_day ASC
    ) d;

    -- Rating distribution
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
        GROUP BY s.rating
        ORDER BY s.rating ASC
    ) r;

    -- Ageing summary across CCIs
    SELECT jsonb_build_object(
        'today', COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date = 0),
        'day1', COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date = 1),
        'day2', COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date = 2),
        'day3plus', COUNT(*) FILTER (WHERE CURRENT_DATE - cm.closure_date::date >= 3)
    ) INTO v_ageing_summary
    FROM public.closure_master cm
    WHERE (p_cci_code IS NULL OR cm.cci_code = p_cci_code)
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
        'rating_distribution', v_rating_distribution
    );
END;
$$;

-- 6.6 BATCH IMPORT CLOSURES (RPC)
-- Secure function to handle bulk insert/update of closure records from Excel/CSV
CREATE OR REPLACE FUNCTION public.import_closures_batch(
    p_closures JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_item JSONB;
    v_inserted INT := 0;
    v_updated INT := 0;
    v_rejected INT := 0;
    v_rejections JSONB := '[]'::jsonb;
    v_closure_id TEXT;
    v_so_number TEXT;
    v_cci_code TEXT;
    v_cci_name TEXT;
    v_customer_name TEXT;
    v_customer_mobile TEXT;
    v_model TEXT;
    v_repair_creation_date TIMESTAMPTZ;
    v_repair_complete_date TIMESTAMPTZ;
    v_closure_date TIMESTAMPTZ;
    v_source_data JSONB;
    v_exists BOOLEAN;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Forbidden: Admin access required';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_closures)
    LOOP
        BEGIN
            v_closure_id := TRIM(v_item->>'closure_id');
            v_so_number := TRIM(v_item->>'so_number');
            v_cci_code := UPPER(TRIM(v_item->>'cci_code'));
            v_cci_name := TRIM(v_item->>'cci_name');
            v_customer_name := TRIM(v_item->>'customer_name');
            v_customer_mobile := TRIM(v_item->>'customer_mobile');
            v_model := TRIM(v_item->>'model');
            v_source_data := COALESCE(v_item->'source_data', '{}'::jsonb);

            -- Validate required fields
            IF v_closure_id IS NULL OR v_closure_id = '' THEN
                RAISE EXCEPTION 'Missing Closure ID';
            END IF;
            IF v_so_number IS NULL OR v_so_number = '' THEN
                RAISE EXCEPTION 'Missing SO Number';
            END IF;
            IF v_cci_code IS NULL OR v_cci_code = '' THEN
                RAISE EXCEPTION 'Missing CCI Code';
            END IF;

            -- Auto-create CCI in cci_master if missing, to maintain foreign key integrity
            IF NOT EXISTS (SELECT 1 FROM public.cci_master WHERE cci_code = v_cci_code) THEN
                INSERT INTO public.cci_master (cci_code, cci_name, region, location, status)
                VALUES (v_cci_code, COALESCE(v_cci_name, v_cci_code), 'General', 'General', 'ACTIVE')
                ON CONFLICT (cci_code) DO NOTHING;
            END IF;

            -- Parse dates
            v_closure_date := COALESCE((v_item->>'closure_date')::timestamptz, now());
            v_repair_complete_date := (v_item->>'repair_complete_date')::timestamptz;
            v_repair_creation_date := (v_item->>'repair_creation_date')::timestamptz;

            -- Check if record already exists
            SELECT EXISTS (
                SELECT 1 FROM public.closure_master
                WHERE closure_id = v_closure_id
                  AND so_number = v_so_number
                  AND cci_code = v_cci_code
            ) INTO v_exists;

            IF v_exists THEN
                UPDATE public.closure_master
                SET cci_name = COALESCE(v_cci_name, cci_name),
                    customer_name = COALESCE(v_customer_name, customer_name),
                    customer_mobile = COALESCE(v_customer_mobile, customer_mobile),
                    model = COALESCE(v_model, model),
                    repair_creation_date = COALESCE(v_repair_creation_date, repair_creation_date),
                    repair_complete_date = COALESCE(v_repair_complete_date, repair_complete_date),
                    closure_date = COALESCE(v_closure_date, closure_date),
                    source_data = source_data || v_source_data,
                    updated_at = now()
                WHERE closure_id = v_closure_id
                  AND so_number = v_so_number
                  AND cci_code = v_cci_code;
                v_updated := v_updated + 1;
            ELSE
                INSERT INTO public.closure_master (
                    closure_id, so_number, cci_code, cci_name,
                    customer_name, customer_mobile, model,
                    repair_creation_date, repair_complete_date, closure_date,
                    source_data
                ) VALUES (
                    v_closure_id, v_so_number, v_cci_code, COALESCE(v_cci_name, v_cci_code),
                    COALESCE(v_customer_name, 'Unknown Customer'),
                    COALESCE(v_customer_mobile, 'N/A'),
                    COALESCE(v_model, 'Motorola Device'),
                    v_repair_creation_date, v_repair_complete_date, v_closure_date,
                    v_source_data
                );
                v_inserted := v_inserted + 1;
            END IF;

        EXCEPTION WHEN OTHERS THEN
            v_rejected := v_rejected + 1;
            v_rejections := v_rejections || jsonb_build_object(
                'record', v_item,
                'reason', SQLERRM
            );
        END;
    END LOOP;

    -- Log Audit
    INSERT INTO public.audit_log (
        user_id, role, action, description, metadata
    ) VALUES (
        auth.uid(),
        'ADMIN',
        'CLOSURE_IMPORT',
        format('Closure batch import processed: %s inserted, %s updated, %s rejected', v_inserted, v_updated, v_rejected),
        jsonb_build_object(
            'inserted', v_inserted,
            'updated', v_updated,
            'rejected', v_rejected
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'inserted', v_inserted,
        'updated', v_updated,
        'rejected', v_rejected,
        'rejections', v_rejections
    );
END;
$$;

-- ============================================================================
-- 7. INITIAL SEED DATA (Default CCIs & Admin Seed Helper)
-- ============================================================================

INSERT INTO public.cci_master (cci_code, cci_name, region, location, status)
VALUES 
    ('BLR01', 'Motorola Authorized Care - Bangalore Central', 'South', 'Bangalore', 'ACTIVE'),
    ('DEL01', 'Motorola Authorized Care - Delhi Connaught', 'North', 'Delhi', 'ACTIVE'),
    ('MUM01', 'Motorola Authorized Care - Mumbai Andheri', 'West', 'Mumbai', 'ACTIVE'),
    ('KOC01', 'Motorola Authorized Care - Kochi MG Road', 'South', 'Kochi', 'ACTIVE'),
    ('KOL01', 'Motorola Authorized Care - Kolkata Salt Lake', 'East', 'Kolkata', 'ACTIVE')
ON CONFLICT (cci_code) DO NOTHING;
