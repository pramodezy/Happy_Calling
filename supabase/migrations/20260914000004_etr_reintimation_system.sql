-- ============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260914000004
-- ETR RE-INTIMATION WORKFLOW & 3-ETA MAXIMUM POLICY SYSTEM
-- ============================================================================

-- 1. ADD TRACKING COLUMNS TO open_calls_master
ALTER TABLE public.open_calls_master
    ADD COLUMN IF NOT EXISTS current_etr_date DATE,
    ADD COLUMN IF NOT EXISTS eta_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS etr_status TEXT DEFAULT 'PENDING';

CREATE INDEX IF NOT EXISTS idx_open_calls_etr_date ON public.open_calls_master(current_etr_date);
CREATE INDEX IF NOT EXISTS idx_open_calls_eta_count ON public.open_calls_master(eta_count);

-- 2. ADD RE-INTIMATION & REVISION TRACKING TO intimation_calling
ALTER TABLE public.intimation_calling
    ADD COLUMN IF NOT EXISTS eta_number INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS previous_etr_date DATE,
    ADD COLUMN IF NOT EXISTS revision_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_intimation_eta_number ON public.intimation_calling(eta_number);

-- 3. SYNCHRONIZE INITIAL ETAs FROM PAST INTIMATIONS (IF ANY)
DO $$
DECLARE
    r RECORD;
    v_cnt INT;
    v_last_etr DATE;
BEGIN
    FOR r IN SELECT DISTINCT service_order FROM public.intimation_calling WHERE calling_status = 'Completed'
    LOOP
        SELECT count(*), max(etr_date) INTO v_cnt, v_last_etr
        FROM public.intimation_calling
        WHERE service_order = r.service_order AND calling_status = 'Completed';

        UPDATE public.open_calls_master
        SET current_etr_date = v_last_etr,
            eta_count = LEAST(v_cnt, 3),
            etr_status = CASE WHEN v_cnt >= 3 THEN 'MAX_ETAS_REACHED' ELSE 'COMMITTED' END
        WHERE service_order = r.service_order;
    END LOOP;
END;
$$;

