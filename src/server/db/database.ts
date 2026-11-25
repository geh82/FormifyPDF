import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RoleName } from "../../lib/formifypdf/types.ts";

let cachedDb: DatabaseSync | null = null;
let cachedDbPath: string | null = null;

export function getDatabasePath(overridePath?: string): string {
  return path.resolve(
    overridePath ||
      process.env.FORMIFYPDF_DB_PATH ||
      path.join(process.cwd(), "storage", "formifypdf.sqlite")
  );
}

export function resetDatabaseCache() {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      // Ignore close errors
    }
  }
  cachedDb = null;
  cachedDbPath = null;
}

export function getDatabase(overridePath?: string): DatabaseSync {
  const dbPath = getDatabasePath(overridePath);
  if (cachedDb && cachedDbPath === dbPath) {
    return cachedDb;
  }
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      // Ignore
    }
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");

  runMigrations(db);
  seedBaselineData(db);

  cachedDb = db;
  cachedDbPath = dbPath;
  return db;
}

function runMigrations(db: DatabaseSync) {
  const migrationsDir = path.resolve(process.cwd(), "migrations");
  if (!fs.existsSync(migrationsDir)) {
    throw new Error("Migrations directory missing");
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Ensure tracking table exists before querying
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const checkStmt = db.prepare("SELECT version FROM schema_migrations WHERE version = ?");
  const insertStmt = db.prepare("INSERT INTO schema_migrations (version) VALUES (?)");

  for (const file of files) {
    const existing = checkStmt.get(file) as { version: string } | undefined;
    if (existing) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(sql);
      insertStmt.run(file);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }
}

export const ROLE_DEFINITIONS: Array<{
  name: RoleName;
  displayName: string;
  description: string;
  permissions: string[];
}> = [
  {
    name: "administrator",
    displayName: "Administrator",
    description: "Full tenant administration, users, API keys, retention, templates, and rendering.",
    permissions: [
      "documents:read",
      "documents:write",
      "documents:delete",
      "fields:edit",
      "templates:read",
      "templates:write",
      "templates:approve",
      "templates:delete",
      "render:write",
      "signed:write",
      "api_keys:manage",
      "users:manage",
      "settings:manage",
      "audit:read",
    ],
  },
  {
    name: "template_manager",
    displayName: "Template Manager",
    description: "Create, version, duplicate, archive, and approve AcroForm templates.",
    permissions: [
      "documents:read",
      "documents:write",
      "fields:edit",
      "templates:read",
      "templates:write",
      "templates:approve",
      "render:write",
      "signed:write",
      "audit:read",
    ],
  },
  {
    name: "editor",
    displayName: "Editor",
    description: "Upload PDFs, run analysis, and edit detected fields in the visual editor.",
    permissions: [
      "documents:read",
      "documents:write",
      "fields:edit",
      "templates:read",
      "templates:write",
      "render:write",
      "signed:write",
    ],
  },
  {
    name: "reviewer",
    displayName: "Reviewer",
    description: "Inspect field manifests, test sample fills, and approve templates.",
    permissions: [
      "documents:read",
      "templates:read",
      "templates:approve",
      "render:write",
      "audit:read",
    ],
  },
  {
    name: "api_integration_user",
    displayName: "API Integration User",
    description: "Consume approved templates, render documents, and upload signed files via REST API.",
    permissions: [
      "documents:read",
      "documents:write",
      "templates:read",
      "render:write",
      "signed:write",
    ],
  },
  {
    name: "read_only_user",
    displayName: "Read-Only User",
    description: "View dashboard metrics, documents, templates, and processing logs.",
    permissions: ["documents:read", "templates:read"],
  },
];

function seedBaselineData(db: DatabaseSync) {
  // 1. Default tenant
  db.prepare(`
    INSERT OR IGNORE INTO tenants (id, name, slug, retention_days)
    VALUES ('tenant_default', 'Default Workspace', 'default', 30)
  `).run();

  // 2. Roles & Permissions
  const allPerms = Array.from(new Set(ROLE_DEFINITIONS.flatMap((r) => r.permissions)));
  const insPerm = db.prepare(
    "INSERT OR IGNORE INTO permissions (code, description) VALUES (?, ?)"
  );
  for (const p of allPerms) {
    insPerm.run(p, `Permission ${p}`);
  }

  const insRole = db.prepare(
    "INSERT OR IGNORE INTO roles (name, display_name, description) VALUES (?, ?, ?)"
  );
  const insRp = db.prepare(
    "INSERT OR IGNORE INTO role_permissions (role_name, permission_code) VALUES (?, ?)"
  );
  for (const r of ROLE_DEFINITIONS) {
    insRole.run(r.name, r.displayName, r.description);
    for (const p of r.permissions) {
      insRp.run(r.name, p);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS public_conversions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES analysis_jobs(id) ON DELETE SET NULL,
      access_token_hash TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'pdf',
      zip_archive_id TEXT,
      archive_filename TEXT,
      extra_page_count INTEGER NOT NULL DEFAULT 0,
      paid INTEGER NOT NULL DEFAULT 0,
      paid_tier_id TEXT,
      paid_tier_name TEXT,
      paid_amount_cents INTEGER,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const legacy30 = db
    .prepare("SELECT id FROM pricing_tiers WHERE id = 'tier_30_499' AND tenant_id = 'tenant_default'")
    .get() as { id: string } | undefined;
  if (legacy30) {
    db.prepare("DELETE FROM pricing_tiers WHERE id = 'tier_30_499' AND tenant_id = 'tenant_default'").run();
    const insTier = db.prepare(
      "INSERT OR IGNORE INTO pricing_tiers (id, tenant_id, name, max_pages, price_cents, description, is_active) VALUES (?, 'tenant_default', ?, ?, ?, ?, 1)"
    );
    insTier.run("tier_30_599", "Up to 30 pages", 30, 599, "Up to 30 pages — $5.99");
    insTier.run("tier_45_749", "Up to 45 pages", 45, 749, "Up to 45 pages — $7.49");
    insTier.run("tier_60_999", "Up to 60 pages", 60, 999, "Up to 60 pages — $9.99");
  }
}

export function getRolePermissions(db: DatabaseSync, roleName: string): string[] {
  const rows = db
    .prepare("SELECT permission_code FROM role_permissions WHERE role_name = ?")
    .all(roleName) as Array<{ permission_code: string }>;
  return rows.map((r) => r.permission_code);
}