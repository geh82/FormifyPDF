import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { createZipUploadRouter } from "./server/zipRoutes.ts";
import type { ZipRouterConfig } from "./server/zipRoutes.ts";
import { getStorageProvider } from "./src/lib/storage/storage.ts";
import { getDatabase } from "./src/server/db/database.ts";
import { createApiRouter } from "./src/server/routes.ts";
import type { ApiRouterConfig } from "./src/server/routes.ts";
import { createV1ApiRouter, purgeExpiredDocuments } from "./src/server/v1Routes.ts";

dotenv.config();

export interface AppConfig extends ApiRouterConfig {
  zipOptions?: ZipRouterConfig;
}

export async function createApp(apiConfig: AppConfig = {}) {
  // Initialize SQLite relational schema & baseline RBAC / ALV integration seed
  getDatabase();

  const app = express();
  app.disable("x-powered-by");

  // Global baseline security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()"
    );
    next();
  });

  app.use(express.json({ limit: "4mb" }));

  // Mount FormForge AI v1 REST API
  app.use(
    "/api/v1",
    createV1ApiRouter({
      disableRateLimit: apiConfig.disableRateLimit,
    })
  );

  // Mount ZIP upload & workspace archive routes before generic /api fallback
  app.use(
    "/api/zip-uploads",
    createZipUploadRouter({
      ...apiConfig.zipOptions,
      disableRateLimit:
        apiConfig.zipOptions?.disableRateLimit ?? apiConfig.disableRateLimit,
    })
  );

  // Mount ALV Form Online API routes
  app.use("/api", createApiRouter(apiConfig));

  const isProd = process.env.NODE_ENV === "production";
  if (!isProd && process.env.VITEST !== "true") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (isProd) {
    const distDir = path.resolve(process.cwd(), "dist");
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get("*", (_req, res) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
    }
  }

  return app;
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isEntryPoint) {
  const port = Number(process.env.PORT || "3000");
  const retentionHours = Math.max(
    1,
    Number(process.env.PDF_RETENTION_HOURS || "24")
  );

  const app = await createApp();

  // Periodic POPIA & FormForge retention cleanup
  const storage = getStorageProvider();
  setInterval(() => {
    storage.deleteExpired(retentionHours).catch((err) => {
      console.error("[Retention Cleanup Error]", err);
    });
    try {
      purgeExpiredDocuments("tenant_default");
    } catch (err) {
      console.error("[FormForge Retention Error]", err);
    }
  }, 60 * 60 * 1000).unref();

  app.listen(port, "0.0.0.0", () => {
    console.log(`FormForge AI & ALV Form Online listening on http://0.0.0.0:${port}`);
  });
}
