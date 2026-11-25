import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { getStorageProvider } from "../lib/storage/storage.ts";
import { validatePdfBufferSignature } from "./formifypdf-storage.ts";
import { getDatabase } from "./db/database.ts";
import { resolvePythonExecutable } from "./python-runner.ts";
import type { PythonRunOptions } from "./python-runner.ts";

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

  // Security headers for all API endpoints
  router.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    next();
  });

  // Readiness & dependency health check endpoint
  router.get("/health", async (_req, res) => {
    const storage = getStorageProvider();
    const storageHealth = await storage.healthCheck();

    let databaseOk = false;
    try {
      const db = getDatabase();
      const row = db.prepare("SELECT 1 as ok").get() as { ok: number } | undefined;
      databaseOk = row?.ok === 1;
    } catch {
      databaseOk = false;
    }

    const scriptPath = path.resolve(
      config.pythonOptions?.scriptPath ||
        path.join(process.cwd(), "python", "formifypdf_engine.py")
    );
    let scriptAvailable = false;
    try {
      await fs.access(scriptPath);
      scriptAvailable = true;
    } catch {
      scriptAvailable = false;
    }

    // Node AcroForm engine is built-in and runs whenever Python PDF deps are absent
    const nodeEngineOk = true;
    const ok = databaseOk && storageHealth.ok && nodeEngineOk;

    res.status(ok ? 200 : 503).json({
      ok,
      status: ok ? "healthy" : "degraded",
      databaseOk,
      storageOk: storageHealth.ok,
      storageProvider: storageHealth.provider,
      nodeEngineOk,
      scriptAvailable,
      pythonExecutable: path.basename(
        resolvePythonExecutable(config.pythonOptions?.pythonExecutable)
      ),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}