import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { createRateLimiter } from "../src/server/rate-limit.ts";
import {
  DEFAULT_MAX_ZIP_BYTES,
  ZipSecurityError,
  deleteZipArchive,
  getZipManifest,
  isValidZipId,
  listZipArchives,
  readZipEntry,
  saveZipArchive,
  type ZipStorageLimits,
} from "./zipStorage.ts";

export interface ZipRouterConfig {
  rootDir?: string;
  limits?: ZipStorageLimits;
  disableRateLimit?: boolean;
}

export function createZipUploadRouter(config: ZipRouterConfig = {}): express.Router {
  const router = express.Router();
  const maxUploadBytes = config.limits?.maxArchiveBytes ?? DEFAULT_MAX_ZIP_BYTES;

  const limiter = config.disableRateLimit
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : createRateLimiter();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fields: 2,
    },
  });

  // Security headers for all ZIP API routes
  router.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    next();
  });

  // POST /api/zip-uploads — upload and extract a .zip into uploaded-zips/<id>/files/
  router.post("/", limiter, (req, res) => {
    upload.single("file")(req, res, async (multerErr: unknown) => {
      if (multerErr) {
        if (multerErr instanceof multer.MulterError) {
          if (multerErr.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({
              ok: false,
              error: `ZIP file exceeds the ${Math.round(maxUploadBytes / (1024 * 1024))} MB limit`,
            });
            return;
          }
          res.status(400).json({ ok: false, error: multerErr.message });
          return;
        }
        res.status(400).json({ ok: false, error: "Invalid multipart ZIP upload" });
        return;
      }

      const file = req.file;
      if (!file || !file.buffer) {
        res.status(400).json({ ok: false, error: "No ZIP file was uploaded" });
        return;
      }

      const originalName = (file.originalname || "").trim();
      if (!originalName.toLowerCase().endsWith(".zip")) {
        res.status(400).json({
          ok: false,
          error: "Only .zip archive files are permitted",
        });
        return;
      }

      try {
        const manifest = await saveZipArchive(file.buffer, originalName, {
          rootDir: config.rootDir,
          limits: config.limits,
        });
        res.status(201).json({ ok: true, archive: manifest });
      } catch (err) {
        if (err instanceof ZipSecurityError) {
          res.status(err.statusCode).json({
            ok: false,
            code: err.code,
            error: err.message,
          });
          return;
        }
        console.error("[ZIP Upload Error]", err);
        res.status(500).json({
          ok: false,
          error: "Failed to unpack and store ZIP archive",
        });
      }
    });
  });

  // GET /api/zip-uploads — list stored ZIP archives
  router.get("/", async (_req, res) => {
    try {
      const archives = await listZipArchives(config.rootDir);
      res.status(200).json({ ok: true, archives });
    } catch (err) {
      console.error("[ZIP List Error]", err);
      res.status(500).json({ ok: false, error: "Failed to list ZIP archives" });
    }
  });

  // GET /api/zip-uploads/:id — get archive manifest
  router.get("/:id", async (req, res) => {
    const id = req.params.id;
    if (!isValidZipId(id)) {
      res.status(400).json({ ok: false, error: "Invalid archive identifier" });
      return;
    }

    try {
      const manifest = await getZipManifest(id, config.rootDir);
      if (!manifest) {
        res.status(404).json({ ok: false, error: "ZIP archive not found" });
        return;
      }
      res.status(200).json({ ok: true, archive: manifest });
    } catch (err) {
      if (err instanceof ZipSecurityError) {
        res.status(err.statusCode).json({ ok: false, error: err.message });
        return;
      }
      res.status(500).json({ ok: false, error: "Failed to retrieve archive manifest" });
    }
  });

  // Shared handler for serving an extracted entry safely with nosniff + sandbox CSP
  const handleServeEntry = async (
    req: Request,
    res: Response,
    rawRelPath: string
  ) => {
    const id = req.params.id;
    if (!isValidZipId(id)) {
      res.status(400).json({ ok: false, error: "Invalid archive identifier" });
      return;
    }

    let decodedRelPath = rawRelPath;
    try {
      decodedRelPath = decodeURIComponent(rawRelPath);
    } catch {
      res.status(400).json({ ok: false, error: "Malformed file path encoding" });
      return;
    }

    try {
      const entry = await readZipEntry(id, decodedRelPath, config.rootDir);
      if (!entry) {
        res.status(404).json({ ok: false, error: "File not found in archive" });
        return;
      }

      const safeDownloadName = path.basename(entry.safeRelPath).replace(/["\r\n]/g, "_");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; sandbox"
      );
      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeDownloadName}"`
      );
      res.setHeader("Content-Length", String(entry.buffer.length));
      res.status(200).send(entry.buffer);
    } catch (err) {
      if (err instanceof ZipSecurityError) {
        res.status(err.statusCode).json({
          ok: false,
          code: err.code,
          error: err.message,
        });
        return;
      }
      console.error("[ZIP Entry Read Error]", err);
      res.status(500).json({ ok: false, error: "Failed to read archive entry" });
    }
  };

  // GET /api/zip-uploads/:id/files/* (wildcard file read)
  router.get("/:id/files/*", async (req, res) => {
    const rawRelPath = (req.params as Record<string, string>)[0] || "";
    await handleServeEntry(req, res, rawRelPath);
  });

  // GET /api/zip-uploads/:id/file?path=... (query param file read)
  router.get("/:id/file", async (req, res) => {
    const rawRelPath = typeof req.query.path === "string" ? req.query.path : "";
    await handleServeEntry(req, res, rawRelPath);
  });

  // DELETE /api/zip-uploads/:id — remove archive from uploaded-zips/<id>/
  router.delete("/:id", async (req, res) => {
    const id = req.params.id;
    if (!isValidZipId(id)) {
      res.status(400).json({ ok: false, error: "Invalid archive identifier" });
      return;
    }

    try {
      const deleted = await deleteZipArchive(id, config.rootDir);
      if (!deleted) {
        res.status(404).json({ ok: false, error: "ZIP archive not found" });
        return;
      }
      res.status(200).json({ ok: true, id });
    } catch (err) {
      if (err instanceof ZipSecurityError) {
        res.status(err.statusCode).json({ ok: false, error: err.message });
        return;
      }
      console.error("[ZIP Delete Error]", err);
      res.status(500).json({ ok: false, error: "Failed to delete ZIP archive" });
    }
  });

  return router;
}
