-- ============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260914000003
-- INTIMATION CALLING & OPEN CALLS SNAPSHOT MANAGEMENT SYSTEM
-- ============================================================================

-- 1. OPEN CALLS MASTER TABLE
CREATE TABLE IF NOT EXISTS public.open_calls_master (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_order TEXT NOT NULL UNIQUE,
    station_code TEXT NOT NULL,
    cci_code TEXT NOT NULL REFERENCES public.cci_master(cci_code) ON UPDATE CASCADE,
    station_name TEXT,
    customer_name TEXT,
    customer_mobile TEXT,
    alternate_mobile TEXT,
    model TEXT,
    so_status TEXT,
    warranty_status TEXT,
    parts_status TEXT,
    doa_status TEXT,
    carry_in_time TIMESTAMPTZ NOT NULL,
    finish_repair_time TIMESTAMPTZ,
    is_open BOOLEAN NOT NULL DEFAULT TRUE,
    upload_session_id TEXT,
    last_uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    source_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for lightning-fast queries & filtering
CREATE INDEX IF NOT EXISTS idx_open_calls_so ON public.open_calls_master(service_order);
CREATE INDEX IF NOT EXISTS idx_open_calls_cci ON public.open_calls_master(cci_code);
CREATE INDEX IF NOT EXISTS idx_open_calls_is_open ON public.open_calls_master(is_open);
CREATE INDEX IF NOT EXISTS idx_open_calls_carry_in ON public.open_calls_master(carry_in_time);
CREATE INDEX IF NOT EXISTS idx_open_calls_upload_session ON public.open_calls_master(upload_session_id);

-- 2. INTIMATION CALLING MASTER (Historical ETR Intimation Records)
CREATE TABLE IF NOT EXISTS public.intimation_calling (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_order TEXT NOT NULL,
    cci_code TEXT NOT NULL REFERENCES public.cci_master(cci_code) ON UPDATE CASCADE,
    etr_date DATE NOT NULL,
    calling_status TEXT NOT NULL CHECK (calling_status IN ('Completed', 'Customer Not Reachable', 'Call Back Required')),
    cci_comment TEXT,
    customer_comment TEXT,
    calling_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intimation_so ON public.intimation_calling(service_order);
CREATE INDEX IF NOT EXISTS idx_intimation_cci ON public.intimation_calling(cci_code);
CREATE INDEX IF NOT EXISTS idx_intimation_status ON public.intimation_calling(calling_status);
CREATE INDEX IF NOT EXISTS idx_intimation_created_at ON public.intimation_calling(created_at);

-- 3. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.open_calls_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intimation_calling ENABLE ROW LEVEL SECURITY;

-- Policies for open_calls_master
DROP POLICY IF EXISTS "open_calls_admin_all" ON public.open_calls_master;
CREATE POLICY "open_calls_admin_all" ON public.open_calls_master
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE auth_user_id = auth.uid() AND role = 'ADMIN'))
    WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE auth_user_id = auth.uid() AND role = 'ADMIN'));

DROP POLICY IF EXISTS "open_calls_cci_select" ON public.open_calls_master;
CREATE POLICY "open_calls_cci_select" ON public.open_calls_master
    FOR SELECT TO authenticated
    USING (
        cci_code IN (
            SELECT cci_code FROM public.user_profiles 
            WHERE auth_user_id = auth.uid() AND status = 'ACTIVE'
        )
    );

-- Policies for intimation_calling
DROP POLICY IF EXISTS "intimation_calling_admin_all" ON public.intimation_calling;
CREATE POLICY "intimation_calling_admin_all" ON public.intimation_calling
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE auth_user_id = auth.uid() AND role = 'ADMIN'))
    WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE auth_user_id = auth.uid() AND role = 'ADMIN'));

DROP POLICY IF EXISTS "intimation_calling_cci_select" ON public.intimation_calling;
CREATE POLICY "intimation_calling_cci_select" ON public.intimation_calling
    FOR SELECT TO authenticated
    USING (
        cci_code IN (
            SELECT cci_code FROM public.user_profiles 
            WHERE auth_user_id = auth.uid() AND status = 'ACTIVE'
        )
    );

