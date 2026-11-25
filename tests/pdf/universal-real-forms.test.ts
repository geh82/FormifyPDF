import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRadioGroup,
  PDFRawStream,
  PDFTextField,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  rgb,
} from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server.ts";
import { topLeftPdfToBottomLeftPdf } from "../../src/lib/formifypdf/coordinate.ts";
import type { AcroFormValidationReport, FieldManifest } from "../../src/lib/formifypdf/types.ts";
import { resetDatabaseCache } from "../../src/server/db/database.ts";
import { runFormifyNodeEngine } from "../../src/server/formifypdf-node-engine.ts";
import { getPdfJsDocumentOptions } from "../../src/server/pdf-raster-cv.ts";

function getApStreamOps(raw: unknown): string {
  if (!(raw instanceof PDFRawStream)) return "";
  try {
    return Buffer.from(decodePDFRawStream(raw).decode()).toString("latin1");
  } catch {
    return Buffer.from(raw.contents).toString("latin1");
  }
}

function assertAllWidgetsDimHighlighted(pdfDoc: PDFDocument): number {
  const form = pdfDoc.getForm();
  const needApps = form.acroForm.dict.get(PDFName.of("NeedAppearances"));
  expect(needApps?.toString()).toBe("false");

  let widgetCount = 0;
  for (const f of form.getFields()) {
    for (const w of f.acroField.getWidgets()) {
      widgetCount++;
      const mk = w.dict.lookupMaybe(PDFName.of("MK"), PDFDict);
      expect(mk?.has(PDFName.of("BG")) ?? false).toBe(false);
      expect(mk?.has(PDFName.of("BC")) ?? false).toBe(false);

      const apN = w.dict.lookupMaybe(PDFName.of("AP"), PDFDict)?.lookup(PDFName.of("N"));
      if (f instanceof PDFCheckBox || f instanceof PDFRadioGroup) {
        const apDict = apN as PDFDict | undefined;
        const offOps = getApStreamOps(apDict?.lookup(PDFName.of("Off")));
        expect(offOps).toContain("/FHighlight gs");
        expect(offOps).toContain("0.58 0.78 0.98 rg");
      } else {
        const ops = getApStreamOps(apN);
        expect(ops).toContain("/FHighlight gs");
        expect(ops).toContain("0.58 0.78 0.98 rg");
      }
    }
  }
  return widgetCount;
}

