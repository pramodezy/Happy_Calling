-- ==============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260917000011
-- BSM (REGIONAL SERVICE MANAGER) INTIMATION CALLING ACCESS & RLS POLICIES
-- ==============================================================================

-- 1. RLS POLICY FOR BSM ON open_calls_master
DROP POLICY IF EXISTS "BSM read open_calls_master" ON public.open_calls_master;
CREATE POLICY "BSM read open_calls_master" ON public.open_calls_master
    FOR SELECT
    TO authenticated
    USING (
        public.is_admin()
        OR (public.is_bsm() AND cci_code IN (SELECT get_bsm_allowed_ccis()))
        OR cci_code = (SELECT cci_code FROM public.user_profiles WHERE auth_user_id = auth.uid())
    );

-- 2. RLS POLICY FOR BSM ON intimation_calling
DROP POLICY IF EXISTS "BSM read intimation_calling" ON public.intimation_calling;
CREATE POLICY "BSM read intimation_calling" ON public.intimation_calling
    FOR SELECT
    TO authenticated
    USING (
        public.is_admin()
        OR (public.is_bsm() AND cci_code IN (SELECT get_bsm_allowed_ccis()))
        OR cci_code = (SELECT cci_code FROM public.user_profiles WHERE auth_user_id = auth.uid())
    );

-- 3. UPDATE get_intimation_dashboard TO SUPPORT REGIONAL BSM ACCESS
DROP FUNCTION IF EXISTS public.get_intimation_dashboard(TEXT);

CREATE OR REPLACE FUNCTION public.get_intimation_dashboard(
    p_cci_code TEXT DEFAULT NULL,
    p_region TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_role TEXT;
    v_bsm_regions TEXT[];
    v_user_cci TEXT;
    v_effective_region TEXT;
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

    SELECT role, cci_code, COALESCE(assigned_regions, '{}'::text[])
    INTO v_caller_role, v_user_cci, v_bsm_regions
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid() AND status = 'ACTIVE';

    IF v_caller_role IS NULL THEN
        RAISE EXCEPTION 'User profile not found or inactive';
    END IF;

    IF v_caller_role = 'BSM' THEN
        IF p_region IS NOT NULL AND p_region <> '' THEN
            IF NOT (p_region = ANY(v_bsm_regions)) THEN
                RAISE EXCEPTION 'Forbidden: You do not have authorization for region %', p_region;
            END IF;
            v_effective_region := p_region;
        ELSE
            v_effective_region := NULL;
        END IF;
        v_filter_cci := p_cci_code;
    ELSIF v_caller_role = 'ADMIN' THEN
        v_effective_region := p_region;
        v_filter_cci := p_cci_code;
    ELSE -- CCI_USER
        v_filter_cci := v_user_cci;
        v_effective_region := NULL;
    END IF;

    -- 1. Total Active Open Calls
    SELECT count(*) INTO v_total_open
    FROM public.open_calls_master ocm
    LEFT JOIN public.cci_master c ON ocm.cci_code = c.cci_code
    WHERE ocm.is_open = TRUE
      AND (v_filter_cci IS NULL OR ocm.cci_code = v_filter_cci)
      AND (
          CASE 
              WHEN v_caller_role = 'BSM' THEN
                  (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                  OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
              ELSE
                  (v_effective_region IS NULL OR c.region = v_effective_region)
          END
      );

    -- 2. > 3 Days Critical Backlog
    SELECT count(*) INTO v_critical_backlog
    FROM public.open_calls_master ocm
    LEFT JOIN public.cci_master c ON ocm.cci_code = c.cci_code
    WHERE ocm.is_open = TRUE
      AND ocm.carry_in_time <= (now() - interval '3 days')
      AND (v_filter_cci IS NULL OR ocm.cci_code = v_filter_cci)
      AND (
          CASE 
              WHEN v_caller_role = 'BSM' THEN
                  (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                  OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
              ELSE
                  (v_effective_region IS NULL OR c.region = v_effective_region)
          END
      );

    -- 3. Intimated (ETR Committed & Completed)
    SELECT count(DISTINCT ocm.service_order) INTO v_intimated_count
    FROM public.open_calls_master ocm
    JOIN public.intimation_calling ic ON ocm.service_order = ic.service_order
    LEFT JOIN public.cci_master c ON ocm.cci_code = c.cci_code
    WHERE ocm.is_open = TRUE
      AND ic.calling_status = 'Completed'
      AND (v_filter_cci IS NULL OR ocm.cci_code = v_filter_cci)
      AND (
          CASE 
              WHEN v_caller_role = 'BSM' THEN
                  (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                  OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
              ELSE
                  (v_effective_region IS NULL OR c.region = v_effective_region)
          END
      );

    -- 4. Pending Intimation (>3 days with no completed intimation)
    v_pending_intimation := GREATEST(0, v_critical_backlog - v_intimated_count);

    -- 5. Non-completed attempts
    SELECT count(*) INTO v_not_reachable
    FROM public.intimation_calling ic
    JOIN public.open_calls_master ocm ON ic.service_order = ocm.service_order
    LEFT JOIN public.cci_master c ON ocm.cci_code = c.cci_code
    WHERE ocm.is_open = TRUE
      AND ic.calling_status = 'Customer Not Reachable'
      AND (v_filter_cci IS NULL OR ocm.cci_code = v_filter_cci)
      AND (
          CASE 
              WHEN v_caller_role = 'BSM' THEN
                  (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                  OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
              ELSE
                  (v_effective_region IS NULL OR c.region = v_effective_region)
          END
      );

    SELECT count(*) INTO v_call_back
    FROM public.intimation_calling ic
    JOIN public.open_calls_master ocm ON ic.service_order = ocm.service_order
    LEFT JOIN public.cci_master c ON ocm.cci_code = c.cci_code
    WHERE ocm.is_open = TRUE
      AND ic.calling_status = 'Call Back Required'
      AND (v_filter_cci IS NULL OR ocm.cci_code = v_filter_cci)
      AND (
          CASE 
              WHEN v_caller_role = 'BSM' THEN
                  (v_effective_region IS NOT NULL AND c.region = v_effective_region)
                  OR (v_effective_region IS NULL AND c.region = ANY(v_bsm_regions))
              ELSE
                  (v_effective_region IS NULL OR c.region = v_effective_region)
          END
      );

    RETURN jsonb_build_object(
        'total_open', v_total_open,
        'critical_backlog', v_critical_backlog,
        'intimated_count', v_intimated_count,
        'pending_intimation', v_pending_intimation,
        'not_reachable', v_not_reachable,
        'call_back', v_call_back,
        'caller_role', v_caller_role,
        'assigned_regions', v_bsm_regions
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_intimation_dashboard(TEXT, TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_intimation_dashboard(TEXT, TEXT) TO authenticated, service_role;
