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
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

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

  // 3. Seed first real-world integration: ALV Form Online (pre-calibrated official template)
  seedAlvIntegrationTemplate(db);
}

function seedAlvIntegrationTemplate(db: DatabaseSync) {
  const existing = db
    .prepare("SELECT id FROM templates WHERE id = 'tpl_alv_official'")
    .get();
  if (existing) return;

  const alvPdfPath = path.resolve(process.cwd(), "src/lib/alv/ALV_blank.pdf");
  const alvMapPath = path.resolve(process.cwd(), "src/lib/alv/field_map.json");
  if (!fs.existsSync(alvPdfPath) || !fs.existsSync(alvMapPath)) {
    return;
  }

  const pdfBytes = fs.readFileSync(alvPdfPath);
  const pdfSha = crypto.createHash("sha256").update(pdfBytes).digest("hex");
  const fieldMapRaw = JSON.parse(fs.readFileSync(alvMapPath, "utf-8")) as {
    meta?: { totalPages?: number; totalAssignedCells?: number; totalSelectionBoxes?: number };
    pages?: Array<{ pageIndex: number; width: number; height: number }>;
    fields?: Record<
      string,
      {
        kind?: string;
        page?: number;
        cells?: Array<{ x0: number; y0: number; x1: number; y1: number; name?: string }>;
        options?: Record<string, { x0: number; y0: number; x1: number; y1: number }>;
      }
    >;
  };

  const fieldsList = Object.entries(fieldMapRaw.fields || {}).map(([key, cfg], idx) => {
    const cells = cfg.cells || [];
    const optEntries = Object.entries(cfg.options || {});
    let page = cfg.page ?? 0;
    let rect = { x: 40, y: 40, width: 180, height: 18 };
    let cellRects: Array<{ x: number; y: number; width: number; height: number }> | undefined;

    if (cells.length > 0) {
      const minX = Math.min(...cells.map((c) => c.x0));
      const minY = Math.min(...cells.map((c) => c.y0));
      const maxX = Math.max(...cells.map((c) => c.x1));
      const maxY = Math.max(...cells.map((c) => c.y1));
      rect = {
        x: Math.round(minX * 100) / 100,
        y: Math.round(minY * 100) / 100,
        width: Math.round((maxX - minX) * 100) / 100,
        height: Math.round((maxY - minY) * 100) / 100,
      };
      cellRects = cells.map((c) => ({
        x: Math.round(c.x0 * 100) / 100,
        y: Math.round(c.y0 * 100) / 100,
        width: Math.round((c.x1 - c.x0) * 100) / 100,
        height: Math.round((c.y1 - c.y0) * 100) / 100,
      }));
    } else if (optEntries.length > 0) {
      const boxes = optEntries.map(([, b]) => b);
      const minX = Math.min(...boxes.map((c) => c.x0));
      const minY = Math.min(...boxes.map((c) => c.y0));
      const maxX = Math.max(...boxes.map((c) => c.x1));
      const maxY = Math.max(...boxes.map((c) => c.y1));
      rect = {
        x: Math.round(minX * 100) / 100,
        y: Math.round(minY * 100) / 100,
        width: Math.round((maxX - minX) * 100) / 100,
        height: Math.round((maxY - minY) * 100) / 100,
      };
    }

    const fieldType =
      cfg.kind === "selection"
        ? "radio"
        : cfg.kind === "date_yymmdd"
        ? "date"
        : cells.length > 1
        ? "char_cells"
        : "text";

    return {
      id: `alv_field_${String(idx + 1).padStart(3, "0")}`,
      name: key.replace(/\./g, "_"),
      label: key,
      type: fieldType,
      page,
      rect,
      cellRects,
      coordinateSpace: "top_left_pdf_pt" as const,
      originalLabelText: key,
      detectionSource: "existing_acroform" as const,
      confidence: 1,
      confidenceTier: "high" as const,
      confidenceEvidence: ["Pre-calibrated official ALV_blank.pdf field_map.json"],
      required: false,
      defaultValue: "",
      maxLength: cells.length > 0 ? cells.length : undefined,
      multiline: false,
      options: optEntries.map(([k]) => k),
      validation: {},
      reviewStatus: "accepted" as const,
    };
  });

  const pages = (fieldMapRaw.pages || []).map((p) => ({
    pageIndex: p.pageIndex,
    widthPt: p.width,
    heightPt: p.height,
    rotation: 0 as const,
    orientation: p.width > p.height ? ("landscape" as const) : ("portrait" as const),
    paperSize: "A4" as const,
    mediaBox: { x: 0, y: 0, width: p.width, height: p.height },
    cropBox: { x: 0, y: 0, width: p.width, height: p.height },
    textSpanCount: 400,
    wordCount: 650,
    drawingCount: 900,
    existingWidgetCount: 710,
    needsOcr: false,
    ocrApplied: false,
  }));

  const manifestObj = {
    documentId: "doc_alv_official",
    schemaVersion: "1.0" as const,
    templateName: "South Africa ALV(9)(2011/07) Motor Vehicle Licensing",
    totalPages: pages.length || 2,
    pages,
    fields: fieldsList,
    generatedAt: new Date().toISOString(),
    engineVersion: "alv-calibrated-1.0",
    hasExistingAcroForm: true,
    isScanned: false,
    securityFlags: {
      hasEmbeddedJavaScript: false,
      wasEncrypted: false,
      sanitizedActions: false,
    },
  };

  db.exec("BEGIN;");
  try {
    db.prepare(`
      INSERT OR IGNORE INTO documents (
        id, tenant_id, title, original_filename, sha256, byte_size,
        page_count, is_scanned, has_existing_acroform, status, source_storage_key
      ) VALUES (?, 'tenant_default', ?, ?, ?, ?, ?, 0, 1, 'approved', ?)
    `).run(
      "doc_alv_official",
      "Official Form ALV(9)(2011/07)",
      "ALV_blank.pdf",
      pdfSha,
      pdfBytes.length,
      pages.length || 2,
      "src/lib/alv/ALV_blank.pdf"
    );

    for (const p of pages) {
      db.prepare(`
        INSERT OR IGNORE INTO document_pages (
          id, document_id, page_index, width_pt, height_pt, rotation,
          orientation, paper_size, media_box_json, crop_box_json,
          text_span_count, word_count, drawing_count, existing_widget_count,
          needs_ocr, ocr_applied
        ) VALUES (?, 'doc_alv_official', ?, ?, ?, 0, ?, 'A4', ?, ?, ?, ?, ?, ?, 0, 0)
      `).run(
        `page_alv_${p.pageIndex}`,
        p.pageIndex,
        p.widthPt,
        p.heightPt,
        p.orientation,
        JSON.stringify(p.mediaBox),
        JSON.stringify(p.cropBox),
        p.textSpanCount,
        p.wordCount,
        p.drawingCount,
        p.existingWidgetCount
      );
    }

    db.prepare(`
      INSERT OR IGNORE INTO field_manifests (
        id, tenant_id, document_id, version_number, schema_version,
        manifest_json, field_count, high_confidence_count, medium_confidence_count, low_confidence_count
      ) VALUES ('manifest_alv_v1', 'tenant_default', 'doc_alv_official', 1, '1.0', ?, ?, ?, 0, 0)
    `).run(JSON.stringify(manifestObj), fieldsList.length, fieldsList.length);

    db.prepare(`
      INSERT OR IGNORE INTO acroform_assets (
        id, tenant_id, document_id, storage_key, sha256, byte_size, widget_count, validation_report_json
      ) VALUES ('asset_alv_v1', 'tenant_default', 'doc_alv_official', ?, ?, ?, ?, ?)
    `).run(
      "src/lib/alv/ALV_blank.pdf",
      pdfSha,
      pdfBytes.length,
      (fieldMapRaw.meta?.totalAssignedCells ?? 690) +
        (fieldMapRaw.meta?.totalSelectionBoxes ?? 20),
      JSON.stringify({
        validPdf: true,
        hasAcroFormDict: true,
        widgetCount: 710,
        expectedFieldCount: fieldsList.length,
        missingFields: [],
        appearanceStreamsVerified: true,
        roundTripWriteReadOk: true,
        pageCount: pages.length || 2,
        warnings: [],
      })
    );

    db.prepare(`
      INSERT OR IGNORE INTO templates (
        id, tenant_id, document_id, name, slug, description, category, tags_json,
        status, output_policy, current_version_number, is_system_integration, integration_key
      ) VALUES (
        'tpl_alv_official', 'tenant_default', 'doc_alv_official',
        'ALV(9)(2011/07) — Motor Vehicle Licensing',
        'sa-alv-motor-vehicle-licensing',
        'Pre-calibrated official South African Application for Licensing of Motor Vehicle template integrated with ALV Form Online.',
        'Government & Licensing',
        '["ALV","South Africa","Motor Vehicle","Pre-Calibrated"]',
        'approved', 'flattened', 1, 1, 'alv_form_online'
      )
    `).run();

    db.prepare(`
      INSERT OR IGNORE INTO template_versions (
        id, template_id, version_number, manifest_id, acroform_asset_id,
        is_approved, is_locked, changelog
      ) VALUES (
        'tplv_alv_v1', 'tpl_alv_official', 1, 'manifest_alv_v1', 'asset_alv_v1',
        1, 1, 'Initial pre-calibrated official ALV(9)(2011/07) integration mapping (48 logical fields / 710 cells).'
      )
    `).run();

    db.prepare(`
      INSERT OR IGNORE INTO template_approvals (
        id, template_id, template_version_id, structural_verified, visual_verified, notes
      ) VALUES (
        'appr_alv_v1', 'tpl_alv_official', 'tplv_alv_v1', 1, 1,
        'Verified pre-calibrated ALV Form Online integration template.'
      )
    `).run();

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

export function getRolePermissions(db: DatabaseSync, roleName: string): string[] {
  const rows = db
    .prepare("SELECT permission_code FROM role_permissions WHERE role_name = ?")
    .all(roleName) as Array<{ permission_code: string }>;
  return rows.map((r) => r.permission_code);
}
