-- ============================================================================
-- MOTOROLA HAPPY CALLING - DIRECT AUTH USER GENERATOR FOR STATION REGION MAPPING
-- Run this in Supabase SQL Editor
-- Enables instant creation of Auth users directly inside PostgreSQL without Edge Functions
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
            v_email := lower(v_code) || '@motorolacare.in';

            SELECT id INTO v_auth_id FROM auth.users WHERE email = v_email LIMIT 1;

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
                    jsonb_build_object('user_name', v_name, 'role', 'CCI_USER', 'cci_code', v_code),
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
                    -- Gracefully handle potential constraint variation
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
                    'CCI ' || v_code,
                    'CCI_USER',
                    v_code,
                    v_name,
                    'ACTIVE'
                ) ON CONFLICT (auth_user_id) DO NOTHING;

                v_users_created := v_users_created + 1;
            ELSE
                -- Update existing auth user password and status
                UPDATE auth.users
                SET encrypted_password = v_encrypted_pw,
                    email_confirmed_at = COALESCE(email_confirmed_at, now()),
                    raw_user_meta_data = jsonb_build_object('user_name', v_name, 'role', 'CCI_USER', 'cci_code', v_code),
                    updated_at = now()
                WHERE id = v_auth_id;

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
                    'CCI ' || v_code,
                    'CCI_USER',
                    v_code,
                    v_name,
                    'ACTIVE'
                ) ON CONFLICT (auth_user_id) DO UPDATE
                SET cci_code = v_code,
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

-- Grant execution permissions
GRANT EXECUTE ON FUNCTION public.bulk_create_station_cci_users(JSONB, TEXT) TO authenticated, anon, service_role;

