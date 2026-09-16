-- ============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260916000008
-- ADMIN RPC: DYNAMIC UPDATE OF BSM ASSIGNED REGIONS & AUDIT LOGGING
-- ============================================================================

-- 1. Create or replace admin_update_bsm_regions RPC
CREATE OR REPLACE FUNCTION public.admin_update_bsm_regions(
    p_user_profile_id UUID,
    p_assigned_regions TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
    v_target_user_name TEXT;
    v_target_role TEXT;
    v_admin_name TEXT;
BEGIN
    -- Only Admin can update assigned regions
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object(
            'success', false, 
            'error', 'Unauthorized: Only system administrators can update assigned regions.'
        );
    END IF;

    -- Verify target user exists and get current details
    SELECT user_name, role INTO v_target_user_name, v_target_role
    FROM public.user_profiles
    WHERE id = p_user_profile_id;

    IF v_target_user_name IS NULL THEN
        RETURN jsonb_build_object(
            'success', false, 
            'error', 'Target user profile not found.'
        );
    END IF;

    -- Fetch acting admin name
    SELECT user_name INTO v_admin_name
    FROM public.user_profiles
    WHERE auth_user_id = auth.uid();

    -- Update assigned regions in user_profiles
    UPDATE public.user_profiles
    SET assigned_regions = COALESCE(p_assigned_regions, '{}'::TEXT[]),
        updated_at = NOW()
    WHERE id = p_user_profile_id;

    -- Record audit log entry
    INSERT INTO public.audit_log (
        user_id,
        user_name,
        role,
        action,
        description,
        metadata
    ) VALUES (
        auth.uid(),
        COALESCE(v_admin_name, 'Admin'),
        'ADMIN',
        'BSM_REGIONS_UPDATED',
        'Updated assigned regions for ' || v_target_user_name || ' to [' || array_to_string(COALESCE(p_assigned_regions, '{}'::TEXT[]), ', ') || ']',
        jsonb_build_object(
            'target_profile_id', p_user_profile_id,
            'target_user_name', v_target_user_name,
            'target_role', v_target_role,
            'assigned_regions', COALESCE(p_assigned_regions, '{}'::TEXT[])
        )
    );

    RETURN jsonb_build_object(
        'success', true, 
        'message', 'Successfully updated assigned regions for ' || v_target_user_name,
        'assigned_regions', COALESCE(p_assigned_regions, '{}'::TEXT[])
    );
END;
$$;

-- Grant execution to authenticated users
GRANT EXECUTE ON FUNCTION public.admin_update_bsm_regions(UUID, TEXT[]) TO authenticated;

-- 2. Ensure user_profiles has explicit RLS update policy for Admin
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' 
          AND tablename = 'user_profiles' 
          AND policyname = 'user_profiles_admin_update'
    ) THEN
        CREATE POLICY "user_profiles_admin_update" ON public.user_profiles
        FOR UPDATE TO authenticated
        USING (public.is_admin())
        WITH CHECK (public.is_admin());
    END IF;
END $$;