describe("FormifyPDF Universal Format & Real Multi-Page AcroForm Conversion Suite", () => {
  let tmpDir: string;
  const ncoPdfPath = path.resolve(process.cwd(), "tests/pdf/fixtures/NCO-006-001.pdf");
  const acrPdfPath = path.resolve(process.cwd(), "tests/pdf/fixtures/ACR-12-2014-10.pdf");

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formifypdf-universal-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("converts 3-page NCO-006-001.pdf accurately with 2:0-free 6-cell YYMMDD combs, dotted underlines, and persistent dim highlights", async () => {
    const analyzed = await runFormifyNodeEngine<{ manifest: FieldManifest }>("analyze", {
      pdfPath: ncoPdfPath,
      options: { documentId: "nco_universal_check" },
    });

    const fields = analyzed.manifest.fields;
    expect(analyzed.manifest.totalPages).toBe(3);
    expect(fields.length).toBe(65);
    expect(fields.filter((f) => f.confidenceTier === "low").length).toBe(0);

    // Three separate 6-cell YYMMDD dates omitting static "2:0"
    for (const dateName of ["date", "date_2", "date_of_change"]) {
      const df = fields.find((f) => f.name === dateName);
      expect(df, `Missing date comb ${dateName}`).toBeDefined();
      expect(df?.type).toBe("char_cells");
      expect(df?.cellRects?.length).toBe(6);
      expect(df?.charGridMeta?.acroformStrategy).toBe("comb");
      expect(df?.rect.width).toBeLessThan(85);
    }

    // Key checkbox and dotted underlines
    expect(fields.find((f) => f.name === "not_yet_allocated")?.type).toBe("checkbox");
    expect(fields.find((f) => f.name === "make")?.type).toBe("char_cells");

    const sigFields = fields.filter((f) => f.type === "signature");
    expect(sigFields.length).toBeGreaterThanOrEqual(2);
    for (const sf of sigFields) {
      expect(sf.rect.height).toBeGreaterThanOrEqual(10);
      expect(sf.rect.height).toBeLessThanOrEqual(20);
    }

    const acroPath = path.join(tmpDir, "nco_acroform.pdf");
    const gen = await runFormifyNodeEngine<{
      createdWidgets: number;
      validation: AcroFormValidationReport;
    }>("generate-acroform", {
      pdfPath: ncoPdfPath,
      manifest: analyzed.manifest,
      outputPdfPath: acroPath,
    });

    expect(gen.validation.validPdf).toBe(true);
    expect(gen.validation.hasAcroFormDict).toBe(true);
    expect(gen.validation.roundTripWriteReadOk).toBe(true);
    expect(gen.validation.visualVerification?.passed).toBe(true);
    expect(gen.validation.visualVerification?.alignedCount).toBe(65);
    expect(gen.validation.visualVerification?.meanIoU).toBeGreaterThanOrEqual(0.99);
    expect(gen.validation.visualVerification?.overlappingWidgetPairs).toEqual([]);

    const acroDoc = await PDFDocument.load(fs.readFileSync(acroPath));
    expect(assertAllWidgetsDimHighlighted(acroDoc)).toBeGreaterThanOrEqual(80);

    // Verify native PDF Comb flag + maxLength=6 on YYMMDD date fields
    const dateTf = acroDoc.getForm().getTextField("date");
    expect((dateTf.acroField.getFlags() & (1 << 24)) !== 0).toBe(true);
    expect(dateTf.getMaxLength()).toBe(6);

    // Fillable render + save/reload + pixel tint check
    const filledPath = path.join(tmpDir, "nco_filled.pdf");
    await runFormifyNodeEngine("render-pdf", {
      templatePdfPath: acroPath,
      manifest: analyzed.manifest,
      values: {
        date: "260713",
        date_2: "260714",
        date_of_change: "260715",
        make: "TOYOTA",
        not_yet_allocated: true,
      },
      outputPdfPath: filledPath,
      outputMode: "fillable",
    });

    const readBack = await PDFDocument.load(fs.readFileSync(filledPath));
    expect(assertAllWidgetsDimHighlighted(readBack)).toBeGreaterThanOrEqual(80);
    expect(readBack.getForm().getTextField("date").getText()).toBe("260713");
    expect(readBack.getForm().getTextField("make").getText()).toBe("TOYOTA");
    expect(readBack.getForm().getCheckBox("not_yet_allocated").isChecked()).toBe(true);

    // Verify rendered dim highlight tint pixel on Page 1 via pdfjs-dist annotationMode=1
    const dateRect = fields.find((f) => f.name === "date")!.rect;
    const loading = pdfjsLib.getDocument(
      getPdfJsDocumentOptions(new Uint8Array(fs.readFileSync(filledPath)))
    );
    const pjs = await loading.promise;
    const pPage = await pjs.getPage(fields.find((f) => f.name === "date")!.page + 1);
    const vp = pPage.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    await pPage.render({
      canvas: canvas as never,
      canvasContext: ctx as never,
      viewport: vp,
      annotationMode: 1,
    }).promise;
    const sampleX = Math.round(dateRect.x + dateRect.width * 0.5);
    const sampleY = Math.round(dateRect.y + 3);
    const pix = ctx.getImageData(sampleX, sampleY, 1, 1).data;
    expect(pix[2]).toBeGreaterThan(pix[0] + 10);
    await pjs.cleanup?.();
    await loading.destroy?.();
  }, 30000);

  it("converts 4-page ACR-12-2014-10.pdf with zero checklist/legend phantoms, formula blanks, radios, and comb grids", async () => {
    const analyzed = await runFormifyNodeEngine<{ manifest: FieldManifest }>("analyze", {
      pdfPath: acrPdfPath,
      options: { documentId: "acr_universal_check" },
    });

    const fields = analyzed.manifest.fields;
    expect(analyzed.manifest.totalPages).toBe(4);
    expect(fields.length).toBe(256);
    expect(fields.filter((f) => f.confidenceTier === "low").length).toBe(0);

    // Static legend page 4 (0-indexed page 3) must emit 0 phantom fields, while page 3 (index 2) holds the checklist & test block
    expect(fields.filter((f) => f.page === 2).length).toBe(192);
    expect(fields.filter((f) => f.page === 3).length).toBe(0);

    // Unlabeled checklist phantom Checkboxes must not exist
    expect(fields.some((f) => f.label === "Checkbox")).toBe(false);

    // Key comb fields & radios
    expect(fields.find((f) => f.name === "total_number_of_wheels")?.cellRects?.length).toBe(2);
    expect(fields.find((f) => f.name === "test_date")?.cellRects?.length).toBe(6);
    expect(fields.find((f) => f.name === "re_test_date")?.cellRects?.length).toBe(6);
    expect(fields.find((f) => f.name === "retest_on_or_before")?.cellRects?.length).toBe(6);
    expect(fields.find((f) => f.name === "time_from")?.cellRects?.length).toBe(4);
    expect(fields.find((f) => f.name === "time_to")?.cellRects?.length).toBe(4);
    expect(fields.find((f) => f.name === "receipt_number")?.cellRects?.length).toBe(12);
    expect(fields.find((f) => f.name === "receipt_number_2")?.cellRects?.length).toBe(12);

    const transportRadio = fields.find(
      (f) => f.type === "radio" && f.name.startsWith("used_for_the_transportation_of")
    );
    expect(transportRadio?.options.length).toBe(4);
    const transportOtherComb = fields.find(
      (f) => f.type === "char_cells" && f.name.startsWith("used_for_the_transportation_of")
    );
    expect(transportOtherComb?.cellRects?.length).toBe(10);

    expect(fields.find((f) => f.name === "brake_formula")?.type).toBe("text");
    expect(fields.find((f) => f.name === "brake_formula_result")?.type).toBe("text");
    expect(fields.find((f) => f.name === "park_brake_12_of_brake_force")?.type).toBe("text");

    const acroPath = path.join(tmpDir, "acr_acroform.pdf");
    const gen = await runFormifyNodeEngine<{
      createdWidgets: number;
      validation: AcroFormValidationReport;
    }>("generate-acroform", {
      pdfPath: acrPdfPath,
      manifest: analyzed.manifest,
      outputPdfPath: acroPath,
    });

    expect(gen.validation.validPdf).toBe(true);
    expect(gen.validation.visualVerification?.passed).toBe(true);
    expect(gen.validation.visualVerification?.alignedCount).toBe(256);
    expect(gen.validation.visualVerification?.meanIoU).toBeGreaterThanOrEqual(0.99);
    expect(gen.validation.visualVerification?.overlappingWidgetPairs).toEqual([]);

    const acroDoc = await PDFDocument.load(fs.readFileSync(acroPath));
    expect(assertAllWidgetsDimHighlighted(acroDoc)).toBeGreaterThanOrEqual(275);
  }, 30000);

  it("aligns widgets and renders upright glyphs + comb cells across 0/90/180/270 rotations with non-zero CropBox and mixed paper sizes", async () => {
    const srcPath = path.join(tmpDir, "rotated_mixed_crop.pdf");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const configs: Array<{ w: number; h: number; angle: 0 | 90 | 180 | 270; expectedPaper: string }> = [
      { w: 600, h: 840, angle: 0, expectedPaper: "Custom" },
      { w: 612, h: 792, angle: 90, expectedPaper: "Custom" },
      { w: 595.28, h: 841.89, angle: 180, expectedPaper: "A4" },
      { w: 612, h: 792, angle: 270, expectedPaper: "Custom" },
    ];

    for (const cfg of configs) {
      const page = doc.addPage([cfg.w, cfg.h]);
      if (cfg.angle !== 0) page.setRotation(degrees(cfg.angle));
      const crop = { x: 20, y: 30, width: cfg.w - 40, height: cfg.h - 60 };
      page.setCropBox(crop.x, crop.y, crop.width, crop.height);

      const drawVisRect = (vx: number, vy: number, vw: number, vh: number) => {
        const [rx0, ry0, rx1, ry1] = topLeftPdfToBottomLeftPdf(
          { x: vx, y: vy, width: vw, height: vh },
          crop,
          cfg.angle
        );
        page.drawRectangle({
          x: rx0,
          y: ry0,
          width: rx1 - rx0,
          height: ry1 - ry0,
          borderWidth: 1,
          borderColor: rgb(0, 0, 0),
        });
      };
      const drawVisText = (text: string, vx: number, vy: number, size = 10) => {
        const [tx0, ty0, tx1, ty1] = topLeftPdfToBottomLeftPdf(
          { x: vx, y: vy, width: 100, height: size + 2 },
          crop,
          cfg.angle
        );
        const anchor =
          cfg.angle === 0
            ? { x: tx0, y: ty0 + 2, rotate: degrees(0) }
            : cfg.angle === 90
              ? { x: tx1 - 2, y: ty0, rotate: degrees(90) }
              : cfg.angle === 180
                ? { x: tx1, y: ty1 - 2, rotate: degrees(180) }
                : { x: tx0 + 2, y: ty1, rotate: degrees(270) };
        page.drawText(text, { ...anchor, size, font, color: rgb(0, 0, 0) });
      };

      drawVisText("UNIVERSAL ROTATION AND CROPBOX TEST FORM SECTION ONE", 40, 40, 10);
      drawVisText("Applicant Name:", 40, 84, 10);
      drawVisRect(160, 80, 180, 20);
      drawVisText("Code (5 digits):", 40, 124, 10);
      for (let i = 0; i < 5; i++) drawVisRect(160 + i * 16, 120, 16, 18);
    }

    fs.writeFileSync(srcPath, await doc.save({ useObjectStreams: false }));

    const analyzed = await runFormifyNodeEngine<{
      inspection: { pages: Array<{ rotation: number; orientation: string }> };
      manifest: FieldManifest;
    }>("analyze", { pdfPath: srcPath, options: { documentId: "rot_crop_test" } });

    expect(analyzed.inspection.pages.map((p) => p.rotation)).toEqual([0, 90, 180, 270]);
    expect(analyzed.inspection.pages[1].orientation).toBe("landscape");
    expect(analyzed.manifest.fields.length).toBe(8);

    const acroPath = path.join(tmpDir, "rot_acro.pdf");
    const gen = await runFormifyNodeEngine<{ validation: AcroFormValidationReport }>(
      "generate-acroform",
      { pdfPath: srcPath, manifest: analyzed.manifest, outputPdfPath: acroPath }
    );
    expect(gen.validation.visualVerification?.passed).toBe(true);
    expect(gen.validation.visualVerification?.meanIoU).toBe(1);
    expect(gen.validation.visualVerification?.combFieldCount).toBe(4);

    const filledPath = path.join(tmpDir, "rot_filled.pdf");
    const vals: Record<string, string> = {};
    for (const f of analyzed.manifest.fields) {
      vals[f.name] = f.type === "char_cells" ? "ABCDE" : "JANE";
    }
    await runFormifyNodeEngine("render-pdf", {
      templatePdfPath: acroPath,
      manifest: analyzed.manifest,
      values: vals,
      outputPdfPath: filledPath,
      outputMode: "fillable",
    });

    const loading = pdfjsLib.getDocument(
      getPdfJsDocumentOptions(new Uint8Array(fs.readFileSync(filledPath)))
    );
    const pjs = await loading.promise;
    for (let p = 0; p < 4; p++) {
      const pg = await pjs.getPage(p + 1);
      const vp = pg.getViewport({ scale: 1 });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext("2d");
      await pg.render({
        canvas: canvas as never,
        canvasContext: ctx as never,
        viewport: vp,
        annotationMode: 1,
      }).promise;

      // Typed "JANE" must sit upright on left side [162..200, 82..98] regardless of page /Rotate
      let dark = 0;
      let maxX = -1;
      for (let y = 82; y <= 98; y++) {
        for (let x = 162; x <= 200; x++) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          if (d[0] < 80 && d[1] < 80 && d[2] < 80) {
            dark++;
            if (x > maxX) maxX = x;
          }
        }
      }
      expect(dark).toBeGreaterThanOrEqual(20);
      expect(maxX).toBeLessThan(195);

      // Every comb cell 0..4 must contain ink glyphs for "A","B","C","D","E"
      for (let c = 0; c < 5; c++) {
        let cellInk = 0;
        for (let y = 122; y <= 136; y++) {
          for (let x = 162 + c * 16; x <= 174 + c * 16; x++) {
            const d = ctx.getImageData(x, y, 1, 1).data;
            if (d[0] < 80 && d[1] < 80 && d[2] < 80) cellInk++;
          }
        }
        expect(cellInk).toBeGreaterThanOrEqual(2);
      }

      // Pale blue dim highlight background
      const bg = ctx.getImageData(280, 90, 1, 1).data;
      expect(bg[2]).toBeGreaterThan(bg[0] + 10);
    }
    await pjs.cleanup?.();
    await loading.destroy?.();
  }, 30000);

  it("handles skewed raster scans, open-top tick combs, vector dotted/dashed lines, and full /api/v1 HTTP upload -> AcroForm download", async () => {
    // 1. Skewed (~2.2 deg) scanned image-only PDF
    const w = 1240;
    const h = 1754;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((2.2 * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
    ctx.fillStyle = "#111111";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText("UNIVERSAL VEHICLE & CITIZEN APPLICATION FORM", 100, 140);
    ctx.font = "24px sans-serif";
    ctx.fillText("Identity Code:", 100, 350);
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 3;
    for (let i = 0; i < 6; i++) ctx.strokeRect(420 + i * 44, 315, 44, 48);
    ctx.fillText("Authorized Signature:", 100, 540);
    ctx.beginPath();
    ctx.moveTo(420, 545);
    ctx.lineTo(960, 545);
    ctx.stroke();
    ctx.restore();

    const scanDoc = await PDFDocument.create();
    const img = await scanDoc.embedPng(canvas.toBuffer("image/png"));
    scanDoc.addPage([595.28, 841.89]).drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    const scanPath = path.join(tmpDir, "skewed_scan.pdf");
    fs.writeFileSync(scanPath, await scanDoc.save({ useObjectStreams: false }));

    const scanAnalysis = await runFormifyNodeEngine<{
      ocrJobs: Array<{ deskewAngle: number; status: string }>;
      manifest: FieldManifest;
    }>("analyze", { pdfPath: scanPath, options: { documentId: "skewed_scan" } });

    expect(scanAnalysis.manifest.isScanned).toBe(true);
    expect(scanAnalysis.ocrJobs[0]?.status).toBe("completed");
    expect(Math.abs(scanAnalysis.ocrJobs[0]?.deskewAngle ?? 0)).toBeGreaterThan(1.2);
    const scanComb = scanAnalysis.manifest.fields.find((f) => f.type === "char_cells");
    expect(scanComb?.cellRects?.length).toBe(6);
    expect(scanAnalysis.manifest.fields.some((f) => f.type === "signature")).toBe(true);

    const scanAcroPath = path.join(tmpDir, "skewed_scan_acro.pdf");
    const scanGen = await runFormifyNodeEngine<{ validation: AcroFormValidationReport }>(
      "generate-acroform",
      { pdfPath: scanPath, manifest: scanAnalysis.manifest, outputPdfPath: scanAcroPath }
    );
    expect(scanGen.validation.validPdf).toBe(true);
    assertAllWidgetsDimHighlighted(await PDFDocument.load(fs.readFileSync(scanAcroPath)));

    // 2. Open-top tick comb + vector dotted + dashed lines uploaded via Express /api/v1 HTTP lifecycle
    const vecDoc = await PDFDocument.create();
    const font = await vecDoc.embedFont(StandardFonts.Helvetica);
    const vp = vecDoc.addPage([595.28, 841.89]);
    vp.drawText("NATIONAL PERMIT APPLICATION FORM - COMPLETE ALL FIELDS CLEARLY", {
      x: 45,
      y: 780,
      size: 11,
      font,
    });
    vp.drawText("Serial No:", { x: 45, y: 720, size: 10, font });
    vp.drawLine({ start: { x: 160, y: 716 }, end: { x: 240, y: 716 }, thickness: 0.9, color: rgb(0, 0, 0) });
    for (let i = 0; i <= 5; i++) {
      vp.drawLine({
        start: { x: 160 + i * 16, y: 716 },
        end: { x: 160 + i * 16, y: 730 },
        thickness: 0.9,
        color: rgb(0, 0, 0),
      });
    }
    vp.drawText("Signature: ........................................", { x: 45, y: 670, size: 10, font });
    vp.drawText("Reference:", { x: 45, y: 630, size: 10, font });
    for (let i = 0; i < 18; i++) {
      vp.drawLine({
        start: { x: 160 + i * 10, y: 628 },
        end: { x: 160 + i * 10 + 5, y: 628 },
        thickness: 0.8,
        color: rgb(0, 0, 0),
      });
    }
    const vecBytes = Buffer.from(await vecDoc.save({ useObjectStreams: false }));

    const apiTmp = path.join(tmpDir, "http_api");
    fs.mkdirSync(apiTmp, { recursive: true });
    const prevStorage = process.env.FORMIFYPDF_STORAGE_DIR;
    const prevDb = process.env.FORMIFYPDF_DB_PATH;
    process.env.FORMIFYPDF_STORAGE_DIR = path.join(apiTmp, "storage");
    process.env.FORMIFYPDF_DB_PATH = path.join(apiTmp, "formifypdf_universal.db");
    resetDatabaseCache();

    let server: http.Server | undefined;
    try {
      const app = await createApp({ disableRateLimit: true });
      const baseUrl = await new Promise<string>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => {
          const addr = server?.address();
          resolve(addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "");
        });
      });

      const boot = await (
        await fetch(`${baseUrl}/api/v1/auth/bootstrap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "universal@formifypdf.test",
            fullName: "Universal Admin",
            password: "StrongPassword123!",
          }),
        })
      ).json();
      const token = boot.token as string;

      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(vecBytes)], { type: "application/pdf" }), "tick_dotted.pdf");
      form.append("title", "Tick Comb & Dotted Test");
      const up = await (
        await fetch(`${baseUrl}/api/v1/documents`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        })
      ).json();

      let status = "queued";
      for (let i = 0; i < 80; i++) {
        const jr = await (
          await fetch(`${baseUrl}/api/v1/jobs/${up.jobId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).json();
        status = jr.job.status;
        if (status === "completed" || status === "failed") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(status).toBe("completed");

      const manRes = await (
        await fetch(`${baseUrl}/api/v1/documents/${up.document.id}/manifest`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      const mFields = manRes.manifest.fields as FieldManifest["fields"];
      expect(mFields.find((f) => f.name === "serial_no")?.cellRects?.length).toBe(5);
      expect(mFields.find((f) => f.name === "signature")?.type).toBe("signature");
      expect(mFields.find((f) => f.name === "reference")?.rect.width).toBeGreaterThan(150);

      const dlRes = await fetch(
        `${baseUrl}/api/v1/documents/${up.document.id}/acroform-pdf?disposition=attachment`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(dlRes.status).toBe(200);
      const dlDoc = await PDFDocument.load(Buffer.from(await dlRes.arrayBuffer()));
      assertAllWidgetsDimHighlighted(dlDoc);
      const serialTf = dlDoc.getForm().getTextField("serial_no");
      expect((serialTf.acroField.getFlags() & (1 << 24)) !== 0).toBe(true);
      expect(serialTf.getMaxLength()).toBe(5);
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      resetDatabaseCache();
      if (prevStorage !== undefined) process.env.FORMIFYPDF_STORAGE_DIR = prevStorage;
      else delete process.env.FORMIFYPDF_STORAGE_DIR;
      if (prevDb !== undefined) process.env.FORMIFYPDF_DB_PATH = prevDb;
      else delete process.env.FORMIFYPDF_DB_PATH;
    }
  }, 45000);
});
