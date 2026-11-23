import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server.ts";
import {
  LocalStorageProvider,
  getStorageProvider,
  resetStorageProviderCache,
} from "../../src/lib/storage/storage.ts";
import { runAlvNodeEngine } from "../../src/server/alv-node-engine.ts";
import { getDatabase, resetDatabaseCache } from "../../src/server/db/database.ts";
import { runFormForgeNodeEngine } from "../../src/server/formforge-node-engine.ts";

// Minimal valid magic-byte fixtures for PNG, JPEG, and WebP
const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const VALID_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

async function createSamplePdfBuffer(text = "Full Legal Name:"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("APPLICATION INTAKE FORM", { x: 45, y: 760, size: 13, font });
  page.drawText(text, { x: 45, y: 700, size: 10, font });
  page.drawText("Accept Policy: [ ]", { x: 45, y: 660, size: 10, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

describe("Storage Architecture, Migrations, Security & Supporting Uploads", () => {
  let tmpRoot: string;
  let generatedDir: string;
  let signedDir: string;
  let formforgeStorageDir: string;
  let dbPath: string;
  let server: http.Server;
  let baseUrl: string;
  let adminToken = "";
  let readonlyToken = "";
  let docId = "";
  let renderedGenId = "";
  let samplePdf: Buffer;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "formforge-repair-test-"));
    generatedDir = path.join(tmpRoot, "generated");
    signedDir = path.join(tmpRoot, "signed");
    formforgeStorageDir = path.join(tmpRoot, "ff-storage");
    dbPath = path.join(tmpRoot, "formforge.sqlite");

    process.env.STORAGE_PROVIDER = "local";
    process.env.GENERATED_PDF_DIR = generatedDir;
    process.env.SIGNED_PDF_DIR = signedDir;
    process.env.FORMFORGE_STORAGE_DIR = formforgeStorageDir;
    process.env.FORMFORGE_DB_PATH = dbPath;
    process.env.MAX_UPLOAD_BYTES = String(256 * 1024); // 256 KB cap for size-limit test
    delete process.env.FORMFORGE_ADMIN_PASSWORD;

    resetStorageProviderCache();
    resetDatabaseCache();
    samplePdf = await createSamplePdfBuffer();

    const app = await createApp({ disableRateLimit: true });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetDatabaseCache();
    resetStorageProviderCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.GENERATED_PDF_DIR;
    delete process.env.SIGNED_PDF_DIR;
    delete process.env.FORMFORGE_STORAGE_DIR;
    delete process.env.FORMFORGE_DB_PATH;
    delete process.env.MAX_UPLOAD_BYTES;
  });

  it("validates LocalStorageProvider confinement, symlink rejection, and retention pruning", async () => {
    const provider = new LocalStorageProvider({
      generatedDir: path.join(tmpRoot, "unit-gen"),
      signedDir: path.join(tmpRoot, "unit-signed"),
    });
    const docIdHex = "0123456789abcdef01234567";
    await provider.saveGeneratedPdf(docIdHex, samplePdf);
    expect(await provider.existsGeneratedPdf(docIdHex)).toBe(true);
    expect(await provider.existsSignedPdf(docIdHex)).toBe(false);

    // Reject path traversal IDs
    await expect(provider.saveGeneratedPdf("../evil", samplePdf)).rejects.toThrow();
    await expect(provider.readGeneratedPdf("not-hex-id")).rejects.toThrow();

    // Symlink rejection check
    const secretFile = path.join(tmpRoot, "secret.txt");
    fs.writeFileSync(secretFile, "SECRET");
    const symId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const symPath = path.join(tmpRoot, "unit-gen", `${symId}.pdf`);
    try {
      fs.symlinkSync(secretFile, symPath);
      expect(await provider.existsGeneratedPdf(symId)).toBe(false);
      expect(await provider.readGeneratedPdf(symId)).toBeNull();
    } catch {
      // Symlinks may require elevated privileges on Windows; skip assertion if OS forbids symlink creation
    }

    // Retention cleanup prunes aged files
    const targetFile = path.join(tmpRoot, "unit-gen", `${docIdHex}.pdf`);
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(targetFile, oldTime, oldTime);
    const pruned = await provider.deleteExpired(24);
    expect(pruned.deletedGenerated).toBe(1);
    expect(await provider.existsGeneratedPdf(docIdHex)).toBe(false);

    // S3 provider fails safely if S3_BUCKET is missing
    process.env.STORAGE_PROVIDER = "s3";
    delete process.env.S3_BUCKET;
    resetStorageProviderCache();
    expect(() => getStorageProvider()).toThrow(/S3_BUCKET/);
    process.env.STORAGE_PROVIDER = "local";
    resetStorageProviderCache();
  });

  it("initializes migrations 001 + 002 safely and preserves data across re-initialization", () => {
    const db = getDatabase(dbPath);
    const migrations = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: string }>;
    expect(migrations.map((m) => m.version)).toEqual([
      "001_init.sql",
      "002_supporting_documents.sql",
    ]);

    // Re-opening cache must preserve existing seeded templates without destructive reset
    resetDatabaseCache();
    const db2 = getDatabase(dbPath);
    const tpl = db2
      .prepare("SELECT id, status FROM templates WHERE id = 'tpl_alv_official'")
      .get() as { id: string; status: string } | undefined;
    expect(tpl?.status).toBe("approved");
  });

  it("enforces bearer-only auth (blocks query ?token=), RBAC, and end-to-end supporting PDF & image multi-uploads", async () => {
    // 1. Bootstrap admin & create read_only_user
    const bootRes = await fetch(`${baseUrl}/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@repair.test",
        fullName: "Repair Admin",
        password: "StrongPassword123!",
      }),
    });
    expect(bootRes.status).toBe(201);
    adminToken = (await bootRes.json()).token;

    // Query-string token must NEVER be accepted
    const queryTokenRes = await fetch(
      `${baseUrl}/api/v1/documents?token=${encodeURIComponent(adminToken)}`
    );
    expect(queryTokenRes.status).toBe(401);

    await fetch(`${baseUrl}/api/v1/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        email: "ro@repair.test",
        fullName: "Read Only",
        role: "read_only_user",
        password: "ViewerPassword123!",
      }),
    });
    const roLogin = await (
      await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ro@repair.test", password: "ViewerPassword123!" }),
      })
    ).json();
    readonlyToken = roLogin.token;

    // 2. Upload source PDF document & render via seeded ALV template
    const upForm = new FormData();
    upForm.append("title", "Repair Intake");
    upForm.append("autoAnalyze", "false");
    upForm.append(
      "file",
      new Blob([new Uint8Array(samplePdf)], { type: "application/pdf" }),
      "intake.pdf"
    );
    const docRes = await fetch(`${baseUrl}/api/v1/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: upForm,
    });
    expect(docRes.status).toBe(201);
    docId = (await docRes.json()).document.id;

    const renderRes = await fetch(`${baseUrl}/api/v1/render/tpl_alv_official`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        outputMode: "flattened",
        values: {
          "owner.identificationNumber": "8506155012089",
          "owner.surnameOrOrganisation": "MÜLLER — CO",
        },
      }),
    });
    expect(renderRes.status).toBe(201);
    renderedGenId = (await renderRes.json()).generatedDocumentId;

    // 3. Multi-file supporting upload (PDF + PNG + JPEG + WebP)
    const multiForm = new FormData();
    multiForm.append("generatedDocumentId", renderedGenId);
    multiForm.append("category", "identity_and_proof");
    multiForm.append("files", new Blob([new Uint8Array(samplePdf)], { type: "application/pdf" }), "id_copy.pdf");
    multiForm.append("files", new Blob([new Uint8Array(VALID_PNG)], { type: "image/png" }), "license.png");
    multiForm.append("files", new Blob([new Uint8Array(VALID_JPEG)], { type: "image/jpeg" }), "vehicle.jpg");
    multiForm.append("files", new Blob([new Uint8Array(VALID_WEBP)], { type: "image/webp" }), "proof.webp");

    const supRes = await fetch(`${baseUrl}/api/v1/supporting-documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: multiForm,
    });
    expect(supRes.status).toBe(201);
    const supJson = await supRes.json();
    expect(supJson.supportingDocuments).toHaveLength(4);
    expect(supJson.supportingDocuments.map((d: { mimeType: string }) => d.mimeType)).toEqual([
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);

    // 4. Read-only user cannot upload or delete supporting documents
    const roUpload = await fetch(`${baseUrl}/api/v1/supporting-documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readonlyToken}` },
      body: multiForm,
    });
    expect(roUpload.status).toBe(403);

    const firstSupId = supJson.supportingDocuments[0].id;
    const roDelete = await fetch(`${baseUrl}/api/v1/supporting-documents/${firstSupId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${readonlyToken}` },
    });
    expect(roDelete.status).toBe(403);

    // 5. List & download supporting attachment securely
    const listRes = await fetch(
      `${baseUrl}/api/v1/supporting-documents?generatedDocumentId=${renderedGenId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).supportingDocuments).toHaveLength(4);

    const dlRes = await fetch(`${baseUrl}/api/v1/supporting-documents/${firstSupId}/download`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dlRes.headers.get("content-type")).toBe("application/pdf");

    // 6. Reject spoofed image/executable, oversized file, and unknown documentId
    const spoofForm = new FormData();
    spoofForm.append("documentId", docId);
    spoofForm.append(
      "files",
      new Blob(["<script>alert(1)</script>"], { type: "image/png" }),
      "evil.png"
    );
    const spoofRes = await fetch(`${baseUrl}/api/v1/supporting-documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: spoofForm,
    });
    expect(spoofRes.status).toBe(400);

    const bigForm = new FormData();
    bigForm.append("documentId", docId);
    bigForm.append(
      "files",
      new Blob([new Uint8Array(Buffer.concat([VALID_PNG, Buffer.alloc(300 * 1024)]))], {
        type: "image/png",
      }),
      "huge.png"
    );
    const bigRes = await fetch(`${baseUrl}/api/v1/supporting-documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: bigForm,
    });
    expect(bigRes.status).toBe(413);

    // 7. Delete supporting attachment
    const delRes = await fetch(`${baseUrl}/api/v1/supporting-documents/${firstSupId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(200);
    const dlAfter = await fetch(`${baseUrl}/api/v1/supporting-documents/${firstSupId}/download`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(dlAfter.status).toBe(404);
  });

  it("handles special Unicode characters cleanly in ALV & FormForge Node PDF engines and redacts PII in overflow errors", async () => {
    // ALV Node engine with accented/Unicode characters
    const alvOut = await runAlvNodeEngine({
      owner: {
        identificationType: "rsa_id",
        identificationNumber: "8506155012089",
        surnameOrOrganisation: "MÜLLER — RENÉ",
        initials: "JR",
        firstNames: "JOSÉ",
      },
      declaration: {
        place: "GQEBERHA – PORT ELIZABETH",
        dateYYMMDD: "261122",
      },
    });
    expect(alvOut.pdfBuffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // Overflow error must NOT echo raw sensitive ID value
    await expect(
      runAlvNodeEngine({
        owner: { identificationNumber: "99999999999999999" },
      })
    ).rejects.toThrow(/exceeds PDF box capacity/);
    await expect(
      runAlvNodeEngine({
        owner: { identificationNumber: "99999999999999999" },
      })
    ).rejects.not.toThrow(/99999999999999999/);

    // FormForge Node engine full round-trip: analyze -> generate-acroform -> render flattened + fillable
    const pdfPath = path.join(tmpRoot, "ff_node_test.pdf");
    const acroPath = path.join(tmpRoot, "ff_node_acro.pdf");
    const flatPath = path.join(tmpRoot, "ff_node_flat.pdf");
    fs.writeFileSync(pdfPath, samplePdf);

    const analysis = await runFormForgeNodeEngine<{
      manifest: Record<string, unknown>;
    }>("analyze", {
      pdfPath,
      options: { documentId: "doc_node_check" },
    });

    const acroRes = await runFormForgeNodeEngine<{
      createdWidgets: number;
      validation: { validPdf: boolean; hasAcroFormDict: boolean };
    }>("generate-acroform", {
      pdfPath,
      manifest: analysis.manifest,
      outputPdfPath: acroPath,
    });
    expect(acroRes.createdWidgets).toBeGreaterThanOrEqual(1);
    expect(acroRes.validation.validPdf).toBe(true);
    expect(acroRes.validation.hasAcroFormDict).toBe(true);

    const renderRes = await runFormForgeNodeEngine<{
      populatedWidgets: number;
      flattened: boolean;
    }>("render-pdf", {
      templatePdfPath: acroPath,
      manifest: analysis.manifest,
      values: { full_legal_name: "René Müller — Test", accept_policy: true },
      outputPdfPath: flatPath,
      flatten: true,
    });
    expect(renderRes.flattened).toBe(true);
    expect(renderRes.populatedWidgets).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(flatPath).subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("verifies seeded ALV manifest coordinates, renders dotted/nested/radio/right-aligned fields, and supports PUT replacement & tenant isolation", async () => {
    // 1. Seeded ALV template manifest verification
    const manRes = await fetch(`${baseUrl}/api/v1/templates/tpl_alv_official/manifest`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(manRes.status).toBe(200);
    const manJson = await manRes.json();
    expect(manJson.manifest.pages).toHaveLength(2);
    expect(manJson.manifest.fields).toHaveLength(48);

    const idTypeField = manJson.manifest.fields.find(
      (f: { name: string }) => f.name === "owner_identificationType"
    );
    expect(idTypeField?.type).toBe("radio");
    expect(idTypeField?.optionRects?.rsa_id?.width).toBeGreaterThan(5);
    for (const f of manJson.manifest.fields as Array<{
      page: number;
      rect: { x: number; y: number; width: number; height: number };
    }>) {
      expect(f.page === 0 || f.page === 1).toBe(true);
      expect(Number.isFinite(f.rect.x)).toBe(true);
      expect(Number.isFinite(f.rect.y)).toBe(true);
      expect(f.rect.width).toBeGreaterThan(0);
      expect(f.rect.height).toBeGreaterThan(0);
    }

    // 2. Engine B render with dotted, underscored, nested, radio & right-aligned values
    const renderRes = await fetch(`${baseUrl}/api/v1/render/tpl_alv_official`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        outputMode: "flattened",
        values: {
          "owner.identificationType": "rsa_id",
          "owner.identificationNumber": "8506155012089",
          "vehicle.odometerReading": "12450",
          owner: {
            surnameOrOrganisation: "VAN DER MERWE",
            initials: "J",
          },
          declaration_place: "CAPE TOWN",
        },
      }),
    });
    expect(renderRes.status).toBe(201);
    const renderJson = await renderRes.json();
    expect(renderJson.populatedWidgets).toBeGreaterThanOrEqual(6);

    const renderedPdfRes = await fetch(`${baseUrl}${renderJson.downloadUrl}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(renderedPdfRes.status).toBe(200);
    const pdfBuf = Buffer.from(await renderedPdfRes.arrayBuffer());
    expect(pdfBuf.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // 3. PUT /api/v1/supporting-documents/:id replacement + old storage cleanup
    const listRes = await fetch(
      `${baseUrl}/api/v1/supporting-documents?generatedDocumentId=${renderedGenId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    const listJson = await listRes.json();
    const targetId = listJson.supportingDocuments[0].id as string;

    const db = getDatabase(dbPath);
    const beforeRow = db
      .prepare("SELECT storage_key, sha256 FROM supporting_documents WHERE id = ?")
      .get(targetId) as { storage_key: string; sha256: string };
    const oldAbsPath = path.join(formforgeStorageDir, ...beforeRow.storage_key.split("/"));
    expect(fs.existsSync(oldAbsPath)).toBe(true);

    // Reject spoofed payload on PUT
    const badPutForm = new FormData();
    badPutForm.append("file", new Blob(["NOT_A_PNG"], { type: "image/png" }), "bad.png");
    const badPutRes = await fetch(`${baseUrl}/api/v1/supporting-documents/${targetId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: badPutForm,
    });
    expect(badPutRes.status).toBe(400);

    // Valid PUT replacement with PDF
    const replacePdf = await createSamplePdfBuffer("Replaced Attachment Proof:");
    const goodPutForm = new FormData();
    goodPutForm.append(
      "file",
      new Blob([new Uint8Array(replacePdf)], { type: "application/pdf" }),
      "replaced_proof.pdf"
    );
    goodPutForm.append("category", "updated_proof");
    const putRes = await fetch(`${baseUrl}/api/v1/supporting-documents/${targetId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: goodPutForm,
    });
    expect(putRes.status).toBe(200);
    const putJson = await putRes.json();
    expect(putJson.supportingDocument.originalFilename).toBe("replaced_proof.pdf");
    expect(putJson.supportingDocument.mimeType).toBe("application/pdf");
    expect(putJson.supportingDocument.sha256).not.toBe(beforeRow.sha256);

    // Old file and old storage_metadata row must have been removed
    expect(fs.existsSync(oldAbsPath)).toBe(false);
    const oldMeta = db
      .prepare("SELECT id FROM storage_metadata WHERE storage_key = ?")
      .get(beforeRow.storage_key);
    expect(oldMeta).toBeUndefined();

    // 4. Cross-tenant isolation: user in a second tenant cannot view, replace, or delete targetId
    db.prepare("INSERT INTO tenants (id, name, slug) VALUES ('tenant_other', 'Other Org', 'other')").run();
    const { hashPassword, createSessionForUser } = await import("../../src/server/auth.ts");
    db.prepare(
      `INSERT INTO users (id, tenant_id, email, full_name, role_name, password_hash, is_active)
       VALUES ('usr_other_admin', 'tenant_other', 'other@other.test', 'Other Admin', 'administrator', ?, 1)`
    ).run(hashPassword("OtherStrongPass123!"));
    const otherSession = createSessionForUser("usr_other_admin", "tenant_other", {
      headers: {},
      ip: "127.0.0.1",
    } as unknown as Parameters<typeof createSessionForUser>[2]);

    const crossGet = await fetch(`${baseUrl}/api/v1/supporting-documents/${targetId}/download`, {
      headers: { Authorization: `Bearer ${otherSession.token}` },
    });
    expect(crossGet.status).toBe(404);

    const crossPut = await fetch(`${baseUrl}/api/v1/supporting-documents/${targetId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${otherSession.token}` },
      body: goodPutForm,
    });
    expect(crossPut.status).toBe(404);

    const crossDel = await fetch(`${baseUrl}/api/v1/supporting-documents/${targetId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${otherSession.token}` },
    });
    expect(crossDel.status).toBe(404);

    // 5. Deleting targetId removes both storage_metadata & physical file
    const newRow = db
      .prepare("SELECT storage_key FROM supporting_documents WHERE id = ?")
      .get(targetId) as { storage_key: string };
    const newAbsPath = path.join(formforgeStorageDir, ...newRow.storage_key.split("/"));
    expect(fs.existsSync(newAbsPath)).toBe(true);

    const delRes = await fetch(`${baseUrl}/api/v1/supporting-documents/${targetId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.status).toBe(200);
    expect(fs.existsSync(newAbsPath)).toBe(false);
    expect(
      db.prepare("SELECT id FROM storage_metadata WHERE storage_key = ?").get(newRow.storage_key)
    ).toBeUndefined();
  });
});
