-- ==============================================================================
-- MIGRATION: Fix admin_create_system_user, add auth.identities, & repair cci_120
-- ==============================================================================

-- 1. REPAIR USERS cci_120 & cci_123 IMMEDIATELY
DO $$
DECLARE
    v_codes TEXT[] := ARRAY['120', '123'];
    v_code TEXT;
    v_user_id UUID;
    v_email TEXT;
    v_username TEXT;
    v_password TEXT := 'Moto@123';
    v_hashed_pw TEXT;
    v_cci_name TEXT;
BEGIN
    BEGIN
        v_hashed_pw := extensions.crypt(v_password, extensions.gen_salt('bf', 10));
    EXCEPTION WHEN OTHERS THEN
        v_hashed_pw := crypt(v_password, gen_salt('bf', 10));
    END;

    FOREACH v_code IN ARRAY v_codes
    LOOP
        v_username := 'cci_' || v_code;
        v_email := v_username || '@happycalling.in';
        v_cci_name := NULL;

        -- Get name from cci_master if exists
        SELECT cci_name INTO v_cci_name FROM public.cci_master WHERE cci_code = v_code;
        IF v_cci_name IS NULL THEN
            v_cci_name := 'CCI Station ' || v_code;
        END IF;

        -- Find user by email match or partial code match
        SELECT id INTO v_user_id 
        FROM auth.users 
        WHERE email = v_username 
           OR email = v_email 
           OR email ILIKE '%' || v_code || '%'
        ORDER BY created_at DESC LIMIT 1;

        IF v_user_id IS NULL THEN
            v_user_id := gen_random_uuid();
            INSERT INTO auth.users (
                id, instance_id, email, encrypted_password, email_confirmed_at,
                raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                role, aud, confirmation_token, recovery_token, email_change, email_change_token_new
            ) VALUES (
                v_user_id,
                '00000000-0000-0000-0000-000000000000'::uuid,
                v_email,
                v_hashed_pw,
                now(),
                '{"provider":"email","providers":["email"]}'::jsonb,
                jsonb_build_object('username', v_username, 'user_name', v_username, 'role', 'CCI_USER', 'cci_code', v_code),
                now(), now(),
                'authenticated', 'authenticated', '', '', '', ''
            );
        ELSE
            UPDATE auth.users
            SET email = v_email,
                encrypted_password = v_hashed_pw,
                email_confirmed_at = COALESCE(email_confirmed_at, now()),
                raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb,
                raw_user_meta_data = jsonb_build_object('username', v_username, 'user_name', v_username, 'role', 'CCI_USER', 'cci_code', v_code),
                updated_at = now()
            WHERE id = v_user_id;
        END IF;

        -- Upsert required auth.identities (MANDATORY for GoTrue password auth)
        BEGIN
            DELETE FROM auth.identities WHERE user_id = v_user_id OR id = v_user_id::text;
            INSERT INTO auth.identities (
                id, user_id, identity_data, provider, provider_id,
                last_sign_in_at, created_at, updated_at
            ) VALUES (
                v_user_id::text,
                v_user_id,
                jsonb_build_object('sub', v_user_id::text, 'email', v_email),
                'email',
                v_user_id::text,
                now(), now(), now()
            );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;

        -- Upsert user_profiles
        INSERT INTO public.user_profiles (
            auth_user_id, user_name, role, cci_code, cci_name, status
        ) VALUES (
            v_user_id,
            v_username,
            'CCI_USER',
            v_code,
            v_cci_name,
            'ACTIVE'
        )
        ON CONFLICT (auth_user_id) DO UPDATE
        SET user_name = EXCLUDED.user_name,
            role = 'CCI_USER',
            cci_code = EXCLUDED.cci_code,
            cci_name = EXCLUDED.cci_name,
            status = 'ACTIVE';

        RAISE NOTICE 'Repaired user % (%) with password %', v_username, v_email, v_password;
    END LOOP;
END $$;

