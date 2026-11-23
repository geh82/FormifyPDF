import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { RoleName } from "../lib/formforge/types.ts";
import { getDatabase, getRolePermissions } from "./db/database.ts";

export interface AuthenticatedPrincipal {
  kind: "user" | "api_key";
  userId: string | null;
  apiKeyId: string | null;
  tenantId: string;
  email: string;
  fullName: string;
  role: RoleName;
  permissions: string[];
}

export interface AuthedRequest extends Request {
  principal?: AuthenticatedPrincipal;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash.startsWith("scrypt:")) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  const actualBuf = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function isAdminBootstrapped(): boolean {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM users WHERE role_name = 'administrator' AND is_active = 1"
    )
    .get() as { cnt: number };
  return row.cnt > 0 || Boolean((process.env.FORMFORGE_ADMIN_PASSWORD || "").trim());
}

export function hasAnyAdminUserInDb(): boolean {
  const db = getDatabase();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM users WHERE role_name = 'administrator'")
    .get() as { cnt: number };
  return row.cnt > 0;
}

export function logAuditEvent(params: {
  tenantId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}) {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO audit_events (
        id, tenant_id, actor_user_id, actor_email, action, resource_type, resource_id, metadata_json, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `aud_${crypto.randomBytes(10).toString("hex")}`,
      params.tenantId ?? "tenant_default",
      params.actorUserId ?? null,
      params.actorEmail ?? null,
      params.action,
      params.resourceType,
      params.resourceId ?? null,
      JSON.stringify(params.metadata ?? {}),
      params.ipAddress ?? null
    );
  } catch (err) {
    console.error("[Audit Event Error]", err);
  }
}

export function createSessionForUser(
  userId: string,
  tenantId: string,
  req?: Request
): { token: string; expiresAt: string; sessionId: string } {
  const db = getDatabase();
  const rawToken = `ffs_${crypto.randomBytes(32).toString("hex")}`;
  const tokenHash = hashToken(rawToken);
  const sessionId = `sess_${crypto.randomBytes(10).toString("hex")}`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, user_id, tenant_id, token_hash, user_agent, ip_address, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    userId,
    tenantId,
    tokenHash,
    req?.headers["user-agent"]?.slice(0, 200) ?? null,
    req?.ip ?? null,
    expiresAt
  );

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(
    userId
  );

  return { token: rawToken, expiresAt, sessionId };
}

export function resolvePrincipalFromRequest(
  req: Request
): AuthenticatedPrincipal | null {
  const db = getDatabase();
  const authHeader = req.headers.authorization || "";
  const apiKeyHeader =
    typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";

  let rawBearer = "";
  if (authHeader.startsWith("Bearer ")) {
    rawBearer = authHeader.slice(7).trim();
  }

  // 1. Check API Key (X-API-Key or Bearer ffk_...)
  const candidateApiKey =
    apiKeyHeader.trim() || (rawBearer.startsWith("ffk_") ? rawBearer : "");
  if (candidateApiKey) {
    const keyHash = hashToken(candidateApiKey);
    const keyRow = db
      .prepare(
        `SELECT id, tenant_id, name, scopes_json, created_by
         FROM api_keys
         WHERE key_hash = ? AND revoked_at IS NULL`
      )
      .get(keyHash) as
      | {
          id: string;
          tenant_id: string;
          name: string;
          scopes_json: string;
          created_by: string | null;
        }
      | undefined;

    if (!keyRow) return null;

    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(
      keyRow.id
    );

    let scopes: string[] = [];
    try {
      scopes = JSON.parse(keyRow.scopes_json) as string[];
    } catch {
      scopes = [];
    }

    return {
      kind: "api_key",
      userId: keyRow.created_by,
      apiKeyId: keyRow.id,
      tenantId: keyRow.tenant_id,
      email: `api-key:${keyRow.name}`,
      fullName: keyRow.name,
      role: "api_integration_user",
      permissions:
        scopes.length > 0
          ? scopes
          : getRolePermissions(db, "api_integration_user"),
    };
  }

  // 2. Check User Session Token (Bearer ffs_...)
  const sessionToken =
    rawBearer ||
    (typeof req.query.token === "string" ? req.query.token.trim() : "");
  if (!sessionToken) return null;

  const tokenHash = hashToken(sessionToken);
  const row = db
    .prepare(
      `SELECT s.id as session_id, s.expires_at, s.revoked_at,
              u.id as user_id, u.tenant_id, u.email, u.full_name, u.role_name, u.is_active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as
    | {
        session_id: string;
        expires_at: string;
        revoked_at: string | null;
        user_id: string;
        tenant_id: string;
        email: string;
        full_name: string;
        role_name: RoleName;
        is_active: number;
      }
    | undefined;

  if (!row || row.revoked_at || !row.is_active) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  return {
    kind: "user",
    userId: row.user_id,
    apiKeyId: null,
    tenantId: row.tenant_id,
    email: row.email,
    fullName: row.full_name,
    role: row.role_name,
    permissions: getRolePermissions(db, row.role_name),
  };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const principal = resolvePrincipalFromRequest(req);
  if (!principal) {
    res.status(401).json({
      ok: false,
      code: "UNAUTHORIZED",
      error: "Authentication required. Sign in or supply a valid API key.",
    });
    return;
  }
  req.principal = principal;
  next();
}

export function requirePermission(permission: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const principal = req.principal || resolvePrincipalFromRequest(req);
    if (!principal) {
      res.status(401).json({
        ok: false,
        code: "UNAUTHORIZED",
        error: "Authentication required.",
      });
      return;
    }
    req.principal = principal;

    if (
      principal.role !== "administrator" &&
      !principal.permissions.includes(permission)
    ) {
      res.status(403).json({
        ok: false,
        code: "FORBIDDEN",
        error: `Role '${principal.role}' lacks required permission '${permission}'.`,
      });
      return;
    }
    next();
  };
}
