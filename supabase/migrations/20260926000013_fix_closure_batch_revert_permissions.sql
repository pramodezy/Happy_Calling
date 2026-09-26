-- ============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260926000013
-- FIX CLOSURE IMPORT BATCH REVERT PERMISSIONS & OVERLOAD RESOLUTION
-- ============================================================================

-- 1. DROP OBSOLETE OVERLOADED FUNCTIONS (Resolves PostgREST PGRST203)
DROP FUNCTION IF EXISTS public.import_closures_batch(JSONB);

-- 2. ENSURE RLS AND GRANTS ON BATCH TRACKING TABLE
GRANT ALL ON public.closure_import_batches TO authenticated, service_role;
GRANT ALL ON public.closure_master TO authenticated, service_role;

DROP POLICY IF EXISTS "Admin full access on closure_import_batches" ON public.closure_import_batches;
CREATE POLICY "Admin full access on closure_import_batches"
    ON public.closure_import_batches
    FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- 3. ENSURE is_admin() CHECKS BOTH 'ADMIN' AND 'SUPER_ADMIN'
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE auth_user_id = auth.uid() 
          AND role IN ('ADMIN', 'SUPER_ADMIN') 
          AND status = 'ACTIVE'
    );
$$;

-- 4. RECREATE BATCH TRACKING FUNCTIONS WITH PROPER GRANTS & NULL SAFETY

