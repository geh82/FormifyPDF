import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { runFormifyPythonEngine } from "../../src/server/formifypdf-runner.ts";
import { getPdfJsDocumentOptions, renderPdfPagePngBuffer } from "../../src/server/pdf-raster-cv.ts";
import { extractPageStructuralGeometry } from "../../src/server/pdf-vector-extractor.ts";
import type { AcroFormValidationReport, FieldManifest } from "../../src/lib/formifypdf/types.ts";

describe("FormifyPDF Conversion & Rendering Engine (Engine A & B)", () => {
  let tmpDir: string;
  let digitalPdfPath: string;
  let scannedPdfPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formifypdf-py-test-"));
    digitalPdfPath = path.join(tmpDir, "unfamiliar_digital_form.pdf");
    scannedPdfPath = path.join(tmpDir, "unfamiliar_scanned_form.pdf");

    // 1. Multi-page native digital PDF with A4/Letter pages, labels, underline, checkbox, 8-box char_cells, multiline rect
    const doc = await PDFDocument.create();
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const p1 = doc.addPage([595.28, 841.89]); // A4
    p1.drawText("MUNICIPAL PERMIT APPLICATION", { x: 50, y: 841.89 - 60, size: 14, font: fontBold });
    p1.drawText("Applicant Name:", { x: 50, y: 841.89 - 110, size: 10, font });
    p1.drawLine({
      start: { x: 160, y: 841.89 - 113 },
      end: { x: 420, y: 841.89 - 113 },
      thickness: 1.0,
      color: rgb(0, 0, 0),
    });

    p1.drawText("Email Address:", { x: 50, y: 841.89 - 150, size: 10, font });
    p1.drawRectangle({
      x: 160,
      y: 841.89 - 156,
      width: 260,
      height: 20,
      borderWidth: 0.8,
      borderColor: rgb(0, 0, 0),
    });

    p1.drawText("Identity Code:", { x: 50, y: 841.89 - 190, size: 10, font });
    for (let i = 0; i < 8; i++) {
      const x0 = 160 + i * 20;
      p1.drawRectangle({
        x: x0,
        y: 841.89 - 196,
        width: 18,
        height: 20,
        borderWidth: 0.8,
        borderColor: rgb(0, 0, 0),
      });
    }

    p1.drawText("Agree Terms:", { x: 50, y: 841.89 - 230, size: 10, font });
    p1.drawRectangle({
      x: 160,
      y: 841.89 - 232,
      width: 12,
      height: 12,
      borderWidth: 0.8,
      borderColor: rgb(0, 0, 0),
    });

    const p2 = doc.addPage([612.0, 792.0]); // Letter
    p2.drawText("Notes / Justification:", { x: 50, y: 792.0 - 70, size: 10, font });
    p2.drawRectangle({
      x: 50,
      y: 792.0 - 180,
      width: 450,
      height: 98,
      borderWidth: 0.8,
      borderColor: rgb(0, 0, 0),
    });

    fs.writeFileSync(digitalPdfPath, Buffer.from(await doc.save({ useObjectStreams: false })));

    // 2. Scanned image-only PDF (high-DPI PNG embedded in PDF with zero selectable text spans)
    const { png } = await renderPdfPagePngBuffer(digitalPdfPath, 0, 150);
    const scanDoc = await PDFDocument.create();
    const pngImage = await scanDoc.embedPng(png);
    const sp = scanDoc.addPage([595.28, 841.89]);
    sp.drawImage(pngImage, { x: 0, y: 0, width: 595.28, height: 841.89 });
    fs.writeFileSync(scannedPdfPath, Buffer.from(await scanDoc.save({ useObjectStreams: false })));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("analyzes an unfamiliar multi-page digital PDF, detects char_cells & controls, builds AcroForm, and renders flattened + fillable outputs", async () => {
    const analysis = await runFormifyPythonEngine<{
      inspection: { pageCount: number; pages: Array<{ paperSize: string }> };
      manifest: FieldManifest;
    }>("analyze", {
      pdfPath: digitalPdfPath,
      options: { documentId: "doc_test_digital", enableOcr: true },
    });

    expect(analysis.inspection.pageCount).toBe(2);
    expect(analysis.inspection.pages[0].paperSize).toBe("A4");
    expect(analysis.inspection.pages[1].paperSize).toBe("Letter");

    const fields = analysis.manifest.fields;
    expect(fields.length).toBeGreaterThanOrEqual(4);

    // Must detect grouped 8-cell char_cells field
    const charCellField = fields.find((f) => f.type === "char_cells");
    expect(charCellField).toBeTruthy();
    expect(charCellField?.cellRects?.length).toBe(8);

    // Must detect checkbox
    const cbField = fields.find((f) => f.type === "checkbox");
    expect(cbField).toBeTruthy();

    // Generate AcroForm master PDF
    const acroOutPath = path.join(tmpDir, "digital_acroform.pdf");
    const genRes = await runFormifyPythonEngine<{
      createdWidgets: number;
      validation: AcroFormValidationReport;
    }>("generate-acroform", {
      pdfPath: digitalPdfPath,
      manifest: analysis.manifest,
      outputPdfPath: acroOutPath,
    });

    expect(fs.existsSync(acroOutPath)).toBe(true);
    expect(genRes.createdWidgets).toBeGreaterThanOrEqual(fields.length);
    expect(genRes.validation.validPdf).toBe(true);
    expect(genRes.validation.hasAcroFormDict).toBe(true);
    expect(genRes.validation.roundTripWriteReadOk).toBe(true);
    expect(genRes.validation.missingFields).toEqual([]);

    // Engine B: Render FLATTENED PDF
    const sampleValues: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.type === "checkbox") sampleValues[f.name] = true;
      else if (f.type === "char_cells") sampleValues[f.name] = "ZA998877";
      else sampleValues[f.name] = "Thabo Mbeki Test";
    }

    const flatPdfPath = path.join(tmpDir, "rendered_flat.pdf");
    const flatRes = await runFormifyPythonEngine<{ populatedWidgets: number; flattened: boolean }>(
      "render-pdf",
      {
        templatePdfPath: acroOutPath,
        manifest: analysis.manifest,
        values: sampleValues,
        outputPdfPath: flatPdfPath,
        flatten: true,
      }
    );
    expect(flatRes.flattened).toBe(true);
    expect(flatRes.populatedWidgets).toBeGreaterThanOrEqual(5);

    // Verify flattened PDF has 0 remaining editable widgets AND contains rendered text
    const flatBytes = fs.readFileSync(flatPdfPath);
    const flatDoc = await PDFDocument.load(flatBytes);
    expect(flatDoc.getForm().getFields().length).toBe(0);
    const flatTask = pdfjsLib.getDocument(getPdfJsDocumentOptions(new Uint8Array(flatBytes)));
    const flatPdfJs = await flatTask.promise;
    try {
      const flatPage0 = await flatPdfJs.getPage(1);
      const flatGeom = await extractPageStructuralGeometry(flatPage0, 0);
      const flatText = flatGeom.textRuns.map((r) => r.text).join(" ");
      expect(flatText).toContain("Thabo");
    } finally {
      await Promise.resolve(flatPdfJs.cleanup?.()).catch(() => {});
      await Promise.resolve(flatTask.destroy?.()).catch(() => {});
    }

    // Engine B: Render FILLABLE PDF
    const fillablePdfPath = path.join(tmpDir, "rendered_fillable.pdf");
    const fillRes = await runFormifyPythonEngine<{ populatedWidgets: number; flattened: boolean }>(
      "render-pdf",
      {
        templatePdfPath: acroOutPath,
        manifest: analysis.manifest,
        values: sampleValues,
        outputPdfPath: fillablePdfPath,
        flatten: false,
      }
    );
    expect(fillRes.flattened).toBe(false);
    expect(fillRes.populatedWidgets).toBeGreaterThanOrEqual(5);

    const fillableDoc = await PDFDocument.load(fs.readFileSync(fillablePdfPath));
    const fillableFields = fillableDoc.getForm().getFields();
    expect(fillableFields.length).toBeGreaterThanOrEqual(fields.length);
    const combPdfField = fillableFields.find((f) => f.getName() === charCellField?.name) as unknown as {
      isCombed?: () => boolean;
      getMaxLength?: () => number | undefined;
    };
    expect(combPdfField).toBeTruthy();
    expect(combPdfField.isCombed?.()).toBe(true);
    expect(combPdfField.getMaxLength?.()).toBe(8);
    const fieldValues = fillableFields.map((f) => {
      const maybeText = f as unknown as { getText?: () => string | undefined };
      try {
        return maybeText.getText ? maybeText.getText() || "" : "";
      } catch {
        return "";
      }
    });
    expect(fieldValues.some((v) => v.includes("Thabo"))).toBe(true);
  }, 45000);

  it("applies raster CV preprocessing and Tesseract OCR fallback on a scanned image-only PDF", async () => {
    const analysis = await runFormifyPythonEngine<{
      inspection: { isScanned: boolean; pages: Array<{ ocrApplied: boolean; wordCount: number }> };
      ocrJobs: Array<{ extractedChars: number; ocrEngine: string }>;
      manifest: FieldManifest;
    }>("analyze", {
      pdfPath: scannedPdfPath,
      options: { documentId: "doc_test_scanned", enableOcr: true, ocrLanguage: "eng" },
    });

    expect(analysis.inspection.isScanned).toBe(true);
    expect(analysis.inspection.pages[0].ocrApplied).toBe(true);
    expect(analysis.ocrJobs.length).toBe(1);
    expect(analysis.ocrJobs[0].ocrEngine).toBe("tesseract");
    const hasTesseractCli = (() => {
      try {
        execFileSync(process.platform === "win32" ? "where" : "which", ["tesseract"], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    })();
    if (hasTesseractCli) {
      expect(analysis.ocrJobs[0].extractedChars).toBeGreaterThan(20);
    }
    expect(analysis.manifest.fields.length).toBeGreaterThanOrEqual(1);
  }, 45000);
});
