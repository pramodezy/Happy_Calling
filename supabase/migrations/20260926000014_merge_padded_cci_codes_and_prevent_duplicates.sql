-- ============================================================================
-- Migration: Merge Padded Station Codes (e.g. '062' -> '62') & Prevent Duplicates
-- Description:
--   1. Deletes duplicate padded closures where unpadded record already exists (prevents unique constraint error)
--   2. Updates remaining padded closures, feedback, and open calls to unpadded codes
--   3. Deletes auto-created duplicate '0xx' entries from cci_master
--   4. Updates import_closures_batch() to match codes with or without leading zeros
-- ============================================================================

-- Step 1A: Delete duplicate padded closures where the unpadded record already exists
-- (Prevents ERROR 23505: duplicate key violates unique constraint "uq_closure_record")
DELETE FROM public.closure_master cm_padded
WHERE cm_padded.cci_code ~ '^0+\d+$'
  AND EXISTS (
      SELECT 1 FROM public.closure_master cm_real
      WHERE cm_real.closure_id = cm_padded.closure_id
        AND cm_real.so_number = cm_padded.so_number
        AND cm_real.cci_code = ltrim(cm_padded.cci_code, '0')
  );

-- Step 1B: Reassign remaining closures in closure_master to the unpadded code
UPDATE public.closure_master cm
SET cci_code = ltrim(cm.cci_code, '0'),
    cci_name = COALESCE(
        (SELECT cci_name FROM public.cci_master WHERE cci_code = ltrim(cm.cci_code, '0')),
        cm.cci_name
    )
WHERE cm.cci_code ~ '^0+\d+$'
  AND EXISTS (
      SELECT 1 FROM public.cci_master c 
      WHERE c.cci_code = ltrim(cm.cci_code, '0')
  );

-- Step 2A: Delete duplicate padded happy calling records if unpadded already exists
DELETE FROM public.happy_calling hc_padded
WHERE hc_padded.cci_code ~ '^0+\d+$'
  AND EXISTS (
      SELECT 1 FROM public.happy_calling hc_real
      WHERE hc_real.closure_id = hc_padded.closure_id
        AND hc_real.so_number = hc_padded.so_number
        AND hc_real.cci_code = ltrim(hc_padded.cci_code, '0')
  );

-- Step 2B: Reassign remaining happy_calling feedback records to unpadded
UPDATE public.happy_calling hc
SET cci_code = ltrim(hc.cci_code, '0')
WHERE hc.cci_code ~ '^0+\d+$'
  AND EXISTS (
      SELECT 1 FROM public.cci_master c 
      WHERE c.cci_code = ltrim(hc.cci_code, '0')
  );

-- Step 3A: Delete duplicate padded open calls if unpadded already exists
DELETE FROM public.open_calls_master ocm_padded
WHERE ocm_padded.cci_code ~ '^0+\d+$'
  AND EXISTS (
      SELECT 1 FROM public.open_calls_master ocm_real
      WHERE ocm_real.service_order = ocm_padded.service_order
        AND ocm_real.cci_code = ltrim(ocm_padded.cci_code, '0')
  );

-- Step 3B: Reassign remaining open_calls_master records to unpadded
UPDATE public.open_calls_master ocm
SET cci_code = ltrim(ocm.cci_code, '0')
WHERE ocm.cci_code ~ '^0+\d+$'
  AND EXISTS (
      SELECT 1 FROM public.cci_master c 
      WHERE c.cci_code = ltrim(ocm.cci_code, '0')
  );

-- Step 4: Reassign user_profiles if any were mistakenly linked to padded codes
UPDATE public.user_profiles up
SET cci_code = ltrim(up.cci_code, '0')
WHERE up.cci_code ~ '^0+\d+$'
  AND EXISTS (
      SELECT 1 FROM public.cci_master c 
      WHERE c.cci_code = ltrim(up.cci_code, '0')
  );

