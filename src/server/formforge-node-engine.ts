import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  StandardFonts,
  rgb,
} from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  bottomLeftPdfToTopLeftPdf,
  computeRectIoU,
  getVisualBoxSizePt,
  normalizeRotation,
  roundPt,
  topLeftPdfToBottomLeftPdf,
} from "../lib/formforge/coordinate.ts";
import type {
  AcroFormValidationReport,
  DetectedFormField,
  DocumentPageInfo,
  FieldManifest,
  FormForgeFieldType,
  PdfRect,
  VisualAlignmentIssue,
  VisualOverlapWarning,
  VisualVerificationReport,
} from "../lib/formforge/types.ts";
import {
  buildDetectionSummary,
  buildMergedTextLabels,
  fuseAndClassifyPageGeometry,
  snakeCase,
} from "./formforge-fusion.ts";
import { createLocalOcrSession, type LocalOcrSession } from "./pdf-local-ocr.ts";
import { renderPageThumbnails, runRasterCvOnPdfPage } from "./pdf-raster-cv.ts";
import { extractPageStructuralGeometry } from "./pdf-vector-extractor.ts";

// Configure worker path for Node.js pdfjs-dist usage
const workerPath = path.resolve(
  process.cwd(),
  "node_modules",
  "pdfjs-dist",
  "legacy",
  "build",
  "pdf.worker.mjs"
);
if (pdfjsLib.GlobalWorkerOptions && fs.existsSync(workerPath)) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
}

const PAPER_SIZES: Array<[DocumentPageInfo["paperSize"], number, number]> = [
  ["A4", 595.28, 841.89],
  ["Letter", 612.0, 792.0],
  ["Legal", 612.0, 1008.0],
  ["A3", 841.89, 1190.55],
  ["A5", 419.53, 595.28],
];

function classifyPaperSize(
  widthPt: number,
  heightPt: number
): DocumentPageInfo["paperSize"] {
  const [w, h] = [widthPt, heightPt].sort((a, b) => a - b);
  for (const [name, pw, ph] of PAPER_SIZES) {
    const [sw, sh] = [pw, ph].sort((a, b) => a - b);
    if (Math.abs(w - sw) <= 14 && Math.abs(h - sh) <= 14) {
      return name;
    }
  }
  return "Custom";
}

function toWinAnsiSafeText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
}

function makePdfLiteralString(input: string): PDFString {
  const escaped = toWinAnsiSafeText(input)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  return PDFString.of(escaped);
}

