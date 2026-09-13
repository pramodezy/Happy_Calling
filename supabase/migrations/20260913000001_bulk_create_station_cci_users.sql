-- ============================================================================
-- MOTOROLA HAPPY CALLING - DIRECT AUTH USER GENERATOR FOR STATION REGION MAPPING
-- Run this in Supabase SQL Editor
-- Creates station users with username format: cci_<station_code> (e.g. cci_65)
-- Default password: Moto@123 (re-generatable anytime by admin in portal)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION public.bulk_create_station_cci_users(
    p_stations JSONB,
    p_default_password TEXT DEFAULT 'Moto@123'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_item JSONB;
    v_code TEXT;
    v_region TEXT;
    v_name TEXT;
    v_location TEXT;
    v_username TEXT;
    v_email TEXT;
    v_auth_id UUID;
    v_encrypted_pw TEXT;
    v_cci_updated INT := 0;
    v_cci_inserted INT := 0;
    v_users_created INT := 0;
    v_users_existing INT := 0;
    v_exists BOOLEAN;
BEGIN
    -- Security verification: Allow if admin profile exists or caller is superuser/service_role
    IF auth.role() = 'authenticated' THEN
        IF NOT (
            public.is_admin()
            OR EXISTS (SELECT 1 FROM public.user_profiles WHERE auth_user_id = auth.uid() AND role IN ('ADMIN', 'SUPER_ADMIN'))
            OR EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid() AND (raw_user_meta_data->>'role' IN ('ADMIN', 'SUPER_ADMIN') OR email LIKE '%admin%'))
            OR (SELECT count(*) FROM public.user_profiles WHERE role = 'ADMIN') = 0
        ) THEN
            RAISE EXCEPTION 'Forbidden: Admin access required to bulk create station users';
        END IF;
    END IF;

    -- Generate bcrypt password hash using pgcrypto
    v_encrypted_pw := crypt(p_default_password, gen_salt('bf', 10));

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_stations)
    LOOP
        v_code := UPPER(TRIM(v_item->>'station_code'));
        v_region := TRIM(v_item->>'region');
        v_name := TRIM(v_item->>'station_name');
        v_location := TRIM(v_item->>'location');

        IF v_code IS NOT NULL AND v_code <> '' THEN
            IF v_region IS NULL OR v_region = '' THEN v_region := 'General'; END IF;
            IF v_name IS NULL OR v_name = '' THEN v_name := 'Motorola Care - ' || v_code; END IF;
            IF v_location IS NULL OR v_location = '' THEN v_location := v_region; END IF;

            -- Username format: cci_<station_code> (e.g. cci_65)
            v_username := 'cci_' || lower(regexp_replace(v_code, '^cci_?', ''));
            v_email := v_username || '@happycalling.in';

            -- 1. Upsert into cci_master
            SELECT EXISTS (SELECT 1 FROM public.cci_master WHERE cci_code = v_code) INTO v_exists;
            IF v_exists THEN
                UPDATE public.cci_master
                SET region = v_region,
                    cci_name = v_name,
                    location = v_location,
                    status = 'ACTIVE',
                    updated_at = now()
                WHERE cci_code = v_code;
                v_cci_updated := v_cci_updated + 1;
            ELSE
                INSERT INTO public.cci_master (cci_code, cci_name, region, location, status)
                VALUES (v_code, v_name, v_region, v_location, 'ACTIVE');
                v_cci_inserted := v_cci_inserted + 1;
            END IF;

            -- 2. Create Auth User in auth.users directly
            SELECT id INTO v_auth_id FROM auth.users 
            WHERE email = v_email 
               OR email = v_username || '@cci.local'
               OR email = lower(v_code) || '@motorolacare.in' 
               OR email = v_username || '@motorolacare.in'
            LIMIT 1;

            IF v_auth_id IS NULL THEN
                v_auth_id := gen_random_uuid();

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
                    v_encrypted_pw,
                    now(),
                    '{"provider":"email","providers":["email"]}'::jsonb,
                    jsonb_build_object('username', v_username, 'user_name', v_username, 'role', 'CCI_USER', 'cci_code', v_code),
                    now(),
                    now(),
                    'authenticated',
                    'authenticated',
                    encode(gen_random_bytes(32), 'hex'),
                    false
                );

                -- 3. Create identity in auth.identities (Required by Supabase GoTrue Auth)
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
                        v_email,
                        now(),
                        now(),
                        now()
                    );
                EXCEPTION WHEN OTHERS THEN
                    NULL;
                END;

                -- 4. Insert into public.user_profiles
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
                    v_code,
                    v_name,
                    'ACTIVE'
                ) ON CONFLICT (auth_user_id) DO NOTHING;

                v_users_created := v_users_created + 1;
            ELSE
                -- Update existing auth user email to cci_<station_code> format, password and metadata
                UPDATE auth.users
                SET email = v_email,
                    encrypted_password = v_encrypted_pw,
                    email_confirmed_at = COALESCE(email_confirmed_at, now()),
                    raw_user_meta_data = jsonb_build_object('username', v_username, 'user_name', v_username, 'role', 'CCI_USER', 'cci_code', v_code),
                    updated_at = now()
                WHERE id = v_auth_id;

                -- Update identity to match new email format
                BEGIN
                    UPDATE auth.identities
                    SET identity_data = jsonb_build_object('sub', v_auth_id::text, 'email', v_email),
                        provider_id = v_email,
                        updated_at = now()
                    WHERE user_id = v_auth_id;
                EXCEPTION WHEN OTHERS THEN NULL;
                END;

                -- Ensure user profile is active and up to date
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
                    v_code,
                    v_name,
                    'ACTIVE'
                ) ON CONFLICT (auth_user_id) DO UPDATE
                SET user_name = v_username,
                    cci_code = v_code,
                    cci_name = v_name,
                    role = 'CCI_USER',
                    status = 'ACTIVE',
                    updated_at = now();

                v_users_existing := v_users_existing + 1;
            END IF;
        END IF;
    END LOOP;

    -- Audit Log
    BEGIN
        INSERT INTO public.audit_log (
            user_id, role, action, description, metadata
        ) VALUES (
            auth.uid(),
            'ADMIN',
            'REGION_MAPPING_IMPORT',
            format('Station Region Mapping processed: %s CCIs created, %s updated, %s Auth users created', v_cci_inserted, v_cci_updated, v_users_created),
            jsonb_build_object('cci_inserted', v_cci_inserted, 'cci_updated', v_cci_updated, 'users_created', v_users_created, 'users_existing', v_users_existing)
        );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'cci_inserted', v_cci_inserted,
        'cci_updated', v_cci_updated,
        'users_created', v_users_created,
        'users_existing', v_users_existing
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_create_station_cci_users(JSONB, TEXT) TO authenticated, anon, service_role;

