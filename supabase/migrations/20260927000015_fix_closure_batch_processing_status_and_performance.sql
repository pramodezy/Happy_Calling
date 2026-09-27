-- ============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260927000015
-- FIX CLOSURE IMPORT BATCH "PROCESSING" STATUS BUG & RESTORE INGESTION SPEED
-- ============================================================================
-- Description:
--   1. Adds missing 'error_log' column to public.closure_import_batches (resolves PostgreSQL 42703).
--   2. Heals existing import batches stuck in 'PROCESSING' status.
--   3. Recreates import_closures_batch() with:
--        - Fast indexed CCI code matching (eliminating slow table-scan regexes).
--        - Proper batch counter accumulation across chunks (inserted_count + v_inserted).
--        - Safe update of batch status to 'COMPLETED'.
--        - Safe exception isolation so batch metadata updates never roll back imported closures.
--   4. Adds finalize_closure_import_batch() helper for guaranteed client-side sync.
-- ============================================================================

-- 1. ADD MISSING error_log COLUMN TO closure_import_batches
ALTER TABLE public.closure_import_batches 
    ADD COLUMN IF NOT EXISTS error_log JSONB DEFAULT '[]'::jsonb;

-- 2. HEAL EXISTING STUCK BATCHES
-- 2.1 Re-link and mark batches COMPLETED if they already have closures in closure_master
UPDATE public.closure_import_batches b
SET status = 'COMPLETED',
    inserted_count = GREATEST(b.inserted_count, (
        SELECT count(*) FROM public.closure_master cm WHERE cm.import_batch_id = b.id
    ))
WHERE b.status = 'PROCESSING'
  AND (
    b.inserted_count > 0 
    OR b.updated_count > 0 
    OR EXISTS (SELECT 1 FROM public.closure_master cm WHERE cm.import_batch_id = b.id)
  );

-- 2.2 Mark any remaining empty abandoned batches older than 30 minutes as FAILED
UPDATE public.closure_import_batches
SET status = 'FAILED',
    metadata = metadata || '{"failure_reason": "Batch ingestion did not complete or timed out"}'::jsonb
WHERE status = 'PROCESSING'
  AND created_at < (now() - INTERVAL '30 minutes');

-- 3. RECREATE import_closures_batch() WITH HIGH PERFORMANCE & ACCURATE BATCH STATUS
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
    v_raw_cci_code TEXT;
    v_cci_code TEXT;
    v_clean_cci_code TEXT;
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
            v_raw_cci_code := UPPER(TRIM(COALESCE(v_item->>'cci_code', '')));
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
            IF v_raw_cci_code IS NULL OR v_raw_cci_code = '' THEN
                RAISE EXCEPTION 'Missing CCI Code';
            END IF;

            -- High-performance indexed station matching (O(1) index lookups vs slow full-table regex scans)
            IF v_raw_cci_code ~ '^0+\d+$' THEN
                v_clean_cci_code := ltrim(v_raw_cci_code, '0');
            ELSE
                v_clean_cci_code := v_raw_cci_code;
            END IF;

            -- 1. Try exact match on unpadded code first (e.g. '62')
            SELECT cci_code INTO v_matched_cci_code
            FROM public.cci_master
            WHERE cci_code = v_clean_cci_code
            LIMIT 1;

            -- 2. Try raw code if different (e.g. '062')
            IF v_matched_cci_code IS NULL AND v_clean_cci_code <> v_raw_cci_code THEN
                SELECT cci_code INTO v_matched_cci_code
                FROM public.cci_master
                WHERE cci_code = v_raw_cci_code
                LIMIT 1;
            END IF;

            IF v_matched_cci_code IS NOT NULL THEN
                v_cci_code := v_matched_cci_code;
            ELSE
                -- Auto-create missing CCI normalized to maintain foreign key integrity
                v_cci_code := v_clean_cci_code;
                INSERT INTO public.cci_master (cci_code, cci_name, region, location, status)
                VALUES (v_cci_code, COALESCE(v_cci_name, v_cci_code), 'General', 'General', 'ACTIVE')
                ON CONFLICT (cci_code) DO NOTHING;
            END IF;

            -- Parse dates
            v_closure_date := COALESCE((v_item->>'closure_date')::timestamptz, now());
            v_repair_complete_date := (v_item->>'repair_complete_date')::timestamptz;
            v_repair_creation_date := (v_item->>'repair_creation_date')::timestamptz;

            -- Check if record already exists (uses unique index uq_closure_record)
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
                    v_closure_id, v_so_number, v_cci_code, COALESCE(v_cci_name, v_cci_code),
                    COALESCE(v_customer_name, 'Valued Customer'),
                    COALESCE(v_customer_mobile, 'N/A'),
                    COALESCE(v_model, 'Motorola Device'),
                    v_repair_creation_date, v_repair_complete_date, v_closure_date,
                    v_warranty_status, v_repair_type,
                    v_source_data, p_batch_id
                );

                v_inserted := v_inserted + 1;
            END IF;

        EXCEPTION WHEN OTHERS THEN
            v_rejected := v_rejected + 1;
            v_rejections := v_rejections || jsonb_build_object(
                'record', v_item,
                'closure_id', v_item->>'closure_id',
                'so_number', v_item->>'so_number',
                'reason', SQLERRM
            );
        END;
    END LOOP;

    -- Update batch tracking record if batch_id provided (accumulate counters across chunks)
    IF p_batch_id IS NOT NULL THEN
        BEGIN
            UPDATE public.closure_import_batches
            SET inserted_count = inserted_count + v_inserted,
                updated_count = updated_count + v_updated,
                rejected_count = rejected_count + v_rejected,
                status = 'COMPLETED',
                error_log = COALESCE(error_log, '[]'::jsonb) || v_rejections
            WHERE id = p_batch_id;
        EXCEPTION WHEN OTHERS THEN
            -- Isolate batch table update error so closure records are never rolled back
            NULL;
        END;
    END IF;

    -- Audit log entry
    BEGIN
        INSERT INTO public.audit_log (
            user_id, role, action, description, metadata
        ) VALUES (
            auth.uid(),
            'ADMIN',
            'CLOSURE_IMPORT',
            format('Batch chunk imported %s closures (%s inserted, %s updated, %s rejected)',
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
        'rejections', v_rejections,
        'batch_id', p_batch_id
    );
END;
$$;

-- 4. HELPER RPC TO EXPLICITLY FINALIZE BATCH STATUS FROM CLIENT
CREATE OR REPLACE FUNCTION public.finalize_closure_import_batch(
    p_batch_id UUID,
    p_status TEXT DEFAULT 'COMPLETED',
    p_inserted INT DEFAULT NULL,
    p_updated INT DEFAULT NULL,
    p_rejected INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Forbidden: Only administrators can finalize import batches';
    END IF;

    UPDATE public.closure_import_batches
    SET status = CASE 
            WHEN p_status IN ('COMPLETED', 'FAILED', 'REVERTED') THEN p_status 
            ELSE 'COMPLETED' 
        END,
        inserted_count = COALESCE(p_inserted, inserted_count),
        updated_count = COALESCE(p_updated, updated_count),
        rejected_count = COALESCE(p_rejected, rejected_count)
    WHERE id = p_batch_id;

    RETURN jsonb_build_object('success', true, 'batch_id', p_batch_id);
END;
$$;

-- 5. MANDATORY EXECUTE GRANTS
GRANT EXECUTE ON FUNCTION public.import_closures_batch(JSONB, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_closure_import_batch(UUID, TEXT, INT, INT, INT) TO authenticated, service_role;
