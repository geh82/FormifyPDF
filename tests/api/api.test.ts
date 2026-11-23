import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server.ts";
import { resetStorageProviderCache } from "../../src/lib/storage/storage.ts";

function buildValidPayload() {
  return {
    owner: {
      identificationType: "rsa_id",
      identificationNumber: "8506155012089",
      countryOfIssue: "",
      surnameOrOrganisation: "VAN DER MERWE",
      initials: "JP",
      firstNames: "JOHANNES PETRUS",
      email: "jp.vdmerwe@example.co.za",
      homePhoneCode: "011",
      homePhoneNumber: "4401234",
      dayPhoneCode: "011",
      dayPhoneNumber: "8805678",
      faxCode: "",
      faxNumber: "",
      cellphone: "0825551234",
    },
    postalAddress: {
      line1: "PO BOX 1420",
      line2: "",
      line3: "",
      suburb: "SANDTON",
      city: "JOHANNESBURG",
      postalCode: "2146",
    },
    streetAddress: {
      line1: "42 RIVONIA ROAD",
      line2: "SUITE 4B",
      line3: "",
      suburb: "SANDHURST",
      city: "JOHANNESBURG",
      postalCode: "2196",
    },
    sameAsPostal: false,
    noticesAddress: "postal",
    hasOrganisationProxy: false,
    hasOrganisationRepresentative: false,
    vehicle: {
      licenceNumber: "GP442198",
      registerNumber: "ABC1234",
      chassisVin: "WBA3A5C50CF256981",
      make: "BMW",
      seriesName: "320I SEDAN AUTO",
      noOdometer: false,
      odometerReading: "124500",
      steeringPosition: "right",
    },
    declaration: {
      signatoryRole: "owner",
      signatoryName: "Johannes Petrus van der Merwe",
      place: "JOHANNESBURG",
      dateYYMMDD: "261122",
      physicalSignatureAcknowledged: true,
    },
  };
}

