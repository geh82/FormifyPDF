import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server.ts";
import { resetStorageProviderCache } from "../../src/lib/storage/storage.ts";
import { resolvePythonExecutable } from "../../src/server/python-runner.ts";

describe("End-to-End Customer ALV Workflow", () => {
  let tmpRoot: string;
  let generatedDir: string;
  let signedDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alv-e2e-"));
    generatedDir = path.join(tmpRoot, "generated");
    signedDir = path.join(tmpRoot, "signed");

    process.env.STORAGE_PROVIDER = "local";
    process.env.GENERATED_PDF_DIR = generatedDir;
    process.env.SIGNED_PDF_DIR = signedDir;
    resetStorageProviderCache();

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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.GENERATED_PDF_DIR;
    delete process.env.SIGNED_PDF_DIR;
    resetStorageProviderCache();
  });

  it("completes the full journey from ALV payload -> PDF generation -> download -> inline view -> PyMuPDF inspection -> signed upload", async () => {
    const payload = {
      owner: {
        identificationType: "business_reg",
        identificationNumber: "202012345607",
        countryOfIssue: "",
        surnameOrOrganisation: "CAPE LOGISTICS PTY LTD",
        initials: "",
        firstNames: "",
        email: "fleet@capelogistics.co.za",
        homePhoneCode: "",
        homePhoneNumber: "",
        dayPhoneCode: "021",
        dayPhoneNumber: "4009900",
        faxCode: "",
        faxNumber: "",
        cellphone: "0834445566",
      },
      postalAddress: {
        line1: "PO BOX 880",
        line2: "",
        line3: "",
        suburb: "BELLVILLE",
        city: "CAPE TOWN",
        postalCode: "7535",
      },
      streetAddress: {
        line1: "18 VOORTREKKER ROAD",
        line2: "UNIT 3",
        line3: "",
        suburb: "BELLVILLE",
        city: "CAPE TOWN",
        postalCode: "7530",
      },
      sameAsPostal: false,
      noticesAddress: "street",
      hasOrganisationProxy: true,
      proxy: {
        identificationType: "rsa_id",
        identificationNumber: "7901015009089",
        countryOfIssue: "",
        surname: "NKOSI",
        initials: "TM",
      },
      hasOrganisationRepresentative: false,
      vehicle: {
        licenceNumber: "CA552100",
        registerNumber: "XYZ9876",
        chassisVin: "1HGBH41JXMN109186",
        make: "ISUZU",
        seriesName: "NPR 400 AMT",
        noOdometer: true,
        odometerReading: "",
        steeringPosition: "right",
      },
      declaration: {
        signatoryRole: "organisation_proxy",
        signatoryName: "Thabo Mbeki Nkosi",
        place: "CAPE TOWN",
        dateYYMMDD: "261122",
        physicalSignatureAcknowledged: true,
      },
    };

    // 1. Generate PDF
    const genRes = await fetch(`${baseUrl}/api/generate-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(genRes.status).toBe(200);
    const genData = await genRes.json();
    expect(genData.ok).toBe(true);

    // 2. Download PDF
    const dlRes = await fetch(`${baseUrl}${genData.downloadUrl}`);
    expect(dlRes.status).toBe(200);
    const downloadedPdf = Buffer.from(await dlRes.arrayBuffer());
    expect(downloadedPdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // 3. Inline view PDF
    const inlineRes = await fetch(`${baseUrl}${genData.inlineUrl}`);
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.headers.get("content-disposition")).toContain("inline");
    const inlinePdf = Buffer.from(await inlineRes.arrayBuffer());
    expect(inlinePdf.equals(downloadedPdf)).toBe(true);

    // 4. Verify downloaded PDF is readable and contains populated official data
    const checkPdfPath = path.join(tmpRoot, "downloaded_check.pdf");
    fs.writeFileSync(checkPdfPath, downloadedPdf);
    const pyCheck = execFileSync(
      resolvePythonExecutable(),
      [
        "-c",
        "import fitz, sys; d=fitz.open(sys.argv[1]); print(len(d), d[1].get_text('text'))",
        checkPdfPath,
      ],
      { encoding: "utf-8" }
    );
    expect(pyCheck.startsWith("2 ")).toBe(true);
    expect(pyCheck).toContain("CAPE TOWN");

    // 5. Upload signed PDF
    const uploadForm = new FormData();
    uploadForm.append("documentId", genData.id);
    uploadForm.append(
      "file",
      new Blob([downloadedPdf], { type: "application/pdf" }),
      "signed_alv.pdf"
    );
    const upRes = await fetch(`${baseUrl}/api/upload-signed`, {
      method: "POST",
      body: uploadForm,
    });
    expect(upRes.status).toBe(200);
    const upData = await upRes.json();
    expect(upData.ok).toBe(true);
    expect(upData.documentId).toBe(genData.id);

    // 6. Verify generated and signed files reside in separate directories
    expect(fs.existsSync(path.join(generatedDir, `${genData.id}.pdf`))).toBe(true);
    expect(fs.existsSync(path.join(signedDir, `${genData.id}_signed.pdf`))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, `${genData.id}_signed.pdf`))).toBe(false);
  });
});
