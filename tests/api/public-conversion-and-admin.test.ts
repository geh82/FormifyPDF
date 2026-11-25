import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server.ts";
import { resetDatabaseCache } from "../../src/server/db/database.ts";

describe("Public Conversion Flow, Toggle Enforcement (403) & Pricing Tier Validation (400)", () => {
  let tmpRoot: string;
  let server: http.Server | undefined;
  let baseUrl: string;
  let samplePdfBuffer: Buffer;
  let sampleZipBuffer: Buffer;
  let adminToken = "";

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "formifypdf-public-test-"));
    process.env.FORMIFYPDF_STORAGE_DIR = path.join(tmpRoot, "storage");
    process.env.FORMIFYPDF_DB_PATH = path.join(tmpRoot, "formifypdf_public.db");
    process.env.UPLOADED_ZIPS_DIR = path.join(tmpRoot, "uploaded-zips");
    delete process.env.FORMIFYPDF_ADMIN_PASSWORD;
    resetDatabaseCache();

    const doc = await PDFDocument.create();
    const p = doc.addPage([595.28, 841.89]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    p.drawText("PUBLIC CLIENT FORM", { x: 45, y: 770, size: 12, font });
    p.drawText("Applicant Name:", { x: 45, y: 720, size: 10, font });
    p.drawLine({
      start: { x: 150, y: 717 },
      end: { x: 420, y: 717 },
      thickness: 1,
      color: rgb(0, 0, 0),
    });
    samplePdfBuffer = Buffer.from(await doc.save({ useObjectStreams: false }));

    const zip = new JSZip();
    zip.file("forms/applicant-form.pdf", samplePdfBuffer);
    zip.file("notes/readme.txt", "Form bundle readme");
    sampleZipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    const app = await createApp({ disableRateLimit: true });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server!.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind port");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const bootRes = await fetch(`${baseUrl}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@formifypdf.test",
        fullName: "Admin User",
        password: "AdminPassword123!",
      }),
    });
    const bootJson = (await bootRes.json()) as { token: string };
    adminToken = bootJson.token;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    resetDatabaseCache();
    delete process.env.FORMIFYPDF_STORAGE_DIR;
    delete process.env.FORMIFYPDF_DB_PATH;
    delete process.env.UPLOADED_ZIPS_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("enforces admin auth on /api/v1/admin, 400 validation on invalid pricing tiers, and exposes active tiers on /api/v1/public/config", async () => {
    const unauthAdmin = await fetch(`${baseUrl}/api/v1/admin`);
    expect(unauthAdmin.status).toBe(401);

    const badTierRes = await fetch(`${baseUrl}/api/v1/admin/pricing-tiers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "",
        maxPages: -5,
        priceCents: -100,
      }),
    });
    expect(badTierRes.status).toBe(400);

    const addTierRes = await fetch(`${baseUrl}/api/v1/admin/pricing-tiers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Up to 50 pages",
        maxPages: 50,
        priceCents: 799,
        description: "Up to 50 pages",
      }),
    });
    expect(addTierRes.status).toBe(200);

    const pubConfigRes = await fetch(`${baseUrl}/api/v1/public/config`);
    expect(pubConfigRes.status).toBe(200);
    const pubConfig = (await pubConfigRes.json()) as {
      ok: boolean;
      pricingTiers: Array<{ max_pages: number; price_cents: number }>;
    };
    expect(pubConfig.ok).toBe(true);
    expect(pubConfig.pricingTiers.some((t) => t.max_pages === 50 && t.price_cents === 799)).toBe(
      true
    );
  });

  it("enforces 403 when feature toggles are disabled and runs full public convert -> preview -> checkout -> unlocked PDF & ZIP download", async () => {
    // By default in migration 003, topTierZipUpload is 0 -> 403
    const zipFormBlocked = new FormData();
    zipFormBlocked.append(
      "file",
      new Blob([new Uint8Array(sampleZipBuffer)], { type: "application/zip" }),
      "bundle.zip"
    );
    const blockedZipUpload = await fetch(`${baseUrl}/api/v1/public/zip-upload`, {
      method: "POST",
      body: zipFormBlocked,
    });
    expect(blockedZipUpload.status).toBe(403);

    // Disable normalUpload and verify 403 on public PDF upload
    await fetch(`${baseUrl}/api/v1/admin/toggles`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        normalUpload: false,
        normalDownload: true,
        topTierZipUpload: false,
        topTierZipDownload: false,
      }),
    });

    const pdfFormBlocked = new FormData();
    pdfFormBlocked.append(
      "file",
      new Blob([new Uint8Array(samplePdfBuffer)], { type: "application/pdf" }),
      "blocked.pdf"
    );
    const blockedPdfRes = await fetch(`${baseUrl}/api/v1/public/documents`, {
      method: "POST",
      body: pdfFormBlocked,
    });
    expect(blockedPdfRes.status).toBe(403);

    // Enable all toggles so client PDF & ZIP upload/download work end-to-end
    await fetch(`${baseUrl}/api/v1/admin/toggles`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        normalUpload: true,
        normalDownload: true,
        topTierZipUpload: true,
        topTierZipDownload: true,
      }),
    });

    const zipForm = new FormData();
    zipForm.append(
      "file",
      new Blob([new Uint8Array(sampleZipBuffer)], { type: "application/zip" }),
      "client-bundle.zip"
    );
    const zipUpRes = await fetch(`${baseUrl}/api/v1/public/zip-upload`, {
      method: "POST",
      body: zipForm,
    });
    expect(zipUpRes.status).toBe(201);
    const uploaded = (await zipUpRes.json()) as {
      ok: boolean;
      conversionId: string;
      accessToken: string;
    };
    expect(uploaded.ok).toBe(true);

    // Wait for analysis job completion
    let jobStatus = "queued";
    let jobError: string | null = null;
    for (let i = 0; i < 80; i++) {
      const statusRes = await fetch(
        `${baseUrl}/api/v1/public/conversions/${uploaded.conversionId}`,
        { headers: { "x-conversion-token": uploaded.accessToken } }
      );
      const statusJson = (await statusRes.json()) as {
        conversion: {
          job: { status: string; error_message?: string | null } | null;
          paid: boolean;
          pageCount: number;
        };
        matchedTier: { id: string; price_cents: number };
      };
      jobStatus = statusJson.conversion.job?.status || "queued";
      jobError = statusJson.conversion.job?.error_message || null;
      if (jobStatus === "completed") {
        expect(statusJson.conversion.paid).toBe(false);
        expect(statusJson.matchedTier.price_cents).toBe(299);
        break;
      }
      if (jobStatus === "failed") {
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect({ jobStatus, jobError }).toEqual({ jobStatus: "completed", jobError: null });

    // Preview is allowed before checkout
    const previewRes = await fetch(
      `${baseUrl}/api/v1/public/conversions/${uploaded.conversionId}/preview`,
      { headers: { "x-conversion-token": uploaded.accessToken } }
    );
    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("content-type")).toContain("application/pdf");

    // Downloads are locked (402) before checkout
    const prePayPdfDl = await fetch(
      `${baseUrl}/api/v1/public/conversions/${uploaded.conversionId}/download`,
      { headers: { "x-conversion-token": uploaded.accessToken } }
    );
    expect(prePayPdfDl.status).toBe(402);

    const prePayZipDl = await fetch(
      `${baseUrl}/api/v1/public/conversions/${uploaded.conversionId}/zip-download`,
      { headers: { "x-conversion-token": uploaded.accessToken } }
    );
    expect(prePayZipDl.status).toBe(402);

    // Confirm checkout for matched tier
    const checkoutRes = await fetch(
      `${baseUrl}/api/v1/public/conversions/${uploaded.conversionId}/checkout`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-conversion-token": uploaded.accessToken,
        },
        body: JSON.stringify({ tierId: "tier_15_299" }),
      }
    );
    expect(checkoutRes.status).toBe(200);

    // Both PDF and ZIP downloads succeed after payment
    const paidPdfDl = await fetch(
      `${baseUrl}/api/v1/public/conversions/${uploaded.conversionId}/download`,
      { headers: { "x-conversion-token": uploaded.accessToken } }
    );
    expect(paidPdfDl.status).toBe(200);
    expect(paidPdfDl.headers.get("content-type")).toContain("application/pdf");

    const paidZipDl = await fetch(
      `${baseUrl}/api/v1/public/conversions/${uploaded.conversionId}/zip-download`,
      { headers: { "x-conversion-token": uploaded.accessToken } }
    );
    expect(paidZipDl.status).toBe(200);
    expect(paidZipDl.headers.get("content-type")).toContain("application/zip");
    const outZipBytes = new Uint8Array(await paidZipDl.arrayBuffer());
    const parsedOutZip = await JSZip.loadAsync(outZipBytes);
    expect(Object.keys(parsedOutZip.files).some((k) => k.endsWith("-fillable-acroform.pdf"))).toBe(
      true
    );
    expect(Object.keys(parsedOutZip.files)).toContain("notes/readme.txt");
  });
});
