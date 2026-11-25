import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeRectIoU } from "../../src/lib/formforge/coordinate.ts";
import type { AcroFormValidationReport, DetectedFormField, FieldManifest, PdfRect } from "../../src/lib/formforge/types.ts";
import { runFormForgeNodeEngine } from "../../src/server/formforge-node-engine.ts";
import { renderPdfPagePngBuffer } from "../../src/server/pdf-raster-cv.ts";

interface BenchmarkTarget {
  name: string;
  page: number; // 0-based
  rect: PdfRect;
  expectedKind?: "char_cells" | "radio" | "checkbox" | "multiline" | "signature" | "text";
}

interface BenchmarkMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  meanIoU: number;
}

function evaluateDetectionBenchmark(
  detected: DetectedFormField[],
  groundTruth: BenchmarkTarget[],
  iouThreshold = 0.35
): BenchmarkMetrics {
  const matchedGt = new Set<number>();
  const matchedPred = new Set<number>();
  let iouSum = 0;

  // Greedy bipartite match sorted by highest IoU
  const pairs: Array<{ gi: number; pi: number; iou: number }> = [];
  for (let gi = 0; gi < groundTruth.length; gi++) {
    const gt = groundTruth[gi];
    for (let pi = 0; pi < detected.length; pi++) {
      const pred = detected[pi];
      if (pred.page !== gt.page) continue;
      const iou = computeRectIoU(gt.rect, pred.rect);
      if (iou >= iouThreshold) {
        pairs.push({ gi, pi, iou });
      }
    }
  }
  pairs.sort((a, b) => b.iou - a.iou);

  for (const pair of pairs) {
    if (matchedGt.has(pair.gi) || matchedPred.has(pair.pi)) continue;
    matchedGt.add(pair.gi);
    matchedPred.add(pair.pi);
    iouSum += pair.iou;
  }

  const tp = matchedGt.size;
  const fp = Math.max(0, detected.length - tp);
  const fn = Math.max(0, groundTruth.length - tp);
  const precision = detected.length > 0 ? tp / detected.length : 0;
  const recall = groundTruth.length > 0 ? tp / groundTruth.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const meanIoU = tp > 0 ? iouSum / tp : 0;

  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3)),
    meanIoU: Number(meanIoU.toFixed(3)),
  };
}

function loadAlvGroundTruth(pageFilter?: number): BenchmarkTarget[] {
  const raw = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "tests/benchmark/fixtures/bench_field_map.json"), "utf-8")
  ) as { fields: Record<string, any> };

  const tupleToRect = (t: number[]): PdfRect => ({
    x: t[0],
    y: t[1],
    width: t[2] - t[0],
    height: t[3] - t[1],
  });

  const targets: BenchmarkTarget[] = [];
  for (const [name, g] of Object.entries(raw.fields)) {
    const pageIdx = Number(g.page || 1) - 1;
    if (pageFilter !== undefined && pageIdx !== pageFilter) continue;

    let rect: PdfRect | null = null;
    if (Array.isArray(g.rect)) {
      rect = tupleToRect(g.rect);
    } else if (g.options) {
      const rs = (Object.values(g.options) as any[]).map((v) => tupleToRect(v.rect));
      const x0 = Math.min(...rs.map((r) => r.x));
      const y0 = Math.min(...rs.map((r) => r.y));
      const x1 = Math.max(...rs.map((r) => r.x + r.width));
      const y1 = Math.max(...rs.map((r) => r.y + r.height));
      rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    } else if (Array.isArray(g.cells) && g.cells.length > 0) {
      const rs = g.cells.map((c: number[]) => tupleToRect(c));
      const x0 = Math.min(...rs.map((r: PdfRect) => r.x));
      const y0 = Math.min(...rs.map((r: PdfRect) => r.y));
      const x1 = Math.max(...rs.map((r: PdfRect) => r.x + r.width));
      const y1 = Math.max(...rs.map((r: PdfRect) => r.y + r.height));
      rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    if (rect) {
      targets.push({
        name,
        page: pageIdx,
        rect,
        expectedKind:
          g.kind === "char_cells"
            ? "char_cells"
            : g.kind === "selection_box"
            ? "radio"
            : g.kind === "checkbox"
            ? "checkbox"
            : "text",
      });
    }
  }
  return targets;
}