-- 4. RPC: SUBMIT INTIMATION CALL WITH 3-ETA CEILING ENFORCEMENT
CREATE OR REPLACE FUNCTION public.submit_intimation_call(
    p_service_order TEXT,
    p_cci_code TEXT,
    p_etr_date DATE,
    p_calling_status TEXT,
    p_cci_comment TEXT DEFAULT NULL,
    p_customer_comment TEXT DEFAULT NULL,
    p_revision_reason TEXT DEFAULT NULL
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
    v_completed_count INT := 0;
    v_prev_etr DATE := NULL;
    v_new_eta_number INT := 1;
    v_call_is_open BOOLEAN;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: User is not authenticated';
    END IF;

    SELECT role, cci_code, user_name INTO v_role, v_assigned_cci, v_user_name
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid() AND status = 'ACTIVE';

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'Forbidden: User profile not found or inactive';
    END IF;

    IF v_role <> 'ADMIN' AND v_assigned_cci <> p_cci_code THEN
        RAISE EXCEPTION 'Forbidden: User not authorized to log intimation for Station %', p_cci_code;
    END IF;

    -- Verify open call existence
    SELECT is_open, current_etr_date, eta_count 
    INTO v_call_is_open, v_prev_etr, v_completed_count
    FROM public.open_calls_master
    WHERE service_order = p_service_order;

    IF v_call_is_open IS NULL THEN
        RAISE EXCEPTION 'Service Order % not found in Open Calls Master', p_service_order;
    END IF;

    -- Calculate current completed ETAs
    SELECT count(*), max(etr_date) 
    INTO v_completed_count, v_prev_etr
    FROM public.intimation_calling
    WHERE service_order = p_service_order 
      AND calling_status = 'Completed';

    -- ENFORCE 3-ETA MAXIMUM POLICY
    IF p_calling_status = 'Completed' AND v_completed_count >= 3 AND v_role <> 'ADMIN' THEN
        RAISE EXCEPTION 'Maximum 3 ETAs have already been committed for Service Order %. Service Manager escalation is required.', p_service_order;
    END IF;

    IF p_calling_status = 'Completed' THEN
        v_new_eta_number := v_completed_count + 1;
    ELSE
        -- If unreachable or callback, retain current sequence
        v_new_eta_number := GREATEST(1, v_completed_count + 1);
    END IF;

    -- Insert intimation calling log
    INSERT INTO public.intimation_calling (
        service_order, cci_code, etr_date, calling_status,
        cci_comment, customer_comment, calling_user_id,
        eta_number, previous_etr_date, revision_reason, created_at
    ) VALUES (
        p_service_order, p_cci_code, p_etr_date, p_calling_status,
        p_cci_comment, p_customer_comment, auth.uid(),
        v_new_eta_number, v_prev_etr, p_revision_reason, now()
    ) RETURNING id INTO v_new_id;

    -- Update open_calls_master on Completed intimation
    IF p_calling_status = 'Completed' THEN
        UPDATE public.open_calls_master
        SET current_etr_date = p_etr_date,
            eta_count = v_new_eta_number,
            etr_status = CASE WHEN v_new_eta_number >= 3 THEN 'MAX_ETAS_REACHED' ELSE 'COMMITTED' END,
            updated_at = now()
        WHERE service_order = p_service_order;
    END IF;

    -- Log to audit log
    INSERT INTO public.audit_log (
        user_id, role, cci_code, action, description, metadata
    ) VALUES (
        auth.uid(),
        v_role,
        p_cci_code,
        'INTIMATION_CALL_LOGGED',
        'Customer ETR committed: ' || p_etr_date || ' (ETA #' || v_new_eta_number || ') for SO ' || p_service_order,
        jsonb_build_object(
            'service_order', p_service_order,
            'cci_code', p_cci_code,
            'eta_number', v_new_eta_number,
            'etr_date', p_etr_date,
            'previous_etr_date', v_prev_etr,
            'status', p_calling_status,
            'user_name', v_user_name
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'id', v_new_id,
        'eta_number', v_new_eta_number,
        'remaining_etas', GREATEST(0, 3 - v_new_eta_number)
    );
END;
$$;

-- 5. RPC: GET NEXT INTIMATION CALL (Prioritizes Expiring ETAs, then Ageing > 3d)
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
    v_is_reintimation BOOLEAN := FALSE;
    v_eta_due INT := 1;
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

    -- PRIORITY 1: Re-intimation for calls whose committed ETR has expired or is expiring within 24h
    -- and where repair is not yet finished, and call has NOT exceeded 3 ETAs
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
        ocm.current_etr_date,
        ocm.eta_count,
        ocm.source_data
    INTO v_call
    FROM public.open_calls_master ocm
    WHERE ocm.is_open = TRUE
      AND (v_role = 'ADMIN' OR ocm.cci_code = v_cci)
      AND ocm.finish_repair_time IS NULL
      AND ocm.current_etr_date IS NOT NULL
      AND ocm.current_etr_date <= (CURRENT_DATE + interval '1 day')
      AND ocm.eta_count < 3
      AND NOT EXISTS (
          -- Do not re-call if an intimation was already logged today
          SELECT 1 FROM public.intimation_calling ic
          WHERE ic.service_order = ocm.service_order
            AND ic.created_at >= CURRENT_DATE
      )
    ORDER BY ocm.current_etr_date ASC, ocm.carry_in_time ASC
    LIMIT 1;

    IF v_call IS NOT NULL THEN
        v_is_reintimation := TRUE;
        v_eta_due := v_call.eta_count + 1;
    ELSE
        -- PRIORITY 2: Fresh open calls with Ageing > 3 days (carry_in_time <= now() - interval '3 days')
        -- with 0 completed ETAs
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
            ocm.current_etr_date,
            ocm.eta_count,
            ocm.source_data
        INTO v_call
        FROM public.open_calls_master ocm
        WHERE ocm.is_open = TRUE
          AND ocm.carry_in_time <= (now() - interval '3 days')
          AND (v_role = 'ADMIN' OR ocm.cci_code = v_cci)
          AND (ocm.eta_count = 0 OR ocm.current_etr_date IS NULL)
          AND NOT EXISTS (
              SELECT 1 FROM public.intimation_calling ic
              WHERE ic.service_order = ocm.service_order
                AND ic.calling_status = 'Completed'
          )
        ORDER BY ocm.carry_in_time ASC
        LIMIT 1;

        IF v_call IS NOT NULL THEN
            v_is_reintimation := FALSE;
            v_eta_due := 1;
        END IF;
    END IF;

    IF v_call IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    RETURN jsonb_build_object(
        'found', true,
        'call', to_jsonb(v_call),
        'is_reintimation', v_is_reintimation,
        'eta_due', v_eta_due
    );
END;
$$;
