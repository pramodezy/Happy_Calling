-- ============================================================================
-- MOTOROLA HAPPY CALLING: RESET NON-ADMIN USERS & REGENERATE FROM cci_master
-- Paste and Run in: Supabase Dashboard -> SQL Editor -> New Query -> Run
-- 
-- 1. Keeps only Admin users (wipes all stale/test station accounts)
-- 2. Scans public.cci_master for station codes
-- 3. Creates clean auth accounts:
--    - Username: cci_<station_code> (e.g. cci_1, cci_65)
--    - Default Password: Moto@123
--    - Active profile in public.user_profiles
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
DECLARE
    r RECORD;
    v_clean_code TEXT;
    v_username TEXT;
    v_email TEXT;
    v_auth_id UUID;
    v_pw TEXT := crypt('Moto@123', gen_salt('bf', 10));
    v_deleted INT := 0;
    v_created INT := 0;
BEGIN
    -- ------------------------------------------------------------------------
    -- STEP 1: DELETE ALL NON-ADMIN ACCOUNTS
    -- ------------------------------------------------------------------------
    
    -- Delete non-admin identities
    DELETE FROM auth.identities
    WHERE user_id IN (
        SELECT id FROM auth.users 
        WHERE email NOT ILIKE '%admin%' 
          AND (raw_user_meta_data->>'role' IS NULL OR raw_user_meta_data->>'role' NOT IN ('ADMIN', 'SUPER_ADMIN'))
          AND id NOT IN (SELECT auth_user_id FROM public.user_profiles WHERE role IN ('ADMIN', 'SUPER_ADMIN'))
    );

    -- Delete non-admin user profiles
    DELETE FROM public.user_profiles
    WHERE role <> 'ADMIN'
      AND auth_user_id NOT IN (
          SELECT id FROM auth.users 
          WHERE email ILIKE '%admin%' 
             OR raw_user_meta_data->>'role' IN ('ADMIN', 'SUPER_ADMIN')
      );

    -- Delete non-admin auth users
    WITH deleted_users AS (
        DELETE FROM auth.users
        WHERE email NOT ILIKE '%admin%'
          AND (raw_user_meta_data->>'role' IS NULL OR raw_user_meta_data->>'role' NOT IN ('ADMIN', 'SUPER_ADMIN'))
          AND id NOT IN (SELECT auth_user_id FROM public.user_profiles WHERE role IN ('ADMIN', 'SUPER_ADMIN'))
        RETURNING id
    )
    SELECT count(*) INTO v_deleted FROM deleted_users;

    RAISE NOTICE 'Cleaned up % non-admin user accounts.', v_deleted;

    -- ------------------------------------------------------------------------
    -- STEP 2: ENSURE STATION 1 EXISTS IN cci_master
    -- ------------------------------------------------------------------------
    INSERT INTO public.cci_master (cci_code, cci_name, region, location, status)
    VALUES ('1', 'Motorola Care - Station 1', 'General', 'General', 'ACTIVE')
    ON CONFLICT (cci_code) DO NOTHING;

    -- ------------------------------------------------------------------------
    -- STEP 3: GENERATE CLEAN AUTH USERS FROM ALL STATIONS IN cci_master
    -- ------------------------------------------------------------------------
    FOR r IN 
        SELECT cci_code, cci_name, region, location 
        FROM public.cci_master 
        WHERE cci_code IS NOT NULL AND TRIM(cci_code) <> ''
        ORDER BY cci_code ASC
    LOOP
        v_clean_code := lower(regexp_replace(TRIM(r.cci_code), '^cci_?', ''));
        v_username := 'cci_' || v_clean_code;
        v_email := v_username || '@happycalling.in';
        v_auth_id := gen_random_uuid();

        -- 3.1 Create user in auth.users
        INSERT INTO auth.users (
            id,
            instance_id,
            email,
            encrypted_password,
            email_confirmed_at,
            raw_app_meta_data,
            raw_user_meta_data,
            created_at,
            updated_at,
            role,
            aud,
            confirmation_token,
            is_super_admin
        ) VALUES (
            v_auth_id,
            '00000000-0000-0000-0000-000000000000'::uuid,
            v_email,
            v_pw,
            now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object(
                'username', v_username,
                'user_name', v_username,
                'role', 'CCI_USER',
                'cci_code', r.cci_code
            ),
            now(),
            now(),
            'authenticated',
            'authenticated',
            encode(gen_random_bytes(32), 'hex'),
            false
        );

        -- 3.2 Create identity in auth.identities
        BEGIN
            INSERT INTO auth.identities (
                id,
                user_id,
                identity_data,
                provider,
                provider_id,
                last_sign_in_at,
                created_at,
                updated_at
            ) VALUES (
                v_auth_id,
                v_auth_id,
                jsonb_build_object('sub', v_auth_id::text, 'email', v_email),
                'email',
                v_auth_id::text,
                now(),
                now(),
                now()
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        -- 3.3 Create active profile in public.user_profiles
        INSERT INTO public.user_profiles (
            auth_user_id,
            user_name,
            role,
            cci_code,
            cci_name,
            status
        ) VALUES (
            v_auth_id,
            v_username,
            'CCI_USER',
            r.cci_code,
            r.cci_name,
            'ACTIVE'
        ) ON CONFLICT (auth_user_id) DO UPDATE
        SET user_name = v_username,
            cci_code = r.cci_code,
            cci_name = r.cci_name,
            role = 'CCI_USER',
            status = 'ACTIVE',
            updated_at = now();

        v_created := v_created + 1;
        RAISE NOTICE 'Created station account: % (code: %) -> password: Moto@123', v_username, r.cci_code;
    END LOOP;

    RAISE NOTICE '=======================================================';
    RAISE NOTICE 'SUMMARY: Removed % old non-admin users. Created % station users from cci_master with default password Moto@123!', v_deleted, v_created;
    RAISE NOTICE '=======================================================';
END $$;
