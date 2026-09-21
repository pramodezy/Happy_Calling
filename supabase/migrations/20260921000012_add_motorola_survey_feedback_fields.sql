-- ============================================================================
-- Migration: 20260921000012_add_motorola_survey_feedback_fields.sql
-- Description: Adds mandatory Motorola Survey verification columns to happy_calling
--              and updates submit_happy_calling RPC function to validate and record them.
-- ============================================================================

-- 1. Add survey verification columns to happy_calling
ALTER TABLE public.happy_calling
ADD COLUMN IF NOT EXISTS survey_email_received VARCHAR(10) CHECK (survey_email_received IN ('Yes', 'No')),
ADD COLUMN IF NOT EXISTS survey_submitted VARCHAR(10) CHECK (survey_submitted IN ('Yes', 'No'));

-- 2. Add indexing for survey reporting and analytics
CREATE INDEX IF NOT EXISTS idx_happy_calling_survey_email ON public.happy_calling(survey_email_received);
CREATE INDEX IF NOT EXISTS idx_happy_calling_survey_submitted ON public.happy_calling(survey_submitted);

-- 3. Update submit_happy_calling RPC function
CREATE OR REPLACE FUNCTION public.submit_happy_calling(
    p_closure_id TEXT,
    p_so_number TEXT,
    p_cci_code TEXT,
    p_calling_status TEXT,
    p_customer_rating INT DEFAULT NULL,
    p_feedback_category TEXT DEFAULT NULL,
    p_customer_remarks TEXT DEFAULT NULL,
    p_cci_remarks TEXT DEFAULT NULL,
    p_survey_email_received TEXT DEFAULT NULL,
    p_survey_submitted TEXT DEFAULT NULL
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

        -- Mandatory Motorola Survey confirmations for Completed feedback calls
        IF p_survey_email_received IS NULL OR p_survey_email_received NOT IN ('Yes', 'No') THEN
            RAISE EXCEPTION 'Motorola Survey Email confirmation (Yes/No) is required for Completed calls';
        END IF;

        IF p_survey_submitted IS NULL OR p_survey_submitted NOT IN ('Yes', 'No') THEN
            RAISE EXCEPTION 'Motorola Survey submission confirmation (Yes/No) is required for Completed calls';
        END IF;

        -- Logical integrity: Cannot submit survey if email was not received
        IF p_survey_email_received = 'No' AND p_survey_submitted = 'Yes' THEN
            RAISE EXCEPTION 'Customer cannot submit survey if survey email was not received';
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
        cci_remarks,
        survey_email_received,
        survey_submitted
    ) VALUES (
        p_closure_id,
        p_so_number,
        p_cci_code,
        v_closure.cci_name,
        CURRENT_DATE,
        CURRENT_TIME,
        v_auth_id,
        p_calling_status,
        CASE WHEN p_calling_status = 'Completed' THEN p_customer_rating ELSE NULL END,
        CASE WHEN p_calling_status = 'Completed' THEN p_feedback_category ELSE NULL END,
        p_customer_remarks,
        p_cci_remarks,
        CASE WHEN p_calling_status = 'Completed' THEN p_survey_email_received ELSE NULL END,
        CASE WHEN p_calling_status = 'Completed' THEN p_survey_submitted ELSE NULL END
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
            'survey_email_received', p_survey_email_received,
            'survey_submitted', p_survey_submitted,
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
