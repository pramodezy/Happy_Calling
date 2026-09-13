-- ============================================================================
-- MOTOROLA HAPPY CALLING - SEED SCRIPT (Initial Admin & Sample Data)
-- Run this in Supabase SQL Editor AFTER running migrations
-- ============================================================================

-- 1. Create Initial Admin Profile (Matches an authenticated Supabase Auth user)
-- Note: Replace '00000000-0000-0000-0000-000000000000' with your actual Supabase Auth User ID (from Authentication -> Users)
-- Or use the helper below:

DO $$
DECLARE
    v_admin_email TEXT := 'admin@motorolacare.in';
    v_auth_id UUID;
BEGIN
    -- Check if user exists in auth.users
    SELECT id INTO v_auth_id FROM auth.users WHERE email = v_admin_email LIMIT 1;

    IF v_auth_id IS NOT NULL THEN
        INSERT INTO public.user_profiles (auth_user_id, user_name, role, cci_code, cci_name, status)
        VALUES (v_auth_id, 'Motorola National Admin', 'ADMIN', NULL, 'National Care HQ', 'ACTIVE')
        ON CONFLICT (auth_user_id) DO UPDATE 
        SET role = 'ADMIN', status = 'ACTIVE';
        RAISE NOTICE 'Admin user profile linked successfully for %', v_admin_email;
    ELSE
        RAISE NOTICE 'Please create user % in Supabase Auth Dashboard first, then re-run this script.', v_admin_email;
    END IF;
END $$;

-- 2. Insert Sample Service Closures for Demonstration & Immediate Testing
INSERT INTO public.closure_master (
    closure_id, so_number, cci_code, cci_name,
    customer_name, customer_mobile, model,
    repair_creation_date, repair_complete_date, closure_date,
    source_data
) VALUES
    ('CLO-1001', 'SO-88201', 'BLR01', 'Motorola Authorized Care - Bangalore Central', 'Aditya Sharma', '+91 98765 43210', 'Motorola Edge 50 Pro', now() - INTERVAL '3 days', now() - INTERVAL '2 days', now() - INTERVAL '2 days', '{"imei": "358912345678901", "technician": "Rajesh M"}'::jsonb),
    ('CLO-1002', 'SO-88202', 'BLR01', 'Motorola Authorized Care - Bangalore Central', 'Priya Sundaram', '+91 98123 45678', 'Moto G85 5G', now() - INTERVAL '2 days', now() - INTERVAL '1 day', now() - INTERVAL '1 day', '{"imei": "358912345678902", "technician": "Kiran S"}'::jsonb),
    ('CLO-1003', 'SO-88203', 'BLR01', 'Motorola Authorized Care - Bangalore Central', 'Rahul Verma', '+91 97654 32109', 'Motorola Razr 50 Ultra', now() - INTERVAL '1 day', now() - INTERVAL '4 hours', now() - INTERVAL '3 hours', '{"imei": "358912345678903", "technician": "Rajesh M"}'::jsonb),
    ('CLO-1004', 'SO-88204', 'DEL01', 'Motorola Authorized Care - Delhi Connaught', 'Amitabh Sengupta', '+91 99988 77665', 'Moto G64 5G', now() - INTERVAL '4 days', now() - INTERVAL '3 days', now() - INTERVAL '3 days', '{"imei": "358912345678904", "technician": "Vikas K"}'::jsonb),
    ('CLO-1005', 'SO-88205', 'MUM01', 'Motorola Authorized Care - Mumbai Andheri', 'Neha Deshmukh', '+91 98234 56789', 'Motorola Edge 50 Fusion', now() - INTERVAL '1 day', now() - INTERVAL '6 hours', now() - INTERVAL '5 hours', '{"imei": "358912345678905", "technician": "Suresh T"}'::jsonb)
ON CONFLICT (closure_id, so_number, cci_code) DO NOTHING;
