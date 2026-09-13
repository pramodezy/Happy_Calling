# Motorola Happy Calling - CCI Service Portal

> **Enterprise Post-Service Customer Satisfaction & Feedback Platform**  
> Subtitle: **CCI Service Portal**

---

## 1. Architecture Overview

```
GitHub Repository (main branch)
       ↓ (Automatic push trigger)
GitHub Actions (.github/workflows/deploy.yml)
       ↓ (Builds Vite bundle)
GitHub Pages (Static Web Hosting)
       ↓
Static HTML5 / Vanilla JavaScript / CSS / Chart.js
       ↓
Supabase Live Backend
  ├── Supabase Auth (Authentication & Session State)
  ├── Supabase PostgreSQL (Source of Truth)
  ├── Row Level Security (RLS) (Tenant & Role-enforced Access Control)
  ├── Stored Procedures / RPC Functions (Atomic Business Logic)
  ├── Edge Functions (Privileged Admin Tasks via Service Role)
  └── Supabase Realtime (Live Admin & CCI Dashboard Refresh)
```

> [!IMPORTANT]
> **CRITICAL OPERATIONAL PRINCIPLE:**  
> **GitHub Pages is for STATIC FRONTEND HOSTING ONLY.** It is never treated as a database. Operational records are never stored in JavaScript files, static JSON, browser bundles, or GitHub commits. When a CCI completes a call, data is written directly to Supabase and immediately reflects across dashboards, pending lists, and admin monitors without triggering or requiring any GitHub Pages deployment.

---

## 2. Core User Roles & Security

| Role | Access Scope | Key Capabilities | Security Enforcement |
| :--- | :--- | :--- | :--- |
| **`CCI_USER`** | **Assigned CCI Only** | • View pending closures for assigned center<br>• Execute Happy Calling workflow (`SUBMIT & NEXT`)<br>• View own completed calls & audit records<br>• Monitor own center KPI metrics & ageing | Row Level Security (RLS) dynamically checks `auth.uid()` against `public.user_profiles.cci_code`. Browser parameter manipulation (e.g. changing URL query params) is rejected at DB level. |
| **`ADMIN`** | **Company-Wide (All CCIs)** | • Company-wide executive dashboard & charts<br>• Compare CCI partner performance & rankings<br>• Ingest Motorola closure dumps (XLSX, XLS, CSV)<br>• Master Closure database inspection<br>• User Management & Privileged Password Resets<br>• CCI Center management<br>• Comprehensive Audit Trail | Full RLS access guarded by `public.is_admin()` database function. Server-side Edge Functions for sensitive auth modifications. |

---

## 3. Database Model & Schema

The system uses 5 core tables defined in `supabase/migrations/20260913000000_initial_schema.sql`:

1. **`cci_master`**: Authorized Service Partner centers (Code, Name, Region, City/Location, Status).
2. **`user_profiles`**: Application-level profile linked to `auth.users(id)` via `auth_user_id`. Never stores passwords. Contains `role` and `cci_code`.
3. **`closure_master`**: Motorola service closures. Preserves original closure data, IMEI, dates, and extra metadata in `source_data JSONB`.
4. **`happy_calling`**: Customer calling attempts and completed feedback (`Calling Status`, `Customer Rating 1–10`, `Feedback Category Happy/Neutral/Unhappy`, `Customer Remarks`, `CCI Remarks`).
   - **Duplicate Protection**: Unique index on `(closure_id, so_number, cci_code) WHERE (calling_status = 'Completed')` guarantees that once a closure is completed, no duplicate completion can be entered.
5. **`audit_log`**: Immutable record of all system events (Logins, Imports, Happy Calling submissions, User adjustments).

---

## 4. Stored Procedures & Database Functions

- **`get_current_user_profile()`**: Returns verified server-side profile of `auth.uid()`, updating `last_login`.
- **`get_next_pending_closure()`**: Automatically retrieves the single oldest pending closure for the user's assigned CCI.
- **`submit_happy_calling(...)`**: Atomic submission RPC that verifies CCI ownership, validates inputs, prevents duplicate completions, writes happy calling record, and registers an audit log entry.
- **`get_cci_dashboard(timeframe)`**: Computes live KPIs, 7-day completion trend, ageing breakdown, and rating distribution for a CCI.
- **`get_admin_dashboard(cci, region, dateFrom, dateTo)`**: Computes company-wide metrics, partner leaderboard, and national distribution.
- **`import_closures_batch(closures)`**: Bulk inserts and updates Motorola closures with tolerance for future column changes.