-- Step 5: Delete all the auto-created duplicate padded records from cci_master
DELETE FROM public.cci_master c_padded
WHERE c_padded.cci_code ~ '^0+\d+$'
  AND EXISTS (
      SELECT 1 FROM public.cci_master c_real 
      WHERE c_real.cci_code = ltrim(c_padded.cci_code, '0')
  );

-- Step 6: Update import_closures_batch() with flexible matching (matches '062' <-> '62')
CREATE OR REPLACE FUNCTION public.import_closures_batch(
    p_closures JSONB,
    p_batch_id UUID DEFAULT NULL
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
    v_matched_cci_code TEXT;
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
    IF NOT public.is_admin() THEN
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

            -- Match existing CCI in cci_master: exact match first, then without leading zeros, then with leading zeros
            SELECT cci_code INTO v_matched_cci_code 
            FROM public.cci_master 
            WHERE cci_code = v_cci_code 
               OR (v_cci_code ~ '^0+\d+$' AND cci_code = ltrim(v_cci_code, '0'))
               OR (cci_code ~ '^0+\d+$' AND ltrim(cci_code, '0') = v_cci_code)
            LIMIT 1;

            IF v_matched_cci_code IS NOT NULL THEN
                v_cci_code := v_matched_cci_code;
            ELSE
                -- If purely numeric with leading zeros, normalize before inserting new
                IF v_cci_code ~ '^0+\d+$' THEN
                    v_cci_code := ltrim(v_cci_code, '0');
                END IF;

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
                    closure_date = COALESCE(v_closure_date, closure_date),
                    repair_complete_date = COALESCE(v_repair_complete_date, repair_complete_date),
                    repair_creation_date = COALESCE(v_repair_creation_date, repair_creation_date),
                    warranty_status = COALESCE(v_warranty_status, warranty_status),
                    repair_type = COALESCE(v_repair_type, repair_type),
                    source_data = COALESCE(v_source_data, source_data),
                    import_batch_id = COALESCE(p_batch_id, import_batch_id),
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
                    warranty_status, repair_type,
                    source_data, import_batch_id
                ) VALUES (
                    v_closure_id, v_so_number, v_cci_code, v_cci_name,
                    v_customer_name, v_customer_mobile, v_model,
                    v_repair_creation_date, v_repair_complete_date, v_closure_date,
                    v_warranty_status, v_repair_type,
                    v_source_data, p_batch_id
                );

                v_inserted := v_inserted + 1;
            END IF;

        EXCEPTION WHEN OTHERS THEN
            v_rejected := v_rejected + 1;
            v_rejections := v_rejections || jsonb_build_object(
                'closure_id', v_item->>'closure_id',
                'so_number', v_item->>'so_number',
                'error', SQLERRM
            );
        END;
    END LOOP;

    -- Update batch record if batch_id provided
    IF p_batch_id IS NOT NULL THEN
        UPDATE public.closure_import_batches
        SET inserted_count = v_inserted,
            updated_count = v_updated,
            rejected_count = v_rejected,
            status = 'COMPLETED',
            error_log = v_rejections
        WHERE id = p_batch_id;
    END IF;

    -- Audit log entry
    BEGIN
        INSERT INTO public.audit_log (
            user_id, role, action, description, metadata
        ) VALUES (
            auth.uid(),
            'ADMIN',
            'CLOSURE_IMPORT',
            format('Batch imported %s closures (%s inserted, %s updated, %s rejected)',
                   v_inserted + v_updated, v_inserted, v_updated, v_rejected),
            jsonb_build_object(
                'batch_id', p_batch_id,
                'inserted', v_inserted,
                'updated', v_updated,
                'rejected', v_rejected
            )
        );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'inserted', v_inserted,
        'updated', v_updated,
        'rejected', v_rejected,
        'rejections', v_rejections
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_closures_batch(JSONB, UUID) TO authenticated, service_role;