describe("FormForge Universal Detection & AcroForm Benchmark Suite", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formforge-bench-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Scenario 1: Digital multi-page government form achieves >=95% recall, >=0.85 mean IoU, and preserves comb char grids", async () => {
    const alvPdf = path.resolve(process.cwd(), "tests/benchmark/fixtures/bench_form.pdf");
    const out = await runFormForgeNodeEngine<{
      manifest: FieldManifest;
      ocrJobs: any[];
    }>("analyze", {
      pdfPath: alvPdf,
      options: { documentId: "bench_alv_digital" },
    });

    const gt = loadAlvGroundTruth();
    const metrics = evaluateDetectionBenchmark(out.manifest.fields, gt);

    expect(metrics.recall).toBeGreaterThanOrEqual(0.95);
    expect(metrics.precision).toBeGreaterThanOrEqual(0.75);
    expect(metrics.f1).toBeGreaterThanOrEqual(0.84);
    expect(metrics.meanIoU).toBeGreaterThanOrEqual(0.85);

    const charGt = gt.filter((g) => g.expectedKind === "char_cells");
    const charPred = out.manifest.fields.filter((f) => f.type === "char_cells");
    const charMetrics = evaluateDetectionBenchmark(charPred, charGt);
    expect(charMetrics.recall).toBeGreaterThanOrEqual(0.95);
    expect(out.manifest.detectionSummary?.combFieldCount).toBeGreaterThanOrEqual(35);

    // Ensure shaded section banners were not emitted as phantom input fields
    const bannerPhantom = out.manifest.fields.find((f) =>
      /for office use only|net vir kantoorgebruik|organisation's proxy/i.test(f.label)
    );
    expect(bannerPhantom).toBeUndefined();
  });

  it("Scenario 2: Scanned image-only PDF triggers offline CV + Tesseract OCR and achieves >=90% recall", async () => {
    const alvPdf = path.resolve(process.cwd(), "tests/benchmark/fixtures/bench_form.pdf");
    const { png } = await renderPdfPagePngBuffer(alvPdf, 0, 160);

    const scanDoc = await PDFDocument.create();
    const pngImg = await scanDoc.embedPng(png);
    const page = scanDoc.addPage([595.28, 841.89]);
    page.drawImage(pngImg, { x: 0, y: 0, width: 595.28, height: 841.89 });
    const scanPdf = path.join(tmpDir, "alv_p1_scanned.pdf");
    fs.writeFileSync(scanPdf, Buffer.from(await scanDoc.save()));

    const out = await runFormForgeNodeEngine<{
      manifest: FieldManifest;
      ocrJobs: Array<{ wordCount: number; ocrEngine: string; status: string }>;
    }>("analyze", {
      pdfPath: scanPdf,
      options: { documentId: "bench_alv_scanned", dpi: 160 },
    });

    expect(out.manifest.isScanned).toBe(true);
    expect(out.manifest.pages[0].ocrApplied).toBe(true);
    expect(out.manifest.detectionSummary?.engineMode).toBe("node_cv_ocr_fusion");
    expect(out.ocrJobs.length).toBe(1);
    expect(out.ocrJobs[0].wordCount).toBeGreaterThan(80);

    const gtPage1 = loadAlvGroundTruth(0);
    const metrics = evaluateDetectionBenchmark(out.manifest.fields, gtPage1);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.9);
    expect(metrics.meanIoU).toBeGreaterThanOrEqual(0.8);
    expect(out.manifest.detectionSummary?.charGridGroupCount).toBeGreaterThanOrEqual(24);
  }, 45000);

  it("Scenario 3: Skewed (~2.1 deg) scanned form activates projection-profile deskewing and recovers form structure", async () => {
    // Build a clean synthetic form, rasterize, skew by 2.1 deg via ImageMagick, embed as image-only PDF
    const srcDoc = await PDFDocument.create();
    const p = srcDoc.addPage([595.28, 841.89]);
    const font = await srcDoc.embedFont(StandardFonts.HelveticaBold);
    const bodyFont = await srcDoc.embedFont(StandardFonts.Helvetica);

    p.drawText("MUNICIPAL PERMIT FORM", { x: 48, y: 785, size: 14, font });
    p.drawText("Full Name:", { x: 48, y: 730, size: 11, font: bodyFont });
    p.drawRectangle({ x: 160, y: 722, width: 320, height: 22, borderWidth: 1, borderColor: rgb(0, 0, 0) });

    p.drawText("Identity Code:", { x: 48, y: 680, size: 11, font: bodyFont });
    for (let i = 0; i < 8; i++) {
      p.drawRectangle({
        x: 160 + i * 20,
        y: 672,
        width: 20,
        height: 20,
        borderWidth: 1,
        borderColor: rgb(0, 0, 0),
      });
    }

    p.drawText("Confirm Eligibility:", { x: 48, y: 630, size: 11, font: bodyFont });
    p.drawRectangle({ x: 165, y: 626, width: 14, height: 14, borderWidth: 1, borderColor: rgb(0, 0, 0) });

    const flatPdf = path.join(tmpDir, "skew_src.pdf");
    fs.writeFileSync(flatPdf, Buffer.from(await srcDoc.save()));

    const { png: origPng, width: imgW, height: imgH } = await renderPdfPagePngBuffer(flatPdf, 0, 150);
    const loadedImg = await loadImage(origPng);
    const rotCanvas = createCanvas(imgW, imgH);
    const rctx = rotCanvas.getContext("2d");
    rctx.fillStyle = "#ffffff";
    rctx.fillRect(0, 0, imgW, imgH);
    rctx.translate(imgW / 2, imgH / 2);
    rctx.rotate((2.1 * Math.PI) / 180);
    rctx.drawImage(loadedImg, -imgW / 2, -imgH / 2);
    const skewedPng = rotCanvas.toBuffer("image/png");

    const skewedPdfDoc = await PDFDocument.create();
    const img = await skewedPdfDoc.embedPng(skewedPng);
    const sp = skewedPdfDoc.addPage([595.28, 841.89]);
    sp.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    const skewedPdf = path.join(tmpDir, "skewed_scan.pdf");
    fs.writeFileSync(skewedPdf, Buffer.from(await skewedPdfDoc.save()));

    const out = await runFormForgeNodeEngine<{ manifest: FieldManifest }>("analyze", {
      pdfPath: skewedPdf,
      options: { documentId: "bench_skewed", dpi: 150 },
    });

    expect(out.manifest.pages[0].ocrApplied).toBe(true);
    expect(Math.abs(out.manifest.pages[0].deskewAngle || 0)).toBeGreaterThanOrEqual(1.0);
    expect(out.manifest.fields.length).toBeGreaterThanOrEqual(3);
    expect(out.manifest.fields.some((f) => f.type === "char_cells")).toBe(true);
  }, 45000);

  it("Scenario 4: Unfamiliar multi-page mixed paper size (A4 + rotated 90° Letter CropBox) validates full AcroForm generation & round-trip", async () => {
    const doc = await PDFDocument.create();
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fontReg = await doc.embedFont(StandardFonts.Helvetica);

    // Page 1: A4 (595.28 x 841.89)
    const p1 = doc.addPage([595.28, 841.89]);
    // Shaded decorative header banner (must NOT become an input field)
    p1.drawRectangle({
      x: 40,
      y: 775,
      width: 515,
      height: 22,
      color: rgb(0.82, 0.82, 0.82),
      borderColor: rgb(0.2, 0.2, 0.2),
      borderWidth: 0.8,
    });
    p1.drawText("SECTION A: APPLICANT INFORMATION", { x: 48, y: 781, size: 10, font: fontBold });

    // 1. Standard text box
    p1.drawText("Applicant Name", { x: 40, y: 736, size: 10, font: fontReg });
    p1.drawRectangle({ x: 160, y: 728, width: 320, height: 22, borderWidth: 1, borderColor: rgb(0, 0, 0) });

    // 2. Tick-comb 8-cell passport number
    p1.drawText("Passport Number", { x: 40, y: 690, size: 10, font: fontReg });
    p1.drawLine({ start: { x: 160, y: 682 }, end: { x: 320, y: 682 }, thickness: 1 });
    for (let i = 0; i <= 8; i++) {
      p1.drawLine({
        start: { x: 160 + i * 20, y: 682 },
        end: { x: 160 + i * 20, y: 698 },
        thickness: 0.9,
      });
    }

    // 3. Spaced individual 5-cell postal code (individual_cells strategy)
    p1.drawText("Postal Code", { x: 40, y: 642, size: 10, font: fontReg });
    for (let i = 0; i < 5; i++) {
      p1.drawRectangle({
        x: 160 + i * 24,
        y: 634,
        width: 18,
        height: 18,
        borderWidth: 1,
        borderColor: rgb(0, 0, 0),
      });
    }

    // 4. Radio circles cluster
    p1.drawText("Contact Method", { x: 40, y: 594, size: 10, font: fontReg });
    p1.drawCircle({ x: 170, y: 597, size: 5.5, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    p1.drawText("Email", { x: 182, y: 594, size: 9.5, font: fontReg });
    p1.drawCircle({ x: 250, y: 597, size: 5.5, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    p1.drawText("Phone", { x: 262, y: 594, size: 9.5, font: fontReg });

    // 5. Square checkbox
    p1.drawRectangle({ x: 160, y: 548, width: 12, height: 12, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    p1.drawText("Accept terms", { x: 180, y: 550, size: 9.5, font: fontReg });

    // 6. Stacked 3-line multiline comments
    p1.drawText("Additional Remarks", { x: 40, y: 505, size: 10, font: fontReg });
    for (let k = 0; k < 3; k++) {
      p1.drawLine({
        start: { x: 160, y: 505 - k * 18 },
        end: { x: 480, y: 505 - k * 18 },
        thickness: 0.8,
      });
    }

    // 7. Dotted inline field
    p1.drawText("City . . . . . . . . . . . . . . . . . . . . . . . .", {
      x: 40,
      y: 420,
      size: 10,
      font: fontReg,
    });

    // 8. Deliberately unlabeled empty box far from any label (tests honest low-confidence flagging)
    p1.drawRectangle({ x: 360, y: 210, width: 140, height: 22, borderWidth: 1, borderColor: rgb(0, 0, 0) });

    // Page 2: Rotated 90 deg Letter with non-zero CropBox offset [36, 36, 648, 828]
    const p2 = doc.addPage([684, 864]);
    p2.setCropBox(36, 36, 612, 792);
    p2.setRotation(pdfDocRotation(90));
    // In unrotated user space, visual top-left after 90° CW corresponds to lower x / lower y -> draw in center safely
    p2.drawText("Signature:", { x: 200, y: 120, size: 10, font: fontReg });
    p2.drawRectangle({ x: 190, y: 200, width: 32, height: 180, borderWidth: 1, borderColor: rgb(0, 0, 0) });

    const mixedPdfPath = path.join(tmpDir, "unfamiliar_mixed.pdf");
    fs.writeFileSync(mixedPdfPath, Buffer.from(await doc.save()));

    const analysis = await runFormForgeNodeEngine<{ manifest: FieldManifest }>("analyze", {
      pdfPath: mixedPdfPath,
      options: { documentId: "bench_mixed" },
    });

    expect(analysis.manifest.totalPages).toBe(2);
    expect(analysis.manifest.pages[0].paperSize).toBe("A4");
    expect(analysis.manifest.pages[1].paperSize).toBe("Letter");
    expect(analysis.manifest.pages[1].rotation).toBe(90);

    const p1Fields = analysis.manifest.fields.filter((f) => f.page === 0);
    // Shaded banner should be excluded
    expect(p1Fields.some((f) => /section a/i.test(f.label))).toBe(false);
    // Comb + individual char grids detected accurately
    const passport = p1Fields.find((f) => f.type === "char_cells" && /passport/i.test(f.label));
    expect(passport).toBeDefined();
    expect(passport?.charGridMeta?.cellCount).toBe(8);
    expect(passport?.charGridMeta?.acroformStrategy).toBe("comb");

    const postal = p1Fields.find((f) => f.type === "char_cells" && /postal/i.test(f.label));
    expect(postal).toBeDefined();
    expect(postal?.charGridMeta?.cellCount).toBe(5);
    expect(postal?.charGridMeta?.acroformStrategy).toBe("individual_cells");

    // Radio group, checkbox, multiline, dotted city
    expect(p1Fields.some((f) => f.type === "radio")).toBe(true);
    expect(p1Fields.some((f) => f.type === "checkbox")).toBe(true);
    expect(p1Fields.some((f) => f.type === "multiline")).toBe(true);
    expect(p1Fields.some((f) => /city/i.test(f.label))).toBe(true);

    // Unlabeled box must be flagged honestly for review (low confidence)
    expect(analysis.manifest.detectionSummary?.reviewRecommendedCount).toBeGreaterThanOrEqual(1);
    const flaggedLow = analysis.manifest.fields.find(
      (f) => f.confidenceTier === "low" && Boolean(f.reviewFlagReason)
    );
    expect(flaggedLow).toBeDefined();

    // Generate genuine AcroForm + verify visual alignment + interactive fill/roundtrip
    const acroOutPath = path.join(tmpDir, "unfamiliar_acroform.pdf");
    const gen = await runFormForgeNodeEngine<{
      createdWidgets: number;
      validation: AcroFormValidationReport;
    }>("generate-acroform", {
      pdfPath: mixedPdfPath,
      manifest: analysis.manifest,
      outputPdfPath: acroOutPath,
    });

    expect(gen.createdWidgets).toBeGreaterThanOrEqual(8);
    expect(gen.validation.validPdf).toBe(true);
    expect(gen.validation.hasAcroFormDict).toBe(true);
    expect(gen.validation.roundTripWriteReadOk).toBe(true);
    expect(gen.validation.visualVerification?.passed).toBe(true);
    expect(gen.validation.visualVerification?.meanIoU).toBeGreaterThanOrEqual(0.85);
    expect(gen.validation.visualVerification?.duplicateWidgetNames.length).toBe(0);

    // Interactive write & reload verification via pdf-lib
    const loadedAcro = await PDFDocument.load(fs.readFileSync(acroOutPath));
    const tfName = p1Fields.find((f) => /applicant name/i.test(f.label))!.name;
    loadedAcro.getForm().getTextField(tfName).setText("Thabo Mokoena");
    const filledSaved = await loadedAcro.save();
    const reloaded = await PDFDocument.load(filledSaved);
    expect(reloaded.getForm().getTextField(tfName).getText()).toBe("Thabo Mokoena");
  });
});

function pdfDocRotation(angle: number) {
  return { type: "degrees" as const, angle } as any;
}