DROP POLICY IF EXISTS "intimation_calling_cci_insert" ON public.intimation_calling;
CREATE POLICY "intimation_calling_cci_insert" ON public.intimation_calling
    FOR INSERT TO authenticated
    WITH CHECK (
        cci_code IN (
            SELECT cci_code FROM public.user_profiles 
            WHERE auth_user_id = auth.uid() AND status = 'ACTIVE'
        )
    );

-- 4. RPC: IMPORT OPEN CALLS BATCH WITH SNAPSHOT REPLACEMENT
CREATE OR REPLACE FUNCTION public.import_open_calls_batch(
    p_calls JSONB,
    p_session_id TEXT,
    p_is_first_chunk BOOLEAN DEFAULT FALSE,
    p_is_last_chunk BOOLEAN DEFAULT FALSE
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
    v_closed INT := 0;
    v_rejected INT := 0;
    v_rejections JSONB := '[]'::jsonb;
    v_exists BOOLEAN;
    v_so TEXT;
    v_raw_code TEXT;
    v_clean_code TEXT;
    v_station_name TEXT;
    v_model TEXT;
    v_so_status TEXT;
    v_warranty_status TEXT;
    v_parts_status TEXT;
    v_doa_status TEXT;
    v_carry_in TIMESTAMPTZ;
    v_finish_repair TIMESTAMPTZ;
    v_cust_name TEXT;
    v_cust_mobile TEXT;
    v_alt_mobile TEXT;
    v_source_data JSONB;
BEGIN
    -- Verify Admin permission
    IF NOT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE auth_user_id = auth.uid() AND role = 'ADMIN'
    ) THEN
        RAISE EXCEPTION 'Forbidden: Only administrators can upload Open Calls data.';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_calls)
    LOOP
        BEGIN
            v_so := TRIM(v_item->>'service_order');
            v_raw_code := TRIM(v_item->>'station_code');
            v_clean_code := TRIM(v_item->>'cci_code');

            IF v_so IS NULL OR v_so = '' THEN
                RAISE EXCEPTION 'Missing Service Order';
            END IF;
            IF v_clean_code IS NULL OR v_clean_code = '' THEN
                RAISE EXCEPTION 'Missing Station Code';
            END IF;

            -- Auto-link or ensure CCI exists in cci_master
            IF NOT EXISTS (SELECT 1 FROM public.cci_master WHERE cci_code = v_clean_code) THEN
                INSERT INTO public.cci_master (cci_code, cci_name, region, location, status)
                VALUES (v_clean_code, COALESCE(TRIM(v_item->>'station_name'), 'Motorola Care - ' || v_clean_code), 'General', 'General', 'ACTIVE')
                ON CONFLICT (cci_code) DO NOTHING;
            END IF;

            v_station_name := TRIM(v_item->>'station_name');
            v_model := TRIM(v_item->>'model');
            v_so_status := TRIM(v_item->>'so_status');
            v_warranty_status := TRIM(v_item->>'warranty_status');
            v_parts_status := TRIM(v_item->>'parts_status');
            v_doa_status := TRIM(v_item->>'doa_status');
            v_carry_in := (v_item->>'carry_in_time')::timestamptz;
            v_finish_repair := (v_item->>'finish_repair_time')::timestamptz;
            v_cust_name := TRIM(v_item->>'customer_name');
            v_cust_mobile := TRIM(v_item->>'customer_mobile');
            v_alt_mobile := TRIM(v_item->>'alternate_mobile');
            v_source_data := COALESCE(v_item->'source_data', '{}'::jsonb);

            IF v_carry_in IS NULL THEN
                v_carry_in := now();
            END IF;

            SELECT EXISTS (SELECT 1 FROM public.open_calls_master WHERE service_order = v_so) INTO v_exists;

            IF v_exists THEN
                UPDATE public.open_calls_master
                SET station_code = v_raw_code,
                    cci_code = v_clean_code,
                    station_name = COALESCE(v_station_name, station_name),
                    customer_name = COALESCE(v_cust_name, customer_name),
                    customer_mobile = COALESCE(v_cust_mobile, customer_mobile),
                    alternate_mobile = COALESCE(v_alt_mobile, alternate_mobile),
                    model = COALESCE(v_model, model),
                    so_status = COALESCE(v_so_status, so_status),
                    warranty_status = COALESCE(v_warranty_status, warranty_status),
                    parts_status = v_parts_status,
                    doa_status = v_doa_status,
                    carry_in_time = v_carry_in,
                    finish_repair_time = v_finish_repair,
                    is_open = TRUE,
                    upload_session_id = p_session_id,
                    last_uploaded_at = now(),
                    closed_at = NULL,
                    source_data = source_data || v_source_data,
                    updated_at = now()
                WHERE service_order = v_so;
                v_updated := v_updated + 1;
            ELSE
                INSERT INTO public.open_calls_master (
                    service_order, station_code, cci_code, station_name,
                    customer_name, customer_mobile, alternate_mobile, model,
                    so_status, warranty_status, parts_status, doa_status,
                    carry_in_time, finish_repair_time, is_open,
                    upload_session_id, last_uploaded_at, source_data
                ) VALUES (
                    v_so, v_raw_code, v_clean_code, v_station_name,
                    v_cust_name, v_cust_mobile, v_alt_mobile, v_model,
                    v_so_status, v_warranty_status, v_parts_status, v_doa_status,
                    v_carry_in, v_finish_repair, TRUE,
                    p_session_id, now(), v_source_data
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

    -- If final chunk of upload, flag any call from older sessions as closed
    IF p_is_last_chunk THEN
        UPDATE public.open_calls_master
        SET is_open = FALSE,
            closed_at = now(),
            updated_at = now()
        WHERE is_open = TRUE
          AND upload_session_id <> p_session_id;
        GET DIAGNOSTICS v_closed = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'inserted', v_inserted,
        'updated', v_updated,
        'closed', v_closed,
        'rejected', v_rejected,
        'rejections', v_rejections
    );
