# FormifyPDF — Administrator Operations & Studio Guide

**Hidden Admin Route:** `/admin` (never linked on `/` or exposed to public visitors)  
**Domain:** `formifypdf.com`

This guide details how an administrator accesses, configures, secures, and operates the entire FormifyPDF platform—including local PC testing, live pricing & feature toggle control, document conversion studio, template approval, Engine B rendering, RBAC users, API keys, and retention management.

---

## 1. Accessing & Logging Into `/admin` (Local PC & Live Deployments)

The public homepage (`/`) intentionally hides all administrative UI (`Admin` links, tabs, and `AuthGate`). To access the admin workspace, navigate directly to **`/admin`** in your browser's address bar:

- **Local PC Development Server:**
  1. Ensure Node.js 20/22+ is installed and run `npm install` followed by `npm run dev` (or start Docker via `docker-compose up`).
  2. Open `http://localhost:3000/admin` in your browser.
- **Hosted Development / Production Server:**
  - Development URL: `https://<your-dev-domain>/admin`
  - Production Domain: `https://formifypdf.com/admin`

### Login Flows on `/admin`

1. **First-Run Setup (`FORMIFYPDF_ADMIN_PASSWORD` is NOT set and no admin exists in SQLite):**
   - `/admin` opens **Claim FormifyPDF Administrator**.
   - Pre-filled email is `admin@formifypdf.local` (editable), along with Organisation Name, Full Name, and a password of **at least 8 characters**.
   - Click **Claim Admin & Open Studio**. Once claimed, public bootstrap locks permanently (`HTTP 409` on any second attempt).
2. **Returning Sign-In (or when `FORMIFYPDF_ADMIN_PASSWORD` IS set in `.env`):**
   - `/admin` opens **Sign In to FormifyPDF Studio**.
   - Enter your claimed administrator email (default `admin@formifypdf.local`) and your password.
   - If `FORMIFYPDF_ADMIN_PASSWORD` is configured in `.env`, signing in with `admin@formifypdf.local` (or any administrator email) and that secret password automatically authenticates (and bootstraps the initial admin record on first login if none exists).
3. **Password Reset:**
   - Click **Forgot password?**, enter the account email, click **Issue Token** (in non-production mode the short-lived reset token appears immediately on screen), enter the token and new 8+ character password, and submit **Confirm Reset**. All previous sessions are automatically revoked.

---

## 2. Live Website Configuration (**Admin Controls** Tab)

All settings changed inside **Admin Controls** write directly to SQLite and emit a live configuration sync (`BroadcastChannel` + `localStorage` + `GET /api/v1/public/config` with `Cache-Control: no-store`), applying immediately across open `/` visitor tabs and enforced strictly on the backend:

### A. Public Feature Toggles (`POST /api/v1/admin/toggles`)

| Toggle | Public UI & Server Effect When Enabled (`ON`) / Disabled (`OFF`) |
| :--- | :--- |
| **Client PDF Upload** (`normalUpload`) | **ON:** `Upload` button enabled on `/`; `POST /api/v1/public/documents` & `POST /api/v1/documents` accept PDFs.<br>**OFF:** `Upload` disabled on `/` with admin notice; server returns `HTTP 403`. |
| **Client PDF Download** (`normalDownload`) | **ON:** `Download` unlocks after payment; server streams AcroForm PDF.<br>**OFF:** `Download` remains disabled even after payment with admin notice; server returns `HTTP 403`. |
| **ZIP Upload** (`topTierZipUpload`) | **ON:** `ZIP Upload` button enabled on `/`; `POST /api/v1/public/zip-upload` accepts `.zip` bundles.<br>**OFF:** `ZIP Upload` disabled on `/` with admin notice; server returns `HTTP 403`. *(Note: default after fresh migration `003` is `OFF` until enabled by Admin!)* |
| **ZIP Download** (`topTierZipDownload`) | **ON:** `ZIP Download` unlocks after payment; server packages AcroForm + archive assets.<br>**OFF:** `ZIP Download` disabled with admin notice; server returns `HTTP 403`. |

Click **Save Feature Toggles** to persist and broadcast changes live.

### B. Page-Based Pricing Tiers (`POST` / `PATCH` / `DELETE /api/v1/admin/pricing-tiers`)

Administrators have full CRUD control over page-based pricing tiers:
- **Add Tier:** Fill in **Tier Name** (e.g., `Up to 75 pages`), **Max Pages** (positive integer), **Price (USD)** (converted accurately to cents), and optional **Description**, then click **Add Pricing Tier**. *(Invalid inputs return `HTTP 400`.)*
- **Edit Tier Live:** Click **Edit** on any row to modify **Name**, **Max Pages**, **Price (USD)**, or **Description** inline, then click **Save**. Updated prices appear immediately on `/` and are enforced by `POST /api/v1/public/conversions/:id/checkout`.
- **Activate / Deactivate Tier:** Click **Deactivate** or **Activate** to hide or restore a tier without deleting its record. Only active tiers (`is_active = 1`) appear on `/` and participate in `matchPricingTierForPages`.
- **Delete Tier:** Click **Delete** to remove a tier permanently.
- **Dynamic Custom Quote Threshold:** `/` automatically sets the **"Above X Pages — Custom Price"** boundary to the highest active tier's `max_pages` (default `60`, making `61+` pages request a custom quote).

