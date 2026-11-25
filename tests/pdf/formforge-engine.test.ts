import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFormForgePythonEngine } from "../../src/server/formforge-runner.ts";
import type { AcroFormValidationReport, FieldManifest } from "../../src/lib/formforge/types.ts";

const pythonBin = process.platform === "win32" ? "python" : "python3";

describe("FormForge AI Python Conversion & Rendering Engine (Engine A & B)", () => {
  let tmpDir: string;
  let digitalPdfPath: string;
  let scannedPdfPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formforge-py-test-"));
    digitalPdfPath = path.join(tmpDir, "unfamiliar_digital_form.pdf");
    scannedPdfPath = path.join(tmpDir, "unfamiliar_scanned_form.pdf");

    // Generate two unfamiliar test PDFs via PyMuPDF:
    // 1. Multi-page native digital PDF with Letter/A4 pages, labels, underlines, checkbox, 8-box char_cells, multiline rect
    // 2. Scanned image-only PDF (high-DPI PNG embedded in PDF with zero selectable text spans)
    const genScript = `
import fitz

# 1. Digital multi-page PDF
doc = fitz.open()
p1 = doc.new_page(width=595.28, height=841.89)  # A4
p1.insert_text((50, 60), "MUNICIPAL PERMIT APPLICATION", fontsize=14)
p1.insert_text((50, 110), "Applicant Name:", fontsize=10)
p1.draw_line((160, 113), (420, 113), width=1.0)

p1.insert_text((50, 150), "Email Address:", fontsize=10)
p1.draw_rect(fitz.Rect(160, 136, 420, 156), width=0.8)

p1.insert_text((50, 190), "Identity Code:", fontsize=10)
for i in range(8):
    x0 = 160 + i * 20
    p1.draw_rect(fitz.Rect(x0, 176, x0 + 18, 196), width=0.8)

p1.insert_text((50, 230), "Agree Terms:", fontsize=10)
p1.draw_rect(fitz.Rect(160, 220, 172, 232), width=0.8)

p2 = doc.new_page(width=612.0, height=792.0)  # Letter page
p2.insert_text((50, 70), "Notes / Justification:", fontsize=10)
p2.draw_rect(fitz.Rect(50, 82, 500, 180), width=0.8)
pix = doc[0].get_pixmap(dpi=150)
doc.save(${JSON.stringify(digitalPdfPath)})

# Render page 1 of digital PDF as high-DPI raster image into an image-only PDF
scan_doc = fitz.open()
sp = scan_doc.new_page(width=595.28, height=841.89)
sp.insert_image(sp.rect, stream=pix.tobytes("png"))
scan_doc.save(${JSON.stringify(scannedPdfPath)})
doc.close()
scan_doc.close()
`;
    execFileSync(pythonBin, ["-c", genScript], { stdio: "pipe" });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("analyzes an unfamiliar multi-page digital PDF, detects char_cells & controls, builds AcroForm, and renders flattened + fillable outputs", async () => {
    const analysis = await runFormForgePythonEngine<{
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
    const genRes = await runFormForgePythonEngine<{
      createdWidgets: number;
      validation: AcroFormValidationReport;
    }>("generate-acroform", {
      pdfPath: digitalPdfPath,
      manifest: analysis.manifest,
      outputPdfPath: acroOutPath,
    });

    expect(fs.existsSync(acroOutPath)).toBe(true);
    expect(genRes.createdWidgets).toBeGreaterThanOrEqual(10);
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
    const flatRes = await runFormForgePythonEngine<{ populatedWidgets: number; flattened: boolean }>(
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
    const flatVerify = execFileSync(
      pythonBin,
      [
        "-c",
        `import fitz; d=fitz.open(${JSON.stringify(flatPdfPath)}); print(sum(len(list(p.widgets() or [])) for p in d)); print(d[0].get_text())`,
      ],
      { encoding: "utf-8" }
    );
    const [widgetCountLine, ...textLines] = flatVerify.trim().split("\n");
    expect(Number(widgetCountLine)).toBe(0);
    expect(textLines.join("\n")).toContain("Thabo");

    // Engine B: Render FILLABLE PDF
    const fillablePdfPath = path.join(tmpDir, "rendered_fillable.pdf");
    const fillRes = await runFormForgePythonEngine<{ populatedWidgets: number; flattened: boolean }>(
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

    const fillableJson = JSON.parse(
      execFileSync(
        pythonBin,
        [
          "-c",
          `import json; from pypdf import PdfReader; f=PdfReader(${JSON.stringify(fillablePdfPath)}).get_fields() or {}; print(json.dumps({"count": len(f), "vals": [str(v.get("/V","")) for v in f.values()]}))`,

        ],
        { encoding: "utf-8" }
      ).trim()
    ) as { count: number; vals: string[] };
    expect(fillableJson.count).toBeGreaterThanOrEqual(10);
    expect(fillableJson.vals.some((v) => v.includes("Thabo"))).toBe(true);
  }, 45000);

  it("applies OpenCV preprocessing and Tesseract OCR fallback on a scanned image-only PDF", async () => {
    const analysis = await runFormForgePythonEngine<{
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