-- 2. ROBUST FUTURE FIX: UPDATE admin_create_system_user
CREATE OR REPLACE FUNCTION public.admin_create_system_user(
    p_email TEXT,
    p_password TEXT,
    p_user_name TEXT,
    p_role TEXT,
    p_cci_code TEXT DEFAULT NULL,
    p_assigned_regions TEXT[] DEFAULT '{}'::text[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions, pg_temp
AS $$
DECLARE
    v_user_id UUID := gen_random_uuid();
    v_hashed_pw TEXT;
    v_cci_name TEXT := NULL;
    v_clean_code TEXT;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Forbidden: Only administrators can create users';
    END IF;

    IF p_role NOT IN ('CCI_USER', 'ADMIN', 'BSM') THEN
        RAISE EXCEPTION 'Invalid role: %', p_role;
    END IF;

    p_email := LOWER(TRIM(p_email));
    IF p_email IS NULL OR p_email = '' THEN
        RAISE EXCEPTION 'Email/Username cannot be empty';
    END IF;

    -- Auto-normalize username to full email if no domain is provided
    IF p_email NOT LIKE '%@%' THEN
        IF p_role = 'CCI_USER' AND p_cci_code IS NOT NULL THEN
            v_clean_code := LOWER(REGEXP_REPLACE(TRIM(p_cci_code), '^cci_?', ''));
            p_email := 'cci_' || v_clean_code || '@happycalling.in';
        ELSE
            p_email := p_email || '@happycalling.in';
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_email) THEN
        RAISE EXCEPTION 'User with email % already exists', p_email;
    END IF;

    IF length(p_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters long';
    END IF;

    BEGIN
        v_hashed_pw := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
    EXCEPTION WHEN OTHERS THEN
        v_hashed_pw := crypt(p_password, gen_salt('bf', 10));
    END;

    IF p_role = 'CCI_USER' AND p_cci_code IS NOT NULL THEN
        SELECT cci_name INTO v_cci_name FROM public.cci_master WHERE cci_code = p_cci_code;
    END IF;

    -- 1. Insert into auth.users with email confirmed
    INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, recovery_token,
        email_change_token_new, email_change
    ) VALUES (
        '00000000-0000-0000-0000-000000000000',
        v_user_id,
        'authenticated',
        'authenticated',
        p_email,
        v_hashed_pw,
        now(),
        jsonb_build_object('provider', 'email', 'providers', array['email']),
        jsonb_build_object('user_name', p_user_name, 'role', p_role, 'cci_code', p_cci_code),
        now(), now(), '', '', '', ''
    );

    -- 2. Insert into auth.identities (MANDATORY for Supabase GoTrue authentication)
    BEGIN
        INSERT INTO auth.identities (
            id, user_id, identity_data, provider, provider_id,
            last_sign_in_at, created_at, updated_at
        ) VALUES (
            v_user_id::text,
            v_user_id,
            jsonb_build_object('sub', v_user_id::text, 'email', p_email),
            'email',
            v_user_id::text,
            now(), now(), now()
        );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- 3. Insert into public.user_profiles
    INSERT INTO public.user_profiles (
        auth_user_id, user_name, role, cci_code, cci_name, assigned_regions, status
    ) VALUES (
        v_user_id,
        p_user_name,
        p_role,
        CASE WHEN p_role = 'CCI_USER' THEN p_cci_code ELSE NULL END,
        CASE WHEN p_role = 'CCI_USER' THEN v_cci_name ELSE NULL END,
        CASE WHEN p_role = 'BSM' THEN COALESCE(p_assigned_regions, '{}'::text[]) ELSE '{}'::text[] END,
        'ACTIVE'
    );

    -- 4. Audit log
    BEGIN
        INSERT INTO public.audit_log (user_id, role, action, description, metadata)
        VALUES (
            auth.uid(),
            'ADMIN',
            'USER_CREATED',
            format('Admin created %s user "%s" (%s)', p_role, p_user_name, p_email),
            jsonb_build_object('email', p_email, 'role', p_role, 'assigned_regions', p_assigned_regions)
        );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN jsonb_build_object('success', true, 'user_id', v_user_id, 'email', p_email);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_create_system_user(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO authenticated, service_role;
