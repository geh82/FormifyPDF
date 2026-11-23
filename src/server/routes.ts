import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { getStorageProvider } from "../lib/storage/storage.ts";
import {
  alvSubmissionSchema,
  isValidDocumentId,
  toPdfEnginePayload,
} from "../lib/validation/alv-schema.ts";
import {
  PythonEngineError,
  resolvePythonExecutable,
  runAlvPythonEngine,
} from "./python-runner.ts";
import type { PythonRunOptions } from "./python-runner.ts";
import { createRateLimiter } from "./rate-limit.ts";

export interface ApiRouterConfig {
  pythonOptions?: PythonRunOptions;
  maxUploadBytes?: number;
  disableRateLimit?: boolean;
}

export function isValidPdfBuffer(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) {
    return false;
  }
  const header = buffer.subarray(0, 1024).toString("latin1");
  if (!header.includes("%PDF-")) {
    return false;
  }
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString("latin1");
  return tail.includes("%%EOF");
}

export function createApiRouter(config: ApiRouterConfig = {}): express.Router {
  const router = express.Router();
  const maxUploadBytes =
    config.maxUploadBytes ??
    Math.max(1024, Number(process.env.MAX_UPLOAD_BYTES || String(10 * 1024 * 1024)));

  const limiter = config.disableRateLimit
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : createRateLimiter();

  // Strict JSON parser with 64 KB cap for form submissions
  const jsonParser = express.json({ limit: "64kb", strict: true });

  // Multer memory storage so uploaded bytes are verified before persisting
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fields: 5,
    },
  });

  // Security headers for all API endpoints
  router.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    next();
  });

  // Health check endpoint
  router.get("/health", async (_req, res) => {
    const storage = getStorageProvider();
    const storageHealth = await storage.healthCheck();
    const templatePath = path.resolve(
      config.pythonOptions?.templatePath ||
        path.join(process.cwd(), "src", "lib", "alv", "ALV_blank.pdf")
    );
    const scriptPath = path.resolve(
      config.pythonOptions?.scriptPath ||
        path.join(process.cwd(), "src", "lib", "alv", "fill_alv.py")
    );

    let templateAvailable = false;
    let scriptAvailable = false;
    try {
      await fs.access(templatePath);
      templateAvailable = true;
    } catch {
      templateAvailable = false;
    }
    try {
      await fs.access(scriptPath);
      scriptAvailable = true;
    } catch {
      scriptAvailable = false;
    }

    const ok = storageHealth.ok && templateAvailable && scriptAvailable;
    res.status(ok ? 200 : 503).json({
      ok,
      status: ok ? "healthy" : "degraded",
      pythonExecutable: path.basename(
        resolvePythonExecutable(config.pythonOptions?.pythonExecutable)
      ),
      templateAvailable,
      scriptAvailable,
      storageProvider: storageHealth.provider,
      storageOk: storageHealth.ok,
      timestamp: new Date().toISOString(),
    });
  });

  // A. Generate official ALV PDF
  router.post("/generate-pdf", limiter, jsonParser, async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({
        ok: false,
        error: "Request body must be a valid JSON object",
      });
      return;
    }

    const parsed = alvSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      const fieldErrors = parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      res.status(400).json({
        ok: false,
        error: "Form validation failed",
        fieldErrors,
      });
      return;
    }

    const id = crypto.randomBytes(12).toString("hex");
    const enginePayload = toPdfEnginePayload(parsed.data);

    try {
      const { pdfBuffer } = await runAlvPythonEngine(
        enginePayload,
        config.pythonOptions
      );

      const storage = getStorageProvider();
      await storage.saveGeneratedPdf(id, pdfBuffer);

      // Verify persisted existence before returning success
      const exists = await storage.existsGeneratedPdf(id);
      if (!exists) {
        res.status(500).json({
          ok: false,
          error: "Generated PDF could not be verified in storage",
        });
        return;
      }

      res.status(200).json({
        ok: true,
        id,
        downloadUrl: `/api/download?id=${id}&type=generated&disposition=attachment`,
        inlineUrl: `/api/download?id=${id}&type=generated&disposition=inline`,
        filename: "ALV_generated.pdf",
      });
    } catch (err) {
      if (err instanceof PythonEngineError) {
        console.error(`[ALV PDF Engine Error] ${err.code}: ${err.message}`);
        const statusCode =
          err.code === "PYTHON_PROCESSING_FAILED" ? 422 : 500;
        res.status(statusCode).json({
          ok: false,
          code: err.code,
          error:
            statusCode === 422
              ? err.message
              : "PDF generation service encountered an internal error",
        });
        return;
      }
      console.error("[ALV PDF Unexpected Error]", err);
      res.status(500).json({
        ok: false,
        error: "Unexpected error while generating the official ALV PDF",
      });
    }
  });

  // B. Download or view generated PDF inline
  router.get("/download", async (req, res) => {
    const id = req.query.id;
    const type = req.query.type;
    const dispositionParam = req.query.disposition;

    if (!isValidDocumentId(id)) {
      res.status(400).json({
        ok: false,
        error: "Invalid document identifier",
      });
      return;
    }

    if (type !== "generated") {
      res.status(400).json({
        ok: false,
        error: "Unsupported or restricted document type",
      });
      return;
    }

    const disposition =
      dispositionParam === undefined || dispositionParam === "attachment"
        ? "attachment"
        : dispositionParam === "inline"
        ? "inline"
        : null;

    if (!disposition) {
      res.status(400).json({
        ok: false,
        error: "Invalid disposition parameter; expected 'attachment' or 'inline'",
      });
      return;
    }

    try {
      const storage = getStorageProvider();
      const pdfBuffer = await storage.readGeneratedPdf(id);
      if (!pdfBuffer) {
        res.status(404).json({
          ok: false,
          error: "Generated ALV PDF was not found or has expired",
        });
        return;
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="ALV_generated.pdf"`
      );
      res.setHeader("Content-Length", String(pdfBuffer.length));
      res.status(200).send(pdfBuffer);
    } catch (err) {
      console.error("[ALV Download Error]", err);
      res.status(500).json({
        ok: false,
        error: "Failed to retrieve generated PDF",
      });
    }
  });

  // C. Upload physically signed PDF
  router.post("/upload-signed", limiter, (req, res) => {
    upload.single("file")(req, res, async (multerErr: unknown) => {
      if (multerErr) {
        if (multerErr instanceof multer.MulterError) {
          if (multerErr.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({
              ok: false,
              error: `Uploaded PDF exceeds the maximum allowed size of ${Math.round(
                maxUploadBytes / (1024 * 1024)
              )} MB`,
            });
            return;
          }
          res.status(400).json({
            ok: false,
            error: `Upload error: ${multerErr.message}`,
          });
          return;
        }
        res.status(400).json({
          ok: false,
          error: "Invalid multipart upload request",
        });
        return;
      }

      const documentId = req.body?.documentId;
      if (!isValidDocumentId(documentId)) {
        res.status(400).json({
          ok: false,
          error: "A valid generated documentId is required before uploading a signed PDF",
        });
        return;
      }

      const file = req.file;
      if (!file || !file.buffer) {
        res.status(400).json({
          ok: false,
          error: "No PDF file was provided",
        });
        return;
      }

      const originalName = (file.originalname || "").trim();
      if (!originalName.toLowerCase().endsWith(".pdf")) {
        res.status(400).json({
          ok: false,
          error: "Uploaded file must have a .pdf extension",
        });
        return;
      }

      if (file.mimetype && file.mimetype !== "application/pdf" && file.mimetype !== "application/octet-stream") {
        res.status(400).json({
          ok: false,
          error: "Uploaded file MIME type must be application/pdf",
        });
        return;
      }

      if (!isValidPdfBuffer(file.buffer)) {
        res.status(400).json({
          ok: false,
          error: "Uploaded file failed PDF signature verification and does not appear to be a valid PDF",
        });
        return;
      }

      try {
        const storage = getStorageProvider();
        const generatedExists = await storage.existsGeneratedPdf(documentId);
        if (!generatedExists) {
          res.status(404).json({
            ok: false,
            error: "Referenced generated ALV document does not exist or has expired",
          });
          return;
        }

        const sha256 = crypto
          .createHash("sha256")
          .update(file.buffer)
          .digest("hex");
        const uploadedAt = new Date().toISOString();

        await storage.saveSignedPdf(documentId, file.buffer, {
          sha256,
          byteSize: file.buffer.length,
          uploadedAt,
        });

        const stored = await storage.existsSignedPdf(documentId);
        if (!stored) {
          res.status(500).json({
            ok: false,
            error: "Signed PDF storage verification failed",
          });
          return;
        }

        res.status(200).json({
          ok: true,
          documentId,
          reference: `ALV-${documentId.slice(0, 8).toUpperCase()}`,
          byteSize: file.buffer.length,
          sha256,
          uploadedAt,
        });
      } catch (err) {
        console.error("[ALV Signed Upload Error]", err);
        res.status(500).json({
          ok: false,
          error: "Failed to store the signed PDF document",
        });
      }
    });
  });

  // Handle JSON syntax errors and payload-too-large cleanly
  router.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (
        err instanceof SyntaxError &&
        "status" in err &&
        (err as { status?: number }).status === 400
      ) {
        res.status(400).json({
          ok: false,
          error: "Malformed JSON payload",
        });
        return;
      }
      if (
        typeof err === "object" &&
        err !== null &&
        "type" in err &&
        (err as { type?: string }).type === "entity.too.large"
      ) {
        res.status(413).json({
          ok: false,
          error: "Request payload exceeds maximum allowed size",
        });
        return;
      }
      next(err);
    }
  );

  // Explicit 404 for unknown /api/* routes
  router.use((_req, res) => {
    res.status(404).json({
      ok: false,
      error: "API endpoint not found",
    });
  });

  return router;
}
