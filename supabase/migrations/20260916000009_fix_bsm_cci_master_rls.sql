-- ============================================================================
-- MOTOROLA HAPPY CALLING: MIGRATION 20260916000009
-- FIX: STRICT RLS SCOPING FOR CCI_MASTER ON BSM LOGINS
-- ============================================================================

-- 1. Drop the legacy permissive policy that allowed any authenticated user to read all active CCIs
DROP POLICY IF EXISTS "cci_master_user_select" ON public.cci_master;

-- 2. Drop and recreate the scoped SELECT policy for cci_master
DROP POLICY IF EXISTS "BSM and User read cci_master" ON public.cci_master;

CREATE POLICY "BSM and User read cci_master" ON public.cci_master
    FOR SELECT
    TO authenticated
    USING (
        -- Admins have nationwide access
        public.is_admin()
        
        -- BSM users can ONLY access CCIs belonging to their assigned regional spokes
        OR (public.is_bsm() AND region = ANY(public.get_user_assigned_regions()))
        
        -- Non-admin, non-BSM users (CCI agents) can view active stations or their own station
        OR (NOT public.is_bsm() AND NOT public.is_admin() AND status = 'ACTIVE')
    );