---

## 3. Studio Workspace Modules (`/admin`)

The `/admin` header switches between **Conversion Studio** and **ZIP Workspace & Auditor**:

### Conversion Studio Navigation
1. **Dashboard:** Real-time DB metrics (total documents processed, templates created, approved templates, conversion success rate %, failures, storage footprint in bytes, recent audit activity, and recent jobs).
2. **Admin Controls:** Live Feature Toggles and Page Pricing Tier management (Section 2 above).
3. **Convert PDF:** Authenticated 3-step internal converter (`Upload PDF` → `Convert to Fillable PDF` → `Download AcroForm`), supporting OCR enable/force flags and OCR language selection.
4. **Document Analysis:** Inspect page dimensions, MediaBox/CropBox geometry, rotation, scanned vs digital detection, text spans, and OCR job durations per page.
5. **Visual Field Editor (`PdfFieldEditor`):** Click and drag/resize detected field boxes on any page canvas, rename field keys/labels, change types (`text`, `comb`, `checkbox`, `radio`, `multiline`, `date`), adjust `maxLength` comb cells, save new manifest versions (`PUT /api/v1/documents/:id/manifest`), and regenerate the AcroForm PDF.
6. **Templates Library:** Create versioned templates from analyzed documents, inspect structural diffs (`added`, `modified`, `removed` fields across versions), duplicate templates, export JSON manifests, and download Master AcroForms.
7. **Preview & Validation (`DocumentPreviewAndValidation`):** Run sample test-fills (flattened or fillable), inspect structural AcroForm validation reports (overlapping widgets, out-of-bounds coordinates), and **Approve & Lock** templates (`templates:approve` permission required).
8. **Document Generation (Engine B):** Select any **Approved** template, fill dynamic manifest fields (or invoke `/api/v1/render/:templateId` via API), preview/download the generated customer PDF (flattened default or fillable), attach supporting documents (`.pdf`, `.png`, `.jpg`, `.webp`), and upload physically signed customer copies.
9. **API & Integrations:** Issue scoped API keys (`fpk_...` for `X-API-Key` or `Bearer` auth), revoke compromised keys immediately, and inspect the live `/api/v1/openapi.json` endpoint catalog.
10. **Processing History:** Monitor `queued`, `running`, `completed`, and `failed` jobs and click **Retry** on any failed job.
11. **Settings & Retention:** Update Workspace/Organisation Name, configure **Document Retention Window (Days)** (immediately applied to all new uploads' `retention_expires_at`), check storage footprint, and manually trigger **Run Retention Purge** (automatic hourly cleanup also runs in `server.ts`).
12. **Users, RBAC & Audit:** View the 6 least-privilege roles (`Administrator`, `Template Manager`, `Editor`, `Reviewer`, `API Integration User`, `Read-Only User`), add/disable users, inspect and revoke active Bearer sessions immediately, and audit system events (`admin.toggles_updated`, `admin.pricing_tier_*`, `public.checkout_confirmed`, `auth.login`, etc.).

### ZIP Workspace & Auditor (`ZipInspectorSection`)
- Unpack `.zip` asset packages safely with path-traversal confinement, run brand/token audits, strip macOS clutter (`__MACOSX`, `._*`), edit bundled CSS safely, and repackage clean `.zip` downloads.

---

## 4. Production Deployment & Scaling Checklist

- **Environment Secrets (`.env`):** Set a strong `FORMIFYPDF_ADMIN_PASSWORD` (optional once claimed, or used as admin override), `FORMIFYPDF_STORAGE_DIR`, `FORMIFYPDF_DB_PATH`, and `PDF_RETENTION_HOURS`.
- **Concurrency Tuning:** Set `FORMIFYPDF_WORKER_CONCURRENCY` (default `2`) based on available CPU cores/RAM (each concurrent OCR/Python worker consumes ~150–400 MB RAM during heavy raster processing).
- **Rate Limits:** Adjust `RATE_LIMIT_WINDOW_MS` (default `60000`) and `RATE_LIMIT_MAX_REQUESTS` (default `30`) to match expected office/public traffic behind a reverse proxy.
- **Backups:** Back up SQLite (`formifypdf.sqlite` + `-wal`/`-shm` or via `.backup`) and `FORMIFYPDF_STORAGE_DIR` (`originals/`, `acroforms/`, `rendered/`, `signed/`, `supporting/`), or run `docker-compose.yml` with PostgreSQL + S3 storage provider.
