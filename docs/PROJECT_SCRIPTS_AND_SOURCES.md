# FormifyPDF — Project Scripts & Source Architecture Reference

**Domain:** `formifypdf.com`  
**Stack:** React 19 + Vite + TypeScript + Tailwind CSS v4 + Express + SQLite (`node:sqlite`, WAL mode) / PostgreSQL migrations + `pdf-lib` + `pdfjs-dist` + Tesseract.js + Python (`PyMuPDF`, `pypdf`, `pdfplumber`, `OpenCV`, `pytesseract`)

This document inventories all package scripts, entry points, server scripts, Python engine utilities, database migrations, shared libraries, frontend UI components, and automated test suites used across FormifyPDF, along with the exact responsibility of each file.

---

## 1. NPM & CLI Scripts (`package.json`)

| Script / Command | Target | Purpose |
| :--- | :--- | :--- |
| `npm run dev` | `tsx server.ts` | Starts the unified Express backend + Vite middleware development server on port `3000`. Automatically runs SQLite migrations, recovers interrupted jobs, starts hourly retention cleanup, and serves both `/` and `/admin` plus `/api/*`. |
| `npm run build` | `vite build` | Compiles the React/TypeScript/Tailwind frontend bundle into `dist/` and copies unbundled `src/assets` into `dist/src/assets`. |
| `npm start` | `node server.ts` | Starts the production Node.js server (Node 22+ native TypeScript/ESM execution) serving the compiled `dist/` SPA and all API routes. |
| `npm run preview` | `vite preview` | Serves the static `dist/` frontend bundle independently for local frontend build inspection. |
| `npm run clean` | `rm -rf dist server.js` | Removes build output artifacts before a fresh build. |
| `npm run lint` | `tsc --noEmit` | Runs strict TypeScript type-checking across frontend, server, and tests without emitting JS files. |
| `npm test` | `vitest run` | Executes the complete Vitest test suite (unit, PDF detection benchmarks, REST API, RBAC, ZIP security, and React DOM integration tests). |

---

## 2. Core Entry Points & Infrastructure Config

| File | Purpose |
| :--- | :--- |
| `server.ts` | Primary HTTP application bootstrapper (`createApp`). Initializes SQLite + WAL mode, runs `recoverStaleJobs()`, sets baseline security headers, mounts `/api/v1`, `/api/zip-uploads`, and `/api`, attaches Vite dev middleware (or static `dist/` SPA fallback in production), schedules hourly POPIA/retention purging, listens on `0.0.0.0:3000`, and handles graceful `SIGINT`/`SIGTERM` shutdown. |
| `index.html` | HTML5 SPA entry point with synchronized SEO `<title>`, `<meta name="description">`, OpenGraph (`og:title`, `og:description`, `og:site_name`, `og:url` pointing to `https://formifypdf.com`), and root `<div id="root">`. |
| `src/main.tsx` | Client React bootstrap mounting `<App />` into `#root` and importing global CSS (`src/index.css`). |
| `src/App.tsx` | Top-level SPA router distinguishing `/` (public landing & converter `PublicLandingConverter`) from `/admin` (`AdminWorkspace` hosting `FormifyPdfStudio` and `ZipInspectorSection`). Keeps `/admin` hidden from public navigation on `/`. |
| `vite.config.ts` | Vite configuration enabling React, Tailwind CSS v4, `@` alias resolution, asset copying plugin, `0.0.0.0:3000` dev server binding, and conditional `DISABLE_HMR` handling. |
| `vitest.config.ts` | Vitest configuration defining test globs, timeouts, and environment rules for PDF, API, and JSDOM frontend tests. |
| `tsconfig.json` | Strict TypeScript compiler configuration covering browser (`DOM`), Node (`node:sqlite`, `node:*`), and test code. |
| `Dockerfile` | Multi-layer container definition installing Node.js, Python 3, Tesseract OCR, and OpenCV/PDF packages, building `dist/`, and launching `node server.ts`. |
| `docker-compose.yml` | Production orchestration stack wiring `postgres:16-alpine`, `redis:7-alpine`, and the `web` service on port `3000` with persistent volumes for SQLite/storage, generated PDFs, and signed returns. |
| `.env.example` | Reference template listing all supported runtime environment variables (`DATABASE_URL`, `FORMIFYPDF_ADMIN_PASSWORD`, `FORMIFYPDF_DB_PATH`, `FORMIFYPDF_STORAGE_DIR`, `FORMIFYPDF_WORKER_CONCURRENCY`, `MAX_UPLOAD_BYTES`, `PDF_RETENTION_HOURS`, `PYTHON_EXECUTABLE`, `PYTHON_TIMEOUT_MS`, `RATE_LIMIT_*`, `REDIS_URL`, `S3_*`, `STORAGE_PROVIDER`, etc.). |
| `metadata.json` | Application descriptor and capability manifest (`FormifyPDF`, permissions, and metadata). |
| `firebase-applet-config.json` | Client Firebase configuration metadata retained by the applet runtime. |

