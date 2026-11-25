# FormifyPDF — Website & Platform Guide

**Website:** `https://formifypdf.com`  
**Support:** `support@formifypdf.com` · **Sales & Custom Volume:** `sales@formifypdf.com`  
**Response Hours:** Monday – Friday (Same-business-day replies)

---

## 1. Overview: What FormifyPDF Does

FormifyPDF converts non-fillable (static digital or scanned) PDF forms and structured ZIP form bundles into **ISO 32000-1 interactive AcroForm PDFs**—without requiring visitors to create an account or sign in.

Key platform capabilities:
- **Zero-Login Client Workflow:** Visitors upload a PDF or ZIP bundle directly on `/` and inspect the converted fillable PDF before paying.
- **Hybrid Structural + OCR Field Detection:** Combines vector path analysis (underlines, closed boxes, table grids, checkboxes, radio options) with raster computer vision, projection-profile deskewing, and offline Tesseract OCR for scanned forms.
- **Comb Character Grid Preservation:** Fixed-width numeric/date boxes (such as `YYMMDD` dates, tax IDs, and account numbers) are generated as native AcroForm comb fields (`MaxLen`) so characters align cell by cell.
- **Geometry & Reader Compatibility:** Preserves original typography, CropBox offsets, mixed paper sizes (A4/Letter/Legal), and rotated pages (`0°`, `90°`, `180°`, `270°`) for Adobe Acrobat, macOS Preview, Chrome, Edge, and Firefox.

---

## 2. Public User Journey (`/`)

1. **Choose Upload Mode (`Upload` or `ZIP Upload`):**
   - Click **Upload** (or drag and drop a `.pdf` file) to convert a single PDF form.
   - Click **ZIP Upload** (or drag and drop a `.zip` archive) to convert a PDF form along with bundled package assets (preserving non-PDF supporting files on export).
   - *(Availability of `Upload` and `ZIP Upload` reflects live administrator feature toggles.)*
2. **Convert to Fillable PDF:**
   - Click **Convert to Fillable PDF**.
   - Real-time upload and multi-stage processing progress appears automatically (`Queued` → `Inspecting page geometry` → `Running OCR` → `Detecting fields` → `Building AcroForm widgets` → `Ready`).
3. **Inspect Live On-Screen Preview:**
   - The converted fillable PDF renders immediately inside the **Converted Fillable PDF Preview** viewer with page navigation (`Previous` / `Next`) and zoom (`75%`, `100%`, `125%`).
   - Beside the viewer, the **Conversion Ready** summary displays source type, total page count (for ZIPs, summed across PDFs inside the archive), detected field/widget counts, and the automatically matched active pricing tier.
4. **Pay Matched Page Tier to Unlock Downloads:**
   - Before checkout, both **Download** (PDF) and **ZIP Download** (ZIP bundle) remain strictly **Locked** in both the UI and on the server (`HTTP 402` if requested directly).
   - Click **Pay $X.XX to Unlock Downloads** to confirm the matched tier.
5. **Download Converted Outputs:**
   - Immediately upon confirmation, **Download** exports `<slug>-fillable-acroform.pdf` and **ZIP Download** exports `<slug>-fillable-bundle.zip` (containing the fillable AcroForm PDF alongside non-PDF archive files).

---

## 3. Page-Based Pricing & Custom Plans

Pricing tiers are stored in the database and loaded live on `/` from `/api/v1/public/config`:

| Plan / Tier | Coverage | Default Price |
| :--- | :--- | :--- |
| **Up to 15 pages** | Single PDF or ZIP bundle up to 15 pages | **$2.99** |
| **Up to 30 pages** | Single PDF or ZIP bundle up to 30 pages | **$5.99** |
| **Up to 45 pages** | Single PDF or ZIP bundle up to 45 pages | **$7.49** |
| **Up to 60 pages** | Single PDF or ZIP bundle up to 60 pages | **$9.99** |
| **Above 60 Pages** *(or above highest active tier)* | High-page packets (`61+` pages) | **Custom Price** (Quote modal / `sales@formifypdf.com`) |
| **Bulk, Business & Recurring Conversions** | Organizations with bulk batches or ongoing monthly volume | **Custom Business Plan** (Quote modal / `sales@formifypdf.com`) |

*Note: Whenever an administrator adds, edits, deactivates, or deletes pricing tiers in `/admin`, the pricing grid, tier matching, and checkout amount update live on `/`.*

---

## 4. Contacts, Policies & Footer Resources

- **Contact Section (`#contact`):** Provides direct commercial email channels (`support@formifypdf.com` for general/format support, `sales@formifypdf.com` for 60+ page quotes and bulk/recurring business agreements), `https://formifypdf.com`, business hours, and a validated message form.
- **Specifications & Legal Modals:** Accessible from the footer (`AcroForm Specification`, `Security & Document Handling`, `Privacy Policy`, `Terms of Service`).
- **Social Channels:** Linked in the footer (`X`, `LinkedIn`, `GitHub`, `YouTube`).

---

## 5. Concurrent Multi-User Handling & Architecture

FormifyPDF isolates every visitor and concurrent conversion safely:

1. **Per-Conversion Token & File Isolation:**
   - Each upload receives a cryptographically random `conversionId` (`conv_...`), unique `documentId`, SHA-256 hashed 48-char `accessToken` (passed only via `x-conversion-token` header), and randomized storage keys (`originals/<random>.pdf`, `acroforms/<random>.pdf`). Users cannot view, preview, pay for, or download another user's conversion.
2. **Asynchronous Bounded Worker Queue (`src/server/job-queue.ts`):**
   - Incoming conversions return immediately with `HTTP 201` + `jobId` and are placed in `activeQueue`.
   - Workers execute up to `FORMIFYPDF_WORKER_CONCURRENCY` jobs simultaneously (default `2` concurrent PDF pipelines; configurable via environment variable to match CPU cores). Additional simultaneous uploads queue in FIFO order without blocking HTTP requests or dropping connections.
   - Each job spawns an isolated OS temp IPC directory and Python/Node conversion context, preventing memory/variable cross-talk between concurrent users.
   - On server restart, `recoverStaleJobs()` cleanly marks interrupted jobs as recoverable failures.
3. **Database Concurrency (SQLite WAL Mode):**
   - SQLite is configured with `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`, and `BEGIN IMMEDIATE` atomic transactions around manifest/page writes so concurrent reads (polling, previews, pricing lookups) never block writes and concurrent writes serialize cleanly without `SQLITE_BUSY` crashes. (PostgreSQL migrations are also provided for multi-container deployments.)
4. **Per-IP Rate Limiting (`src/server/rate-limit.ts`):**
   - Upload and auth endpoints enforce a sliding-window rate limiter (`RATE_LIMIT_MAX_REQUESTS`, default `30` per `RATE_LIMIT_WINDOW_MS = 60000`) to protect worker capacity from single-client floods.
5. **Storage & Security:**
   - All paths are strictly confined inside `FORMIFYPDF_STORAGE_DIR` and `UPLOADED_ZIPS_DIR`, blocking zip-slip traversal and rejecting invalid PDF/ZIP signatures before analysis.