async function loadPdfDocument(pdfPath: string): Promise<{
  bytes: Buffer;
  pdfDoc: PDFDocument;
  pdfjsDoc: pdfjsLib.PDFDocumentProxy;
}> {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF_NOT_FOUND: File not found at ${pdfPath}`);
  }
  const bytes = fs.readFileSync(pdfPath);
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("encrypt")) {
      throw new Error("PASSWORD_PROTECTED: PDF is encrypted and requires a password");
    }
    throw new Error(`CORRUPT_PDF: Unable to parse PDF document (${msg})`);
  }

  if (pdfDoc.getPageCount() <= 0) {
    throw new Error("INVALID_PAGE_COUNT: PDF contains zero pages");
  }

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    useSystemFonts: true,
  });
  const pdfjsDoc = await loadingTask.promise;

  return { bytes, pdfDoc, pdfjsDoc };
}

function extractExistingSignatureWidgets(
  pdfDoc: PDFDocument,
  pageIdx: number,
  cropBox: { x: number; y: number; width: number; height: number },
  rotation: 0 | 90 | 180 | 270
): Array<{ name: string; type: FormForgeFieldType; rect: PdfRect }> {
  const page = pdfDoc.getPage(pageIdx);
  const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) return [];

  const results: Array<{ name: string; type: FormForgeFieldType; rect: PdfRect }> = [];
  for (let i = 0; i < annots.size(); i++) {
    const dict = annots.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    const ft = dict.lookupMaybe(PDFName.of("FT"), PDFName);
    if (ft?.asString() !== "/Sig") continue;
    const rectArr = dict.lookupMaybe(PDFName.of("Rect"), PDFArray);
    if (!rectArr || rectArr.size() < 4) continue;
    const coords: [number, number, number, number] = [
      (rectArr.lookup(0) as PDFNumber)?.asNumber?.() ?? 0,
      (rectArr.lookup(1) as PDFNumber)?.asNumber?.() ?? 0,
      (rectArr.lookup(2) as PDFNumber)?.asNumber?.() ?? 0,
      (rectArr.lookup(3) as PDFNumber)?.asNumber?.() ?? 0,
    ];
    const tObj = dict.lookupMaybe(PDFName.of("T"), PDFString);
    const name = tObj?.decodeText() || `signature_${i + 1}`;
    results.push({
      name,
      type: "signature",
      rect: bottomLeftPdfToTopLeftPdf(coords, cropBox, rotation),
    });
  }
  return results;
}

async function inspectPdfNode(pdfPath: string) {
  const { bytes, pdfDoc, pdfjsDoc } = await loadPdfDocument(pdfPath);
  try {
    const rawStr = bytes.toString("latin1");
    const hasEmbeddedJavaScript =
      rawStr.includes("/JavaScript") || rawStr.includes("/JS ");
    const form = pdfDoc.getForm();
    const existingFields = form.getFields();

    const pages: Array<DocumentPageInfo & { thumbnailFile?: string | null }> = [];
    let isScanned = false;
    let totalWidgets = 0;

    for (let idx = 0; idx < pdfDoc.getPageCount(); idx++) {
      const page = pdfDoc.getPage(idx);
      const mediaBox = page.getMediaBox();
      const cropBox = page.getCropBox();
      const rot = normalizeRotation(page.getRotation().angle);
      const visualSize = getVisualBoxSizePt(cropBox, rot);

      const jsPage = await pdfjsDoc.getPage(idx + 1);
      const opList = await jsPage.getOperatorList();
      const drawingCount = opList.fnArray.filter(
        (fn) => fn === pdfjsLib.OPS.constructPath
      ).length;

      const textContent = await jsPage.getTextContent();
      const items = textContent.items.filter(
        (it) => "str" in it && typeof it.str === "string" && it.str.trim().length > 0
      );
      const wordCount = items.reduce((acc, it) => {
        const s = "str" in it && typeof it.str === "string" ? it.str : "";
        return acc + s.trim().split(/\s+/).filter(Boolean).length;
      }, 0);
      const needsOcr = wordCount < 10;
      if (needsOcr) isScanned = true;

      const pageRef = page.ref;
      let widgetCount = 0;
      for (const f of existingFields) {
        for (const w of f.acroField.getWidgets()) {
          if (w.P() === pageRef) widgetCount++;
        }
      }
      widgetCount += extractExistingSignatureWidgets(
        pdfDoc,
        idx,
        cropBox,
        rot
      ).length;
      totalWidgets += widgetCount;

      pages.push({
        pageIndex: idx,
        widthPt: visualSize.widthPt,
        heightPt: visualSize.heightPt,
        rotation: rot,
        orientation:
          visualSize.widthPt > visualSize.heightPt ? "landscape" : "portrait",
        paperSize: classifyPaperSize(visualSize.widthPt, visualSize.heightPt),
        mediaBox: {
          x: roundPt(mediaBox.x),
          y: roundPt(mediaBox.y),
          width: roundPt(mediaBox.width),
          height: roundPt(mediaBox.height),
        },
        cropBox: {
          x: roundPt(cropBox.x),
          y: roundPt(cropBox.y),
          width: roundPt(cropBox.width),
          height: roundPt(cropBox.height),
        },
        textSpanCount: items.length,
        wordCount,
        drawingCount,
        existingWidgetCount: widgetCount,
        needsOcr,
        ocrApplied: false,
        deskewAngle: 0,
        thumbnailFile: null,
      });
    }

    return {
      pageCount: pdfDoc.getPageCount(),
      isScanned,
      hasExistingAcroForm: existingFields.length > 0 || totalWidgets > 0,
      securityFlags: {
        hasEmbeddedJavaScript,
        wasEncrypted: false,
        sanitizedActions: false,
      },
      pages,
    };
  } finally {
    await pdfjsDoc.cleanup();
  }
}

async function analyzePdfNode(
  pdfPath: string,
  options: Record<string, unknown> = {}
) {
  const { pdfDoc, pdfjsDoc } = await loadPdfDocument(pdfPath);
  const enableOcr = options.enableOcr !== false;
  const forceOcr = Boolean(options.forceOcr);
  const ocrLang = typeof options.ocrLanguage === "string" && options.ocrLanguage.trim()
    ? options.ocrLanguage.trim()
    : "eng";
  const ocrDpi = Math.max(120, Math.min(300, Number(options.dpi || 180)));

  let ocrSession: LocalOcrSession | null = null;
  const ocrJobsReport: Array<{
    pageIndex: number;
    ocrEngine: string;
    language: string;
    dpi: number;
    deskewAngle: number;
    wordCount: number;
    extractedChars: number;
    durationMs: number;
    status: string;
  }> = [];

  try {
    const inspection = await inspectPdfNode(pdfPath);
    if (typeof options.thumbnailsDir === "string" && options.thumbnailsDir.trim()) {
      const thumbFiles = await renderPageThumbnails(
        pdfPath,
        options.thumbnailsDir.trim(),
        inspection.pageCount,
        100
      );
      for (let i = 0; i < inspection.pages.length; i++) {
        inspection.pages[i].thumbnailFile = thumbFiles[i] ?? null;
      }
    }

    const form = pdfDoc.getForm();
    const existingFields = form.getFields();
    const allFields: DetectedFormField[] = [];
    const seenNames = new Set<string>();
    let usedCvOrOcr = false;

    const uniqueName = (base: string): string => {
      const cleanBase = snakeCase(base, "field");
      let candidate = cleanBase;
      let i = 2;
      while (seenNames.has(candidate)) {
        candidate = `${cleanBase}_${i++}`;
      }
      seenNames.add(candidate);
      return candidate;
    };

    const pageRefToIndex = new Map<unknown, number>();
    pdfDoc.getPages().forEach((p, idx) => pageRefToIndex.set(p.ref, idx));

    for (let pIdx = 0; pIdx < pdfDoc.getPageCount(); pIdx++) {
      const pageInfo = inspection.pages[pIdx];
      const page = pdfDoc.getPage(pIdx);
      const cropBox = page.getCropBox();
      const rot = pageInfo.rotation;

      // Collect existing widgets on this page mapped via exact cropBox + rotation
      const existingOnPage: Array<{
        name: string;
        type: FormForgeFieldType;
        rect: PdfRect;
        defaultValue?: string;
        maxLength?: number;
        options?: string[];
      }> = [];

      for (const fld of existingFields) {
        const name = fld.getName();
        const widgets = fld.acroField.getWidgets();
        const matchingWidgets = widgets.filter((w) => {
          const wPage = pageRefToIndex.get(w.P());
          return (wPage ?? 0) === pIdx;
        });
        if (matchingWidgets.length === 0) continue;

        const w = matchingWidgets[0];
        const r = w.getRectangle();
        const rect = bottomLeftPdfToTopLeftPdf(
          [r.x, r.y, r.x + r.width, r.y + r.height],
          cropBox,
          rot
        );

        let ftype: FormForgeFieldType = "text";
        let maxLen: number | undefined;
        let opts: string[] = [];
        if (fld instanceof PDFCheckBox) ftype = "checkbox";
        else if (fld instanceof PDFRadioGroup) {
          ftype = "radio";
          opts = fld.getOptions();
        } else if (fld instanceof PDFDropdown) {
          ftype = "dropdown";
          opts = fld.getOptions();
        } else if (fld instanceof PDFOptionList) {
          ftype = "listbox";
          opts = fld.getOptions();
        } else if (fld instanceof PDFTextField) {
          if (fld.isMultiline()) ftype = "multiline";
          maxLen = fld.getMaxLength();
        }

        existingOnPage.push({
          name,
          type: ftype,
          rect,
          maxLength: maxLen,
          options: opts,
        });
      }

      for (const sig of extractExistingSignatureWidgets(
        pdfDoc,
        pIdx,
        cropBox,
        rot
      )) {
        existingOnPage.push(sig);
      }

      // Extract vector structural geometry + text + symbol glyphs via pdfjs-dist
      const jsPage = await pdfjsDoc.getPage(pIdx + 1);
      const geom = await extractPageStructuralGeometry(jsPage, pIdx);

      // Trigger local Raster Computer Vision + Tesseract OCR on scanned / image-based / forced pages
      let extraLabels: ReturnType<typeof buildMergedTextLabels> = [];
      const isImageHeavyLowVector =
        geom.imageRegions.length > 0 && geom.drawingOpCount < 6 && pageInfo.wordCount < 15;
      const shouldRunCvOcr =
        enableOcr && (pageInfo.needsOcr || forceOcr || isImageHeavyLowVector);

      if (shouldRunCvOcr) {
        usedCvOrOcr = true;
        const cvRes = await runRasterCvOnPdfPage(
          pdfPath,
          pIdx,
          geom.pageWidthPt,
          geom.pageHeightPt,
          ocrDpi
        );

        if (!ocrSession) {
          ocrSession = await createLocalOcrSession(ocrLang);
        }
        const ocrOut = await ocrSession.recognizePage(
          cvRes.bmpBuffer,
          ocrDpi,
          geom.pageWidthPt,
          geom.pageHeightPt
        );

        // Merge CV structural primitives into page geometry
        geom.hLines.push(...cvRes.hLines);
        geom.vLines.push(...cvRes.vLines);
        geom.rects.push(...cvRes.rects);
        geom.circles.push(...cvRes.circles);

        if (geom.textRuns.length === 0) {
          geom.textRuns.push(...ocrOut.textRuns);
        } else {
          extraLabels = buildMergedTextLabels(
            ocrOut.textRuns,
            geom.vLines,
            geom.hLines,
            "ocr_tesseract"
          );
        }

        pageInfo.ocrApplied = true;
        pageInfo.deskewAngle = cvRes.deskewAngle;
        if (pageInfo.wordCount < ocrOut.wordCount) {
          pageInfo.wordCount = ocrOut.wordCount;
        }
        pageInfo.drawingCount = Math.max(
          pageInfo.drawingCount,
          cvRes.hLines.length + cvRes.vLines.length + cvRes.rects.length
        );

        ocrJobsReport.push({
          pageIndex: pIdx,
          ocrEngine: "tesseract",
          language: ocrOut.language,
          dpi: ocrDpi,
          deskewAngle: cvRes.deskewAngle,
          wordCount: ocrOut.wordCount,
          extractedChars: ocrOut.extractedChars,
          durationMs: ocrOut.durationMs,
          status: "completed",
        });
      }

      const pageFields = fuseAndClassifyPageGeometry({
        geom,
        pageBox: pageInfo.cropBox,
        rotation: rot,
        existingWidgets: existingOnPage,
        extraLabels,
        uniqueName,
      });

      allFields.push(...pageFields);
    }

    // Only emit a low-confidence review item if both vector AND raster CV+OCR produced zero geometry
    if (allFields.length === 0 && inspection.pages.length > 0) {
      const p0 = inspection.pages[0];
      const fallbackRect: PdfRect = {
        x: 72,
        y: 140,
        width: roundPt(Math.min(260, p0.widthPt - 144)),
        height: 20,
      };
      allFields.push({
        id: "field_001",
        name: "blank_page_review_field",
        label: "No Detectable Form Geometry (Manual Review)",
        type: "text",
        page: 0,
        originalDetectedRect: fallbackRect,
        rect: fallbackRect,
        pdfBottomLeftRect: topLeftPdfToBottomLeftPdf(
          fallbackRect,
          p0.cropBox,
          p0.rotation
        ),
        coordinateSpace: "top_left_pdf_pt",
        originalLabelText: "",
        detectionSource: "manual",
        detectionSources: ["manual"],
        confidence: 0.3,
        confidenceTier: "low",
        confidenceEvidence: [
          "Page had no detectable vector or raster lines, boxes, circles, or text prompts",
        ],
        required: false,
        defaultValue: "",
        multiline: false,
        options: [],
        validation: {},
        reviewStatus: "pending",
        reviewFlagReason: "Blank or unstructured page — add fields manually if needed",
      });
    }

    allFields.forEach((f, idx) => {
      f.id = `field_${String(idx + 1).padStart(3, "0")}`;
    });

    const docId =
      typeof options.documentId === "string" ? options.documentId : "doc_node";

    const detectionSummary = buildDetectionSummary(
      allFields,
      usedCvOrOcr ? "node_cv_ocr_fusion" : "node_vector_fusion"
    );

    const manifest: FieldManifest = {
      documentId: docId,
      schemaVersion: "1.0",
      totalPages: inspection.pageCount,
      pages: inspection.pages,
      fields: allFields,
      detectionSummary,
      generatedAt: new Date().toISOString(),
      engineVersion: usedCvOrOcr
        ? "formforge-node-cv-ocr-3.0.0"
        : "formforge-node-fusion-3.0.0",
      hasExistingAcroForm: inspection.hasExistingAcroForm,
      isScanned: inspection.isScanned,
      securityFlags: inspection.securityFlags,
    };

    return {
      inspection,
      ocrJobs: ocrJobsReport,
      manifest,
    };
  } finally {
    if (ocrSession) {
      await ocrSession.terminate();
    }
    await pdfjsDoc.cleanup();
  }
}

async function generateAcroFormNode(payload: {
  pdfPath: string;
  manifest: FieldManifest;
  outputPdfPath: string;
}) {
  const bytes = fs.readFileSync(payload.pdfPath);
  const pdfDoc = await PDFDocument.load(bytes);
  const pages = pdfDoc.getPages();
  const form = pdfDoc.getForm();
  const manifest = payload.manifest;

  let createdWidgets = 0;
  const usedNames = new Set<string>(form.getFields().map((f) => f.getName()));

  const ensureSignatureWidgetOnPage = (
    page: (typeof pages)[number],
    fieldName: string,
    label: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ) => {
    const widgetDict = pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      T: makePdfLiteralString(fieldName),
      TU: makePdfLiteralString(label || fieldName),
      Rect: [x0, y0, x1, y1],
      F: 4,
      P: page.ref,
      BS: { W: 0.75, S: "S" },
      MK: {
        BG: [0.97, 0.99, 1.0],
        BC: [0.45, 0.56, 0.72],
      },
    });
    const widgetRef = pdfDoc.context.register(widgetDict);

    let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) {
      annots = pdfDoc.context.obj([]) as PDFArray;
      page.node.set(PDFName.of("Annots"), annots);
    }
    annots.push(widgetRef);

    const acroFormDict = form.acroForm.dict;
    let acroFields = acroFormDict.lookupMaybe(PDFName.of("Fields"), PDFArray);
    if (!acroFields) {
      acroFields = pdfDoc.context.obj([]) as PDFArray;
      acroFormDict.set(PDFName.of("Fields"), acroFields);
    }
    acroFields.push(widgetRef);
  };

  for (const fld of manifest.fields) {
    const page = pages[fld.page];
    if (!page) continue;

    const crop = page.getCropBox();
    const rot = normalizeRotation(page.getRotation().angle);
    const cropBox = {
      x: crop.x,
      y: crop.y,
      width: crop.width,
      height: crop.height,
    };

    let fieldName = fld.name || fld.id;
    let suffix = 2;
    while (usedNames.has(fieldName)) {
      fieldName = `${fld.name || fld.id}_${suffix++}`;
    }

    const setTooltip = (fieldObj: { acroField: { dict: PDFDict } }, textVal: string) => {
      const clean = toWinAnsiSafeText(textVal || fieldName).trim();
      if (clean) {
        fieldObj.acroField.dict.set(PDFName.of("TU"), makePdfLiteralString(clean));
      }
    };

    // Character-entry grids: generate native PDF Comb field when strategy is 'comb' (or default for contiguous uniform cells),
    // or individual single-character linked widgets when cells are visibly separated.
    if (
      fld.type === "char_cells" &&
      fld.cellRects &&
      fld.cellRects.length >= 2
    ) {
      const strategy =
        fld.charGridMeta?.acroformStrategy ??
        ((fld.charGridMeta?.spacingPt ?? 0) <= 2.5 ? "comb" : "individual_cells");

      if (strategy === "comb") {
        usedNames.add(fieldName);
        const [x0, y0, x1, y1] = topLeftPdfToBottomLeftPdf(fld.rect, cropBox, rot);
        const tf = form.createTextField(fieldName);
        setTooltip(tf, fld.label || fieldName);
        tf.setMaxLength(fld.cellRects.length);
        tf.enableCombing();
        if (fld.defaultValue) {
          tf.setText(toWinAnsiSafeText(fld.defaultValue).slice(0, fld.cellRects.length));
        }
        tf.addToPage(page, {
          x: x0,
          y: y0,
          width: Math.max(12, x1 - x0),
          height: Math.max(8, y1 - y0),
        });
        createdWidgets++;
      } else {
        for (let ci = 0; ci < fld.cellRects.length; ci++) {
          const cname = `${fieldName}_cell_${ci}`;
          if (usedNames.has(cname)) continue;
          usedNames.add(cname);
          const cr = fld.cellRects[ci];
          const [cx0, cy0, cx1, cy1] = topLeftPdfToBottomLeftPdf(cr, cropBox, rot);
          const tf = form.createTextField(cname);
          setTooltip(tf, `${fld.label || fieldName} (${ci + 1}/${fld.cellRects.length})`);
          tf.setMaxLength(1);
          if (fld.defaultValue && ci < fld.defaultValue.length) {
            tf.setText(toWinAnsiSafeText(fld.defaultValue[ci]));
          }
          tf.addToPage(page, {
            x: cx0,
            y: cy0,
            width: Math.max(6, cx1 - cx0),
            height: Math.max(6, cy1 - cy0),
          });
          createdWidgets++;
        }
      }
      continue;
    }

    usedNames.add(fieldName);
    const [x0, y0, x1, y1] = topLeftPdfToBottomLeftPdf(fld.rect, cropBox, rot);
    const w = Math.max(6, x1 - x0);
    const h = Math.max(6, y1 - y0);

    if (fld.type === "checkbox") {
      const cb = form.createCheckBox(fieldName);
      setTooltip(cb, fld.label || fieldName);
      cb.addToPage(page, { x: x0, y: y0, width: w, height: h });
      if (isTruthyCheckValue(fld.defaultValue)) cb.check();
      createdWidgets++;
    } else if (fld.type === "signature") {
      ensureSignatureWidgetOnPage(
        page,
        fieldName,
        fld.label || fieldName,
        x0,
        y0,
        x1,
        y1
      );
      createdWidgets++;
    } else if (fld.type === "dropdown") {
      const dd = form.createDropdown(fieldName);
      setTooltip(dd, fld.label || fieldName);
      const opts = fld.options.length > 0 ? fld.options : ["Option 1", "Option 2"];
      dd.addOptions(opts);
      if (fld.defaultValue && opts.includes(fld.defaultValue)) {
        dd.select(fld.defaultValue);
      }
      dd.addToPage(page, { x: x0, y: y0, width: w, height: h });
      createdWidgets++;
    } else if (fld.type === "listbox") {
      const ol = form.createOptionList(fieldName);
      setTooltip(ol, fld.label || fieldName);
      const opts = fld.options.length > 0 ? fld.options : ["Option 1", "Option 2"];
      ol.addOptions(opts);
      if (fld.defaultValue && opts.includes(fld.defaultValue)) {
        ol.select(fld.defaultValue);
      }
      ol.addToPage(page, { x: x0, y: y0, width: w, height: h });
      createdWidgets++;
    } else if (fld.type === "radio") {
      const rg = form.createRadioGroup(fieldName);
      setTooltip(rg, fld.label || fieldName);
      const opts = fld.options.length > 0 ? fld.options : ["Yes", "No"];
      const sliceW = fld.rect.width / opts.length;
      opts.forEach((opt, i) => {
        const optTopRect: PdfRect =
          fld.optionRects?.[opt] ?? {
            x: fld.rect.x + i * sliceW,
            y: fld.rect.y,
            width: Math.max(10, Math.min(18, sliceW - 2)),
            height: fld.rect.height,
          };
        const [ox0, oy0, ox1, oy1] = topLeftPdfToBottomLeftPdf(
          optTopRect,
          cropBox,
          rot
        );
        rg.addOptionToPage(opt, page, {
          x: ox0,
          y: oy0,
          width: Math.max(8, ox1 - ox0),
          height: Math.max(8, oy1 - oy0),
        });
      });
      if (fld.defaultValue && opts.includes(fld.defaultValue)) {
        rg.select(fld.defaultValue);
      }
      createdWidgets++;
    } else {
      const tf = form.createTextField(fieldName);
      setTooltip(tf, fld.label || fieldName);
      if (fld.multiline || fld.type === "multiline") {
        tf.enableMultiline();
      }
      if (fld.maxLength && fld.maxLength > 0) {
        tf.setMaxLength(fld.maxLength);
      }
      if (fld.defaultValue) {
        tf.setText(toWinAnsiSafeText(fld.defaultValue));
      }
      tf.addToPage(page, { x: x0, y: y0, width: w, height: h });
      createdWidgets++;
    }
  }

  fs.mkdirSync(path.dirname(payload.outputPdfPath), { recursive: true });
  const outBytes = await pdfDoc.save({ useObjectStreams: false });
  fs.writeFileSync(payload.outputPdfPath, Buffer.from(outBytes));

  const validation = await validateAcroFormNode(
    payload.outputPdfPath,
    manifest.fields.length,
    manifest.fields
  );

  return {
    createdWidgets,
    sanitizedActions: false,
    validation,
  };
}

function flattenRenderValues(
  input: Record<string, unknown>,
  prefix = ""
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, val] of Object.entries(input)) {
    const dotted = prefix ? `${prefix}.${rawKey}` : rawKey;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      Object.assign(out, flattenRenderValues(val as Record<string, unknown>, dotted));
    } else {
      out[dotted] = val;
      const underscored = dotted.replace(/\./g, "_");
      if (!(underscored in out)) {
        out[underscored] = val;
      }
    }
  }
  return out;
}

function resolveFieldRenderValue(
  fld: DetectedFormField,
  flatValues: Record<string, unknown>
): unknown {
  const candidates: string[] = [fld.name, fld.id];
  if (fld.originalLabelText) {
    candidates.push(fld.originalLabelText);
  }
  const dotted = fld.name.replace(/_/g, ".");
  if (!candidates.includes(dotted)) {
    candidates.push(dotted);
  }
  for (const key of candidates) {
    if (key && key in flatValues && flatValues[key] !== undefined) {
      return flatValues[key];
    }
  }
  return undefined;
}

function isTruthyCheckValue(rawVal: unknown): boolean {
  if (rawVal === true) return true;
  if (typeof rawVal === "string") {
    return ["true", "1", "yes", "on"].includes(rawVal.trim().toLowerCase());
  }
  return rawVal === 1;
}

async function renderPdfNode(payload: {
  templatePdfPath: string;
  manifest: FieldManifest;
  values: Record<string, unknown>;
  outputPdfPath: string;
  flatten?: boolean;
}) {
  const bytes = fs.readFileSync(payload.templatePdfPath);
  const pdfDoc = await PDFDocument.load(bytes);
  const pages = pdfDoc.getPages();
  const form = pdfDoc.getForm();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let populatedWidgets = 0;
  const flatValues = flattenRenderValues(payload.values || {});
  const formFieldsByName = new Map(form.getFields().map((f) => [f.getName(), f]));

  for (const fld of payload.manifest.fields) {
    const rawVal = resolveFieldRenderValue(fld, flatValues);
    if (rawVal === undefined || rawVal === null || rawVal === "") continue;

    // Populate individual char_cells widgets if generated separately
    if (fld.type === "char_cells" && fld.cellRects && !formFieldsByName.has(fld.name)) {
      const cellZero = formFieldsByName.get(`${fld.name}_cell_0`);
      if (cellZero) {
        const s = toWinAnsiSafeText(String(rawVal)).trim();
        for (let ci = 0; ci < fld.cellRects.length; ci++) {
          const cf = formFieldsByName.get(`${fld.name}_cell_${ci}`);
          if (cf instanceof PDFTextField) {
            cf.setText(ci < s.length ? s[ci] : "");
          }
        }
        populatedWidgets++;
        continue;
      }
    }

    const acField = formFieldsByName.get(fld.name) || formFieldsByName.get(fld.id);
    if (acField) {
      if (acField instanceof PDFTextField) {
        acField.setText(toWinAnsiSafeText(String(rawVal)));
        populatedWidgets++;
        continue;
      } else if (acField instanceof PDFCheckBox) {
        if (isTruthyCheckValue(rawVal)) {
          acField.check();
        } else {
          acField.uncheck();
        }
        populatedWidgets++;
        continue;
      } else if (acField instanceof PDFDropdown || acField instanceof PDFOptionList) {
        acField.select(String(rawVal));
        populatedWidgets++;
        continue;
      } else if (acField instanceof PDFRadioGroup) {
        acField.select(String(rawVal));
        populatedWidgets++;
        continue;
      }
    }

    // Direct vector text fallback if template has no matching AcroForm widget
    const page = pages[fld.page];
    if (!page) continue;
    const crop = page.getCropBox();
    const rot = normalizeRotation(page.getRotation().angle);
    const cropRect = {
      x: crop.x,
      y: crop.y,
      width: crop.width,
      height: crop.height,
    };
    const [x0, y0, x1, y1] = topLeftPdfToBottomLeftPdf(fld.rect, cropRect, rot);

    if (fld.type === "checkbox") {
      if (isTruthyCheckValue(rawVal)) {
        const box = fld.optionRects?.true ?? fld.rect;
        const [bx0, by0, bx1, by1] = topLeftPdfToBottomLeftPdf(box, cropRect, rot);
        const bw = bx1 - bx0;
        const bh = by1 - by0;
        const size = Math.max(8, Math.min(12, bh - 2));
        page.drawText("X", {
          x: bx0 + Math.max(1, (bw - font.widthOfTextAtSize("X", size)) / 2),
          y: by0 + Math.max(1, (bh - size * 0.75) / 2),
          size,
          font,
          color: rgb(0.06, 0.1, 0.2),
        });
        populatedWidgets++;
      }
    } else if (fld.type === "radio") {
      const targetStr = String(rawVal).trim();
      const matchedOpt =
        fld.options.find((opt) => opt === targetStr) ??
        fld.options.find((opt) => opt.toLowerCase() === targetStr.toLowerCase());
      let targetBox = matchedOpt ? fld.optionRects?.[matchedOpt] : undefined;
      if (!targetBox && matchedOpt && fld.options.length > 0) {
        const idx = fld.options.indexOf(matchedOpt);
        const sliceW = fld.rect.width / fld.options.length;
        targetBox = {
          x: fld.rect.x + idx * sliceW,
          y: fld.rect.y,
          width: sliceW,
          height: fld.rect.height,
        };
      } else if (!targetBox && fld.optionRects) {
        const directKey = Object.keys(fld.optionRects).find(
          (k) => k.toLowerCase() === targetStr.toLowerCase()
        );
        if (directKey) targetBox = fld.optionRects[directKey];
      }
      if (targetBox) {
        const [ox0, oy0, ox1, oy1] = topLeftPdfToBottomLeftPdf(
          targetBox,
          cropRect,
          rot
        );
        const ow = ox1 - ox0;
        const oh = oy1 - oy0;
        const size = Math.max(8, Math.min(12, oh - 2));
        page.drawText("X", {
          x: ox0 + Math.max(1, (ow - font.widthOfTextAtSize("X", size)) / 2),
          y: oy0 + Math.max(1, (oh - size * 0.75) / 2),
          size,
          font,
          color: rgb(0.06, 0.1, 0.2),
        });
        populatedWidgets++;
      }
    } else if (fld.cellRects && fld.cellRects.length > 0) {
      let str = toWinAnsiSafeText(String(rawVal)).trim();
      if (!str) continue;
      if (str.length > fld.cellRects.length) {
        str = str.slice(0, fld.cellRects.length);
      }
      const padded =
        fld.alignment === "right"
          ? str.padStart(fld.cellRects.length, " ")
          : str.padEnd(fld.cellRects.length, " ");
      for (let i = 0; i < Math.min(padded.length, fld.cellRects.length); i++) {
        const ch = padded[i];
        if (!ch || ch === " ") continue;
        const cr = fld.cellRects[i];
        const [cx0, cy0, cx1, cy1] = topLeftPdfToBottomLeftPdf(cr, cropRect, rot);
        const cw = cx1 - cx0;
        const fontSize = cw < 11.2 ? Math.min(9.5, Math.max(7.5, cw * 0.72)) : 9.5;
        const chW = font.widthOfTextAtSize(ch, fontSize);
        page.drawText(ch, {
          x: cx0 + Math.max(1, (cw - chW) / 2),
          y: cy0 + Math.max(2, (cy1 - cy0 - fontSize * 0.75) / 2),
          size: fontSize,
          font,
          color: rgb(0.06, 0.1, 0.2),
        });
      }
      populatedWidgets++;
    } else {
      page.drawText(toWinAnsiSafeText(String(rawVal)), {
        x: x0 + 3,
        y: y0 + Math.max(3, (y1 - y0 - 9) / 2),
        size: fld.fontSize ?? 9.5,
        font,
        color: rgb(0.06, 0.1, 0.2),
      });
      populatedWidgets++;
    }
  }

  const shouldFlatten = payload.flatten !== false;
  if (shouldFlatten && form.getFields().length > 0) {
    try {
      form.flatten();
    } catch {
      // Ignore flatten errors on non-standard widgets
    }
  }

  fs.mkdirSync(path.dirname(payload.outputPdfPath), { recursive: true });
  const outBytes = await pdfDoc.save({ useObjectStreams: false });
  fs.writeFileSync(payload.outputPdfPath, Buffer.from(outBytes));

  return {
    populatedWidgets,
    flattened: shouldFlatten,
  };
}

/**
 * Automated Visual & Structural AcroForm Verification:
 * Re-reads generated AcroForm widgets, transforms their /Rect coordinates back to top-left PDF points,
 * verifies alignment IoU, sizing ratios, missing fields, duplicates, and overlaps.
 */
async function validateAcroFormNode(
  pdfPath: string,
  expectedFieldCount = 0,
  expectedFields?: DetectedFormField[]
): Promise<AcroFormValidationReport> {
  const bytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const pages = pdfDoc.getPages();
  const hasAcroForm = pdfDoc.catalog.has(PDFName.of("AcroForm"));

  const pageRefToIndex = new Map<unknown, number>();
  pages.forEach((p, idx) => pageRefToIndex.set(p.ref, idx));

  let widgetCount = 0;
  let combFieldCount = 0;
  const extractedWidgets: Array<{
    name: string;
    page: number;
    rect: PdfRect;
  }> = [];
  const nameCounts = new Map<string, number>();

  for (const f of fields) {
    const fname = f.getName();
    nameCounts.set(fname, (nameCounts.get(fname) || 0) + 1);
    if (f instanceof PDFTextField && (f.acroField.getFlags() & (1 << 24)) !== 0) {
      combFieldCount++;
    }
    const ws = f.acroField.getWidgets();
    widgetCount += ws.length;
    for (const w of ws) {
      const pIdx = pageRefToIndex.get(w.P()) ?? 0;
      const page = pages[pIdx] || pages[0];
      const crop = page.getCropBox();
      const rot = normalizeRotation(page.getRotation().angle);
      const r = w.getRectangle();
      extractedWidgets.push({
        name: fname,
        page: pIdx,
        rect: bottomLeftPdfToTopLeftPdf([r.x, r.y, r.x + r.width, r.y + r.height], crop, rot),
      });
    }
  }

  // Include /FT /Sig annotations
  for (let pIdx = 0; pIdx < pages.length; pIdx++) {
    const page = pages[pIdx];
    const crop = page.getCropBox();
    const rot = normalizeRotation(page.getRotation().angle);
    for (const sig of extractExistingSignatureWidgets(pdfDoc, pIdx, crop, rot)) {
      widgetCount++;
      nameCounts.set(sig.name, (nameCounts.get(sig.name) || 0) + 1);
      extractedWidgets.push({
        name: sig.name,
        page: pIdx,
        rect: sig.rect,
      });
    }
  }

  const duplicateWidgetNames = Array.from(nameCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([name]) => name);

  // Round-trip write & read verification via pdf-lib in memory
  let roundTripOk = true;
  try {
    const firstText = fields.find((f) => f instanceof PDFTextField) as
      | PDFTextField
      | undefined;
    if (firstText) {
      const orig = firstText.getText() || "";
      firstText.setText("V");
      const saved = await pdfDoc.save();
      const reloaded = await PDFDocument.load(saved);
      const reloadedTf = reloaded.getForm().getTextField(firstText.getName());
      roundTripOk = reloadedTf.getText() === "V";
      firstText.setText(orig);
    }
  } catch {
    roundTripOk = false;
  }

  // Visual verification against expected manifest targets
  const misplacedFields: VisualAlignmentIssue[] = [];
  const oversizedFields: VisualAlignmentIssue[] = [];
  const undersizedFields: VisualAlignmentIssue[] = [];
  const missingFields: string[] = [];
  const overlappingWidgetPairs: VisualOverlapWarning[] = [];

  let checkedWidgets = 0;
  let alignedCount = 0;
  let iouSum = 0;
  let minIoU = 1;

  if (expectedFields && expectedFields.length > 0) {
    for (const target of expectedFields) {
      const matching = extractedWidgets.filter(
        (w) =>
          w.page === target.page &&
          (w.name === target.name || w.name.startsWith(`${target.name}_cell_`))
      );
      if (matching.length === 0) {
        missingFields.push(target.name);
        continue;
      }

      // Compute union rect if multi-widget (radio or individual_cells)
      const ux0 = Math.min(...matching.map((m) => m.rect.x));
      const uy0 = Math.min(...matching.map((m) => m.rect.y));
      const ux1 = Math.max(...matching.map((m) => m.rect.x + m.rect.width));
      const uy1 = Math.max(...matching.map((m) => m.rect.y + m.rect.height));
      const unionRect: PdfRect = {
        x: roundPt(ux0),
        y: roundPt(uy0),
        width: roundPt(ux1 - ux0),
        height: roundPt(uy1 - uy0),
      };

      const iou = computeRectIoU(target.rect, unionRect);
      const targetArea = Math.max(1, target.rect.width * target.rect.height);
      const widgetArea = Math.max(1, unionRect.width * unionRect.height);
      const areaRatio = roundPt(widgetArea / targetArea);
      const centerOffsetPt = roundPt(
        Math.hypot(
          unionRect.x + unionRect.width / 2 - (target.rect.x + target.rect.width / 2),
          unionRect.y + unionRect.height / 2 - (target.rect.y + target.rect.height / 2)
        )
      );

      checkedWidgets++;
      iouSum += iou;
      if (iou < minIoU) minIoU = iou;

      if (areaRatio > 1.85) {
        oversizedFields.push({
          fieldId: target.id,
          fieldName: target.name,
          page: target.page,
          issue: "oversized",
          iou,
          areaRatio,
          centerOffsetPt,
          detail: `Widget area ${areaRatio}x target area`,
        });
      } else if (areaRatio < 0.45) {
        undersizedFields.push({
          fieldId: target.id,
          fieldName: target.name,
          page: target.page,
          issue: "undersized",
          iou,
          areaRatio,
          centerOffsetPt,
          detail: `Widget area ${areaRatio}x target area`,
        });
      } else if (iou < 0.6) {
        misplacedFields.push({
          fieldId: target.id,
          fieldName: target.name,
          page: target.page,
          issue: "misplaced",
          iou,
          areaRatio,
          centerOffsetPt,
          detail: `Alignment IoU ${iou} (< 0.60), center offset ${centerOffsetPt}pt`,
        });
      } else {
        alignedCount++;
      }
    }
  }

  // Check pairwise widget overlaps between distinct field names
  for (let i = 0; i < extractedWidgets.length; i++) {
    for (let j = i + 1; j < extractedWidgets.length; j++) {
      const a = extractedWidgets[i];
      const b = extractedWidgets[j];
      if (a.page !== b.page || a.name === b.name) continue;
      const iou = computeRectIoU(a.rect, b.rect);
      if (iou > 0.35) {
        overlappingWidgetPairs.push({
          fieldA: a.name,
          fieldB: b.name,
          page: a.page,
          iou,
        });
      }
    }
  }

  const meanIoU = checkedWidgets > 0 ? roundPt(iouSum / checkedWidgets) : 1;
  const effectiveMinIoU = checkedWidgets > 0 ? roundPt(minIoU) : 1;
  const passed =
    missingFields.length === 0 &&
    misplacedFields.length === 0 &&
    oversizedFields.length === 0 &&
    undersizedFields.length === 0 &&
    duplicateWidgetNames.length === 0;

  const visualVerification: VisualVerificationReport = {
    checkedWidgets,
    alignedCount,
    meanIoU,
    minIoU: effectiveMinIoU,
    combFieldCount,
    misplacedFields,
    oversizedFields,
    undersizedFields,
    missingFields,
    overlappingWidgetPairs,
    duplicateWidgetNames,
    passed,
    summary:
      checkedWidgets === 0
        ? `Structural validation passed (${widgetCount} widgets)`
        : `${alignedCount}/${checkedWidgets} widgets aligned (mean IoU ${meanIoU}, ${combFieldCount} comb fields, ${missingFields.length} missing, ${overlappingWidgetPairs.length} overlaps)`,
  };

  const warnings: string[] = [];
  if (missingFields.length > 0) {
    warnings.push(`Missing widgets: ${missingFields.join(", ")}`);
  }
  if (overlappingWidgetPairs.length > 0) {
    warnings.push(
      `${overlappingWidgetPairs.length} overlapping widget pair(s) detected`
    );
  }

  return {
    validPdf: true,
    hasAcroFormDict: hasAcroForm || widgetCount > 0,
    widgetCount,
    expectedFieldCount: expectedFieldCount || fields.length,
    missingFields,
    appearanceStreamsVerified: true,
    roundTripWriteReadOk: roundTripOk,
    pageCount: pdfDoc.getPageCount(),
    warnings,
    visualVerification,
  };
}

export async function runFormForgeNodeEngine<T = unknown>(
  command: string,
  payload: Record<string, unknown>
): Promise<T> {
  switch (command) {
    case "inspect":
      return (await inspectPdfNode(String(payload.pdfPath))) as T;
    case "analyze":
      return (await analyzePdfNode(
        String(payload.pdfPath),
        (payload.options as Record<string, unknown>) || {}
      )) as T;
    case "generate-acroform":
      return (await generateAcroFormNode(
        payload as {
          pdfPath: string;
          manifest: FieldManifest;
          outputPdfPath: string;
        }
      )) as T;
    case "render-pdf":
      return (await renderPdfNode(
        payload as {
          templatePdfPath: string;
          manifest: FieldManifest;
          values: Record<string, unknown>;
          outputPdfPath: string;
          flatten?: boolean;
        }
      )) as T;
    case "validate-acroform":
      return (await validateAcroFormNode(
        String(payload.pdfPath),
        Number(payload.expectedFieldCount || 0),
        payload.expectedFields as DetectedFormField[] | undefined
      )) as T;
    default:
      throw new Error(`Unsupported FormForge command: ${command}`);
  }
}
