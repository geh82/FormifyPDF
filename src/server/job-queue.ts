import crypto from "node:crypto";
import path from "node:path";
import type {
  AcroFormValidationReport,
  DetectedFormField,
  DocumentPageInfo,
  FieldManifest,
  JobStage,
} from "../lib/formifypdf/types.ts";
import { logAuditEvent } from "./auth.ts";
import { getDatabase } from "./db/database.ts";
import { runFormifyPythonEngine } from "./formifypdf-runner.ts";
import {
  ensureStorageDirs,
  readStorageBuffer,
  resolveSafeStoragePath,
  saveStorageBuffer,
} from "./formifypdf-storage.ts";

interface AnalyzeEngineOutput {
  inspection: {
    pageCount: number;
    isScanned: boolean;
    hasExistingAcroForm: boolean;
    securityFlags: {
      hasEmbeddedJavaScript: boolean;
      wasEncrypted: boolean;
      sanitizedActions: boolean;
    };
    pages: Array<DocumentPageInfo & { thumbnailFile?: string | null }>;
  };
  ocrJobs: Array<{
    pageIndex: number;
    language: string;
    dpi: number;
    deskewAngle: number;
    wordCount: number;
    durationMs: number;
    status: string;
  }>;
  manifest: FieldManifest;
}

interface GenerateAcroFormOutput {
  createdWidgets: number;
  sanitizedActions: boolean;
  validation: AcroFormValidationReport;
}

const activeQueue: string[] = [];
let runningCount = 0;
const MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.FORMIFYPDF_WORKER_CONCURRENCY || "2")
);

