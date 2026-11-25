import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RoleName } from "../../lib/formforge/types.ts";

let cachedDb: DatabaseSync | null = null;
let cachedDbPath: string | null = null;

export function getDatabasePath(overridePath?: string): string {
  return path.resolve(
    overridePath ||
      process.env.FORMFORGE_DB_PATH ||
      path.join(process.cwd(), "storage", "formforge.sqlite")
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
    db.exec("BEGIN;");
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

}

type RawRectInput =
  | [number, number, number, number]
  | { x0: number; y0: number; x1: number; y1: number };

function toTopLeftRect(raw: RawRectInput | undefined): {
  x: number;
  y: number;
  width: number;
  height: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} | null {
  if (!raw) return null;
  let x0: number;
  let y0: number;
  let x1: number;
  let y1: number;
  if (Array.isArray(raw) && raw.length >= 4) {
    [x0, y0, x1, y1] = raw.map(Number);
  } else if (typeof raw === "object" && "x0" in raw) {
    x0 = Number(raw.x0);
    y0 = Number(raw.y0);
    x1 = Number(raw.x1);
    y1 = Number(raw.y1);
  } else {
    return null;
  }
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    x: round(x0),
    y: round(y0),
    width: round(Math.max(1, x1 - x0)),
    height: round(Math.max(1, y1 - y0)),
    x0,
    y0,
    x1,
    y1,
  };
}




export function getRolePermissions(db: DatabaseSync, roleName: string): string[] {
  const rows = db
    .prepare("SELECT permission_code FROM role_permissions WHERE role_name = ?")
    .all(roleName) as Array<{ permission_code: string }>;
  return rows.map((r) => r.permission_code);
}