-- ============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260913000002
-- 1. Add warranty_status and repair_type columns to closure_master
-- 2. Update get_next_pending_closure() RPC to return source_data, warranty, and repair type
-- 3. Update import_closures_batch() to store warranty_status and repair_type
-- 4. Clean up legacy demo CCIs (BLR01, DEL01, MUM01, KOC01, KOL01)
-- ============================================================================

-- 1. ADD COLUMNS
ALTER TABLE public.closure_master ADD COLUMN IF NOT EXISTS warranty_status TEXT;
ALTER TABLE public.closure_master ADD COLUMN IF NOT EXISTS repair_type TEXT;

-- Populate warranty_status & repair_type from existing source_data if available
UPDATE public.closure_master
SET 
    warranty_status = COALESCE(
        warranty_status,
        source_data->>'Warranty Status',
        source_data->>'warranty_status',
        source_data->>'Warranty',
        source_data->>'warranty',
        source_data->>'Warranty Type',
        source_data->>'IW/OOW',
        source_data->>'In Warranty'
    ),
    repair_type = COALESCE(
        repair_type,
        source_data->>'Repair Type',
        source_data->>'repair_type',
        source_data->>'Job Type',
        source_data->>'job_type',
        source_data->>'Type of Repair',
        source_data->>'Service Type',
        source_data->>'Repair Nature'
    )
WHERE warranty_status IS NULL OR repair_type IS NULL;

-- 2. UPDATE get_next_pending_closure()
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
        cm.repair_creation_date,
        cm.warranty_status,
        cm.repair_type,
        cm.source_data
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

-- 3. UPDATE import_closures_batch() TO UPSERT WARRANTY & REPAIR TYPE
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
    v_exists BOOLEAN;
    v_closure_id TEXT;
    v_so_number TEXT;
    v_cci_code TEXT;
    v_cci_name TEXT;
    v_customer_name TEXT;
    v_customer_mobile TEXT;
    v_model TEXT;
    v_closure_date TIMESTAMPTZ;
    v_repair_complete_date TIMESTAMPTZ;
    v_repair_creation_date TIMESTAMPTZ;
    v_warranty_status TEXT;
    v_repair_type TEXT;
    v_source_data JSONB;
BEGIN
    -- Verify admin role
    IF NOT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE auth_user_id = auth.uid() AND role = 'ADMIN'
    ) THEN
        RAISE EXCEPTION 'Forbidden: Only administrators can import closure data';
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
            v_warranty_status := TRIM(v_item->>'warranty_status');
            v_repair_type := TRIM(v_item->>'repair_type');
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
                    warranty_status = COALESCE(v_warranty_status, warranty_status),
                    repair_type = COALESCE(v_repair_type, repair_type),
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
                    warranty_status, repair_type,
                    repair_creation_date, repair_complete_date, closure_date,
                    source_data
                ) VALUES (
                    v_closure_id, v_so_number, v_cci_code, COALESCE(v_cci_name, v_cci_code),
                    COALESCE(v_customer_name, 'Valued Customer'),
                    COALESCE(v_customer_mobile, 'N/A'),
                    COALESCE(v_model, 'Motorola Device'),
                    v_warranty_status,
                    v_repair_type,
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

    RETURN jsonb_build_object(
        'success', true,
        'inserted', v_inserted,
        'updated', v_updated,
        'rejected', v_rejected,
        'rejections', v_rejections
    );
END;
$$;

-- 4. PURGE PREVIOUS DEMO CCIs IF REAL STATIONS EXIST
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.cci_master 
        WHERE cci_code NOT IN ('BLR01', 'DEL01', 'MUM01', 'KOC01', 'KOL01')
    ) THEN
        DELETE FROM public.closure_master WHERE cci_code IN ('BLR01', 'DEL01', 'MUM01', 'KOC01', 'KOL01');
        DELETE FROM public.happy_calling WHERE cci_code IN ('BLR01', 'DEL01', 'MUM01', 'KOC01', 'KOL01');
        DELETE FROM public.user_profiles WHERE cci_code IN ('BLR01', 'DEL01', 'MUM01', 'KOC01', 'KOL01');
        DELETE FROM public.cci_master WHERE cci_code IN ('BLR01', 'DEL01', 'MUM01', 'KOC01', 'KOL01');
    END IF;
END $$;