function updateJobStage(
  jobId: string,
  stage: JobStage,
  progressPct: number,
  status: "queued" | "running" | "completed" | "failed" = "running"
) {
  const db = getDatabase();
  db.prepare(`
    UPDATE analysis_jobs
    SET stage = ?, progress_pct = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(stage, progressPct, status, jobId);
}

export function recoverStaleJobs(): number {
  const db = getDatabase();
  const stale = db
    .prepare(
      "SELECT id, document_id FROM analysis_jobs WHERE status IN ('queued', 'running')"
    )
    .all() as Array<{ id: string; document_id: string }>;

  if (stale.length === 0) return 0;

  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(`
      UPDATE analysis_jobs
      SET status = 'failed',
          stage = 'failed',
          error_code = 'SERVER_RESTARTED',
          error_message = 'Server restarted before analysis completed',
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE status IN ('queued', 'running')
    `).run();

    db.prepare(`
      UPDATE documents
      SET status = 'error', updated_at = datetime('now')
      WHERE status = 'analysing'
        AND id IN (SELECT document_id FROM analysis_jobs WHERE error_code = 'SERVER_RESTARTED')
    `).run();

    db.exec("COMMIT;");
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ignore
    }
    throw err;
  }
  return stale.length;
}

export function enqueueAnalysisJob(jobId: string) {
  activeQueue.push(jobId);
  drainQueue();
}

function drainQueue() {
  while (runningCount < MAX_CONCURRENCY && activeQueue.length > 0) {
    const nextJobId = activeQueue.shift()!;
    runningCount++;
    processAnalysisJob(nextJobId)
      .catch((err) => {
        console.error(`[Worker Job ${nextJobId} Unhandled Error]`, err);
      })
      .finally(() => {
        runningCount--;
        drainQueue();
      });
  }
}

export async function processAnalysisJob(jobId: string): Promise<void> {
  const db = getDatabase();
  const jobRow = db
    .prepare(
      `SELECT j.*, d.source_storage_key, d.title, d.original_filename
       FROM analysis_jobs j
       JOIN documents d ON d.id = j.document_id
       WHERE j.id = ?`
    )
    .get(jobId) as
    | {
        id: string;
        tenant_id: string;
        document_id: string;
        triggered_by: string | null;
        options_json: string;
        attempts: number;
        source_storage_key: string;
        title: string;
        original_filename: string;
      }
    | undefined;

  if (!jobRow) return;

  let options: Record<string, unknown> = {};
  try {
    options = JSON.parse(jobRow.options_json || "{}") as Record<string, unknown>;
  } catch {
    options = {};
  }

  db.prepare(`
    UPDATE analysis_jobs
    SET status = 'running', stage = 'inspecting_pdf', progress_pct = 12,
        attempts = attempts + 1, started_at = datetime('now'), error_code = NULL, error_message = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(jobId);

  db.prepare("UPDATE documents SET status = 'analysing', updated_at = datetime('now') WHERE id = ?").run(
    jobRow.document_id
  );

  try {
    const sourcePath = resolveSafeStoragePath(jobRow.source_storage_key);
    const thumbSubdir = path.join(
      ensureStorageDirs(),
      "thumbnails",
      jobRow.document_id
    );

    updateJobStage(jobId, "extracting_content", 28, "running");

    // Run real Python inspection + CV + OCR + semantic classification
    updateJobStage(jobId, "analysing_layout", 45, "running");

    const engineOut = await runFormifyPythonEngine<AnalyzeEngineOutput>(
      "analyze",
      {
        pdfPath: sourcePath,
        options: {
          ...options,
          documentId: jobRow.document_id,
          thumbnailsDir: thumbSubdir,
        },
      }
    );

    if (engineOut.ocrJobs.length > 0) {
      updateJobStage(jobId, "running_ocr", 60, "running");
      const insOcr = db.prepare(`
        INSERT INTO ocr_jobs (
          id, analysis_job_id, document_id, page_index, language, dpi, deskew_angle, word_count, status, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const oj of engineOut.ocrJobs) {
        insOcr.run(
          `ocr_${crypto.randomBytes(8).toString("hex")}`,
          jobId,
          jobRow.document_id,
          oj.pageIndex,
          oj.language,
          oj.dpi,
          oj.deskewAngle,
          oj.wordCount,
          oj.status,
          oj.durationMs
        );
      }
    }

    updateJobStage(jobId, "generating_manifest", 75, "running");

    let manifestId = "";
    let manifest: FieldManifest;

    // Persist inspected pages & manifest atomically inside transaction
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare("DELETE FROM document_pages WHERE document_id = ?").run(
        jobRow.document_id
      );
      const insPage = db.prepare(`
        INSERT INTO document_pages (
          id, document_id, page_index, width_pt, height_pt, rotation, orientation,
          paper_size, media_box_json, crop_box_json, text_span_count, word_count,
          drawing_count, existing_widget_count, needs_ocr, ocr_applied, deskew_angle, thumbnail_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of engineOut.inspection.pages) {
        const thumbKey = p.thumbnailFile
          ? `thumbnails/${jobRow.document_id}/${p.thumbnailFile}`
          : null;
        insPage.run(
          `pg_${crypto.randomBytes(8).toString("hex")}`,
          jobRow.document_id,
          p.pageIndex,
          p.widthPt,
          p.heightPt,
          p.rotation,
          p.orientation,
          p.paperSize,
          JSON.stringify(p.mediaBox),
          JSON.stringify(p.cropBox),
          p.textSpanCount,
          p.wordCount,
          p.drawingCount,
          p.existingWidgetCount,
          p.needsOcr ? 1 : 0,
          p.ocrApplied ? 1 : 0,
          p.deskewAngle ?? 0,
          thumbKey
        );
      }

      manifest = {
        ...engineOut.manifest,
        documentId: jobRow.document_id,
        generatedAt: new Date().toISOString(),
      };

      const prevVerRow = db
        .prepare(
          "SELECT COALESCE(MAX(version_number), 0) as max_ver FROM field_manifests WHERE document_id = ?"
        )
        .get(jobRow.document_id) as { max_ver: number };
      const nextManifestVer = prevVerRow.max_ver + 1;
      manifestId = `man_${crypto.randomBytes(10).toString("hex")}`;

      const highCnt = manifest.fields.filter((f) => f.confidenceTier === "high").length;
      const medCnt = manifest.fields.filter((f) => f.confidenceTier === "medium").length;
      const lowCnt = manifest.fields.filter((f) => f.confidenceTier === "low").length;

      db.prepare(`
        INSERT INTO field_manifests (
          id, tenant_id, document_id, version_number, schema_version, manifest_json,
          field_count, high_confidence_count, medium_confidence_count, low_confidence_count, created_by
        ) VALUES (?, ?, ?, ?, '1.0', ?, ?, ?, ?, ?, ?)
      `).run(
        manifestId,
        jobRow.tenant_id,
        jobRow.document_id,
        nextManifestVer,
        JSON.stringify(manifest),
        manifest.fields.length,
        highCnt,
        medCnt,
        lowCnt,
        jobRow.triggered_by
      );

      const insField = db.prepare(`
        INSERT INTO detected_fields (
          id, manifest_id, document_id, field_key, name, label, field_type,
          page_index, x_pt, y_pt, width_pt, height_pt, detection_source,
          confidence, confidence_tier, required, review_status, properties_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const f of manifest.fields as DetectedFormField[]) {
        insField.run(
          `fld_${crypto.randomBytes(8).toString("hex")}`,
          manifestId,
          jobRow.document_id,
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

      db.prepare(`
        UPDATE documents
        SET page_count = ?, is_scanned = ?, has_existing_acroform = ?, status = 'analyzed', updated_at = datetime('now')
        WHERE id = ?
      `).run(
        engineOut.inspection.pageCount,
        engineOut.inspection.isScanned ? 1 : 0,
        engineOut.inspection.hasExistingAcroForm ? 1 : 0,
        jobRow.document_id
      );

      db.exec("COMMIT;");
    } catch (innerErr) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore if already rolled back
      }
      throw innerErr;
    }

    // Optionally generate initial AcroForm asset right away if requested (outside DB transaction)
    if (options.autoGenerateAcroForm !== false) {
      updateJobStage(jobId, "generating_acroform", 88, "running");
      await generateAcroFormAssetForDocument({
        tenantId: jobRow.tenant_id,
        documentId: jobRow.document_id,
        manifestId,
        manifest,
        actorUserId: jobRow.triggered_by,
      });
    }

    db.prepare(`
      UPDATE analysis_jobs
      SET stage = 'completed', progress_pct = 100, status = 'completed',
          completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(jobId);

    logAuditEvent({
      tenantId: jobRow.tenant_id,
      actorUserId: jobRow.triggered_by,
      action: "document.analyzed",
      resourceType: "document",
      resourceId: jobRow.document_id,
      metadata: {
        jobId,
        fieldCount: manifest.fields.length,
        pageCount: engineOut.inspection.pageCount,
        isScanned: engineOut.inspection.isScanned,
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Analysis failed";
    const errCode =
      (err as Error & { code?: string }).code ||
      (errMsg.includes(":") ? errMsg.split(":", 1)[0].trim() : "ANALYSIS_FAILED");

    const curJob = db
      .prepare("SELECT stage FROM analysis_jobs WHERE id = ?")
      .get(jobId) as { stage: string } | undefined;

    db.prepare(`
      UPDATE analysis_jobs
      SET status = 'failed', stage = 'failed', error_code = ?, error_message = ?,
          completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(errCode, errMsg, jobId);

    db.prepare(
      "UPDATE documents SET status = 'error', updated_at = datetime('now') WHERE id = ?"
    ).run(jobRow.document_id);

    db.prepare(`
      INSERT INTO processing_errors (
        id, tenant_id, document_id, job_id, error_code, error_message, stage, recoverable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      `err_${crypto.randomBytes(8).toString("hex")}`,
      jobRow.tenant_id,
      jobRow.document_id,
      jobId,
      errCode,
      errMsg,
      curJob?.stage || "analysing_layout"
    );
  }
}

export async function generateAcroFormAssetForDocument(params: {
  tenantId: string;
  documentId: string;
  manifestId: string;
  manifest: FieldManifest;
  actorUserId?: string | null;
}): Promise<{
  assetId: string;
  storageKey: string;
  validation: AcroFormValidationReport;
  createdWidgets: number;
}> {
  const db = getDatabase();
  const docRow = db
    .prepare(
      "SELECT source_storage_key, original_filename FROM documents WHERE id = ? AND tenant_id = ?"
    )
    .get(params.documentId, params.tenantId) as
    | { source_storage_key: string; original_filename: string }
    | undefined;

  if (!docRow) {
    throw new Error("Document not found");
  }

  const sourcePath = resolveSafeStoragePath(docRow.source_storage_key);
  const outKey = `acroforms/${crypto.randomBytes(16).toString("hex")}.pdf`;
  const outAbsPath = resolveSafeStoragePath(outKey);

  const out = await runFormifyPythonEngine<GenerateAcroFormOutput>(
    "generate-acroform",
    {
      pdfPath: sourcePath,
      manifest: params.manifest,
      outputPdfPath: outAbsPath,
      preserveExisting: true,
    }
  );

  const savedBuf = readStorageBuffer(outKey);
  if (!savedBuf) {
    throw new Error("Generated AcroForm file missing on storage");
  }

  const sha256 = crypto.createHash("sha256").update(savedBuf).digest("hex");
  const assetId = `asset_${crypto.randomBytes(10).toString("hex")}`;

  db.prepare(`
    INSERT INTO acroform_assets (
      id, tenant_id, document_id, storage_key, sha256, byte_size, widget_count, validation_report_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assetId,
    params.tenantId,
    params.documentId,
    outKey,
    sha256,
    savedBuf.length,
    out.validation.widgetCount,
    JSON.stringify(out.validation)
  );

  db.prepare(`
    INSERT INTO storage_metadata (
      id, tenant_id, provider, storage_key, bucket_or_dir, content_type, byte_size, sha256, classification
    ) VALUES (?, ?, 'local', ?, 'acroforms', 'application/pdf', ?, ?, 'acroform')
  `).run(
    `stm_${crypto.randomBytes(8).toString("hex")}`,
    params.tenantId,
    outKey,
    savedBuf.length,
    sha256
  );

  // Also keep a reference to latest generated asset in document status
  db.prepare(
    "UPDATE documents SET status = 'acroform_ready', updated_at = datetime('now') WHERE id = ?"
  ).run(params.documentId);

  logAuditEvent({
    tenantId: params.tenantId,
    actorUserId: params.actorUserId ?? null,
    action: "acroform.generated",
    resourceType: "acroform_asset",
    resourceId: assetId,
    metadata: {
      documentId: params.documentId,
      widgetCount: out.validation.widgetCount,
      validPdf: out.validation.validPdf,
    },
  });

  return {
    assetId,
    storageKey: outKey,
    validation: out.validation,
    createdWidgets: out.createdWidgets,
  };
}

export { saveStorageBuffer };
