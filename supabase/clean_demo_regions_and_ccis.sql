-- ============================================================================
-- MOTOROLA HAPPY CALLING: CLEANUP LEGACY DEMO CCIs & INITIAL SEED DATA
-- Run in Supabase SQL Editor -> New Query -> Run
-- This purges the initial sample demo data (BLR01, DEL01, MUM01, KOC01, KOL01)
-- so only real station codes (e.g. 1, 2, 3...) and their regions appear in filters.
-- ============================================================================

DO $$
DECLARE
    v_closures_deleted INT := 0;
    v_ccis_deleted INT := 0;
    v_users_deleted INT := 0;
BEGIN
    -- 1. Remove initial demo closures
    DELETE FROM public.closure_master
    WHERE closure_id IN ('CLO-1001', 'CLO-1002', 'CLO-1003', 'CLO-1004', 'CLO-1005')
       OR cci_code IN ('BLR01', 'DEL01', 'MUM01', 'KOC01', 'KOL01');
    GET DIAGNOSTICS v_closures_deleted = ROW_COUNT;

    -- 2. Remove calling records on demo closures if any
    DELETE FROM public.happy_calling
    WHERE cci_code IN ('BLR01', 'DEL01', 'MUM01', 'KOC01', 'KOL01');

    -- 3. Remove user profiles linked to demo CCIs
    DELETE FROM public.user_profiles
    WHERE cci_code IN ('BLR01', 'DEL01', 'MUM01', 'KOC01', 'KOL01');
    GET DIAGNOSTICS v_users_deleted = ROW_COUNT;

    -- 4. Remove demo entries from cci_master
    DELETE FROM public.cci_master
    WHERE cci_code IN ('BLR01', 'DEL01', 'MUM01', 'KOC01', 'KOL01');
    GET DIAGNOSTICS v_ccis_deleted = ROW_COUNT;

    RAISE NOTICE 'SUCCESS: % sample closures, % sample user profiles, and % sample CCIs deleted.', 
        v_closures_deleted, v_users_deleted, v_ccis_deleted;
END $$;
