import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server.ts";
import { resetDatabaseCache } from "../../src/server/db/database.ts";

describe("FormifyPDF /api/v1 REST, RBAC, Conversion & Engine B Lifecycle", () => {
  let tmpRoot: string;
  let server: http.Server | undefined;
  let baseUrl: string;
  let samplePdfBuffer: Buffer;
  let adminToken = "";
  let readonlyToken = "";
  let apiKeySecret = "";
  let uploadedDocId = "";
  let createdTemplateId = "";
  let renderedGenId = "";

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "formifypdf-v1-test-"));
    process.env.FORMIFYPDF_STORAGE_DIR = path.join(tmpRoot, "storage");
    process.env.FORMIFYPDF_DB_PATH = path.join(tmpRoot, "formifypdf_test.db");
    delete process.env.FORMIFYPDF_ADMIN_PASSWORD;
    resetDatabaseCache();

    // Generate clean 1-page unfamiliar digital PDF in tmpRoot via pdf-lib
    const doc = await PDFDocument.create();
    const p = doc.addPage([595.28, 841.89]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    p.drawText("CLIENT INTAKE FORM - PLEASE COMPLETE ALL REQUIRED FIELDS BELOW", {
      x: 45,
      y: 841.89 - 70,
      size: 12,
      font,
    });
    p.drawText("Full Legal Name:", { x: 45, y: 841.89 - 120, size: 10, font });
    p.drawLine({
      start: { x: 165, y: 841.89 - 123 },
      end: { x: 450, y: 841.89 - 123 },
      thickness: 1.0,
      color: rgb(0, 0, 0),
    });
    p.drawText("Primary Email Address:", { x: 45, y: 841.89 - 150, size: 10, font });
    p.drawRectangle({
      x: 165,
      y: 841.89 - 156,
      width: 285,
      height: 18,
      borderWidth: 0.8,
      borderColor: rgb(0, 0, 0),
    });
    p.drawText("Accept Policy:", { x: 45, y: 841.89 - 190, size: 10, font });
    p.drawRectangle({
      x: 165,
      y: 841.89 - 191,
      width: 13,
      height: 13,
      borderWidth: 0.8,
      borderColor: rgb(0, 0, 0),
    });

    const pdfPath = path.join(tmpRoot, "contract_intake.pdf");
    samplePdfBuffer = Buffer.from(await doc.save({ useObjectStreams: false }));
    fs.writeFileSync(pdfPath, samplePdfBuffer);

    const app = await createApp({ disableRateLimit: true });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server?.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    resetDatabaseCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.FORMIFYPDF_STORAGE_DIR;
    delete process.env.FORMIFYPDF_DB_PATH;
  });

  it("exposes /api/health and OpenAPI 3.1 spec, requires auth on protected endpoints, and enforces one-time admin bootstrap + RBAC", async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = await healthRes.json();
    expect(healthJson.ok).toBe(true);
    expect(healthJson.status).toBe("healthy");

    const specRes = await fetch(`${baseUrl}/api/v1/openapi.json`);
    expect(specRes.status).toBe(200);
    const spec = await specRes.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/render/{templateId}"]).toBeTruthy();

    // Unauthenticated call must fail with 401
    const unauthRes = await fetch(`${baseUrl}/api/v1/documents`);
    expect(unauthRes.status).toBe(401);

    // Status before bootstrap
    const stBefore = await (await fetch(`${baseUrl}/api/v1/auth/status`)).json();
    expect(stBefore.requiresFirstRunSetup).toBe(true);

    // Claim initial admin
    const bootRes = await fetch(`${baseUrl}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "chief@formifypdf.test",
        fullName: "Chief Architect",
        password: "StrongPassword123!",
        organisationName: "Acme Testing Org",
      }),
    });
    expect(bootRes.status).toBe(201);
    const bootJson = await bootRes.json();
    expect(bootJson.ok).toBe(true);
    expect(bootJson.user.role).toBe("administrator");
    adminToken = bootJson.token;

    // Second bootstrap must fail with 409 lock
    const bootAgain = await fetch(`${baseUrl}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "attacker@evil.test",
        fullName: "Attacker",
        password: "StrongPassword123!",
      }),
    });
    expect(bootAgain.status).toBe(409);

    // Create read_only_user and verify RBAC blocks write + private master AcroForm export
    const roCreate = await fetch(`${baseUrl}/api/v1/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        email: "viewer@formifypdf.test",
        fullName: "Read Only Viewer",
        role: "read_only_user",
        password: "ViewerPassword123!",
      }),
    });
    expect(roCreate.status).toBe(201);

    const roLogin = await (
      await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "viewer@formifypdf.test",
          password: "ViewerPassword123!",
        }),
      })
    ).json();
    readonlyToken = roLogin.token;

    const roForbidden = await fetch(`${baseUrl}/api/v1/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readonlyToken}`,
      },
      body: JSON.stringify({
        email: "denied@formifypdf.test",
        fullName: "Should Fail",
        role: "read_only_user",
        password: "ReadOnlyPassword123!",
      }),
    });
    expect(roForbidden.status).toBe(403);
  });

  it("uploads a PDF, completes async analysis, edits manifest, builds AcroForm, approves template, renders via Engine B with API key, and accepts signed upload", async () => {
    // Upload PDF
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(samplePdfBuffer)], { type: "application/pdf" }),
      "contract_intake.pdf"
    );
    form.append("title", "Client Intake Form");
    form.append("enableOcr", "true");

    const upRes = await fetch(`${baseUrl}/api/v1/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: form,
    });
    expect(upRes.status).toBe(201);
    const upJson = await upRes.json();
    uploadedDocId = upJson.document.id;
    const jobId = upJson.jobId;
    expect(jobId).toBeTruthy();

    // Poll job to completion
    let jobStatus = "queued";
    for (let i = 0; i < 80; i++) {
      const jr = await (
        await fetch(`${baseUrl}/api/v1/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json();
      jobStatus = jr.job.status;
      if (jobStatus === "completed" || jobStatus === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(jobStatus).toBe("completed");

    // Immediately download converted fillable AcroForm PDF and verify valid PDF + AcroForm widgets
    const acroDownloadRes = await fetch(
      `${baseUrl}/api/v1/documents/${uploadedDocId}/acroform-pdf?disposition=attachment`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    expect(acroDownloadRes.status).toBe(200);
    expect(acroDownloadRes.headers.get("content-type")).toBe("application/pdf");
    expect(acroDownloadRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(acroDownloadRes.headers.get("content-disposition")).toContain("attachment");
    expect(acroDownloadRes.headers.get("content-disposition")).toContain("-fillable-acroform.pdf");
    const acroDownloadBuf = Buffer.from(await acroDownloadRes.arrayBuffer());
    expect(acroDownloadBuf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const loadedAcroDoc = await PDFDocument.load(acroDownloadBuf);
    expect(loadedAcroDoc.catalog.lookup(PDFName.of("AcroForm"))).toBeTruthy();
    expect(loadedAcroDoc.getForm().getFields().length).toBeGreaterThanOrEqual(2);

    // Fetch manifest
    const manRes = await (
      await fetch(`${baseUrl}/api/v1/documents/${uploadedDocId}/manifest`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    expect(manRes.manifest.fields.length).toBeGreaterThanOrEqual(2);

    // Edit manifest
    const editedFields = manRes.manifest.fields.map((f: Record<string, unknown>, idx: number) =>
      idx === 0 ? { ...f, label: "Applicant Full Legal Name", required: true, reviewStatus: "accepted" } : f
    );
    const putRes = await fetch(`${baseUrl}/api/v1/documents/${uploadedDocId}/manifest`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ fields: editedFields }),
    });
    expect(putRes.status).toBe(200);

    // Regenerate AcroForm
    const acroRes = await fetch(`${baseUrl}/api/v1/documents/${uploadedDocId}/generate-acroform`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(acroRes.status).toBe(200);
    const acroJson = await acroRes.json();
    expect(acroJson.validation.hasAcroFormDict).toBe(true);

    // Create Template
    const tplRes = await fetch(`${baseUrl}/api/v1/templates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        documentId: uploadedDocId,
        name: "Client Intake Template",
        category: "Onboarding",
        outputPolicy: "flattened",
      }),
    });
    expect(tplRes.status).toBe(201);
    const tplJson = await tplRes.json();
    createdTemplateId = tplJson.templateId;

    // Unapproved template must reject Engine B render
    const unapprovedRender = await fetch(`${baseUrl}/api/v1/render/${createdTemplateId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ values: {} }),
    });
    expect(unapprovedRender.status).toBe(400);

    // Approve Template (requires both structuralVerified and visualVerified)
    const approveRes = await fetch(`${baseUrl}/api/v1/templates/${createdTemplateId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        structuralVerified: true,
        visualVerified: true,
        notes: "Verified test pass",
      }),
    });
    expect(approveRes.status).toBe(200);

    // Create Scoped API Key & render using X-API-Key
    const keyRes = await (
      await fetch(`${baseUrl}/api/v1/api-keys`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          name: "Portal Worker",
          scopes: ["documents:read", "templates:read", "render:write", "signed:write"],
        }),
      })
    ).json();
    apiKeySecret = keyRes.apiKey.secretKey;
    expect(apiKeySecret.startsWith("fpk_")).toBe(true);

    const reqFieldName = editedFields[0].name;
    const renderRes = await fetch(`${baseUrl}/api/v1/render/${createdTemplateId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKeySecret,
      },
      body: JSON.stringify({
        outputMode: "flattened",
        values: { [reqFieldName]: "Jane Doe" },
      }),
    });
    expect(renderRes.status).toBe(201);
    const renderJson = await renderRes.json();
    renderedGenId = renderJson.generatedDocumentId;
    expect(renderJson.reference).toMatch(/^FP-/);

    // Download generated PDF
    const dlRes = await fetch(`${baseUrl}${renderJson.downloadUrl}`, {
      headers: { "X-API-Key": apiKeySecret },
    });
    expect(dlRes.status).toBe(200);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    expect(dlBuf.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // Upload signed return PDF
    const signedForm = new FormData();
    signedForm.append(
      "file",
      new Blob([dlBuf], { type: "application/pdf" }),
      "signed_client_intake.pdf"
    );
    const signedRes = await fetch(`${baseUrl}/api/v1/rendered/${renderedGenId}/upload-signed`, {
      method: "POST",
      headers: { "X-API-Key": apiKeySecret },
      body: signedForm,
    });
    expect(signedRes.status).toBe(201);
    const tplRender = await fetch(`${baseUrl}/api/v1/render/${createdTemplateId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        outputMode: "flattened",
        values: {
          full_legal_name: "Jane Doe",
        },
      }),
    });
    expect(tplRender.status).toBe(201);
  }, 45000);
});