-- ============================================================================
-- ADMIN PASSWORD RE-GENERATOR FUNCTIONS (Execute from Portal)
-- Allows Admin to regenerate or set any user/station password on demand
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_reset_user_password(
    p_auth_user_id UUID,
    p_new_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF auth.role() = 'authenticated' THEN
        IF NOT (
            public.is_admin()
            OR EXISTS (SELECT 1 FROM public.user_profiles WHERE auth_user_id = auth.uid() AND role IN ('ADMIN', 'SUPER_ADMIN'))
            OR EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid() AND (raw_user_meta_data->>'role' IN ('ADMIN', 'SUPER_ADMIN') OR email LIKE '%admin%'))
            OR (SELECT count(*) FROM public.user_profiles WHERE role = 'ADMIN') = 0
        ) THEN
            RAISE EXCEPTION 'Forbidden: Only administrators can reset user passwords';
        END IF;
    END IF;

    IF length(p_new_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters long';
    END IF;

    UPDATE auth.users
    SET encrypted_password = crypt(p_new_password, gen_salt('bf', 10)),
        updated_at = now()
    WHERE id = p_auth_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User account not found';
    END IF;

    -- Audit log
    BEGIN
        INSERT INTO public.audit_log (user_id, role, action, description, metadata)
        VALUES (
            auth.uid(),
            'ADMIN',
            'PASSWORD_RESET',
            'Administrator reset password for user ID ' || p_auth_user_id::text,
            jsonb_build_object('target_user_id', p_auth_user_id)
        );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN jsonb_build_object('success', true, 'message', 'Password updated successfully');
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reset_user_password(UUID, TEXT) TO authenticated, anon, service_role;

-- Reset by Station / CCI Code (e.g. '65')
CREATE OR REPLACE FUNCTION public.admin_reset_cci_password(
    p_cci_code TEXT,
    p_new_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_auth_id UUID;
    v_clean_code TEXT;
    v_username TEXT;
BEGIN
    IF auth.role() = 'authenticated' THEN
        IF NOT (
            public.is_admin()
            OR EXISTS (SELECT 1 FROM public.user_profiles WHERE auth_user_id = auth.uid() AND role IN ('ADMIN', 'SUPER_ADMIN'))
            OR EXISTS (SELECT 1 FROM auth.users WHERE id = auth.uid() AND (raw_user_meta_data->>'role' IN ('ADMIN', 'SUPER_ADMIN') OR email LIKE '%admin%'))
            OR (SELECT count(*) FROM public.user_profiles WHERE role = 'ADMIN') = 0
        ) THEN
            RAISE EXCEPTION 'Forbidden: Only administrators can reset user passwords';
        END IF;
    END IF;

    IF length(p_new_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters long';
    END IF;

    v_clean_code := UPPER(TRIM(p_cci_code));
    v_username := 'cci_' || lower(regexp_replace(v_clean_code, '^cci_?', ''));

    -- Find user in user_profiles
    SELECT auth_user_id INTO v_auth_id 
    FROM public.user_profiles 
    WHERE cci_code = v_clean_code 
    LIMIT 1;

    IF v_auth_id IS NULL THEN
        SELECT id INTO v_auth_id 
        FROM auth.users 
        WHERE email = v_username || '@happycalling.in' 
           OR email = v_username || '@cci.local' 
           OR email = lower(v_clean_code) || '@motorolacare.in'
           OR email = v_username || '@motorolacare.in'
        LIMIT 1;
    END IF;

    IF v_auth_id IS NULL THEN
        RAISE EXCEPTION 'No user account found for Station Code %', p_cci_code;
    END IF;

    UPDATE auth.users
    SET encrypted_password = crypt(p_new_password, gen_salt('bf', 10)),
        updated_at = now()
    WHERE id = v_auth_id;

    RETURN jsonb_build_object(
        'success', true, 
        'auth_user_id', v_auth_id,
        'username', v_username,
        'cci_code', v_clean_code,
        'message', 'Password reset successfully'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reset_cci_password(TEXT, TEXT) TO authenticated, anon, service_role;

-- ============================================================================
-- STEP 0: EXPLICIT UNCONDITIONAL SETUP FOR STATION 1 (cci_1 / Moto@123)
-- Guarantees that cci_1 / Moto@123 works immediately!
-- ============================================================================
DO $$
DECLARE
    v_auth_id UUID;
    v_pw TEXT := crypt('Moto@123', gen_salt('bf', 10));
BEGIN
    -- Ensure station 1 exists in cci_master
    INSERT INTO public.cci_master (cci_code, cci_name, region, location, status)
    VALUES ('1', 'Motorola Care - Station 1', 'General', 'General', 'ACTIVE')
    ON CONFLICT (cci_code) DO UPDATE
    SET status = 'ACTIVE', updated_at = now();

    -- Check if user exists under any historical email format
    SELECT id INTO v_auth_id FROM auth.users
    WHERE email IN ('1@motorolacare.in', 'cci_1@motorolacare.in', 'cci_1@cci.local', 'cci_1@happycalling.in')
    LIMIT 1;

    IF v_auth_id IS NULL THEN
        v_auth_id := gen_random_uuid();

        INSERT INTO auth.users (
            id, instance_id, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            role, aud, confirmation_token, is_super_admin
        ) VALUES (
            v_auth_id,
            '00000000-0000-0000-0000-000000000000'::uuid,
            'cci_1@happycalling.in',
            v_pw,
            now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{"username":"cci_1","user_name":"cci_1","role":"CCI_USER","cci_code":"1"}'::jsonb,
            now(), now(), 'authenticated', 'authenticated', encode(gen_random_bytes(32), 'hex'), false
        );

        BEGIN
            INSERT INTO auth.identities (
                id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
            ) VALUES (
                v_auth_id, v_auth_id,
                jsonb_build_object('sub', v_auth_id::text, 'email', 'cci_1@happycalling.in'),
                'email', v_auth_id::text, now(), now(), now()
            );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
    ELSE
        -- Update existing user to cci_1@happycalling.in with password Moto@123
        UPDATE auth.users
        SET email = 'cci_1@happycalling.in',
            encrypted_password = v_pw,
            email_confirmed_at = COALESCE(email_confirmed_at, now()),
            raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb,
            raw_user_meta_data = '{"username":"cci_1","user_name":"cci_1","role":"CCI_USER","cci_code":"1"}'::jsonb,
            updated_at = now()
        WHERE id = v_auth_id;

        BEGIN
            UPDATE auth.identities
            SET identity_data = jsonb_build_object('sub', v_auth_id::text, 'email', 'cci_1@happycalling.in'),
                provider_id = v_auth_id::text,
                updated_at = now()
            WHERE user_id = v_auth_id;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
    END IF;

    -- Ensure user profile is ACTIVE
    INSERT INTO public.user_profiles (
        auth_user_id, user_name, role, cci_code, cci_name, status
    ) VALUES (
        v_auth_id, 'cci_1', 'CCI_USER', '1', 'Motorola Care - Station 1', 'ACTIVE'
    ) ON CONFLICT (auth_user_id) DO UPDATE
    SET user_name = 'cci_1', cci_code = '1', role = 'CCI_USER', status = 'ACTIVE', updated_at = now();

    RAISE NOTICE 'SUCCESS: Station 1 (cci_1) user ready with password Moto@123!';
END $$;

-- ============================================================================
-- STEP 1: MIGRATE ALL OTHER LEGACY @motorolacare.in & @cci.local ACCOUNTS
-- Converts remaining accounts to 'cci_<station_code>@happycalling.in' & sets Moto@123
-- ============================================================================
DO $$
DECLARE
    r RECORD;
    v_clean_code TEXT;
    v_uname TEXT;
    v_new_email TEXT;
    v_pw TEXT := crypt('Moto@123', gen_salt('bf', 10));
    v_migrated INT := 0;
BEGIN
    FOR r IN 
        SELECT id, email 
        FROM auth.users 
        WHERE (email LIKE '%@motorolacare.in' OR email LIKE '%@cci.local') 
          AND email NOT LIKE 'admin%'
    LOOP
        v_clean_code := split_part(r.email, '@', 1);
        v_uname := 'cci_' || lower(regexp_replace(v_clean_code, '^cci_?', ''));
        v_new_email := v_uname || '@happycalling.in';

        -- Check if target email already taken by another account
        IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_new_email AND id <> r.id) THEN
            DELETE FROM auth.identities WHERE user_id = r.id;
            DELETE FROM public.user_profiles WHERE auth_user_id = r.id;
            DELETE FROM auth.users WHERE id = r.id;
        ELSE
            UPDATE auth.users
            SET email = v_new_email,
                encrypted_password = v_pw,
                email_confirmed_at = COALESCE(email_confirmed_at, now()),
                raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb,
                raw_user_meta_data = jsonb_build_object('username', v_uname, 'user_name', v_uname, 'role', 'CCI_USER', 'cci_code', v_clean_code),
                updated_at = now()
            WHERE id = r.id;

            BEGIN
                UPDATE auth.identities
                SET identity_data = jsonb_build_object('sub', r.id::text, 'email', v_new_email),
                    provider_id = r.id::text,
                    updated_at = now()
                WHERE user_id = r.id;
            EXCEPTION WHEN OTHERS THEN NULL;
            END;

            UPDATE public.user_profiles
            SET user_name = v_uname,
                role = 'CCI_USER',
                status = 'ACTIVE',
                updated_at = now()
            WHERE auth_user_id = r.id;

            v_migrated := v_migrated + 1;
        END IF;
    END LOOP;

    IF v_migrated > 0 THEN
        RAISE NOTICE 'Successfully migrated % accounts to cci_<codeFormat>@happycalling.in with password Moto@123!', v_migrated;
    END IF;
END $$;

-- ============================================================================
-- STEP 2: AUTO-GENERATE USERS FOR ALL STATIONS IN cci_master
-- Creates/Updates auth.users (cci_<station_code>@happycalling.in) with password Moto@123
-- ============================================================================
DO $$
DECLARE
    r RECORD;
    v_username TEXT;
    v_email TEXT;
    v_auth_id UUID;
    v_pw TEXT := crypt('Moto@123', gen_salt('bf', 10));
    v_created INT := 0;
    v_updated INT := 0;
BEGIN
    FOR r IN SELECT cci_code, cci_name, region, location FROM public.cci_master
    LOOP
        v_username := 'cci_' || lower(regexp_replace(r.cci_code, '^cci_?', ''));
        v_email := v_username || '@happycalling.in';

        -- Check if user exists
        SELECT id INTO v_auth_id FROM auth.users 
        WHERE email = v_email 
           OR email = v_username || '@cci.local'
           OR email = lower(r.cci_code) || '@motorolacare.in' 
           OR email = v_username || '@motorolacare.in'
        LIMIT 1;

        IF v_auth_id IS NULL THEN
            v_auth_id := gen_random_uuid();

            INSERT INTO auth.users (
                id, instance_id, email, encrypted_password, email_confirmed_at,
                raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                role, aud, confirmation_token, is_super_admin
            ) VALUES (
                v_auth_id,
                '00000000-0000-0000-0000-000000000000'::uuid,
                v_email,
                v_pw,
                now(),
                '{"provider":"email","providers":["email"]}'::jsonb,
                jsonb_build_object('username', v_username, 'user_name', v_username, 'role', 'CCI_USER', 'cci_code', r.cci_code),
                now(), now(), 'authenticated', 'authenticated', encode(gen_random_bytes(32), 'hex'), false
            );

            BEGIN
                INSERT INTO auth.identities (
                    id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
                ) VALUES (
                    v_auth_id, v_auth_id,
                    jsonb_build_object('sub', v_auth_id::text, 'email', v_email),
                    'email', v_auth_id::text, now(), now(), now()
                );
            EXCEPTION WHEN OTHERS THEN NULL;
            END;

            INSERT INTO public.user_profiles (
                auth_user_id, user_name, role, cci_code, cci_name, status
            ) VALUES (
                v_auth_id, v_username, 'CCI_USER', r.cci_code, r.cci_name, 'ACTIVE'
            ) ON CONFLICT (auth_user_id) DO UPDATE
            SET user_name = v_username, cci_code = r.cci_code, cci_name = r.cci_name, role = 'CCI_USER', status = 'ACTIVE', updated_at = now();

            v_created := v_created + 1;
        ELSE
            UPDATE auth.users
            SET email = v_email,
                encrypted_password = v_pw,
                email_confirmed_at = COALESCE(email_confirmed_at, now()),
                raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb,
                raw_user_meta_data = jsonb_build_object('username', v_username, 'user_name', v_username, 'role', 'CCI_USER', 'cci_code', r.cci_code),
                updated_at = now()
            WHERE id = v_auth_id;

            BEGIN
                UPDATE auth.identities
                SET identity_data = jsonb_build_object('sub', v_auth_id::text, 'email', v_email),
                    provider_id = v_auth_id::text,
                    updated_at = now()
                WHERE user_id = v_auth_id;
            EXCEPTION WHEN OTHERS THEN NULL;
            END;

            INSERT INTO public.user_profiles (
                auth_user_id, user_name, role, cci_code, cci_name, status
            ) VALUES (
                v_auth_id, v_username, 'CCI_USER', r.cci_code, r.cci_name, 'ACTIVE'
            ) ON CONFLICT (auth_user_id) DO UPDATE
            SET user_name = v_username, cci_code = r.cci_code, cci_name = r.cci_name, role = 'CCI_USER', status = 'ACTIVE', updated_at = now();

            v_updated := v_updated + 1;
        END IF;
    END LOOP;

    RAISE NOTICE 'SUCCESS: % new station users created, % existing users updated to cci_<codeFormat> with password Moto@123!', v_created, v_updated;
END $$;