---

## 5. Deployment Instructions

### Part A: Supabase Setup (Live Backend)

1. **Create Supabase Project:**
   - Log in to [Supabase](https://supabase.com) and create a new project (e.g. `motorola-happy-calling`).
2. **Execute Database Migrations:**
   - Open **SQL Editor** in the Supabase Dashboard.
   - Copy the entire contents of [`supabase/migrations/20260913000000_initial_schema.sql`](./supabase/migrations/20260913000000_initial_schema.sql) and click **Run**.
3. **Deploy Edge Functions:**
   - Install Supabase CLI locally if deploying via CLI:
     ```bash
     supabase functions deploy admin-users
     supabase functions deploy sheets-sync
     ```
   - Ensure `SUPABASE_SERVICE_ROLE_KEY` is set in Edge Function secrets.
4. **Create Initial Admin User:**
   - Go to **Authentication -> Users** and click **Add user**.
   - Email: `admin@motorolacare.in`, Password: `YourSecurePassword123!`
   - Run [`supabase/seed_admin.sql`](./supabase/seed_admin.sql) in the SQL Editor to link the admin profile and insert sample closures.

---

### Part B: GitHub Pages & GitHub Actions Setup

1. **Create GitHub Repository:**
   ```bash
   git init
   git add .
   git commit -m "feat: Initial Motorola Happy Calling Portal release"
   git branch -M main
   git remote add origin https://github.com/YOUR_ORG/motorola-happy-calling.git
   git push -u origin main
   ```
2. **Configure GitHub Repository Secrets:**
   - In GitHub, go to **Settings -> Secrets and variables -> Actions**.
   - Add the following Repository Secrets:
     - `VITE_SUPABASE_URL`: `https://your-project.supabase.co`
     - `VITE_SUPABASE_ANON_KEY`: `eyJhbGci...`
3. **Enable GitHub Pages:**
   - In GitHub, go to **Settings -> Pages**.
   - Under **Build and deployment -> Source**, select **GitHub Actions**.
4. **Automated Deployment:**
   - Any push to `main` triggers `.github/workflows/deploy.yml`, which compiles the Vite bundle and deploys `dist/` directly to GitHub Pages.

---

### Part C: Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your actual Supabase URL & Anon Key

# 3. Start local development server
npm run dev

# 4. Production build check
npm run build

# 5. Preview local production build
npm run preview
```

---

## 6. Security Testing Checklist

- [x] **CCI Data Isolation**: Authenticated CCI A (e.g. `BLR01`) cannot select or view records for CCI B (`DEL01`).
- [x] **Parameter Tampering Immunity**: Modifying client-side JavaScript or URL parameters (`?cci_code=DEL01`) does not bypass RLS; Supabase returns only `BLR01` rows.
- [x] **Duplicate Call Prevention**: Submitting multiple completions for the same `closure_id` is blocked by PostgreSQL unique index.
- [x] **Privileged Function Protection**: Non-admin users attempting to invoke `admin-users` Edge Function receive `403 Forbidden`.
- [x] **Service Role Key Secrecy**: The Supabase Service Role Key is never bundled into frontend assets or committed to Git.
- [x] **Customer PII Privacy**: Customer mobile numbers and identifiers are only served through authenticated RLS queries.

---

## 7. Data Testing Checklist

- [x] **Closure File Ingestion**: Uploading XLSX, XLS, and CSV files correctly matches headers (`SO Number`, `Closure ID`, `Customer Name`, `Mobile`, `Model`, `Closure Date`).
- [x] **Unmatched Columns Ingestion**: Additional Motorola vendor columns are preserved in `source_data JSONB`.
- [x] **Queue Progression**: Submitting feedback via `SUBMIT & NEXT` stores data, increments Completed count, decrements Pending count, and auto-fetches the next oldest closure.
- [x] **Calling Statuses**: Supports `Completed`, `Customer Not Reachable`, and `Call Back Required`.
- [x] **CSAT Rating System**: Requires 1–10 rating and Happy/Neutral/Unhappy categorization for completed calls.
- [x] **Live Realtime Reflection**: Admin dashboard reflects new CCI submissions without requiring a page refresh.
