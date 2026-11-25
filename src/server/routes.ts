import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { getStorageProvider } from "../lib/storage/storage.ts";
function isValidDocumentId(id: unknown): id is string { return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id); }
import { validatePdfBufferSignature } from "./formforge-storage.ts";
import {
  PythonEngineError,
  resolvePythonExecutable,
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
  return validatePdfBufferSignature(buffer).valid;
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
        path.join(process.cwd(), "storage", "blank_template.pdf")
    );
    const scriptPath = path.resolve(
      config.pythonOptions?.scriptPath ||
        path.join(process.cwd(), "python", "formforge_engine.py")
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
  return router;
}