-- 4.1 create_closure_import_batch
CREATE OR REPLACE FUNCTION public.create_closure_import_batch(
    p_file_name TEXT,
    p_total_rows INT DEFAULT 0,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_batch_id UUID;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Forbidden: Only administrators can create import batches';
    END IF;

    INSERT INTO public.closure_import_batches (
        file_name, total_rows, status, created_by, metadata
    ) VALUES (
        COALESCE(NULLIF(TRIM(p_file_name), ''), 'Unnamed Batch'),
        GREATEST(0, p_total_rows),
        'PROCESSING',
        auth.uid(),
        COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_batch_id;

    RETURN v_batch_id;
END;
$$;

-- 4.2 check_closure_batch_status (Pre-flight inspection)
CREATE OR REPLACE FUNCTION public.check_closure_batch_status(
    p_batch_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_batch RECORD;
    v_total INT := 0;
    v_called INT := 0;
    v_safe_to_delete INT := 0;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Forbidden: Only administrators can inspect batch status';
    END IF;

    SELECT * INTO v_batch FROM public.closure_import_batches WHERE id = p_batch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Batch not found: %', p_batch_id;
    END IF;

    -- Total closures currently in closure_master belonging to this batch
    SELECT count(*) INTO v_total
    FROM public.closure_master
    WHERE import_batch_id = p_batch_id;

    -- Closures in this batch that have calling records in happy_calling
    SELECT count(DISTINCT cm.id) INTO v_called
    FROM public.closure_master cm
    JOIN public.happy_calling hc 
      ON cm.closure_id = hc.closure_id 
     AND cm.so_number = hc.so_number
    WHERE cm.import_batch_id = p_batch_id;

    v_safe_to_delete := GREATEST(0, v_total - v_called);

    RETURN jsonb_build_object(
        'batch_id', v_batch.id,
        'file_name', v_batch.file_name,
        'status', v_batch.status,
        'created_at', v_batch.created_at,
        'total_rows', v_batch.total_rows,
        'inserted_count', v_batch.inserted_count,
        'updated_count', v_batch.updated_count,
        'rejected_count', v_batch.rejected_count,
        'total_current_in_master', v_total,
        'called_count', v_called,
        'safe_to_delete_count', v_safe_to_delete,
        'is_reverted', (v_batch.status = 'REVERTED'),
        'reverted_at', v_batch.reverted_at,
        'reverted_count', v_batch.reverted_count
    );
END;
$$;

-- 4.3 revert_closure_batch (Safe revert with NOT EXISTS and audit trail)
CREATE OR REPLACE FUNCTION public.revert_closure_batch(
    p_batch_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_batch RECORD;
    v_deleted_count INT := 0;
    v_called_count INT := 0;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Forbidden: Only administrators can revert closure batches';
    END IF;

    SELECT * INTO v_batch FROM public.closure_import_batches WHERE id = p_batch_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Batch not found: %', p_batch_id;
    END IF;

    IF v_batch.status = 'REVERTED' THEN
        RAISE EXCEPTION 'Batch has already been reverted on %', v_batch.reverted_at;
    END IF;

    -- Count how many closures in this batch have already been called
    SELECT count(DISTINCT cm.id) INTO v_called_count
    FROM public.closure_master cm
    JOIN public.happy_calling hc 
      ON cm.closure_id = hc.closure_id 
     AND cm.so_number = hc.so_number
    WHERE cm.import_batch_id = p_batch_id;

    -- Safely delete uncalled closures belonging to this batch (NULL-safe NOT EXISTS)
    WITH deleted AS (
        DELETE FROM public.closure_master cm
        WHERE cm.import_batch_id = p_batch_id
          AND NOT EXISTS (
              SELECT 1 FROM public.happy_calling hc
              WHERE hc.closure_id = cm.closure_id
                AND hc.so_number = cm.so_number
          )
        RETURNING cm.id
    )
    SELECT count(*) INTO v_deleted_count FROM deleted;

    -- Disconnect remaining called closures from this batch so they are permanently preserved
    UPDATE public.closure_master
    SET import_batch_id = NULL
    WHERE import_batch_id = p_batch_id;

    -- Update batch record to REVERTED
    UPDATE public.closure_import_batches
    SET status = 'REVERTED',
        reverted_at = now(),
        reverted_by = auth.uid(),
        reverted_count = v_deleted_count
    WHERE id = p_batch_id;

    -- Audit Log Entry
    INSERT INTO public.audit_log (
        user_id, role, action, description, metadata
    ) VALUES (
        auth.uid(),
        'ADMIN',
        'CLOSURE_BATCH_REVERT',
        format('Reverted closure batch "%s": %s uncalled records deleted, %s called records protected', 
               v_batch.file_name, v_deleted_count, v_called_count),
        jsonb_build_object(
            'batch_id', p_batch_id,
            'file_name', v_batch.file_name,
            'deleted_count', v_deleted_count,
            'protected_count', v_called_count
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'batch_id', p_batch_id,
        'file_name', v_batch.file_name,
        'deleted_count', v_deleted_count,
        'protected_count', v_called_count,
        'reverted_at', now()
    );
END;
$$;

-- 4.4 import_closures_batch (2-parameter version with batch linking)
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
                    warranty_status, repair_type,
                    repair_creation_date, repair_complete_date, closure_date,
                    source_data, import_batch_id
                ) VALUES (
                    v_closure_id, v_so_number, v_cci_code, COALESCE(v_cci_name, v_cci_code),
                    COALESCE(v_customer_name, 'Valued Customer'),
                    COALESCE(v_customer_mobile, 'N/A'),
                    COALESCE(v_model, 'Motorola Device'),
                    v_warranty_status,
                    v_repair_type,
                    v_repair_creation_date, v_repair_complete_date, v_closure_date,
                    v_source_data, p_batch_id
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

    -- If batch provided, accumulate batch counters
    IF p_batch_id IS NOT NULL THEN
        UPDATE public.closure_import_batches
        SET inserted_count = inserted_count + v_inserted,
            updated_count = updated_count + v_updated,
            rejected_count = rejected_count + v_rejected,
            status = 'COMPLETED'
        WHERE id = p_batch_id;
    END IF;

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

-- 5. MANDATORY EXECUTE GRANTS (Allows PostgREST authenticated calls)
GRANT EXECUTE ON FUNCTION public.create_closure_import_batch(TEXT, INT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_closure_batch_status(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revert_closure_batch(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_closures_batch(JSONB, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role, anon;