describe("ALV Form Online API Routes", () => {
  let tmpRoot: string;
  let generatedDir: string;
  let signedDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alv-api-test-"));
    generatedDir = path.join(tmpRoot, "generated");
    signedDir = path.join(tmpRoot, "signed");

    process.env.STORAGE_PROVIDER = "local";
    process.env.GENERATED_PDF_DIR = generatedDir;
    process.env.SIGNED_PDF_DIR = signedDir;
    resetStorageProviderCache();

    const app = await createApp({
      disableRateLimit: true,
      maxUploadBytes: 512 * 1024, // 512 KB for upload limit test
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.GENERATED_PDF_DIR;
    delete process.env.SIGNED_PDF_DIR;
    resetStorageProviderCache();
  });

  beforeEach(() => {
    resetStorageProviderCache();
  });

  it("GET /api/health reports healthy status", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.templateAvailable).toBe(true);
    expect(body.scriptAvailable).toBe(true);
  });

  it("POST /api/generate-pdf generates, downloads as attachment, views inline, and accepts valid signed upload", async () => {
    // 1. Generate PDF
    const genRes = await fetch(`${baseUrl}/api/generate-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildValidPayload()),
    });
    expect(genRes.status).toBe(200);
    const genJson = await genRes.json();
    expect(genJson.ok).toBe(true);
    expect(genJson.id).toMatch(/^[a-f0-9]{24}$/);
    expect(genJson.filename).toBe("ALV_generated.pdf");

    // 2. Download attachment
    const dlRes = await fetch(
      `${baseUrl}/api/download?id=${genJson.id}&type=generated&disposition=attachment`
    );
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("content-type")).toBe("application/pdf");
    expect(dlRes.headers.get("content-disposition")).toContain("attachment");
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    expect(dlBuf.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // 3. Inline view
    const inlineRes = await fetch(
      `${baseUrl}/api/download?id=${genJson.id}&type=generated&disposition=inline`
    );
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.headers.get("content-type")).toBe("application/pdf");
    expect(inlineRes.headers.get("content-disposition")).toContain("inline");

    // 4. Upload valid signed PDF
    const form = new FormData();
    form.append("documentId", genJson.id);
    form.append(
      "file",
      new Blob([dlBuf], { type: "application/pdf" }),
      "ALV_signed_by_owner.pdf"
    );

    const upRes = await fetch(`${baseUrl}/api/upload-signed`, {
      method: "POST",
      body: form,
    });
    expect(upRes.status).toBe(200);
    const upJson = await upRes.json();
    expect(upJson.ok).toBe(true);
    expect(upJson.documentId).toBe(genJson.id);
    expect(upJson.reference).toMatch(/^ALV-[A-F0-9]{8}$/);
    expect(fs.existsSync(path.join(signedDir, `${genJson.id}_signed.pdf`))).toBe(true);
  });

  it("rejects malformed JSON, empty payload, invalid enum, and unexpected fields", async () => {
    const malformed = await fetch(`${baseUrl}/api/generate-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json",
    });
    expect(malformed.status).toBe(400);

    const empty = await fetch(`${baseUrl}/api/generate-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    const badEnumPayload = buildValidPayload();
    (badEnumPayload.owner as Record<string, unknown>).identificationType = "invalid_enum";
    const badEnum = await fetch(`${baseUrl}/api/generate-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(badEnumPayload),
    });
    expect(badEnum.status).toBe(400);

    const extraFieldPayload = { ...buildValidPayload(), maliciousKey: "../../etc/passwd" };
    const extraField = await fetch(`${baseUrl}/api/generate-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(extraFieldPayload),
    });
    expect(extraField.status).toBe(400);
  });

  it("handles invalid download ID, missing download file, and unsupported download type", async () => {
    const badId = await fetch(`${baseUrl}/api/download?id=../secret&type=generated`);
    expect(badId.status).toBe(400);

    const missing = await fetch(
      `${baseUrl}/api/download?id=0123456789abcdef01234567&type=generated`
    );
    expect(missing.status).toBe(404);

    const badType = await fetch(
      `${baseUrl}/api/download?id=0123456789abcdef01234567&type=signed`
    );
    expect(badType.status).toBe(400);
  });

  it("rejects invalid uploads, non-PDF spoofed uploads, and oversized uploads", async () => {
    const genRes = await fetch(`${baseUrl}/api/generate-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildValidPayload()),
    });
    const { id } = await genRes.json();

    // Missing file
    const noFileForm = new FormData();
    noFileForm.append("documentId", id);
    const noFileRes = await fetch(`${baseUrl}/api/upload-signed`, {
      method: "POST",
      body: noFileForm,
    });
    expect(noFileRes.status).toBe(400);

    // Spoofed non-PDF content with .pdf filename
    const fakePdfForm = new FormData();
    fakePdfForm.append("documentId", id);
    fakePdfForm.append(
      "file",
      new Blob(["#!/bin/sh\necho pwned\n"], { type: "application/pdf" }),
      "exploit.pdf"
    );
    const fakeRes = await fetch(`${baseUrl}/api/upload-signed`, {
      method: "POST",
      body: fakePdfForm,
    });
    expect(fakeRes.status).toBe(400);

    // Oversized PDF (> 512 KB configured in this test app)
    const bigBuf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(600 * 1024, 0x41),
      Buffer.from("\n%%EOF\n"),
    ]);
    const bigForm = new FormData();
    bigForm.append("documentId", id);
    bigForm.append(
      "file",
      new Blob([bigBuf], { type: "application/pdf" }),
      "oversized.pdf"
    );
    const bigRes = await fetch(`${baseUrl}/api/upload-signed`, {
      method: "POST",
      body: bigForm,
    });
    expect(bigRes.status).toBe(413);
  });

  it("reports missing Python executable, missing template, and Python processing failures gracefully", async () => {
    // Missing Python executable
    const badPyApp = await createApp({
      disableRateLimit: true,
      pythonOptions: { pythonExecutable: "/nonexistent/python_binary_xyz" },
    });
    const badPyServer = await new Promise<http.Server>((resolve) => {
      const s = badPyApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = (badPyServer.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/generate-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildValidPayload()),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("PYTHON_NOT_FOUND");
    } finally {
      await new Promise<void>((resolve) => badPyServer.close(() => resolve()));
    }

    // Missing PDF template
    const badTplApp = await createApp({
      disableRateLimit: true,
      pythonOptions: { templatePath: path.join(tmpRoot, "missing_template.pdf") },
    });
    const badTplServer = await new Promise<http.Server>((resolve) => {
      const s = badTplApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = (badTplServer.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/generate-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildValidPayload()),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("TEMPLATE_NOT_FOUND");
    } finally {
      await new Promise<void>((resolve) => badTplServer.close(() => resolve()));
    }

    // Python script exits non-zero (processing failure)
    const failingScript = path.join(tmpRoot, "fail_script.py");
    fs.writeFileSync(failingScript, "import sys; sys.stderr.write('Simulated failure'); sys.exit(1)\n");
    const failPyApp = await createApp({
      disableRateLimit: true,
      pythonOptions: { scriptPath: failingScript },
    });
    const failPyServer = await new Promise<http.Server>((resolve) => {
      const s = failPyApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = (failPyServer.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/generate-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildValidPayload()),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("PYTHON_PROCESSING_FAILED");
    } finally {
      await new Promise<void>((resolve) => failPyServer.close(() => resolve()));
    }
  });
});