END;
$$;

-- 5. RPC: GET NEXT INTIMATION CALL (Ageing > 3 Days, Oldest Carry-In First)
CREATE OR REPLACE FUNCTION public.get_next_intimation_call()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
    v_cci TEXT;
    v_call RECORD;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: User is not authenticated';
    END IF;

    SELECT role, cci_code INTO v_role, v_cci
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid() AND status = 'ACTIVE';

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'Forbidden: User profile not found or inactive';
    END IF;

    -- Pick oldest active open call with Ageing > 3 days (carry_in_time <= now() - interval '3 days')
    -- where NO completed intimation has occurred yet for this open cycle
    SELECT 
        ocm.id,
        ocm.service_order,
        ocm.station_code,
        ocm.cci_code,
        ocm.station_name,
        ocm.customer_name,
        ocm.customer_mobile,
        ocm.alternate_mobile,
        ocm.model,
        ocm.so_status,
        ocm.warranty_status,
        ocm.parts_status,
        ocm.doa_status,
        ocm.carry_in_time,
        ocm.finish_repair_time,
        ocm.source_data
    INTO v_call
    FROM public.open_calls_master ocm
    WHERE ocm.is_open = TRUE
      AND ocm.carry_in_time <= (now() - interval '3 days')
      AND (v_role = 'ADMIN' OR ocm.cci_code = v_cci)
      AND NOT EXISTS (
          SELECT 1 FROM public.intimation_calling ic
          WHERE ic.service_order = ocm.service_order
            AND ic.calling_status = 'Completed'
            AND ic.created_at >= ocm.last_uploaded_at - interval '3 days'
      )
    ORDER BY ocm.carry_in_time ASC
    LIMIT 1;

    IF v_call IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    RETURN jsonb_build_object(
        'found', true,
        'call', to_jsonb(v_call)
    );
END;
$$;

