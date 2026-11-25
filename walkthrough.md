# Security Summary

**Reviewed Files**: 22
**Issues Resolved**: 4

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Storage Confinement & Missing Provider | `src/lib/storage/storage.ts` | 83 | The storage provider module imported at server startup was missing, leaving legacy PDF generation and signed uploads without confined file storage or S3 safeguards. | High | Fixed | Implemented `LocalStorageProvider` and `S3StorageProvider` reusing shared security helpers (`assertConfinedPath`, `assertValidTenantId`, `isRegularNonSymlinkFile`, `validatePdfBufferSignature`), atomic file writes, private permissions (`0600`/`0700`), and private-by-default S3 objects. |
| Missing Tenant Filter in Background Worker | `src/server/job-queue.ts` | 390 | `generateAcroFormAssetForDocument` queried `documents` by `id` alone without filtering by `tenant_id`. | Medium | Fixed | Added `AND tenant_id = ?` to the document lookup query while preserving strict storage bucket validation. |
| Tenant Filtering & Metadata Cleanup Gaps | `src/server/v1Routes.ts` | 206 | Several update/delete statements omitted `AND tenant_id = ?`, retention sweeps only cleaned `tenant_default`, and deleting records could leave orphaned child files or `storage_metadata` rows. | Medium | Fixed | Added `AND tenant_id = ?` across update/delete queries, added `purgeAllTenantsExpiredDocuments`, and cleaned up child storage objects and `storage_metadata` records atomically on delete and purge. |
| Supporting File Replacement Safeguards | `src/server/v1Routes.ts` | 2874 | There was no dedicated replacement endpoint for supporting attachments with transactional swap and old-file cleanup. | Low | Fixed | Added `PUT /api/v1/supporting-documents/:id` with RBAC checks (`documents:write`), tenant ownership checks before storing bytes, size caps (`413`), magic-byte/MIME validation (`400`), and old-file cleanup after DB commit. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| Authentication & Sessions | `src/server/v1Routes.ts` | Accepts credentials strictly via `Authorization: Bearer` or `X-API-Key` headers (rejecting `?token=` query parameters with `401`), hashes tokens and passwords safely, and uses one-time first-run admin setup when no env admin passcode is configured. |
| Database Queries | `src/server/v1Routes.ts` | All SQLite queries use parameterized placeholders (`?`) and explicit `BEGIN` / `COMMIT` / `ROLLBACK` transactions for multi-step writes. |
| File Upload Validation | `src/server/formforge-storage.ts` | Verifies `%PDF-` / `%%EOF` trailers on PDFs and checks PNG, JPEG, WebP, and PDF magic bytes + declared MIME types + extensions before writing files, with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` on downloads. |
| Path Traversal Prevention | `src/server/formforge-storage.ts` | Rejects null bytes, absolute paths, `..` segments, and unapproved buckets, and verifies resolved paths stay strictly inside the storage root. |
| Error Handling & PII Redaction | `src/server/formforge-node-engine.ts` | Overflow and validation errors report character count limits without echoing sensitive field values back in error responses or logs. |
| Dependencies | `package.json` | Audited 362 packages with `bun audit` — 0 known vulnerabilities found. |

## PoC Verification

### Path Traversal & Symlink Escape Against PDF Storage
#### Summary
| Field | Value |
|---|---|
| Issue Type | Path Traversal / Arbitrary File Read & Write |
| Impact | High |
| Affected File | `src/lib/storage/storage.ts:83` |
| Test Scenario | `GET /api/generated/..%2F..%2Fpackage.json/download` and `provider.saveGeneratedPdf("../evil", pdfBuffer)` + symlinked file inside storage directory |

#### How It Was Fixed
Document identifiers and optional tenant identifiers are validated against strict safe-character patterns before resolving confined paths inside the storage root, and reads verify via `lstat` that targets are regular non-symlink files.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `GET /api/generated/..%2F..%2Fpackage.json/download` arrives at the legacy download handler and `provider.saveGeneratedPdf("../evil", buf)` is invoked in tests. | Enters validation |
| 2 | `assertValidDocumentId` (`src/lib/storage/storage.ts:83`) and `assertConfinedPath` (`src/lib/storage/storage.ts:137`) reject `..` and non-matching IDs before any filesystem operation runs; `isRegularNonSymlinkFile` (`src/server/formforge-storage.ts`) rejects symlinked targets. | Blocked before disk access |
| 3 | HTTP request returns `404` and storage call rejects with `"Invalid document identifier"`; symlinked reads return `null`. | **Handled Safely** |

#### Conclusion
**Fix Verified** - Traversed paths, invalid document IDs, and symlink escapes are rejected before reading or writing any file on disk.

---

### Cross-Tenant Access & Spoofed File Upload on Supporting Attachments
#### Summary
| Field | Value |
|---|---|
| Issue Type | Cross-Tenant Data Access & File Type Spoofing |
| Impact | Medium |
| Affected File | `src/server/v1Routes.ts:2874` |
| Test Scenario | Authenticated admin in `tenant_other` attempts `GET`/`PUT`/`DELETE` on a supporting document belonging to `tenant_default`; and `POST`/`PUT` sends `<script>alert(1)</script>` or `NOT_A_PNG` disguised as `image/png`. |

#### How It Was Fixed
Every supporting document endpoint queries `WHERE id = ? AND tenant_id = ?` before touching disk or returning metadata, and runs `validateSupportingFileSignature` on all uploaded buffers before writing to storage.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Cross-tenant `PUT /api/v1/supporting-documents/:id` and spoofed `.png` payload arrive at `src/server/v1Routes.ts:2874`. | Request authenticated |
| 2 | Tenant-scoped SQL query at `src/server/v1Routes.ts:2920` finds no matching record for `tenant_other`; for same-tenant requests, `validateSupportingFileSignature` at `src/server/v1Routes.ts:2939` checks binary PNG headers (`89 50 4E 47 0D 0A 1A 0A`). | Cross-tenant lookup returns `404`; spoofed bytes fail signature check (`400`) |
| 3 | Cross-tenant requests return `404`, spoofed uploads return `400`, and no invalid bytes are saved to storage. | **Handled Safely** |

#### Conclusion
**Fix Verified** - Supporting documents remain strictly isolated per tenant and only signature-verified PDF, PNG, JPEG, and WebP files are accepted.