---

## 3. Python PDF Engine & Build Scripts

| Script | Purpose |
| :--- | :--- |
| `python/formifypdf_engine.py` | Self-hosted Python CLI engine invoked with JSON input/output payloads for `inspect`, `analyze`, `generate-acroform`, `render-pdf`, and `validate-acroform`. Uses `PyMuPDF (fitz)`, `pdfplumber`, `pypdf`, `OpenCV`, `Pillow`, and `pytesseract` to perform page geometry inspection, deskewing, OCR, vector + CV detection, AcroForm widget synthesis, flattening, and validation. |
| `scripts/build_field_map.py` | Standalone CLI calibration and diagnostic script (`python3 scripts/build_field_map.py --pdf ... --out ...`). Inspects blank PDF forms, reconstructs closed vector character-cell rows and checkboxes, pairs bilingual labels, and writes `tests/benchmark/fixtures/bench_field_map.json` and `storage/field_map_report.json`. |

---

## 4. Backend TypeScript Scripts (`src/server/*` & `server/*`)

| Script | Purpose |
| :--- | :--- |
| `src/server/v1Routes.ts` | Main REST API router mounted at `/api/v1`. Implements OpenAPI 3.1 spec (`/openapi.json`), admin bootstrap/login/logout/session/password-reset (`/auth/*`), user & RBAC management (`/users`, `/roles`), dashboard & audit events, authenticated Studio document analysis & visual manifest editing, Engine B template rendering & signed uploads, supporting attachments, **public conversion pipeline** (`/public/config`, `/public/documents`, `/public/zip-upload`, `/public/conversions/:id`, `/preview`, `/checkout`, `/download`, `/zip-download`), and **administrator controls** (`/admin`, `/admin/toggles`, `/admin/pricing-tiers`, `/admin/pricing-tiers/:id`) with live server-side enforcement (`403`, `402`, `400`). |
| `src/server/routes.ts` | Utility API router mounted at `/api`, providing `/api/health` diagnostics (verifying database connectivity, storage provider health, Python script presence, and Node fallback engine availability). |
| `src/server/auth.ts` | Security and RBAC core: `scrypt` salted password hashing & timing-safe verification, SHA-256 session/API-key token hashing, session issuance & revocation checks, `requireAuth`, `requirePermission`, `isAdminBootstrapped`, and `logAuditEvent` persistence. |
| `src/server/db/database.ts` | SQLite (`node:sqlite`) connection singleton configured with `PRAGMA busy_timeout = 5000`, `PRAGMA foreign_keys = ON`, and `PRAGMA journal_mode = WAL`. Runs versioned SQL migrations (`001`–`003`), seeds RBAC roles/permissions and default tenant (`tenant_default`), ensures `public_conversions` table exists, and upgrades legacy pricing tiers idempotently. |
| `src/server/job-queue.ts` | Asynchronous in-process analysis job queue and worker pool (`MAX_CONCURRENCY = FORMIFYPDF_WORKER_CONCURRENCY || 2`). Manages job queueing, stale-job recovery on startup (`recoverStaleJobs`), multi-stage status updates, transactional manifest/page/field persistence, and initial AcroForm asset creation (`generateAcroFormAssetForDocument`). |
| `src/server/formifypdf-runner.ts` | Engine execution orchestrator (`runFormifyPythonEngine`). Probes Python PDF dependencies once (cached), spawns `python/formifypdf_engine.py` with UTF-8/temp JSON IPC and `PYTHON_TIMEOUT_MS` protection, and transparently falls back to the built-in pure-TypeScript Node engine (`runFormifyNodeEngine`) whenever Python/native PDF libraries are absent. |
| `src/server/formifypdf-node-engine.ts` | Complete TypeScript fallback & native Node conversion engine using `pdf-lib` + `pdfjs-dist`. Performs page inspection, vector geometry parsing, raster CV, local Tesseract OCR, field fusion, AcroForm widget creation (comb character grids, checkboxes, radios, text fields, CropBox & rotation alignment), Engine B population/flattening, and structural validation. |
| `src/server/pdf-vector-extractor.ts` | Extracts vector paths, underlines, rectangles, dotted/dashed lines, tables, and text spans/word boxes from digital PDFs via `pdfjs-dist`. |
| `src/server/pdf-raster-cv.ts` | Rasterizes PDF pages onto `@napi-rs/canvas`, computes projection-profile skew angles, deskews scanned pages, renders thumbnails, and detects visual boxes/lines for scanned forms. |
| `src/server/pdf-local-ocr.ts` | Runs offline `tesseract.js` OCR (`@tesseract.js-data/eng`) on scanned pages or non-vector PDFs to recover field labels and spatial word bounds. |
| `src/server/formifypdf-fusion.ts` | Fuses vector primitives, raster CV candidates, and OCR words into typed form fields (`text`, `comb`, `checkbox`, `radio`, `multiline`, `date`, etc.) with clean label association and deduplication. |
| `src/server/detection-fusion.ts` | Helper utilities combining geometric and text heuristics to refine bounding boxes, confidence scores, and phantom-field filtering. |
| `src/server/formifypdf-storage.ts` | Path-confined binary asset storage (`originals`, `acroforms`, `rendered`, `signed`, `supporting`, `thumbnails`) with PDF magic-byte/EOFBuf signature validation, supporting image MIME validation, safe path traversal resolution, and storage footprint calculation. |
| `src/server/python-runner.ts` | Cross-platform Python executable resolver (`PYTHON_EXECUTABLE`, `python3` / `python`) and typed `PythonEngineError` definition. |
| `src/server/rate-limit.ts` | Sliding-window in-memory per-IP HTTP rate limiter (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`) returning `429` + `Retry-After` headers with periodic memory pruning. |
| `server/zipRoutes.ts` | Express router mounted at `/api/zip-uploads` handling ZIP Inspector archive uploads, inspection, macOS clutter cleanup, brand token CSS editing, and safe archive repackaging. |
| `server/zipStorage.ts` | Secure ZIP archive handler enforcing size limits (`DEFAULT_MAX_ZIP_BYTES`), zip-slip/path-traversal guards (`ZipSecurityError`), manifest generation, entry extraction, and archive cleanup. |

---

## 5. Database Migration Scripts (`migrations/*`)

| Migration File | Purpose |
| :--- | :--- |
| `migrations/001_init.sql` | SQLite baseline schema: `tenants`, `roles`, `permissions`, `role_permissions`, `users`, `sessions`, `api_keys`, `documents`, `document_pages`, `analysis_jobs`, `ocr_jobs`, `field_manifests`, `detected_fields`, `acroform_assets`, `templates`, `template_versions`, `template_approvals`, `generated_documents`, `signed_uploads`, `storage_metadata`, `api_requests`, `audit_events`, and `processing_errors`. |
| `migrations/002_supporting_documents.sql` | SQLite schema extension adding `supporting_documents` for multi-file PDF/image attachments linked to documents or rendered outputs. |
| `migrations/003_feature_toggles_and_pricing.sql` | SQLite schema extension adding public conversion toggles on `tenants` (`top_tier_zip_upload`, `top_tier_zip_download`, `normal_upload`, `normal_download`), creating `pricing_tiers` + default active tiers (`$2.99` / 15p, `$5.99` / 30p, `$7.49` / 45p, `$9.99` / 60p), and creating `public_conversions`. |
| `migrations/postgres/001_init.sql` | PostgreSQL-dialect equivalent of `001_init.sql` executed automatically by `docker-compose.yml` during database initialization. |
| `migrations/postgres/002_supporting_documents.sql` | PostgreSQL-dialect equivalent of `002_supporting_documents.sql` adding supporting attachment tables for Docker/Postgres deployments. |

---

## 6. Shared Libraries & Frontend Scripts (`src/*`)

| Script | Purpose |
| :--- | :--- |
| `src/lib/formifypdf/types.ts` | Shared TypeScript domain contracts (`RoleName`, `FieldManifest`, `DetectedFormField`, `DocumentPageInfo`, `AcroFormValidationReport`, `JobStage`, `OutputPolicy`, `TemplateStatus`). |
| `src/lib/formifypdf/coordinate.ts` | Bidirectional PDF coordinate math converting top-left canvas points, bottom-left PDF MediaBox/CropBox coordinates, page rotations (`0`, `90`, `180`, `270`), and IoU geometry overlap calculations. |
| `src/lib/formifypdf/manifest-schema.ts` | `zod` validation schema (`FieldManifestUpdateSchema`) ensuring visual editor manifest saves adhere strictly to coordinate, field-type, comb `maxLength`, and option constraints. |
| `src/lib/storage/storage.ts` | Pluggable storage provider abstraction (`local` filesystem vs S3-compatible object storage via `@aws-sdk/client-s3`) plus `deleteExpired(retentionHours)` cleanup. |
| `src/lib/brandAudit.ts` | Client/shared CSS brand-token & clutter analyzer used by the Admin ZIP Inspector to audit archive stylesheets and flag macOS metadata junk (`__MACOSX`, `._*`). |
| `src/components/PublicLandingConverter.tsx` | Public commercial landing & conversion workspace (`/`). Includes branded navigation, hero before/after showcase, drag-and-drop `Upload` + `ZIP Upload` intake, live conversion progress bar, `pdfjs-dist` interactive `PdfPreviewFrame`, dynamic page-tier matching, locked `Download` / `ZIP Download` pay-to-unlock flow, `Above X Pages` & `Bulk/Business/Recurring` quote modals, FAQ, Contacts section & inquiry form, commercial footer with `formifypdf.com` socials, and live `BroadcastChannel`/`focus` synchronization with Admin updates. |
| `src/components/BrandMark.tsx` | Brand SVG emblem and light/dark `BrandWordmark` component rendered in the header and dark commercial footer. |
| `src/components/studio/FormifyPdfStudio.tsx` | Full administrator workspace mounted on `/admin`. Provides Dashboard metrics, **Feature Toggles & Page Pricing Tiers** (create, inline edit, activate/deactivate, delete, plus live broadcast sync), Convert PDF studio, Document Analysis, Visual Field Editor, Template Library & Version Diffs, Side-by-Side Validation & Approval, Engine B Document Generation, API Keys & OpenAPI Viewer, Job History, Tenant Retention Settings, and User/RBAC/Audit Log management. |
| `src/components/studio/AuthGate.tsx` | Authentication & bootstrap gate shown strictly on `/admin`: supports one-time **Claim FormifyPDF Administrator**, email/password **Sign In**, and token-based **Password Reset**. |
| `src/components/studio/PdfFieldEditor.tsx` | Interactive canvas field calibrator allowing admins/editors to inspect detected bounding boxes on each PDF page, drag/resize fields, convert field types, configure comb cell counts, and save updated `FieldManifest` versions. |
| `src/components/studio/DocumentPreviewAndValidation.tsx` | Side-by-side preview, interactive test-fill runner, structural AcroForm validation report viewer, and template approval workflow inside `/admin`. |
| `src/components/studio/studio-api.ts` | Typed REST client (`StudioApiClient`) managing Bearer tokens, upload progress via `XMLHttpRequest`, binary blob downloads, and `PricingTierRecord` + `matchPricingTierForPages` tier resolution. |
| `src/components/ZipInspectorSection.tsx` | Admin archive utility mounted inside `/admin` under **ZIP Workspace & Auditor** to inspect uploaded `.zip` bundles, strip clutter, edit stylesheet tokens, and repackage safe archives. |
| `src/index.css` | Tailwind CSS v4 entry stylesheet defining `#F7F8F7` page ground, typography smoothing, smooth scrolling with `prefers-reduced-motion`, and emerald brand text selection colors. |

---

## 7. Automated Test Suites (`tests/*`)

| Test File | Purpose |
| :--- | :--- |
| `tests/pdf/alv-conversion.test.ts` | Regression suite validating 57-field `ALV-009` form detection accuracy, zero phantom fields, `YYMMDD` comb cells, and widget placement. |
| `tests/pdf/universal-real-forms.test.ts` | Multi-form real-world test suite validating `NCO-006-001.pdf`, `ACR-12-2014-10.pdf`, skewed scans, dotted lines, open-top tick combs, and full `/api/v1` upload-to-download flows. |
| `tests/pdf/formifypdf-engine.test.ts` | Verifies Engine A & Engine B on unfamiliar digital multi-page PDFs and scanned image-only PDFs via OCR fallback. |
| `tests/pdf/pdf-engine.test.ts` | Validates benchmark field-map integrity and direct execution of `python/formifypdf_engine.py`. |
| `tests/benchmark/detection-benchmark.test.ts` | 4-scenario precision/recall/IoU benchmark suite (digital government form >=95% recall, scanned OCR >=90% recall, ~2.1° deskew recovery, and mixed A4 + rotated 90° Letter CropBox round-trip). |
| `tests/api/public-conversion-and-admin.test.ts` | Verifies admin auth guards on `/api/v1/admin`, `400` validation on pricing tiers, `PATCH`/`DELETE` live propagation to `/public/config`, `403` toggle enforcement, and full public ZIP/PDF convert → preview → `402` lock → checkout → unlocked PDF & ZIP download. |
| `tests/api/formifypdf-v1.test.ts` | Verifies `/api/health`, `/openapi.json`, one-time admin bootstrap lock, RBAC permissions, async analysis, manifest editing, template approval, Engine B rendering, and signed return upload. |
| `tests/api/repair-and-uploads.test.ts` | Verifies database migration integrity, bearer-only auth (blocking query tokens), RBAC isolation, and multi-file supporting PDF/image uploads. |
| `tests/api/zip-uploads.test.ts` | Verifies `/api/zip-uploads` archive ingestion, zip-slip path traversal rejection, clutter stripping, and safe download repackaging. |
| `tests/frontend/public-landing.test.tsx` | JSDOM React integration test verifying public `/` landing UI, pricing tiers, footer/socials/contacts, hidden `/admin`, full client upload → preview → locked downloads → checkout → unlock, and live focus config refresh. |
| `tests/frontend/formifypdf-studio.test.tsx` | JSDOM React integration test verifying the `/admin` Studio 3-step upload → convert → download workflow. |
| `tests/frontend/zip-inspector.test.tsx` | JSDOM React integration test verifying the Admin ZIP Inspector workflow. |