-- 6. RPC: SUBMIT INTIMATION CALL WITH ETR COMMITMENT
CREATE OR REPLACE FUNCTION public.submit_intimation_call(
    p_service_order TEXT,
    p_cci_code TEXT,
    p_etr_date DATE,
    p_calling_status TEXT,
    p_cci_comment TEXT DEFAULT NULL,
    p_customer_comment TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
    v_assigned_cci TEXT;
    v_user_name TEXT;
    v_new_id UUID;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: User is not authenticated';
    END IF;

    SELECT role, cci_code, user_name INTO v_role, v_assigned_cci, v_user_name
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid() AND status = 'ACTIVE';

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'Forbidden: Profile not found or inactive';
    END IF;

    -- Ensure CCI users only submit for their assigned station
    IF v_role <> 'ADMIN' AND v_assigned_cci <> p_cci_code THEN
        RAISE EXCEPTION 'Forbidden: You cannot submit intimation calls for station %', p_cci_code;
    END IF;

    IF p_etr_date IS NULL THEN
        RAISE EXCEPTION 'Missing ETR Date. ETR Date is mandatory for intimation calling.';
    END IF;

    -- Insert into intimation_calling
    INSERT INTO public.intimation_calling (
        service_order, cci_code, etr_date, calling_status,
        cci_comment, customer_comment, calling_user_id
    ) VALUES (
        p_service_order, p_cci_code, p_etr_date, p_calling_status,
        p_cci_comment, p_customer_comment, auth.uid()
    ) RETURNING id INTO v_new_id;

    -- Audit log entry
    INSERT INTO public.audit_log (
        user_id, role, cci_code, action, description, metadata
    ) VALUES (
        auth.uid(), v_role, p_cci_code, 'SUBMIT_INTIMATION',
        'Intimation call logged for SO ' || p_service_order || ' with ETR Date ' || p_etr_date::TEXT || ' (' || p_calling_status || ')',
        jsonb_build_object(
            'service_order', p_service_order,
            'etr_date', p_etr_date,
            'status', p_calling_status,
            'intimation_id', v_new_id
        )
    );

    RETURN jsonb_build_object('success', true, 'id', v_new_id);
END;
$$;

-- 7. RPC: GET INTIMATION DASHBOARD & BACKLOG METRICS
CREATE OR REPLACE FUNCTION public.get_intimation_dashboard(
    p_cci_code TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
    v_user_cci TEXT;
    v_filter_cci TEXT;
    v_total_open INT := 0;
    v_critical_backlog INT := 0;
    v_intimated_count INT := 0;
    v_pending_intimation INT := 0;
    v_not_reachable INT := 0;
    v_call_back INT := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    SELECT role, cci_code INTO v_role, v_user_cci
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid() AND status = 'ACTIVE';

    IF v_role = 'ADMIN' THEN
        v_filter_cci := p_cci_code;
    ELSE
        v_filter_cci := v_user_cci;
    END IF;

    -- 1. Total Active Open Calls
    SELECT count(*) INTO v_total_open
    FROM public.open_calls_master
    WHERE is_open = TRUE
      AND (v_filter_cci IS NULL OR cci_code = v_filter_cci);

    -- 2. > 3 Days Critical Backlog
    SELECT count(*) INTO v_critical_backlog
    FROM public.open_calls_master
    WHERE is_open = TRUE
      AND carry_in_time <= (now() - interval '3 days')
      AND (v_filter_cci IS NULL OR cci_code = v_filter_cci);

    -- 3. Intimated (ETR Committed & Completed)
    SELECT count(DISTINCT ocm.service_order) INTO v_intimated_count
    FROM public.open_calls_master ocm
    JOIN public.intimation_calling ic ON ocm.service_order = ic.service_order
    WHERE ocm.is_open = TRUE
      AND ic.calling_status = 'Completed'
      AND (v_filter_cci IS NULL OR ocm.cci_code = v_filter_cci);

    -- 4. Pending Intimation (>3 days with no completed intimation)
    v_pending_intimation := GREATEST(0, v_critical_backlog - v_intimated_count);

    -- 5. Non-completed attempts
    SELECT count(*) INTO v_not_reachable
    FROM public.intimation_calling ic
    JOIN public.open_calls_master ocm ON ic.service_order = ocm.service_order
    WHERE ocm.is_open = TRUE
      AND ic.calling_status = 'Customer Not Reachable'
      AND (v_filter_cci IS NULL OR ocm.cci_code = v_filter_cci);

    SELECT count(*) INTO v_call_back
    FROM public.intimation_calling ic
    JOIN public.open_calls_master ocm ON ic.service_order = ocm.service_order
    WHERE ocm.is_open = TRUE
      AND ic.calling_status = 'Call Back Required'
      AND (v_filter_cci IS NULL OR ocm.cci_code = v_filter_cci);

    RETURN jsonb_build_object(
        'total_open', v_total_open,
        'critical_backlog', v_critical_backlog,
        'intimated_count', v_intimated_count,
        'pending_intimation', v_pending_intimation,
        'not_reachable', v_not_reachable,
        'call_back', v_call_back
    );
END;
$$;
