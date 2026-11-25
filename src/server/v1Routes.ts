import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import type { NextFunction, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { FieldManifestUpdateSchema } from "../lib/formifypdf/manifest-schema.ts";
import type {
  AcroFormValidationReport,
  FieldManifest,
  OutputPolicy,
  RoleName,
  TemplateStatus,
} from "../lib/formifypdf/types.ts";
import {
  createSessionForUser,
  hasAnyAdminUserInDb,
  hashPassword,
  hashToken,
  isAdminBootstrapped,
  logAuditEvent,
  requireAuth,
  requirePermission,
  resolvePrincipalFromRequest,
  verifyPassword,
  type AuthedRequest,
} from "./auth.ts";
import { ROLE_DEFINITIONS, getDatabase, getRolePermissions } from "./db/database.ts";
import { runFormifyPythonEngine } from "./formifypdf-runner.ts";
import {
  computeDirectoryBytes,
  deleteStorageObject,
  readStorageBuffer,
  resolveSafeStoragePath,
  saveStorageBuffer,
  validatePdfBufferSignature,
  validateSupportingFileSignature,
} from "./formifypdf-storage.ts";
import {
  enqueueAnalysisJob,
  generateAcroFormAssetForDocument,
} from "./job-queue.ts";
import { createRateLimiter } from "./rate-limit.ts";

export interface V1RouterConfig {
  disableRateLimit?: boolean;
  maxPdfUploadBytes?: number;
}

const BootstrapSchema = z.object({
  email: z.string().email().max(180),
  fullName: z.string().min(2).max(120),
  password: z.string().min(8).max(128),
  organisationName: z.string().min(2).max(120).optional(),
});

const LoginSchema = z.object({
  email: z.string().email().max(180),
  password: z.string().min(1).max(128),
});

const CreateUserSchema = z.object({
  email: z.string().email().max(180),
  fullName: z.string().min(2).max(120),
  role: z.enum([
    "administrator",
    "template_manager",
    "editor",
    "reviewer",
    "api_integration_user",
    "read_only_user",
  ]),
  password: z.string().min(8).max(128),
});

const CreateTemplateSchema = z.object({
  documentId: z.string().min(1),
  name: z.string().min(2).max(180),
  description: z.string().max(500).default(""),
  category: z.string().min(1).max(80).default("General"),
  tags: z.array(z.string().max(40)).max(20).default([]),
  outputPolicy: z.enum(["flattened", "fillable", "both"]).default("flattened"),
});

function deleteSupportingRecordAssets(
  db: ReturnType<typeof getDatabase>,
  tenantId: string,
  row: { id: string; storage_key: string }
) {
  deleteStorageObject(row.storage_key);
  db.prepare("DELETE FROM storage_metadata WHERE tenant_id = ? AND storage_key = ?").run(
    tenantId,
    row.storage_key
  );
  db.prepare("DELETE FROM supporting_documents WHERE id = ? AND tenant_id = ?").run(
    row.id,
    tenantId
  );
}

function cleanupDocumentStorageChildren(
  db: ReturnType<typeof getDatabase>,
  tenantId: string,
  documentId: string
) {
  const thumbRows = db
    .prepare(
      "SELECT thumbnail_key FROM document_pages WHERE document_id = ? AND thumbnail_key IS NOT NULL"
    )
    .all(documentId) as Array<{ thumbnail_key: string }>;
  for (const tr of thumbRows) {
    deleteStorageObject(tr.thumbnail_key);
    db.prepare("DELETE FROM storage_metadata WHERE tenant_id = ? AND storage_key = ?").run(
      tenantId,
      tr.thumbnail_key
    );
  }

  const supRows = db
    .prepare("SELECT id, storage_key FROM supporting_documents WHERE document_id = ? AND tenant_id = ?")
    .all(documentId, tenantId) as Array<{ id: string; storage_key: string }>;
  for (const sr of supRows) {
    deleteSupportingRecordAssets(db, tenantId, sr);
  }

  const assetRows = db
    .prepare(
      `SELECT aa.id, aa.storage_key
       FROM acroform_assets aa
       WHERE aa.document_id = ? AND aa.tenant_id = ?
         AND NOT EXISTS (SELECT 1 FROM template_versions tv WHERE tv.acroform_asset_id = aa.id)`
    )
    .all(documentId, tenantId) as Array<{ id: string; storage_key: string }>;
  for (const ar of assetRows) {
    if (!ar.storage_key.startsWith("src/")) {
      deleteStorageObject(ar.storage_key);
      db.prepare("DELETE FROM storage_metadata WHERE tenant_id = ? AND storage_key = ?").run(
        tenantId,
        ar.storage_key
      );
    }
    db.prepare("DELETE FROM acroform_assets WHERE id = ? AND tenant_id = ?").run(ar.id, tenantId);
  }
}

export function purgeExpiredDocuments(tenantId: string): {
  deletedDocuments: number;
  deletedGenerated: number;
  deletedSupporting: number;
} {
  const db = getDatabase();
  let deletedDocuments = 0;
  let deletedGenerated = 0;
  let deletedSupporting = 0;

  const expiredSup = db
    .prepare(
      `SELECT id, storage_key FROM supporting_documents
       WHERE tenant_id = ? AND retention_expires_at IS NOT NULL AND retention_expires_at <= datetime('now')`
    )
    .all(tenantId) as Array<{ id: string; storage_key: string }>;

  for (const s of expiredSup) {
    deleteSupportingRecordAssets(db, tenantId, s);
    deletedSupporting++;
  }

  const expiredGen = db
    .prepare(
      `SELECT id, storage_key FROM generated_documents
       WHERE tenant_id = ? AND retention_expires_at IS NOT NULL AND retention_expires_at <= datetime('now')`
    )
    .all(tenantId) as Array<{ id: string; storage_key: string }>;

  for (const g of expiredGen) {
    const childSigned = db
      .prepare("SELECT storage_key FROM signed_uploads WHERE generated_document_id = ? AND tenant_id = ?")
      .all(g.id, tenantId) as Array<{ storage_key: string }>;
    for (const cs of childSigned) {
      deleteStorageObject(cs.storage_key);
      db.prepare("DELETE FROM storage_metadata WHERE tenant_id = ? AND storage_key = ?").run(
        tenantId,
        cs.storage_key
      );
    }

    const childSup = db
      .prepare(
        "SELECT id, storage_key FROM supporting_documents WHERE generated_document_id = ? AND tenant_id = ?"
      )
      .all(g.id, tenantId) as Array<{ id: string; storage_key: string }>;
    for (const sup of childSup) {
      deleteSupportingRecordAssets(db, tenantId, sup);
      deletedSupporting++;
    }

    deleteStorageObject(g.storage_key);
    db.prepare("DELETE FROM storage_metadata WHERE tenant_id = ? AND storage_key = ?").run(
      tenantId,
      g.storage_key
    );
    db.prepare("DELETE FROM generated_documents WHERE id = ? AND tenant_id = ?").run(g.id, tenantId);
    deletedGenerated++;
  }

  const expiredDocs = db
    .prepare(
      `SELECT d.id, d.source_storage_key FROM documents d
       WHERE d.tenant_id = ?
         AND d.retention_expires_at IS NOT NULL
         AND d.retention_expires_at <= datetime('now')
         AND NOT EXISTS (
           SELECT 1
           FROM template_versions tv
           JOIN field_manifests fm ON fm.id = tv.manifest_id
           WHERE fm.document_id = d.id
         )`
    )
    .all(tenantId) as Array<{ id: string; source_storage_key: string }>;

  for (const d of expiredDocs) {
    cleanupDocumentStorageChildren(db, tenantId, d.id);
    if (!d.source_storage_key.startsWith("src/")) {
      deleteStorageObject(d.source_storage_key);
      db.prepare("DELETE FROM storage_metadata WHERE tenant_id = ? AND storage_key = ?").run(
        tenantId,
        d.source_storage_key
      );
    }
    db.prepare("DELETE FROM documents WHERE id = ? AND tenant_id = ?").run(d.id, tenantId);
    deletedDocuments++;
  }

  return {
    deletedDocuments,
    deletedGenerated,
    deletedSupporting,
  };
}

export function purgeAllTenantsExpiredDocuments(): {
  deletedDocuments: number;
  deletedGenerated: number;
  deletedSupporting: number;
} {
  const db = getDatabase();
  const tenants = db.prepare("SELECT id FROM tenants").all() as Array<{ id: string }>;
  let deletedDocuments = 0;
  let deletedGenerated = 0;
  let deletedSupporting = 0;
  for (const t of tenants) {
    const res = purgeExpiredDocuments(t.id);
    deletedDocuments += res.deletedDocuments;
    deletedGenerated += res.deletedGenerated;
    deletedSupporting += res.deletedSupporting;
  }
  return { deletedDocuments, deletedGenerated, deletedSupporting };
}

function sanitizeHeaderFilename(rawName: string, fallback = "document.pdf"): string {
  const base = path.basename(rawName || fallback).replace(/["\r\n\\]/g, "_").trim();
  return base || fallback;
}

export function createV1ApiRouter(config: V1RouterConfig = {}): express.Router {
  const router = express.Router();
  const maxPdfBytes = config.maxPdfUploadBytes ?? 35 * 1024 * 1024;
  const maxSupportingBytes = Math.max(
    1024,
    Number(process.env.MAX_UPLOAD_BYTES || String(10 * 1024 * 1024))
  );
  const limiter = config.disableRateLimit
    ? (_req: express.Request, _res: express.Response, next: NextFunction) => next()
    : createRateLimiter();

  const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxPdfBytes, files: 1, fields: 8 },
  });

  const supportingUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSupportingBytes, files: 10, fields: 10 },
  });

  // Security headers + API request logging
  router.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");

    res.on("finish", () => {
      try {
        const db = getDatabase();
        const principal =
          req.principal || resolvePrincipalFromRequest(req, { skipTouchApiKey: true });
        db.prepare(`
          INSERT INTO api_requests (id, tenant_id, api_key_id, user_id, method, path, status_code, duration_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `req_${crypto.randomBytes(8).toString("hex")}`,
          principal?.tenantId ?? null,
          principal?.apiKeyId ?? null,
          principal?.userId ?? null,
          req.method,
          req.originalUrl.slice(0, 240),
          res.statusCode,
          Date.now() - start
        );
      } catch {
        // Non-fatal logging
      }
    });
    next();
  });

  // -------------------------------------------------------------------------
  // OpenAPI 3.1 Specification (Public Documentation Endpoint)
  // -------------------------------------------------------------------------
  router.get("/openapi.json", (_req, res) => {
    res.json({
      openapi: "3.1.0",
      info: {
        title: "FormifyPDF REST API",
        version: "1.0.0",
        description:
          "Universal PDF Intelligence, Hybrid OCR/CV Field Detection, AcroForm Generation, Template Versioning & Document Rendering API.",
      },
      servers: [{ url: "/api/v1" }],
      components: {
        securitySchemes: {
          BearerAuth: { type: "http", scheme: "bearer" },
          ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
        },
      },
      security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
      paths: {
        "/documents": {
          get: { summary: "List uploaded PDFs for tenant" },
          post: { summary: "Upload a PDF document (multipart/form-data)" },
        },
        "/documents/{id}/analyze": {
          post: { summary: "Enqueue hybrid structural, OpenCV, OCR, and semantic analysis job" },
        },
        "/jobs/{id}": {
          get: { summary: "Poll analysis/OCR job stage, progress, and errors" },
        },
        "/documents/{id}/manifest": {
          get: { summary: "Retrieve structured FieldManifest v1.0" },
          put: { summary: "Update FieldManifest fields from visual editor" },
        },
        "/documents/{id}/generate-acroform": {
          post: { summary: "Generate interactive AcroForm PDF from manifest" },
        },
        "/templates": {
          get: { summary: "Search and list templates" },
          post: { summary: "Create versioned template from document manifest & AcroForm" },
        },
        "/templates/{id}/approve": {
          post: { summary: "Verify structural & visual checks and lock approved template version" },
        },
        "/templates/{id}/download-acroform": {
          get: { summary: "Download protected fillable AcroForm master (authorised integrations only)" },
        },
        "/render/{templateId}": {
          post: { summary: "Engine B: Populate approved template and generate flattened or fillable output PDF" },
        },
        "/rendered/{id}/download": {
          get: { summary: "Download or view completed customer PDF" },
        },
        "/rendered/{id}/upload-signed": {
          post: { summary: "Upload physically signed customer PDF" },
        },
        "/supporting-documents": {
          get: { summary: "List supporting PDF/image attachments for tenant or form" },
          post: { summary: "Upload one or more supporting PDF/image documents (PNG, JPEG, WebP, PDF)" },
        },
        "/supporting-documents/{id}/download": {
          get: { summary: "Download supporting document attachment securely" },
        },
        "/supporting-documents/{id}": {
          put: { summary: "Replace an existing supporting document attachment" },
          delete: { summary: "Delete supporting document attachment" },
        },
      },
    });
  });

  // -------------------------------------------------------------------------
  // Auth, First-Run Admin Claim, Sessions & RBAC
  // -------------------------------------------------------------------------
  router.get("/auth/status", (req: AuthedRequest, res) => {
    const principal = resolvePrincipalFromRequest(req);
    const hasEnvAdmin = Boolean((process.env.FORMIFYPDF_ADMIN_PASSWORD || "").trim());
    const dbHasAdmin = hasAnyAdminUserInDb();
    res.json({
      ok: true,
      bootstrapped: isAdminBootstrapped(),
      requiresFirstRunSetup: !hasEnvAdmin && !dbHasAdmin,
      authenticated: Boolean(principal),
      user: principal
        ? {
            id: principal.userId,
            email: principal.email,
            fullName: principal.fullName,
            role: principal.role,
            tenantId: principal.tenantId,
            permissions: principal.permissions,
          }
        : null,
    });
  });

  // One-time atomic bootstrap of the first administrator account when FORMIFYPDF_ADMIN_PASSWORD is unset
  router.post("/auth/bootstrap", limiter, (req, res) => {
    if ((process.env.FORMIFYPDF_ADMIN_PASSWORD || "").trim()) {
      res.status(403).json({
        ok: false,
        code: "BOOTSTRAP_LOCKED",
        error: "Admin passcode is configured via environment secret; sign in directly.",
      });
      return;
    }

    const parsed = BootstrapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: parsed.error.issues[0]?.message || "Invalid bootstrap payload",
      });
      return;
    }

    const db = getDatabase();
    db.exec("BEGIN IMMEDIATE;");
    try {
      const cntRow = db
        .prepare("SELECT COUNT(*) as cnt FROM users WHERE role_name = 'administrator'")
        .get() as { cnt: number };
      if (cntRow.cnt > 0) {
        db.exec("ROLLBACK;");
        res.status(409).json({
          ok: false,
          code: "ALREADY_BOOTSTRAPPED",
          error: "Administrator account has already been claimed.",
        });
        return;
      }

      if (parsed.data.organisationName) {
        db.prepare("UPDATE tenants SET name = ? WHERE id = 'tenant_default'").run(
          parsed.data.organisationName
        );
      }

      const userId = `usr_${crypto.randomBytes(10).toString("hex")}`;
      const pwHash = hashPassword(parsed.data.password);
      db.prepare(`
        INSERT INTO users (id, tenant_id, email, full_name, role_name, password_hash, is_active)
        VALUES (?, 'tenant_default', ?, ?, 'administrator', ?, 1)
      `).run(
        userId,
        parsed.data.email.toLowerCase(),
        parsed.data.fullName,
        pwHash
      );
      db.exec("COMMIT;");

      const session = createSessionForUser(userId, "tenant_default", req);
      logAuditEvent({
        tenantId: "tenant_default",
        actorUserId: userId,
        actorEmail: parsed.data.email.toLowerCase(),
        action: "auth.admin_bootstrapped",
        resourceType: "user",
        resourceId: userId,
        ipAddress: req.ip,
      });

      res.status(201).json({
        ok: true,
        token: session.token,
        expiresAt: session.expiresAt,
        user: {
          id: userId,
          email: parsed.data.email.toLowerCase(),
          fullName: parsed.data.fullName,
          role: "administrator",
          tenantId: "tenant_default",
          permissions: getRolePermissions(db, "administrator"),
        },
      });
    } catch (err) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Ignore
      }
      console.error("[Bootstrap Error]", err);
      res.status(500).json({ ok: false, error: "Failed to initialize administrator" });
    }
  });

  router.post("/auth/login", limiter, (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Valid email and password are required" });
      return;
    }

    const db = getDatabase();
    const email = parsed.data.email.toLowerCase();
    const envPass = (process.env.FORMIFYPDF_ADMIN_PASSWORD || "").trim();

    let userRow = db
      .prepare(
        `SELECT id, tenant_id, email, full_name, role_name, password_hash, is_active
         FROM users WHERE email = ?`
      )
      .get(email) as
      | {
          id: string;
          tenant_id: string;
          email: string;
          full_name: string;
          role_name: RoleName;
          password_hash: string;
          is_active: number;
        }
      | undefined;

    // Support configured env admin passcode override
    if (envPass && parsed.data.password === envPass) {
      if (!userRow && !hasAnyAdminUserInDb()) {
        const userId = `usr_${crypto.randomBytes(10).toString("hex")}`;
        db.prepare(`
          INSERT INTO users (id, tenant_id, email, full_name, role_name, password_hash, is_active)
          VALUES (?, 'tenant_default', ?, 'Workspace Administrator', 'administrator', ?, 1)
        `).run(userId, email, hashPassword(envPass));
        userRow = db
          .prepare(
            "SELECT id, tenant_id, email, full_name, role_name, password_hash, is_active FROM users WHERE id = ?"
          )
          .get(userId) as typeof userRow;
      } else if (userRow && userRow.role_name === "administrator") {
        // Env admin password explicitly overrides claimed fallback hash
        const session = createSessionForUser(userRow.id, userRow.tenant_id, req);
        logAuditEvent({
          tenantId: userRow.tenant_id,
          actorUserId: userRow.id,
          actorEmail: userRow.email,
          action: "auth.login",
          resourceType: "session",
          resourceId: session.sessionId,
          ipAddress: req.ip,
        });
        res.json({
          ok: true,
          token: session.token,
          expiresAt: session.expiresAt,
          user: {
            id: userRow.id,
            email: userRow.email,
            fullName: userRow.full_name,
            role: userRow.role_name,
            tenantId: userRow.tenant_id,
            permissions: getRolePermissions(db, userRow.role_name),
          },
        });
        return;
      }
    }

    if (
      !userRow ||
      !userRow.is_active ||
      !verifyPassword(parsed.data.password, userRow.password_hash)
    ) {
      res.status(401).json({ ok: false, error: "Invalid email or password" });
      return;
    }

    const session = createSessionForUser(userRow.id, userRow.tenant_id, req);
    logAuditEvent({
      tenantId: userRow.tenant_id,
      actorUserId: userRow.id,
      actorEmail: userRow.email,
      action: "auth.login",
      resourceType: "session",
      resourceId: session.sessionId,
      ipAddress: req.ip,
    });

    res.json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        id: userRow.id,
        email: userRow.email,
        fullName: userRow.full_name,
        role: userRow.role_name,
        tenantId: userRow.tenant_id,
        permissions: getRolePermissions(db, userRow.role_name),
      },
    });
  });

  router.post("/auth/logout", requireAuth, (req: AuthedRequest, res) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (token) {
      const db = getDatabase();
      db.prepare(
        "UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?"
      ).run(hashToken(token));
    }
    res.json({ ok: true });
  });

  router.get("/auth/sessions", requireAuth, (req: AuthedRequest, res) => {
    const db = getDatabase();
    const sessions = db
      .prepare(
        `SELECT s.id, s.user_id, u.email, u.role_name, s.user_agent, s.ip_address, s.expires_at, s.revoked_at, s.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.tenant_id = ?
         ORDER BY s.created_at DESC LIMIT 50`
      )
      .all(req.principal!.tenantId);
    res.json({ ok: true, sessions });
  });

  router.delete("/auth/sessions/:sessionId", requireAuth, (req: AuthedRequest, res) => {
    const db = getDatabase();
    db.prepare(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND tenant_id = ?"
    ).run(req.params.sessionId, req.principal!.tenantId);
    res.json({ ok: true });
  });

  router.post("/auth/password-reset/request", limiter, (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase().trim() : "";
    if (!email) {
      res.status(400).json({ ok: false, error: "Email is required" });
      return;
    }
    const db = getDatabase();
    const user = db
      .prepare("SELECT id, tenant_id FROM users WHERE email = ? AND is_active = 1")
      .get(email) as { id: string; tenant_id: string } | undefined;

    if (user) {
      const rawResetToken = crypto.randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      db.prepare(
        "UPDATE users SET reset_token_hash = ?, reset_token_expires_at = ? WHERE id = ?"
      ).run(hashToken(rawResetToken), expiresAt, user.id);

      logAuditEvent({
        tenantId: user.tenant_id,
        actorUserId: user.id,
        actorEmail: email,
        action: "auth.password_reset_requested",
        resourceType: "user",
        resourceId: user.id,
      });

      // Return token only when explicitly in development/self-hosted test flow; never log passwords
      res.json({
        ok: true,
        message: "Password reset token issued.",
        resetToken: process.env.NODE_ENV === "production" ? undefined : rawResetToken,
      });
      return;
    }
    res.json({ ok: true, message: "If the account exists, a reset token has been issued." });
  });

  router.post("/auth/password-reset/confirm", limiter, (req, res) => {
    const schema = z.object({
      token: z.string().min(10),
      newPassword: z.string().min(8).max(128),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Valid reset token and 8+ char password required" });
      return;
    }
    const db = getDatabase();
    const tokenHash = hashToken(parsed.data.token);
    const user = db
      .prepare(
        "SELECT id, tenant_id, email, reset_token_expires_at FROM users WHERE reset_token_hash = ?"
      )
      .get(tokenHash) as
      | { id: string; tenant_id: string; email: string; reset_token_expires_at: string | null }
      | undefined;

    if (
      !user ||
      !user.reset_token_expires_at ||
      new Date(user.reset_token_expires_at).getTime() <= Date.now()
    ) {
      res.status(400).json({ ok: false, error: "Reset token is invalid or expired" });
      return;
    }

    db.prepare(
      `UPDATE users
       SET password_hash = ?, reset_token_hash = NULL, reset_token_expires_at = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(hashPassword(parsed.data.newPassword), user.id);

    // Revoke existing sessions on password reset
    db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ?").run(
      user.id
    );

    logAuditEvent({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorEmail: user.email,
      action: "auth.password_reset_confirmed",
      resourceType: "user",
      resourceId: user.id,
    });
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // User Management & Roles (Administrator)
  // -------------------------------------------------------------------------
  router.get("/roles", requireAuth, (_req, res) => {
    res.json({ ok: true, roles: ROLE_DEFINITIONS });
  });

  router.get(
    "/users",
    requireAuth,
    requirePermission("users:manage"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const users = db
        .prepare(
          `SELECT id, tenant_id, email, full_name, role_name, is_active, last_login_at, created_at
           FROM users WHERE tenant_id = ? ORDER BY created_at DESC`
        )
        .all(req.principal!.tenantId);
      res.json({ ok: true, users });
    }
  );

  router.post(
    "/users",
    requireAuth,
    requirePermission("users:manage"),
    (req: AuthedRequest, res) => {
      const parsed = CreateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message || "Invalid user" });
        return;
      }
      const db = getDatabase();
      const email = parsed.data.email.toLowerCase();
      const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (existing) {
        res.status(409).json({ ok: false, error: "A user with that email already exists" });
        return;
      }
      const id = `usr_${crypto.randomBytes(10).toString("hex")}`;
      db.prepare(`
        INSERT INTO users (id, tenant_id, email, full_name, role_name, password_hash, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        id,
        req.principal!.tenantId,
        email,
        parsed.data.fullName,
        parsed.data.role,
        hashPassword(parsed.data.password)
      );

      logAuditEvent({
        tenantId: req.principal!.tenantId,
        actorUserId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: "user.created",
        resourceType: "user",
        resourceId: id,
        metadata: { email, role: parsed.data.role },
      });

      res.status(201).json({
        ok: true,
        user: {
          id,
          email,
          full_name: parsed.data.fullName,
          role_name: parsed.data.role,
          is_active: 1,
        },
      });
    }
  );

  router.patch(
    "/users/:id",
    requireAuth,
    requirePermission("users:manage"),
    (req: AuthedRequest, res) => {
      const schema = z.object({
        role: z
          .enum([
            "administrator",
            "template_manager",
            "editor",
            "reviewer",
            "api_integration_user",
            "read_only_user",
          ])
          .optional(),
        isActive: z.boolean().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: "Invalid update payload" });
        return;
      }
      const db = getDatabase();
      const target = db
        .prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, req.principal!.tenantId);
      if (!target) {
        res.status(404).json({ ok: false, error: "User not found" });
        return;
      }
      if (parsed.data.role) {
        db.prepare(
          "UPDATE users SET role_name = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?"
        ).run(parsed.data.role, req.params.id, req.principal!.tenantId);
      }
      if (typeof parsed.data.isActive === "boolean") {
        db.prepare(
          "UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?"
        ).run(parsed.data.isActive ? 1 : 0, req.params.id, req.principal!.tenantId);
      }
      logAuditEvent({
        tenantId: req.principal!.tenantId,
        actorUserId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: "user.updated",
        resourceType: "user",
        resourceId: req.params.id,
        metadata: parsed.data,
      });
      res.json({ ok: true });
    }
  );

  // -------------------------------------------------------------------------
  // Dashboard & Audit Metrics (100% Real DB Records)
  // -------------------------------------------------------------------------
  router.get(
    "/dashboard",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tid = req.principal!.tenantId;

      const docStats = db
        .prepare(
          `SELECT
            COUNT(*) as total_documents,
            SUM(CASE WHEN status IN ('analyzed', 'uploaded') THEN 1 ELSE 0 END) as awaiting_review,
            COALESCE(SUM(byte_size), 0) as doc_bytes
           FROM documents WHERE tenant_id = ?`
        )
        .get(tid) as { total_documents: number; awaiting_review: number; doc_bytes: number };

      const tplStats = db
        .prepare(
          `SELECT
            COUNT(*) as total_templates,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved_templates
           FROM templates WHERE tenant_id = ?`
        )
        .get(tid) as { total_templates: number; approved_templates: number };

      const jobStats = db
        .prepare(
          `SELECT
            COUNT(*) as total_jobs,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_jobs,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_jobs
           FROM analysis_jobs WHERE tenant_id = ?`
        )
        .get(tid) as { total_jobs: number; completed_jobs: number; failed_jobs: number };

      const genCount = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM generated_documents WHERE tenant_id = ?")
          .get(tid) as { cnt: number }
      ).cnt;

      const recentActivity = db
        .prepare(
          `SELECT id, actor_email, action, resource_type, resource_id, metadata_json, created_at
           FROM audit_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20`
        )
        .all(tid);

      const recentJobs = db
        .prepare(
          `SELECT j.id, j.document_id, d.title as document_title, j.stage, j.progress_pct, j.status, j.error_code, j.error_message, j.created_at
           FROM analysis_jobs j JOIN documents d ON d.id = j.document_id
           WHERE j.tenant_id = ? ORDER BY j.created_at DESC LIMIT 10`
        )
        .all(tid);

      const finishedJobs = (jobStats.completed_jobs || 0) + (jobStats.failed_jobs || 0);
      const successRate =
        finishedJobs > 0
          ? Math.round(((jobStats.completed_jobs || 0) / finishedJobs) * 1000) / 10
          : null;

      res.json({
        ok: true,
        metrics: {
          totalDocumentsProcessed: docStats.total_documents || 0,
          totalTemplatesCreated: tplStats.total_templates || 0,
          approvedTemplates: tplStats.approved_templates || 0,
          documentsAwaitingReview: docStats.awaiting_review || 0,
          conversionSuccessRate: successRate,
          processingFailures: jobStats.failed_jobs || 0,
          totalJobs: jobStats.total_jobs || 0,
          generatedDocumentsCount: genCount,
          storageUsedBytes: computeDirectoryBytes(),
        },
        recentActivity,
        recentJobs,
      });
    }
  );

  router.get(
    "/audit-events",
    requireAuth,
    requirePermission("audit:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const events = db
        .prepare(
          `SELECT id, actor_email, action, resource_type, resource_id, metadata_json, ip_address, created_at
           FROM audit_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`
        )
        .all(req.principal!.tenantId);
      res.json({ ok: true, events });
    }
  );

  // -------------------------------------------------------------------------
  // Documents Ingestion, Inspection & Async Analysis Jobs
  // -------------------------------------------------------------------------
  router.get(
    "/documents",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const docs = db
        .prepare(
          `SELECT d.*,
            (SELECT j.id FROM analysis_jobs j WHERE j.document_id = d.id ORDER BY j.created_at DESC LIMIT 1) as latest_job_id,
            (SELECT j.status FROM analysis_jobs j WHERE j.document_id = d.id ORDER BY j.created_at DESC LIMIT 1) as latest_job_status,
            (SELECT m.field_count FROM field_manifests m WHERE m.document_id = d.id ORDER BY m.version_number DESC LIMIT 1) as latest_field_count,
            (SELECT a.id FROM acroform_assets a WHERE a.document_id = d.id ORDER BY a.created_at DESC LIMIT 1) as latest_acroform_asset_id
           FROM documents d
           WHERE d.tenant_id = ?
           ORDER BY d.created_at DESC`
        )
        .all(req.principal!.tenantId);
      res.json({ ok: true, documents: docs });
    }
  );

  router.post(
    "/documents",
    limiter,
    requireAuth,
    requirePermission("documents:write"),
    (req: AuthedRequest, res) => {
      pdfUpload.single("file")(req, res, async (multerErr: unknown) => {
        if (multerErr) {
          if (multerErr instanceof multer.MulterError && multerErr.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({
              ok: false,
              error: `PDF exceeds maximum allowed upload size of ${Math.round(maxPdfBytes / (1024 * 1024))} MB.`,
            });
            return;
          }
          res.status(400).json({ ok: false, error: "Invalid multipart PDF upload." });
          return;
        }

        const file = req.file;
        if (!file || !file.buffer) {
          res.status(400).json({ ok: false, error: "No PDF file was uploaded." });
          return;
        }
        if (!file.originalname.toLowerCase().endsWith(".pdf")) {
          res.status(400).json({ ok: false, error: "Only .pdf files are supported." });
          return;
        }
        if (
          file.mimetype &&
          file.mimetype !== "application/pdf" &&
          file.mimetype !== "application/octet-stream"
        ) {
          res.status(400).json({ ok: false, error: "Uploaded file MIME type must be application/pdf." });
          return;
        }

        const sig = validatePdfBufferSignature(file.buffer);
        if (!sig.valid) {
          res.status(400).json({ ok: false, error: sig.reason });
          return;
        }

        const db = getDatabase();
        const tid = req.principal!.tenantId;
        const stored = saveStorageBuffer("originals", file.originalname, file.buffer);
        const docId = `doc_${crypto.randomBytes(10).toString("hex")}`;
        const rawTitle =
          typeof req.body?.title === "string" && req.body.title.trim()
            ? req.body.title.trim().slice(0, 180)
            : path.basename(file.originalname, ".pdf");

        const tenant = db
          .prepare("SELECT retention_days FROM tenants WHERE id = ?")
          .get(tid) as { retention_days: number } | undefined;
        const retentionDays = tenant?.retention_days ?? 30;
        const expiresAt = new Date(
          Date.now() + retentionDays * 24 * 60 * 60 * 1000
        ).toISOString();

        // Preliminary fast structural inspection to validate encryption/corruption immediately
        try {
          const abs = resolveSafeStoragePath(stored.storageKey);
          const inspect = await runFormifyPythonEngine<{
            pageCount: number;
            isScanned: boolean;
            hasExistingAcroForm: boolean;
          }>("inspect", { pdfPath: abs });

          db.prepare(`
            INSERT INTO documents (
              id, tenant_id, uploaded_by, title, original_filename, sha256, byte_size,
              page_count, is_scanned, has_existing_acroform, status, source_storage_key, retention_expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)
          `).run(
            docId,
            tid,
            req.principal!.userId,
            rawTitle,
            path.basename(file.originalname),
            stored.sha256,
            stored.byteSize,
            inspect.pageCount,
            inspect.isScanned ? 1 : 0,
            inspect.hasExistingAcroForm ? 1 : 0,
            stored.storageKey,
            expiresAt
          );

          db.prepare(`
            INSERT INTO storage_metadata (
              id, tenant_id, provider, storage_key, bucket_or_dir, content_type, byte_size, sha256, classification, retention_expires_at
            ) VALUES (?, ?, 'local', ?, 'originals', 'application/pdf', ?, ?, 'original', ?)
          `).run(
            `stm_${crypto.randomBytes(8).toString("hex")}`,
            tid,
            stored.storageKey,
            stored.byteSize,
            stored.sha256,
            expiresAt
          );

          logAuditEvent({
            tenantId: tid,
            actorUserId: req.principal!.userId,
            actorEmail: req.principal!.email,
            action: "document.uploaded",
            resourceType: "document",
            resourceId: docId,
            metadata: { filename: file.originalname, pages: inspect.pageCount },
          });

          const autoAnalyze = String(req.body?.autoAnalyze ?? "true") !== "false";
          let jobId: string | null = null;
          if (autoAnalyze) {
            jobId = `job_${crypto.randomBytes(10).toString("hex")}`;
            db.prepare(`
              INSERT INTO analysis_jobs (
                id, tenant_id, document_id, triggered_by, job_type, stage, progress_pct, status, options_json
              ) VALUES (?, ?, ?, ?, 'full_analysis', 'queued', 5, 'queued', ?)
            `).run(
              jobId,
              tid,
              docId,
              req.principal!.userId,
              JSON.stringify({
                enableOcr: String(req.body?.enableOcr ?? "true") !== "false",
                forceOcr: String(req.body?.forceOcr ?? "false") === "true",
                ocrLanguage:
                  typeof req.body?.ocrLanguage === "string"
                    ? req.body.ocrLanguage.slice(0, 16)
                    : "eng",
                autoGenerateAcroForm: true,
              })
            );
            enqueueAnalysisJob(jobId);
          }

          res.status(201).json({
            ok: true,
            document: {
              id: docId,
              title: rawTitle,
              originalFilename: path.basename(file.originalname),
              pageCount: inspect.pageCount,
              isScanned: inspect.isScanned,
              hasExistingAcroForm: inspect.hasExistingAcroForm,
              byteSize: stored.byteSize,
              status: autoAnalyze ? "analysing" : "uploaded",
            },
            jobId,
          });
        } catch (err) {
          deleteStorageObject(stored.storageKey);
          const msg = err instanceof Error ? err.message : "Invalid PDF";
          res.status(422).json({ ok: false, error: msg });
        }
      });
    }
  );

  router.get(
    "/documents/:id",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const doc = db
        .prepare("SELECT * FROM documents WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, req.principal!.tenantId);
      if (!doc) {
        res.status(404).json({ ok: false, error: "Document not found" });
        return;
      }
      const pages = db
        .prepare("SELECT * FROM document_pages WHERE document_id = ? ORDER BY page_index ASC")
        .all(req.params.id);
      const jobs = db
        .prepare("SELECT * FROM analysis_jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 10")
        .all(req.params.id);
      const ocrJobs = db
        .prepare("SELECT * FROM ocr_jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 20")
        .all(req.params.id);
      const latestAsset = db
        .prepare(
          "SELECT * FROM acroform_assets WHERE document_id = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(req.params.id);
      res.json({ ok: true, document: doc, pages, jobs, ocrJobs, latestAsset });
    }
  );

  router.get(
    "/documents/:id/pdf",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const doc = db
        .prepare(
          "SELECT source_storage_key, original_filename FROM documents WHERE id = ? AND tenant_id = ?"
        )
        .get(req.params.id, req.principal!.tenantId) as
        | { source_storage_key: string; original_filename: string }
        | undefined;
      if (!doc) {
        res.status(404).json({ ok: false, error: "Document not found" });
        return;
      }

      const buf = doc.source_storage_key.startsWith("src/")
        ? null
        : readStorageBuffer(doc.source_storage_key);

      if (!buf) {
        res.status(404).json({ ok: false, error: "Source PDF file not found" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${sanitizeHeaderFilename(doc.original_filename)}"`
      );
      res.send(buf);
    }
  );

  router.get(
    "/documents/:id/acroform-pdf",
    requireAuth,
    requirePermission("documents:read"),
    async (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const doc = db
        .prepare(
          "SELECT id, title, original_filename FROM documents WHERE id = ? AND tenant_id = ?"
        )
        .get(req.params.id, tid) as
        | { id: string; title: string; original_filename: string }
        | undefined;
      if (!doc) {
        res.status(404).json({ ok: false, error: "Document not found" });
        return;
      }

      let asset = db
        .prepare(
          `SELECT a.storage_key FROM acroform_assets a
           WHERE a.document_id = ? AND a.tenant_id = ?
           ORDER BY a.created_at DESC LIMIT 1`
        )
        .get(doc.id, tid) as { storage_key: string } | undefined;

      if (!asset) {
        const latestMan = db
          .prepare(
            `SELECT id, manifest_json FROM field_manifests
             WHERE document_id = ? AND tenant_id = ?
             ORDER BY version_number DESC LIMIT 1`
          )
          .get(doc.id, tid) as { id: string; manifest_json: string } | undefined;
        if (latestMan) {
          try {
            const generated = await generateAcroFormAssetForDocument({
              tenantId: tid,
              documentId: doc.id,
              manifestId: latestMan.id,
              manifest: JSON.parse(latestMan.manifest_json) as FieldManifest,
              actorUserId: req.principal!.userId,
            });
            asset = { storage_key: generated.storageKey };
          } catch (err) {
            res.status(422).json({
              ok: false,
              error: err instanceof Error ? err.message : "Failed to generate AcroForm PDF",
            });
            return;
          }
        }
      }

      if (!asset) {
        res.status(404).json({ ok: false, error: "No generated AcroForm asset found yet" });
        return;
      }

      const buf = readStorageBuffer(asset.storage_key);
      if (!buf) {
        res.status(404).json({ ok: false, error: "AcroForm file missing on storage" });
        return;
      }

      const rawBase = (doc.title || doc.original_filename || "document").replace(/\.pdf$/i, "");
      const cleanSlug =
        rawBase
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 64) || "document";
      const downloadName = sanitizeHeaderFilename(`${cleanSlug}-fillable-acroform.pdf`);
      const disposition = req.query.disposition === "attachment" ? "attachment" : "inline";

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `${disposition}; filename="${downloadName}"`);
      res.send(buf);
    }
  );

  router.delete(
    "/documents/:id",
    requireAuth,
    requirePermission("documents:delete"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const doc = db
        .prepare("SELECT id, source_storage_key FROM documents WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, req.principal!.tenantId) as
        | { id: string; source_storage_key: string }
        | undefined;
      if (!doc) {
        res.status(404).json({ ok: false, error: "Document not found" });
        return;
      }
      if (doc.source_storage_key.startsWith("src/")) {
        res.status(400).json({ ok: false, error: "System integration source PDF cannot be deleted" });
        return;
      }
      const linkedTpl = db
        .prepare(
          `SELECT tv.id FROM template_versions tv
           JOIN field_manifests fm ON fm.id = tv.manifest_id
           WHERE fm.document_id = ? LIMIT 1`
        )
        .get(doc.id);
      if (linkedTpl) {
        res.status(409).json({
          ok: false,
          error: "Cannot delete document while a template version references its manifest.",
        });
        return;
      }
      cleanupDocumentStorageChildren(db, req.principal!.tenantId, doc.id);
      deleteStorageObject(doc.source_storage_key);
      db.prepare("DELETE FROM storage_metadata WHERE tenant_id = ? AND storage_key = ?").run(
        req.principal!.tenantId,
        doc.source_storage_key
      );
      db.prepare("DELETE FROM documents WHERE id = ? AND tenant_id = ?").run(
        doc.id,
        req.principal!.tenantId
      );
      logAuditEvent({
        tenantId: req.principal!.tenantId,
        actorUserId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: "document.deleted",
        resourceType: "document",
        resourceId: doc.id,
      });
      res.json({ ok: true });
    }
  );

  router.post(
    "/documents/:id/analyze",
    requireAuth,
    requirePermission("documents:write"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const doc = db
        .prepare("SELECT id FROM documents WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, req.principal!.tenantId);
      if (!doc) {
        res.status(404).json({ ok: false, error: "Document not found" });
        return;
      }
      const jobId = `job_${crypto.randomBytes(10).toString("hex")}`;
      db.prepare(`
        INSERT INTO analysis_jobs (
          id, tenant_id, document_id, triggered_by, job_type, stage, progress_pct, status, options_json
        ) VALUES (?, ?, ?, ?, 'full_analysis', 'queued', 5, 'queued', ?)
      `).run(
        jobId,
        req.principal!.tenantId,
        req.params.id,
        req.principal!.userId,
        JSON.stringify({
          enableOcr: req.body?.enableOcr !== false,
          forceOcr: Boolean(req.body?.forceOcr),
          ocrLanguage:
            typeof req.body?.ocrLanguage === "string"
              ? req.body.ocrLanguage.slice(0, 16)
              : "eng",
          autoGenerateAcroForm: req.body?.autoGenerateAcroForm !== false,
        })
      );
      enqueueAnalysisJob(jobId);
      res.status(202).json({ ok: true, jobId });
    }
  );

  router.get(
    "/jobs",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const jobs = db
        .prepare(
          `SELECT j.*, d.title as document_title, d.original_filename
           FROM analysis_jobs j
           JOIN documents d ON d.id = j.document_id
           WHERE j.tenant_id = ?
           ORDER BY j.created_at DESC LIMIT 50`
        )
        .all(req.principal!.tenantId);
      res.json({ ok: true, jobs });
    }
  );

  router.get(
    "/jobs/:id",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const job = db
        .prepare("SELECT * FROM analysis_jobs WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, req.principal!.tenantId);
      if (!job) {
        res.status(404).json({ ok: false, error: "Job not found" });
        return;
      }
      res.json({ ok: true, job });
    }
  );

  router.post(
    "/jobs/:id/retry",
    requireAuth,
    requirePermission("documents:write"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const job = db
        .prepare("SELECT * FROM analysis_jobs WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, req.principal!.tenantId) as
        | { id: string; document_id: string; options_json: string }
        | undefined;
      if (!job) {
        res.status(404).json({ ok: false, error: "Job not found" });
        return;
      }
      const newJobId = `job_${crypto.randomBytes(10).toString("hex")}`;
      db.prepare(`
        INSERT INTO analysis_jobs (
          id, tenant_id, document_id, triggered_by, job_type, stage, progress_pct, status, options_json
        ) VALUES (?, ?, ?, ?, 'retry_analysis', 'queued', 5, 'queued', ?)
      `).run(
        newJobId,
        req.principal!.tenantId,
        job.document_id,
        req.principal!.userId,
        job.options_json
      );
      enqueueAnalysisJob(newJobId);
      res.status(202).json({ ok: true, jobId: newJobId });
    }
  );

  // -------------------------------------------------------------------------
  // Field Manifest, Visual Editor Updates & AcroForm Generation
  // -------------------------------------------------------------------------
  router.get(
    "/documents/:id/manifest",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT id, version_number, manifest_json, created_at
           FROM field_manifests
           WHERE document_id = ? AND tenant_id = ?
           ORDER BY version_number DESC LIMIT 1`
        )
        .get(req.params.id, req.principal!.tenantId) as
        | { id: string; version_number: number; manifest_json: string; created_at: string }
        | undefined;
      if (!row) {
        res.status(404).json({ ok: false, error: "No field manifest found for document" });
        return;
      }
      res.json({
        ok: true,
        manifestId: row.id,
        versionNumber: row.version_number,
        manifest: JSON.parse(row.manifest_json),
      });
    }
  );

  router.put(
    "/documents/:id/manifest",
    requireAuth,
    requirePermission("fields:edit"),
    (req: AuthedRequest, res) => {
      const parsed = FieldManifestUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: parsed.error.issues[0]?.message || "Invalid field manifest payload",
        });
        return;
      }

      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const latest = db
        .prepare(
          `SELECT id, version_number, manifest_json FROM field_manifests
           WHERE document_id = ? AND tenant_id = ?
           ORDER BY version_number DESC LIMIT 1`
        )
        .get(req.params.id, tid) as
        | { id: string; version_number: number; manifest_json: string }
        | undefined;

      if (!latest) {
        res.status(404).json({ ok: false, error: "Document manifest not found" });
        return;
      }

      const prevManifest = JSON.parse(latest.manifest_json) as FieldManifest;
      const nextManifest: FieldManifest = {
        ...prevManifest,
        templateName: parsed.data.templateName ?? prevManifest.templateName,
        fields: parsed.data.fields,
        generatedAt: new Date().toISOString(),
      };

      const nextVer = latest.version_number + 1;
      const nextManifestId = `man_${crypto.randomBytes(10).toString("hex")}`;
      const highCnt = nextManifest.fields.filter((f) => f.confidenceTier === "high").length;
      const medCnt = nextManifest.fields.filter((f) => f.confidenceTier === "medium").length;
      const lowCnt = nextManifest.fields.filter((f) => f.confidenceTier === "low").length;

      db.exec("BEGIN IMMEDIATE;");
      try {
        db.prepare(`
          INSERT INTO field_manifests (
            id, tenant_id, document_id, version_number, schema_version, manifest_json,
            field_count, high_confidence_count, medium_confidence_count, low_confidence_count, created_by
          ) VALUES (?, ?, ?, ?, '1.0', ?, ?, ?, ?, ?, ?)
        `).run(
          nextManifestId,
          tid,
          req.params.id,
          nextVer,
          JSON.stringify(nextManifest),
          nextManifest.fields.length,
          highCnt,
          medCnt,
          lowCnt,
          req.principal!.userId
        );

        const insField = db.prepare(`
          INSERT INTO detected_fields (
            id, manifest_id, document_id, field_key, name, label, field_type,
            page_index, x_pt, y_pt, width_pt, height_pt, detection_source,
            confidence, confidence_tier, required, review_status, properties_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const f of nextManifest.fields) {
          insField.run(
            `fld_${crypto.randomBytes(8).toString("hex")}`,
            nextManifestId,
            req.params.id,
            f.id,
            f.name,
            f.label,
            f.type,
            f.page,
            f.rect.x,
            f.rect.y,
            f.rect.width,
            f.rect.height,
            f.detectionSource,
            f.confidence,
            f.confidenceTier,
            f.required ? 1 : 0,
            f.reviewStatus,
            JSON.stringify(f)
          );
        }
        db.exec("COMMIT;");
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }

      logAuditEvent({
        tenantId: tid,
        actorUserId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: "manifest.updated",
        resourceType: "field_manifest",
        resourceId: nextManifestId,
        metadata: { documentId: req.params.id, version: nextVer, fields: nextManifest.fields.length },
      });

      res.json({
        ok: true,
        manifestId: nextManifestId,
        versionNumber: nextVer,
        manifest: nextManifest,
      });
    }
  );

  router.post(
    "/documents/:id/generate-acroform",
    requireAuth,
    requirePermission("fields:edit"),
    async (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const latest = db
        .prepare(
          `SELECT id, manifest_json FROM field_manifests
           WHERE document_id = ? AND tenant_id = ?
           ORDER BY version_number DESC LIMIT 1`
        )
        .get(req.params.id, tid) as
        | { id: string; manifest_json: string }
        | undefined;
      if (!latest) {
        res.status(404).json({ ok: false, error: "Analyze document first to produce a manifest" });
        return;
      }

      try {
        const manifest = JSON.parse(latest.manifest_json) as FieldManifest;
        const result = await generateAcroFormAssetForDocument({
          tenantId: tid,
          documentId: req.params.id,
          manifestId: latest.id,
          manifest,
          actorUserId: req.principal!.userId,
        });

        res.json({
          ok: true,
          assetId: result.assetId,
          createdWidgets: result.createdWidgets,
          validation: result.validation,
        });
      } catch (err) {
        res.status(422).json({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to generate AcroForm PDF",
        });
      }
    }
  );

  // Sample-fill test PDF generation & preview before template approval
  router.post(
    "/documents/:id/test-fill",
    requireAuth,
    requirePermission("render:write"),
    async (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const asset = db
        .prepare(
          `SELECT a.storage_key FROM acroform_assets a
           JOIN documents d ON d.id = a.document_id
           WHERE d.id = ? AND d.tenant_id = ?
           ORDER BY a.created_at DESC LIMIT 1`
        )
        .get(req.params.id, tid) as { storage_key: string } | undefined;
      const latestMan = db
        .prepare(
          `SELECT manifest_json FROM field_manifests
           WHERE document_id = ? AND tenant_id = ?
           ORDER BY version_number DESC LIMIT 1`
        )
        .get(req.params.id, tid) as { manifest_json: string } | undefined;

      if (!asset || !latestMan) {
        res.status(404).json({ ok: false, error: "Generate AcroForm PDF before testing" });
        return;
      }

      const tplAbs = resolveSafeStoragePath(asset.storage_key);
      const manifest = JSON.parse(latestMan.manifest_json) as FieldManifest;
      const values = (req.body?.values || {}) as Record<string, unknown>;
      const flatten = req.body?.flatten !== false;

      const outKey = `renders/${crypto.randomBytes(16).toString("hex")}.pdf`;
      const outAbs = resolveSafeStoragePath(outKey);

      try {
        const result = await runFormifyPythonEngine<{
          populatedWidgets: number;
          flattened: boolean;
        }>("render-pdf", {
          templatePdfPath: tplAbs,
          manifest,
          values,
          outputPdfPath: outAbs,
          flatten,
        });

        const buf = readStorageBuffer(outKey);
        if (!buf) {
          res.status(500).json({ ok: false, error: "Sample-filled PDF not found" });
          return;
        }
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("X-Populated-Widgets", String(result.populatedWidgets));
        res.setHeader("Content-Disposition", 'inline; filename="sample_test.pdf"');
        res.send(buf);
      } catch (err) {
        res.status(422).json({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to render sample test PDF",
        });
      } finally {
        deleteStorageObject(outKey);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Templates, Versions, Diffs, Approvals & Protected Master Downloads
  // -------------------------------------------------------------------------
  router.get(
    "/templates",
    requireAuth,
    requirePermission("templates:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const status = typeof req.query.status === "string" ? req.query.status : "";
      const category = typeof req.query.category === "string" ? req.query.category : "";

      const rows = db
        .prepare(
          `SELECT t.*,
            (SELECT tv.id FROM template_versions tv WHERE tv.template_id = t.id ORDER BY tv.version_number DESC LIMIT 1) as latest_version_id,
            (SELECT tv.is_approved FROM template_versions tv WHERE tv.template_id = t.id ORDER BY tv.version_number DESC LIMIT 1) as latest_is_approved,
            (SELECT fm.field_count FROM template_versions tv JOIN field_manifests fm ON fm.id = tv.manifest_id WHERE tv.template_id = t.id ORDER BY tv.version_number DESC LIMIT 1) as field_count
           FROM templates t
           WHERE t.tenant_id = ?
           ORDER BY t.is_system_integration DESC, t.updated_at DESC`
        )
        .all(req.principal!.tenantId) as Array<Record<string, unknown>>;

      const filtered = rows.filter((r) => {
        if (status && r.status !== status) return false;
        if (category && r.category !== category) return false;
        if (q) {
          const hay = `${r.name} ${r.description} ${r.category} ${r.tags_json}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      res.json({ ok: true, templates: filtered });
    }
  );

  router.post(
    "/templates",
    requireAuth,
    requirePermission("templates:write"),
    async (req: AuthedRequest, res) => {
      const parsed = CreateTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message || "Invalid template payload" });
        return;
      }

      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const latestMan = db
        .prepare(
          `SELECT id, manifest_json FROM field_manifests
           WHERE document_id = ? AND tenant_id = ?
           ORDER BY version_number DESC LIMIT 1`
        )
        .get(parsed.data.documentId, tid) as
        | { id: string; manifest_json: string }
        | undefined;
      if (!latestMan) {
        res.status(404).json({ ok: false, error: "Document manifest not found" });
        return;
      }

      let asset = db
        .prepare(
          `SELECT id FROM acroform_assets WHERE document_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(parsed.data.documentId, tid) as { id: string } | undefined;

      if (!asset) {
        const gen = await generateAcroFormAssetForDocument({
          tenantId: tid,
          documentId: parsed.data.documentId,
          manifestId: latestMan.id,
          manifest: JSON.parse(latestMan.manifest_json) as FieldManifest,
          actorUserId: req.principal!.userId,
        });
        asset = { id: gen.assetId };
      }

      const tplId = `tpl_${crypto.randomBytes(10).toString("hex")}`;
      const verId = `tplv_${crypto.randomBytes(10).toString("hex")}`;
      const slugBase = parsed.data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
      const slug = `${slugBase || "template"}-${crypto.randomBytes(3).toString("hex")}`;

      db.exec("BEGIN IMMEDIATE;");
      try {
        db.prepare(`
          INSERT INTO templates (
            id, tenant_id, document_id, name, slug, description, category, tags_json,
            status, output_policy, current_version_number, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_review', ?, 1, ?)
        `).run(
          tplId,
          tid,
          parsed.data.documentId,
          parsed.data.name,
          slug,
          parsed.data.description,
          parsed.data.category,
          JSON.stringify(parsed.data.tags),
          parsed.data.outputPolicy,
          req.principal!.userId
        );

        db.prepare(`
          INSERT INTO template_versions (
            id, template_id, version_number, manifest_id, acroform_asset_id,
            is_approved, is_locked, changelog, created_by
          ) VALUES (?, ?, 1, ?, ?, 0, 0, 'Initial template version', ?)
        `).run(verId, tplId, latestMan.id, asset.id, req.principal!.userId);

        db.exec("COMMIT;");
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }

      logAuditEvent({
        tenantId: tid,
        actorUserId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: "template.created",
        resourceType: "template",
        resourceId: tplId,
        metadata: { name: parsed.data.name, documentId: parsed.data.documentId },
      });

      res.status(201).json({ ok: true, templateId: tplId, versionId: verId, slug });
    }
  );

  router.get(
    "/templates/:id",
    requireAuth,
    requirePermission("templates:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tpl = db
        .prepare("SELECT * FROM templates WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, req.principal!.tenantId);
      if (!tpl) {
        res.status(404).json({ ok: false, error: "Template not found" });
        return;
      }
      const versions = db
        .prepare(
          `SELECT tv.*, fm.field_count, fm.manifest_json, aa.widget_count, aa.validation_report_json
           FROM template_versions tv
           JOIN field_manifests fm ON fm.id = tv.manifest_id
           LEFT JOIN acroform_assets aa ON aa.id = tv.acroform_asset_id
           WHERE tv.template_id = ?
           ORDER BY tv.version_number DESC`
        )
        .all(req.params.id);
      const approvals = db
        .prepare(
          `SELECT ta.*, u.email as approver_email
           FROM template_approvals ta
           LEFT JOIN users u ON u.id = ta.approved_by
           WHERE ta.template_id = ?
           ORDER BY ta.approved_at DESC`
        )
        .all(req.params.id);

      res.json({ ok: true, template: tpl, versions, approvals });
    }
  );

  // Generate new non-destructive template version from updated document manifest
  router.post(
    "/templates/:id/versions",
    requireAuth,
    requirePermission("templates:write"),
    async (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const tpl = db
        .prepare("SELECT * FROM templates WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, tid) as
        | { id: string; document_id: string; current_version_number: number; is_system_integration: number }
        | undefined;
      if (!tpl) {
        res.status(404).json({ ok: false, error: "Template not found" });
        return;
      }
      if (tpl.is_system_integration) {
        res.status(403).json({
          ok: false,
          error: "Locked template cannot be overwritten.",
        });
        return;
      }

      const latestMan = db
        .prepare(
          `SELECT id, manifest_json FROM field_manifests
           WHERE document_id = ? AND tenant_id = ?
           ORDER BY version_number DESC LIMIT 1`
        )
        .get(tpl.document_id, tid) as { id: string; manifest_json: string } | undefined;
      if (!latestMan) {
        res.status(404).json({ ok: false, error: "Document manifest missing" });
        return;
      }

      const gen = await generateAcroFormAssetForDocument({
        tenantId: tid,
        documentId: tpl.document_id,
        manifestId: latestMan.id,
        manifest: JSON.parse(latestMan.manifest_json) as FieldManifest,
        actorUserId: req.principal!.userId,
      });

      const nextVer = tpl.current_version_number + 1;
      const verId = `tplv_${crypto.randomBytes(10).toString("hex")}`;
      const changelog =
        typeof req.body?.changelog === "string" && req.body.changelog.trim()
          ? req.body.changelog.trim().slice(0, 300)
          : `Version ${nextVer}`;

      db.exec("BEGIN IMMEDIATE;");
      try {
        db.prepare(`
          INSERT INTO template_versions (
            id, template_id, version_number, manifest_id, acroform_asset_id,
            is_approved, is_locked, changelog, created_by
          ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
        `).run(verId, tpl.id, nextVer, latestMan.id, gen.assetId, changelog, req.principal!.userId);

        db.prepare(
          "UPDATE templates SET current_version_number = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?"
        ).run(nextVer, tpl.id, tid);
        db.exec("COMMIT;");
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }

      res.status(201).json({
        ok: true,
        versionId: verId,
        versionNumber: nextVer,
        validation: gen.validation,
      });
    }
  );

  // Formal Template Approval Workflow (locks version & requires structural + visual confirmation)
  router.post(
    "/templates/:id/approve",
    requireAuth,
    requirePermission("templates:approve"),
    (req: AuthedRequest, res) => {
      const schema = z.object({
        versionNumber: z.number().int().positive().optional(),
        structuralVerified: z.literal(true),
        visualVerified: z.literal(true),
        notes: z.string().max(500).default(""),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: "Both structuralVerified and visualVerified confirmations are required before approval.",
        });
        return;
      }

      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const tpl = db
        .prepare("SELECT * FROM templates WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, tid) as
        | { id: string; current_version_number: number }
        | undefined;
      if (!tpl) {
        res.status(404).json({ ok: false, error: "Template not found" });
        return;
      }

      const targetVerNum = parsed.data.versionNumber ?? tpl.current_version_number;
      const ver = db
        .prepare(
          `SELECT tv.*, aa.validation_report_json
           FROM template_versions tv
           LEFT JOIN acroform_assets aa ON aa.id = tv.acroform_asset_id
           WHERE tv.template_id = ? AND tv.version_number = ?`
        )
        .get(tpl.id, targetVerNum) as
        | { id: string; validation_report_json: string | null }
        | undefined;

      if (!ver) {
        res.status(404).json({ ok: false, error: "Template version not found" });
        return;
      }

      if (ver.validation_report_json) {
        const rep = JSON.parse(ver.validation_report_json) as AcroFormValidationReport;
        if (!rep.validPdf || !rep.hasAcroFormDict || rep.widgetCount === 0) {
          res.status(422).json({
            ok: false,
            error: "Cannot approve template: AcroForm structural validation failed (0 widgets or missing /AcroForm).",
          });
          return;
        }
      }

      const apprId = `appr_${crypto.randomBytes(10).toString("hex")}`;
      db.exec("BEGIN IMMEDIATE;");
      try {
        db.prepare(
          "UPDATE template_versions SET is_approved = 1, is_locked = 1 WHERE id = ?"
        ).run(ver.id);
        db.prepare(
          "UPDATE templates SET status = 'approved', updated_at = datetime('now') WHERE id = ? AND tenant_id = ?"
        ).run(tpl.id, tid);
        db.prepare(`
          INSERT INTO template_approvals (
            id, template_id, template_version_id, approved_by, structural_verified, visual_verified, notes
          ) VALUES (?, ?, ?, ?, 1, 1, ?)
        `).run(apprId, tpl.id, ver.id, req.principal!.userId, parsed.data.notes);
        db.exec("COMMIT;");
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }

      logAuditEvent({
        tenantId: tid,
        actorUserId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: "template.approved",
        resourceType: "template",
        resourceId: tpl.id,
        metadata: { versionNumber: targetVerNum, approvalId: apprId },
      });

      res.json({ ok: true, approvalId: apprId, status: "approved" });
    }
  );

  router.post(
    "/templates/:id/duplicate",
    requireAuth,
    requirePermission("templates:write"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const tpl = db
        .prepare("SELECT * FROM templates WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, tid) as
        | {
            id: string;
            document_id: string | null;
            name: string;
            slug: string;
            description: string;
            category: string;
            tags_json: string;
            output_policy: string;
          }
        | undefined;
      if (!tpl) {
        res.status(404).json({ ok: false, error: "Template not found" });
        return;
      }
      const ver = db
        .prepare(
          "SELECT * FROM template_versions WHERE template_id = ? ORDER BY version_number DESC LIMIT 1"
        )
        .get(req.params.id) as { manifest_id: string; acroform_asset_id: string } | undefined;
      if (!ver) {
        res.status(404).json({ ok: false, error: "No version to duplicate" });
        return;
      }

      const newId = `tpl_${crypto.randomBytes(10).toString("hex")}`;
      const newVerId = `tplv_${crypto.randomBytes(10).toString("hex")}`;
      const newName = `${String(tpl.name)} (Copy)`;
      const newSlug = `${String(tpl.slug)}-copy-${crypto.randomBytes(3).toString("hex")}`;

      db.exec("BEGIN IMMEDIATE;");
      try {
        db.prepare(`
          INSERT INTO templates (
            id, tenant_id, document_id, name, slug, description, category, tags_json,
            status, output_policy, current_version_number, is_system_integration, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 1, 0, ?)
        `).run(
          newId,
          tid,
          tpl.document_id,
          newName,
          newSlug,
          tpl.description,
          tpl.category,
          tpl.tags_json,
          tpl.output_policy,
          req.principal!.userId
        );
        db.prepare(`
          INSERT INTO template_versions (
            id, template_id, version_number, manifest_id, acroform_asset_id,
            is_approved, is_locked, changelog, created_by
          ) VALUES (?, ?, 1, ?, ?, 0, 0, 'Duplicated template', ?)
        `).run(newVerId, newId, ver.manifest_id, ver.acroform_asset_id, req.principal!.userId);
        db.exec("COMMIT;");
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }
      res.status(201).json({ ok: true, templateId: newId });
    }
  );

  router.patch(
    "/templates/:id",
    requireAuth,
    requirePermission("templates:write"),
    (req: AuthedRequest, res) => {
      const schema = z.object({
        status: z.enum(["draft", "in_review", "approved", "archived"]).optional(),
        outputPolicy: z.enum(["flattened", "fillable", "both"]).optional(),
        category: z.string().max(80).optional(),
        tags: z.array(z.string().max(40)).optional(),
        name: z.string().min(2).max(180).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: "Invalid template update" });
        return;
      }

      const db = getDatabase();
      const tpl = db
        .prepare("SELECT * FROM templates WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, req.principal!.tenantId) as
        | { id: string; status: TemplateStatus; output_policy: OutputPolicy; category: string; tags_json: string; name: string }
        | undefined;
      if (!tpl) {
        res.status(404).json({ ok: false, error: "Template not found" });
        return;
      }

      db.prepare(`
        UPDATE templates
        SET status = ?, output_policy = ?, category = ?, tags_json = ?, name = ?, updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ?
      `).run(
        parsed.data.status ?? tpl.status,
        parsed.data.outputPolicy ?? tpl.output_policy,
        parsed.data.category ?? tpl.category,
        parsed.data.tags ? JSON.stringify(parsed.data.tags) : tpl.tags_json,
        parsed.data.name ?? tpl.name,
        tpl.id,
        req.principal!.tenantId
      );

      res.json({ ok: true });
    }
  );

  router.delete(
    "/templates/:id",
    requireAuth,
    requirePermission("templates:delete"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tpl = db
        .prepare("SELECT id, is_system_integration FROM templates WHERE id = ? AND tenant_id = ?")
        .get(req.params.id, req.principal!.tenantId) as
        | { id: string; is_system_integration: number }
        | undefined;
      if (!tpl) {
        res.status(404).json({ ok: false, error: "Template not found" });
        return;
      }
      if (tpl.is_system_integration) {
        res.status(403).json({
          ok: false,
          error: "Locked template cannot be deleted.",
        });
        return;
      }
      db.prepare("DELETE FROM templates WHERE id = ? AND tenant_id = ?").run(
        tpl.id,
        req.principal!.tenantId
      );
      res.json({ ok: true });
    }
  );

  router.get(
    "/templates/:id/manifest",
    requireAuth,
    requirePermission("templates:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT fm.manifest_json, tv.version_number, t.name, t.output_policy, t.status
           FROM templates t
           JOIN template_versions tv ON tv.template_id = t.id
           JOIN field_manifests fm ON fm.id = tv.manifest_id
           WHERE t.id = ? AND t.tenant_id = ?
           ORDER BY tv.version_number DESC LIMIT 1`
        )
        .get(req.params.id, req.principal!.tenantId) as
        | {
            manifest_json: string;
            version_number: number;
            name: string;
            output_policy: OutputPolicy;
            status: TemplateStatus;
          }
        | undefined;
      if (!row) {
        res.status(404).json({ ok: false, error: "Template manifest not found" });
        return;
      }
      res.json({
        ok: true,
        templateName: row.name,
        versionNumber: row.version_number,
        outputPolicy: row.output_policy,
        status: row.status,
        manifest: JSON.parse(row.manifest_json),
      });
    }
  );

  // Protected Master AcroForm Download (authorised admin/template/integration callers only)
  router.get(
    "/templates/:id/download-acroform",
    requireAuth,
    requirePermission("templates:read"),
    (req: AuthedRequest, res) => {
      if (req.principal!.role === "read_only_user") {
        res.status(403).json({
          ok: false,
          error: "Read-only users cannot export private master AcroForm files.",
        });
        return;
      }

      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT t.slug, aa.storage_key
           FROM templates t
           JOIN template_versions tv ON tv.template_id = t.id
           JOIN acroform_assets aa ON aa.id = tv.acroform_asset_id
           WHERE t.id = ? AND t.tenant_id = ?
           ORDER BY tv.version_number DESC LIMIT 1`
        )
        .get(req.params.id, req.principal!.tenantId) as
        | { slug: string; storage_key: string }
        | undefined;
      if (!row) {
        res.status(404).json({ ok: false, error: "Master AcroForm not found" });
        return;
      }

      const buf = readStorageBuffer(row.storage_key);
      if (!buf) {
        res.status(404).json({ ok: false, error: "Master AcroForm file missing" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${sanitizeHeaderFilename(`${row.slug}-acroform-master.pdf`)}"`
      );
      res.send(buf);
    }
  );

  // -------------------------------------------------------------------------
  // ENGINE B: Independent Rendering, Flattened Customer PDF & Signed Upload
  // -------------------------------------------------------------------------
  router.post(
    "/render/:templateId",
    limiter,
    requireAuth,
    requirePermission("render:write"),
    async (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const row = db
        .prepare(
          `SELECT t.id as template_id, t.name, t.status, t.output_policy, t.is_system_integration,
                  tv.id as version_id, tv.is_approved, fm.manifest_json, aa.storage_key as acroform_key
           FROM templates t
           JOIN template_versions tv ON tv.template_id = t.id
           JOIN field_manifests fm ON fm.id = tv.manifest_id
           JOIN acroform_assets aa ON aa.id = tv.acroform_asset_id
           WHERE t.id = ? AND t.tenant_id = ?
           ORDER BY tv.is_approved DESC, tv.version_number DESC LIMIT 1`
        )
        .get(req.params.templateId, tid) as
        | {
            template_id: string;
            name: string;
            status: TemplateStatus;
            output_policy: OutputPolicy;
            is_system_integration: number;
            version_id: string;
            is_approved: number;
            manifest_json: string;
            acroform_key: string;
          }
        | undefined;

      if (!row) {
        res.status(404).json({ ok: false, error: "Template not found" });
        return;
      }
      if (!row.is_approved && row.status !== "approved") {
        res.status(400).json({
          ok: false,
          error: "Only approved templates can render production documents.",
        });
        return;
      }

      const requestedMode = req.body?.outputMode === "fillable" ? "fillable" : "flattened";
      if (requestedMode === "fillable" && row.output_policy === "flattened") {
        res.status(403).json({
          ok: false,
          error: "Template policy restricts public/customer renders to flattened PDFs only.",
        });
        return;
      }

      const manifest = JSON.parse(row.manifest_json) as FieldManifest;
      const values = (req.body?.values || {}) as Record<string, unknown>;

      // Flatten nested objects (e.g. { owner: { surname: "X" } }) into dotted and underscored keys
      const flatLookup: Record<string, unknown> = {};
      const flattenInto = (obj: Record<string, unknown>, prefix = "") => {
        for (const [k, v] of Object.entries(obj)) {
          const dotted = prefix ? `${prefix}.${k}` : k;
          if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            flattenInto(v as Record<string, unknown>, dotted);
          } else {
            flatLookup[dotted] = v;
            const underscored = dotted.replace(/\./g, "_");
            if (!(underscored in flatLookup)) flatLookup[underscored] = v;
          }
        }
      };
      flattenInto(values);

      // Validate required fields across underscored, dotted, id, and originalLabelText keys
      for (const fld of manifest.fields) {
        if (fld.required) {
          const val =
            flatLookup[fld.name] ??
            flatLookup[fld.id] ??
            (fld.originalLabelText ? flatLookup[fld.originalLabelText] : undefined) ??
            flatLookup[fld.name.replace(/_/g, ".")];
          if (val === undefined || val === null || String(val).trim() === "") {
            res.status(400).json({
              ok: false,
              error: `Field '${fld.label}' is required.`,
              field: fld.name,
            });
            return;
          }
        }
      }

      const tplAbs = resolveSafeStoragePath(row.acroform_key);
      const outKey = `renders/${crypto.randomBytes(16).toString("hex")}.pdf`;
      const outAbs = resolveSafeStoragePath(outKey);

      try {
        const out = await runFormifyPythonEngine<{
          populatedWidgets: number;
          flattened: boolean;
        }>("render-pdf", {
          templatePdfPath: tplAbs,
          manifest,
          values,
          outputPdfPath: outAbs,
          flatten: requestedMode === "flattened",
        });

        const renderedBuf = readStorageBuffer(outKey);
        if (!renderedBuf) {
          res.status(500).json({ ok: false, error: "Rendered PDF missing on storage" });
          return;
        }

        const sha256 = crypto.createHash("sha256").update(renderedBuf).digest("hex");
        const genId = `gen_${crypto.randomBytes(10).toString("hex")}`;
        const reference = `FP-${genId.slice(4, 12).toUpperCase()}`;
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        db.prepare(`
          INSERT INTO generated_documents (
            id, tenant_id, template_id, template_version_id, requested_by, output_mode,
            storage_key, sha256, byte_size, reference_code, submission_summary_json, retention_expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          genId,
          tid,
          row.template_id,
          row.version_id,
          req.principal!.userId,
          requestedMode,
          outKey,
          sha256,
          renderedBuf.length,
          reference,
          JSON.stringify({ fieldCount: Object.keys(values).length, populatedWidgets: out.populatedWidgets }),
          expiresAt
        );

        logAuditEvent({
          tenantId: tid,
          actorUserId: req.principal!.userId,
          actorEmail: req.principal!.email,
          action: "document.rendered",
          resourceType: "generated_document",
          resourceId: genId,
          metadata: { templateId: row.template_id, outputMode: requestedMode, reference },
        });

        res.status(201).json({
          ok: true,
          generatedDocumentId: genId,
          reference,
          outputMode: requestedMode,
          populatedWidgets: out.populatedWidgets,
          byteSize: renderedBuf.length,
          downloadUrl: `/api/v1/rendered/${genId}/download?disposition=attachment`,
          inlineUrl: `/api/v1/rendered/${genId}/download?disposition=inline`,
        });
      } catch (err) {
        deleteStorageObject(outKey);
        res.status(422).json({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to render PDF",
        });
      }
    }
  );

  router.get(
    "/rendered",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT g.*, t.name as template_name,
            (SELECT s.reference_code FROM signed_uploads s WHERE s.generated_document_id = g.id ORDER BY s.created_at DESC LIMIT 1) as signed_reference
           FROM generated_documents g
           LEFT JOIN templates t ON t.id = g.template_id
           WHERE g.tenant_id = ?
           ORDER BY g.created_at DESC LIMIT 30`
        )
        .all(req.principal!.tenantId);
      res.json({ ok: true, generatedDocuments: rows });
    }
  );

  router.get(
    "/rendered/:id/download",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const row = db
        .prepare(
          "SELECT storage_key, reference_code FROM generated_documents WHERE id = ? AND tenant_id = ?"
        )
        .get(req.params.id, req.principal!.tenantId) as
        | { storage_key: string; reference_code: string }
        | undefined;
      if (!row) {
        res.status(404).json({ ok: false, error: "Generated document not found" });
        return;
      }
      const buf = readStorageBuffer(row.storage_key);
      if (!buf) {
        res.status(404).json({ ok: false, error: "Rendered PDF expired or deleted" });
        return;
      }
      const disposition = req.query.disposition === "inline" ? "inline" : "attachment";
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${sanitizeHeaderFilename(`${row.reference_code}.pdf`)}"`
      );
      res.send(buf);
    }
  );

  router.post(
    "/rendered/:id/upload-signed",
    limiter,
    requireAuth,
    requirePermission("signed:write"),
    (req: AuthedRequest, res) => {
      pdfUpload.single("file")(req, res, (multerErr: unknown) => {
        if (multerErr) {
          res.status(400).json({ ok: false, error: "Invalid signed PDF upload" });
          return;
        }
        const file = req.file;
        if (!file || !file.buffer || !file.originalname.toLowerCase().endsWith(".pdf")) {
          res.status(400).json({ ok: false, error: "A valid .pdf file is required" });
          return;
        }
        if (
          file.mimetype &&
          file.mimetype !== "application/pdf" &&
          file.mimetype !== "application/octet-stream"
        ) {
          res.status(400).json({ ok: false, error: "Uploaded file MIME type must be application/pdf" });
          return;
        }
        const sig = validatePdfBufferSignature(file.buffer);
        if (!sig.valid) {
          res.status(400).json({ ok: false, error: sig.reason });
          return;
        }

        const db = getDatabase();
        const gen = db
          .prepare(
            "SELECT id, reference_code FROM generated_documents WHERE id = ? AND tenant_id = ?"
          )
          .get(req.params.id, req.principal!.tenantId) as
          | { id: string; reference_code: string }
          | undefined;
        if (!gen) {
          res.status(404).json({ ok: false, error: "Generated document not found" });
          return;
        }

        const stored = saveStorageBuffer("signed", file.originalname, file.buffer);
        const signedId = `sgn_${crypto.randomBytes(10).toString("hex")}`;
        const signedRef = `${gen.reference_code}-SIGNED`;

        db.prepare(`
          INSERT INTO signed_uploads (
            id, tenant_id, generated_document_id, original_filename, storage_key, sha256, byte_size, reference_code, uploaded_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          signedId,
          req.principal!.tenantId,
          gen.id,
          path.basename(file.originalname),
          stored.storageKey,
          stored.sha256,
          stored.byteSize,
          signedRef,
          req.principal!.userId
        );

        logAuditEvent({
          tenantId: req.principal!.tenantId,
          actorUserId: req.principal!.userId,
          actorEmail: req.principal!.email,
          action: "signed_document.uploaded",
          resourceType: "signed_upload",
          resourceId: signedId,
          metadata: { generatedDocumentId: gen.id, reference: signedRef },
        });

        res.status(201).json({
          ok: true,
          signedUploadId: signedId,
          reference: signedRef,
          sha256: stored.sha256,
          byteSize: stored.byteSize,
        });
      });
    }
  );

  // -------------------------------------------------------------------------
  // Supporting Document Uploads (PDF, PNG, JPEG, WebP — single or multi-file)
  // -------------------------------------------------------------------------
  router.get(
    "/supporting-documents",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tid = req.principal!.tenantId;
      const documentId =
        typeof req.query.documentId === "string" ? req.query.documentId.trim() : "";
      const generatedDocumentId =
        typeof req.query.generatedDocumentId === "string"
          ? req.query.generatedDocumentId.trim()
          : "";

      let rows: unknown[];
      if (documentId) {
        rows = db
          .prepare(
            `SELECT id, document_id, generated_document_id, uploaded_by, category, original_filename, mime_type, sha256, byte_size, created_at
             FROM supporting_documents
             WHERE tenant_id = ? AND document_id = ?
             ORDER BY created_at DESC`
          )
          .all(tid, documentId);
      } else if (generatedDocumentId) {
        rows = db
          .prepare(
            `SELECT id, document_id, generated_document_id, uploaded_by, category, original_filename, mime_type, sha256, byte_size, created_at
             FROM supporting_documents
             WHERE tenant_id = ? AND generated_document_id = ?
             ORDER BY created_at DESC`
          )
          .all(tid, generatedDocumentId);
      } else {
        rows = db
          .prepare(
            `SELECT id, document_id, generated_document_id, uploaded_by, category, original_filename, mime_type, sha256, byte_size, created_at
             FROM supporting_documents
             WHERE tenant_id = ?
             ORDER BY created_at DESC LIMIT 100`
          )
          .all(tid);
      }

      res.json({ ok: true, supportingDocuments: rows });
    }
  );

  router.post(
    "/supporting-documents",
    limiter,
    requireAuth,
    requirePermission("documents:write"),
    (req: AuthedRequest, res) => {
      supportingUpload.fields([
        { name: "files", maxCount: 10 },
        { name: "file", maxCount: 10 },
      ])(req, res, (multerErr: unknown) => {
        if (multerErr) {
          if (
            multerErr instanceof multer.MulterError &&
            multerErr.code === "LIMIT_FILE_SIZE"
          ) {
            res.status(413).json({
              ok: false,
              error: `Supporting file exceeds maximum size of ${Math.round(
                maxSupportingBytes / (1024 * 1024)
              )} MB.`,
            });
            return;
          }
          res.status(400).json({
            ok: false,
            error:
              multerErr instanceof Error
                ? multerErr.message
                : "Invalid multipart supporting-document upload",
          });
          return;
        }

        const fileMap = (req.files || {}) as Record<string, Express.Multer.File[]>;
        const files = [...(fileMap.files || []), ...(fileMap.file || [])];
        if (files.length === 0) {
          res.status(400).json({
            ok: false,
            error: "At least one supporting document file (PDF, PNG, JPEG, or WebP) is required.",
          });
          return;
        }

        const documentId =
          typeof req.body?.documentId === "string" && req.body.documentId.trim()
            ? req.body.documentId.trim()
            : null;
        const generatedDocumentId =
          typeof req.body?.generatedDocumentId === "string" &&
          req.body.generatedDocumentId.trim()
            ? req.body.generatedDocumentId.trim()
            : null;

        if (!documentId && !generatedDocumentId) {
          res.status(400).json({
            ok: false,
            error: "Either documentId or generatedDocumentId is required to associate supporting documents.",
          });
          return;
        }

        const db = getDatabase();
        const tid = req.principal!.tenantId;

        if (documentId) {
          const docExists = db
            .prepare("SELECT id FROM documents WHERE id = ? AND tenant_id = ?")
            .get(documentId, tid);
          if (!docExists) {
            res.status(404).json({ ok: false, error: "Associated document not found" });
            return;
          }
        }
        if (generatedDocumentId) {
          const genExists = db
            .prepare("SELECT id FROM generated_documents WHERE id = ? AND tenant_id = ?")
            .get(generatedDocumentId, tid);
          if (!genExists) {
            res.status(404).json({ ok: false, error: "Associated generated document not found" });
            return;
          }
        }

        const category =
          typeof req.body?.category === "string" && req.body.category.trim()
            ? req.body.category.trim().slice(0, 64)
            : "supporting";

        // Validate every uploaded file before storing any bytes
        const validated: Array<{ file: Express.Multer.File; mimeType: string }> = [];
        for (const f of files) {
          const sig = validateSupportingFileSignature(
            f.buffer,
            f.originalname,
            f.mimetype
          );
          if (!sig.valid || !sig.mimeType) {
            res.status(400).json({
              ok: false,
              error: `${sanitizeHeaderFilename(f.originalname)}: ${sig.reason || "Invalid file"}`,
            });
            return;
          }
          validated.push({ file: f, mimeType: sig.mimeType });
        }

        const tenant = db
          .prepare("SELECT retention_days FROM tenants WHERE id = ?")
          .get(tid) as { retention_days: number } | undefined;
        const expiresAt = new Date(
          Date.now() + (tenant?.retention_days ?? 30) * 24 * 60 * 60 * 1000
        ).toISOString();

        const storedKeys: string[] = [];
        const createdRecords: Array<{
          id: string;
          originalFilename: string;
          mimeType: string;
          byteSize: number;
          sha256: string;
          downloadUrl: string;
        }> = [];

        db.exec("BEGIN IMMEDIATE;");
        try {
          const insSup = db.prepare(`
            INSERT INTO supporting_documents (
              id, tenant_id, document_id, generated_document_id, uploaded_by,
              category, original_filename, mime_type, storage_key, sha256, byte_size, retention_expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const insMeta = db.prepare(`
            INSERT INTO storage_metadata (
              id, tenant_id, provider, storage_key, bucket_or_dir, content_type, byte_size, sha256, classification, retention_expires_at
            ) VALUES (?, ?, 'local', ?, 'supporting', ?, ?, ?, 'supporting', ?)
          `);

          for (const item of validated) {
            const safeName = sanitizeHeaderFilename(item.file.originalname, "supporting.bin");
            const stored = saveStorageBuffer(
              "supporting",
              safeName,
              item.file.buffer
            );
            storedKeys.push(stored.storageKey);
            const supId = `sup_${crypto.randomBytes(10).toString("hex")}`;

            insSup.run(
              supId,
              tid,
              documentId,
              generatedDocumentId,
              req.principal!.userId,
              category,
              safeName,
              item.mimeType,
              stored.storageKey,
              stored.sha256,
              stored.byteSize,
              expiresAt
            );

            insMeta.run(
              `stm_${crypto.randomBytes(8).toString("hex")}`,
              tid,
              stored.storageKey,
              item.mimeType,
              stored.byteSize,
              stored.sha256,
              expiresAt
            );

            createdRecords.push({
              id: supId,
              originalFilename: safeName,
              mimeType: item.mimeType,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
              downloadUrl: `/api/v1/supporting-documents/${supId}/download`,
            });
          }

          db.exec("COMMIT;");
        } catch (err) {
          db.exec("ROLLBACK;");
          for (const key of storedKeys) {
            deleteStorageObject(key);
          }
          console.error("[Supporting Document Upload Error]", err);
          res.status(500).json({ ok: false, error: "Failed to store supporting documents" });
          return;
        }

        logAuditEvent({
          tenantId: tid,
          actorUserId: req.principal!.userId,
          actorEmail: req.principal!.email,
          action: "supporting_documents.uploaded",
          resourceType: documentId ? "document" : "generated_document",
          resourceId: documentId || generatedDocumentId,
          metadata: { count: createdRecords.length, category },
        });

        res.status(201).json({
          ok: true,
          supportingDocuments: createdRecords,
        });
      });
    }
  );

  router.get(
    "/supporting-documents/:id/download",
    requireAuth,
    requirePermission("documents:read"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const row = db
        .prepare(
          `SELECT storage_key, mime_type, original_filename
           FROM supporting_documents
           WHERE id = ? AND tenant_id = ?`
        )
        .get(req.params.id, req.principal!.tenantId) as
        | { storage_key: string; mime_type: string; original_filename: string }
        | undefined;
      if (!row) {
        res.status(404).json({ ok: false, error: "Supporting document not found" });
        return;
      }

      const buf = readStorageBuffer(row.storage_key);
      if (!buf) {
        res.status(404).json({ ok: false, error: "Supporting document file missing or expired" });
        return;
      }

      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", row.mime_type);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${sanitizeHeaderFilename(row.original_filename, "supporting")}"`
      );
      res.setHeader("Content-Length", String(buf.length));
      res.send(buf);
    }
  );

  router.put(
    "/supporting-documents/:id",
    limiter,
    requireAuth,
    requirePermission("documents:write"),
    (req: AuthedRequest, res) => {
      supportingUpload.fields([
        { name: "file", maxCount: 1 },
        { name: "files", maxCount: 1 },
      ])(req, res, (multerErr: unknown) => {
        if (multerErr) {
          if (
            multerErr instanceof multer.MulterError &&
            multerErr.code === "LIMIT_FILE_SIZE"
          ) {
            res.status(413).json({
              ok: false,
              error: `Supporting file exceeds maximum size of ${Math.round(
                maxSupportingBytes / (1024 * 1024)
              )} MB.`,
            });
            return;
          }
          res.status(400).json({
            ok: false,
            error:
              multerErr instanceof Error
                ? multerErr.message
                : "Invalid multipart supporting-document replacement",
          });
          return;
        }

        const fileMap = (req.files || {}) as Record<string, Express.Multer.File[]>;
        const file = (fileMap.file || [])[0] || (fileMap.files || [])[0];
        if (!file || !file.buffer) {
          res.status(400).json({
            ok: false,
            error: "A replacement supporting document file (PDF, PNG, JPEG, or WebP) is required.",
          });
          return;
        }

        const db = getDatabase();
        const tid = req.principal!.tenantId;
        const existing = db
          .prepare(
            `SELECT id, category, storage_key, retention_expires_at
             FROM supporting_documents
             WHERE id = ? AND tenant_id = ?`
          )
          .get(req.params.id, tid) as
          | {
              id: string;
              category: string;
              storage_key: string;
              retention_expires_at: string | null;
            }
          | undefined;

        if (!existing) {
          res.status(404).json({ ok: false, error: "Supporting document not found" });
          return;
        }

        const sig = validateSupportingFileSignature(
          file.buffer,
          file.originalname,
          file.mimetype
        );
        if (!sig.valid || !sig.mimeType) {
          res.status(400).json({
            ok: false,
            error: `${sanitizeHeaderFilename(file.originalname)}: ${sig.reason || "Invalid file"}`,
          });
          return;
        }

        const nextCategory =
          typeof req.body?.category === "string" && req.body.category.trim()
            ? req.body.category.trim().slice(0, 64)
            : existing.category;
        const safeName = sanitizeHeaderFilename(file.originalname, "supporting.bin");
        const stored = saveStorageBuffer("supporting", safeName, file.buffer);

        const tenant = db
          .prepare("SELECT retention_days FROM tenants WHERE id = ?")
          .get(tid) as { retention_days: number } | undefined;
        const expiresAt =
          existing.retention_expires_at ||
          new Date(Date.now() + (tenant?.retention_days ?? 30) * 24 * 60 * 60 * 1000).toISOString();

        db.exec("BEGIN IMMEDIATE;");
        try {
          db.prepare(
            `UPDATE supporting_documents
             SET original_filename = ?, mime_type = ?, storage_key = ?, sha256 = ?,
                 byte_size = ?, category = ?, uploaded_by = ?, retention_expires_at = ?
             WHERE id = ? AND tenant_id = ?`
          ).run(
            safeName,
            sig.mimeType,
            stored.storageKey,
            stored.sha256,
            stored.byteSize,
            nextCategory,
            req.principal!.userId,
            expiresAt,
            existing.id,
            tid
          );

          db.prepare("DELETE FROM storage_metadata WHERE tenant_id = ? AND storage_key = ?").run(
            tid,
            existing.storage_key
          );
          db.prepare(
            `INSERT INTO storage_metadata (
              id, tenant_id, provider, storage_key, bucket_or_dir, content_type, byte_size, sha256, classification, retention_expires_at
            ) VALUES (?, ?, 'local', ?, 'supporting', ?, ?, ?, 'supporting', ?)`
          ).run(
            `stm_${crypto.randomBytes(8).toString("hex")}`,
            tid,
            stored.storageKey,
            sig.mimeType,
            stored.byteSize,
            stored.sha256,
            expiresAt
          );
          db.exec("COMMIT;");
        } catch (err) {
          db.exec("ROLLBACK;");
          deleteStorageObject(stored.storageKey);
          console.error("[Supporting Document Replace Error]", err);
          res.status(500).json({ ok: false, error: "Failed to replace supporting document" });
          return;
        }

        if (existing.storage_key !== stored.storageKey) {
          deleteStorageObject(existing.storage_key);
        }

        logAuditEvent({
          tenantId: tid,
          actorUserId: req.principal!.userId,
          actorEmail: req.principal!.email,
          action: "supporting_document.replaced",
          resourceType: "supporting_document",
          resourceId: existing.id,
          metadata: { filename: safeName, mimeType: sig.mimeType, byteSize: stored.byteSize },
        });

        res.json({
          ok: true,
          supportingDocument: {
            id: existing.id,
            originalFilename: safeName,
            mimeType: sig.mimeType,
            byteSize: stored.byteSize,
            sha256: stored.sha256,
            category: nextCategory,
            downloadUrl: `/api/v1/supporting-documents/${existing.id}/download`,
          },
        });
      });
    }
  );

  router.delete(
    "/supporting-documents/:id",
    requireAuth,
    requirePermission("documents:delete"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const row = db
        .prepare(
          "SELECT id, storage_key FROM supporting_documents WHERE id = ? AND tenant_id = ?"
        )
        .get(req.params.id, req.principal!.tenantId) as
        | { id: string; storage_key: string }
        | undefined;
      if (!row) {
        res.status(404).json({ ok: false, error: "Supporting document not found" });
        return;
      }

      deleteSupportingRecordAssets(db, req.principal!.tenantId, row);

      logAuditEvent({
        tenantId: req.principal!.tenantId,
        actorUserId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: "supporting_document.deleted",
        resourceType: "supporting_document",
        resourceId: row.id,
      });

      res.json({ ok: true, id: row.id });
    }
  );

  // -------------------------------------------------------------------------
  // API Keys & Settings / Retention Management
  // -------------------------------------------------------------------------
  router.get(
    "/api-keys",
    requireAuth,
    requirePermission("api_keys:manage"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const keys = db
        .prepare(
          `SELECT id, name, key_prefix, scopes_json, last_used_at, revoked_at, created_at
           FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`
        )
        .all(req.principal!.tenantId);
      res.json({ ok: true, apiKeys: keys });
    }
  );

  router.post(
    "/api-keys",
    requireAuth,
    requirePermission("api_keys:manage"),
    (req: AuthedRequest, res) => {
      const schema = z.object({
        name: z.string().min(2).max(100),
        scopes: z
          .array(
            z.enum([
              "documents:read",
              "documents:write",
              "templates:read",
              "render:write",
              "signed:write",
            ])
          )
          .min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: "Valid API key name and scopes required" });
        return;
      }

      const rawKey = `fpk_${crypto.randomBytes(24).toString("hex")}`;
      const id = `key_${crypto.randomBytes(10).toString("hex")}`;
      const db = getDatabase();
      db.prepare(`
        INSERT INTO api_keys (id, tenant_id, created_by, name, key_prefix, key_hash, scopes_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        req.principal!.tenantId,
        req.principal!.userId,
        parsed.data.name,
        rawKey.slice(0, 12),
        hashToken(rawKey),
        JSON.stringify(parsed.data.scopes)
      );

      logAuditEvent({
        tenantId: req.principal!.tenantId,
        actorUserId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: "api_key.created",
        resourceType: "api_key",
        resourceId: id,
        metadata: { name: parsed.data.name, scopes: parsed.data.scopes },
      });

      res.status(201).json({
        ok: true,
        apiKey: {
          id,
          name: parsed.data.name,
          prefix: rawKey.slice(0, 12),
          secretKey: rawKey,
          scopes: parsed.data.scopes,
        },
      });
    }
  );

  router.delete(
    "/api-keys/:id",
    requireAuth,
    requirePermission("api_keys:manage"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      db.prepare(
        "UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND tenant_id = ?"
      ).run(req.params.id, req.principal!.tenantId);
      res.json({ ok: true });
    }
  );

  router.get(
    "/settings",
    requireAuth,
    requirePermission("settings:manage"),
    (req: AuthedRequest, res) => {
      const db = getDatabase();
      const tenant = db
        .prepare("SELECT * FROM tenants WHERE id = ?")
        .get(req.principal!.tenantId);
      res.json({
        ok: true,
        tenant,
        storageBytes: computeDirectoryBytes(),
      });
    }
  );

  router.patch(
    "/settings",
    requireAuth,
    requirePermission("settings:manage"),
    (req: AuthedRequest, res) => {
      const schema = z.object({
        name: z.string().min(2).max(120).optional(),
        retentionDays: z.number().int().min(1).max(3650).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: "Invalid settings update" });
        return;
      }
      const db = getDatabase();
      const cur = db
        .prepare("SELECT name, retention_days FROM tenants WHERE id = ?")
        .get(req.principal!.tenantId) as { name: string; retention_days: number };
      db.prepare("UPDATE tenants SET name = ?, retention_days = ? WHERE id = ?").run(
        parsed.data.name ?? cur.name,
        parsed.data.retentionDays ?? cur.retention_days,
        req.principal!.tenantId
      );
      res.json({ ok: true });
    }
  );

  router.post(
    "/retention/purge",
    requireAuth,
    requirePermission("settings:manage"),
    (req: AuthedRequest, res) => {
      const result = purgeExpiredDocuments(req.principal!.tenantId);
      logAuditEvent({
        tenantId: req.principal!.tenantId,
        actorUserId: req.principal!.userId,
        actorEmail: req.principal!.email,
        action: "retention.purged",
        resourceType: "tenant",
        resourceId: req.principal!.tenantId,
        metadata: result,
      });
      res.json({ ok: true, ...result });
    }
  );

  return router;
}
