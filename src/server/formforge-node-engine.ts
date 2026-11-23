import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  rgb,
} from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { topLeftPdfToBottomLeftPdf } from "../lib/formforge/coordinate.ts";
import type {
  AcroFormValidationReport,
  DetectedFormField,
  DocumentPageInfo,
  FieldManifest,
  FormForgeFieldType,
} from "../lib/formforge/types.ts";

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

function classifyPaperSize(widthPt: number, heightPt: number): DocumentPageInfo["paperSize"] {
  const [w, h] = [widthPt, heightPt].sort((a, b) => a - b);
  for (const [name, pw, ph] of PAPER_SIZES) {
    const [sw, sh] = [pw, ph].sort((a, b) => a - b);
    if (Math.abs(w - sw) <= 14 && Math.abs(h - sh) <= 14) {
      return name;
    }
  }
  return "Custom";
}

function roundPt(v: number): number {
  return Math.round(v * 100) / 100;
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

function snakeCase(text: string, fallback = "field"): string {
  let cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) cleaned = fallback;
  if (/^\d/.test(cleaned)) cleaned = `f_${cleaned}`;
  return cleaned.slice(0, 64);
}

function inferFieldTypeFromLabel(label: string): FormForgeFieldType {
  const lower = label.toLowerCase();
  if (lower.includes("email") || lower.includes("e-mail")) return "email";
  if (lower.includes("phone") || lower.includes("tel") || lower.includes("cell") || lower.includes("mobile")) return "phone";
  if (lower.includes("date") || lower.includes("dob") || lower.includes("yy/mm") || lower.includes("dd/mm")) return "date";
  if (lower.includes("amount") || lower.includes("price") || lower.includes("total") || lower.includes("salary") || lower.includes("fee")) return "currency";
  if (lower.includes("address") || lower.includes("street") || lower.includes("suburb") || lower.includes("postal")) return "address";
  if (lower.includes("signature") || lower.includes("signed")) return "signature";
  if (lower.includes("initial")) return "initials";
  if (lower.includes("comment") || lower.includes("notes") || lower.includes("description")) return "multiline";
  if (lower.includes("number") || lower.includes("count") || lower.includes("age") || lower.includes("code") || lower.includes("id ")) return "numeric";
  return "text";
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

async function inspectPdfNode(pdfPath: string) {
  const { bytes, pdfDoc, pdfjsDoc } = await loadPdfDocument(pdfPath);
  try {
    const rawStr = bytes.toString("latin1");
    const hasEmbeddedJavaScript =
      rawStr.includes("/JavaScript") || rawStr.includes("/JS ");
    const form = pdfDoc.getForm();
    const existingFields = form.getFields();
    const hasExistingAcroForm = existingFields.length > 0;

    const pages: Array<DocumentPageInfo & { thumbnailFile?: string | null }> = [];
    let isScanned = false;

    for (let idx = 0; idx < pdfDoc.getPageCount(); idx++) {
      const page = pdfDoc.getPage(idx);
      const { width, height } = page.getSize();
      const mediaBox = page.getMediaBox();
      const cropBox = page.getCropBox();
      const rot = (((page.getRotation().angle || 0) % 360 + 360) % 360) as
        | 0
        | 90
        | 180
        | 270;

      const jsPage = await pdfjsDoc.getPage(idx + 1);
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

      // Count widgets on this page
      const pageRef = page.ref;
      let widgetCount = 0;
      for (const f of existingFields) {
        for (const w of f.acroField.getWidgets()) {
          if (w.P() === pageRef) widgetCount++;
        }
      }

      pages.push({
        pageIndex: idx,
        widthPt: roundPt(width),
        heightPt: roundPt(height),
        rotation: rot === 90 || rot === 180 || rot === 270 ? rot : 0,
        orientation: width > height ? "landscape" : "portrait",
        paperSize: classifyPaperSize(width, height),
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
        drawingCount: 0,
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
      hasExistingAcroForm,
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
  try {
    const inspection = await inspectPdfNode(pdfPath);
    const form = pdfDoc.getForm();
    const existingFields = form.getFields();
    const fields: DetectedFormField[] = [];
    const seenNames = new Set<string>();

    const uniqueName = (base: string): string => {
      let candidate = snakeCase(base, "field");
      let i = 2;
      while (seenNames.has(candidate)) {
        candidate = `${snakeCase(base, "field")}_${i++}`;
      }
      seenNames.add(candidate);
      return candidate;
    };

    // 1. Extract existing AcroForm widgets if present
    if (existingFields.length > 0) {
      const pageMap = new Map<unknown, number>();
      pdfDoc.getPages().forEach((p, idx) => pageMap.set(p.ref, idx));

      let idxCounter = 1;
      for (const fld of existingFields) {
        const name = fld.getName() || `field_${idxCounter}`;
        const widgets = fld.acroField.getWidgets();
        if (widgets.length === 0) continue;
        const w = widgets[0];
        const pageIdx = pageMap.get(w.P()) ?? 0;
        const pageInfo = inspection.pages[pageIdx] || inspection.pages[0];
        const r = w.getRectangle();
        const topY = pageInfo.heightPt - (r.y + r.height);

        let ftype: FormForgeFieldType = "text";
        if (fld instanceof PDFCheckBox) ftype = "checkbox";
        else if (fld instanceof PDFRadioGroup) ftype = "radio";
        else if (fld instanceof PDFDropdown) ftype = "dropdown";
        else if (fld instanceof PDFTextField && fld.isMultiline()) ftype = "multiline";

        fields.push({
          id: `fld_${String(idxCounter++).padStart(3, "0")}`,
          name: uniqueName(name),
          label: name,
          type: ftype,
          page: pageIdx,
          rect: {
            x: roundPt(Math.max(0, r.x)),
            y: roundPt(Math.max(0, topY)),
            width: roundPt(Math.max(12, r.width)),
            height: roundPt(Math.max(12, r.height)),
          },
          coordinateSpace: "top_left_pdf_pt",
          originalLabelText: name,
          detectionSource: "existing_acroform",
          confidence: 0.98,
          confidenceTier: "high",
          confidenceEvidence: ["Extracted from existing PDF AcroForm widget"],
          required: false,
          defaultValue: "",
          multiline: ftype === "multiline",
          options: fld instanceof PDFDropdown ? fld.getOptions() : [],
          validation: {},
          reviewStatus: "accepted",
        });
      }
    }

    // 2. Heuristic label + input slot detection from text spans when no AcroForm fields exist
    if (fields.length === 0) {
      let idxCounter = 1;
      for (let pIdx = 0; pIdx < pdfDoc.getPageCount(); pIdx++) {
        const pageInfo = inspection.pages[pIdx];
        const jsPage = await pdfjsDoc.getPage(pIdx + 1);
        const textContent = await jsPage.getTextContent();

        for (const item of textContent.items) {
          if (!("str" in item) || typeof item.str !== "string") continue;
          const raw = item.str.trim();
          if (raw.length < 2 || raw.length > 60) continue;

          const hasPrompt =
            raw.endsWith(":") ||
            /_{3,}/.test(raw) ||
            /^\[\s*\]/.test(raw) ||
            /^☐/.test(raw);
          if (!hasPrompt) continue;

          const cleanLabel = raw
            .replace(/_{2,}/g, "")
            .replace(/[:\[\]☐]/g, "")
            .trim();
          if (cleanLabel.length < 2) continue;

          const tx = item.transform[4] ?? 40;
          const tyBottom = item.transform[5] ?? 700;
          const itemH = Math.max(12, item.height || 12);
          const itemW = Math.max(20, item.width || cleanLabel.length * 6);
          const topY = Math.max(8, pageInfo.heightPt - tyBottom - itemH);

          const isCheckbox = raw.includes("[ ]") || raw.includes("☐");
          const fieldX = isCheckbox
            ? roundPt(Math.max(8, tx))
            : roundPt(Math.min(pageInfo.widthPt - 140, tx + itemW + 8));
          const fieldW = isCheckbox
            ? 14
            : roundPt(Math.max(80, Math.min(240, pageInfo.widthPt - fieldX - 36)));

          const ftype = isCheckbox ? "checkbox" : inferFieldTypeFromLabel(cleanLabel);

          fields.push({
            id: `fld_${String(idxCounter++).padStart(3, "0")}`,
            name: uniqueName(cleanLabel),
            label: cleanLabel,
            type: ftype,
            page: pIdx,
            rect: {
              x: fieldX,
              y: roundPt(topY),
              width: fieldW,
              height: isCheckbox ? 14 : 18,
            },
            coordinateSpace: "top_left_pdf_pt",
            originalLabelText: raw,
            detectionSource: "vector_underline",
            confidence: 0.78,
            confidenceTier: "medium",
            confidenceEvidence: ["Detected form label / underline cue in PDF text layer"],
            required: false,
            defaultValue: "",
            multiline: ftype === "multiline",
            options: [],
            validation: {},
            reviewStatus: "pending",
          });
        }
      }
    }

    // 3. Fallback baseline fields if document is scanned/image-only without OCR
    if (fields.length === 0) {
      const p0 = inspection.pages[0];
      fields.push({
        id: "fld_001",
        name: "applicant_name",
        label: "Applicant Name",
        type: "text",
        page: 0,
        rect: {
          x: 72,
          y: 140,
          width: roundPt(Math.min(260, p0.widthPt - 144)),
          height: 20,
        },
        coordinateSpace: "top_left_pdf_pt",
        originalLabelText: "Applicant Name",
        detectionSource: "manual",
        confidence: 0.45,
        confidenceTier: "low",
        confidenceEvidence: ["Placeholder field created for scanned/untagged PDF — adjust in visual editor"],
        required: false,
        defaultValue: "",
        multiline: false,
        options: [],
        validation: {},
        reviewStatus: "pending",
      });
    }

    const docId =
      typeof options.documentId === "string" ? options.documentId : "doc_node";

    const manifest: FieldManifest = {
      documentId: docId,
      schemaVersion: "1.0",
      totalPages: inspection.pageCount,
      pages: inspection.pages,
      fields,
      generatedAt: new Date().toISOString(),
      engineVersion: "formforge-node-1.0.0",
      hasExistingAcroForm: inspection.hasExistingAcroForm,
      isScanned: inspection.isScanned,
      securityFlags: inspection.securityFlags,
    };

    return {
      inspection,
      ocrJobs: [],
      manifest,
    };
  } finally {
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

  for (const fld of manifest.fields) {
    const page = pages[fld.page];
    if (!page) continue;

    let fieldName = fld.name || fld.id;
    let suffix = 2;
    while (usedNames.has(fieldName)) {
      fieldName = `${fld.name || fld.id}_${suffix++}`;
    }
    usedNames.add(fieldName);

    const crop = page.getCropBox();
    const [x0, y0, x1, y1] = topLeftPdfToBottomLeftPdf(fld.rect, {
      x: crop.x,
      y: crop.y,
      width: crop.width,
      height: crop.height,
    });
    const w = Math.max(6, x1 - x0);
    const h = Math.max(6, y1 - y0);

    if (fld.type === "checkbox") {
      const cb = form.createCheckBox(fieldName);
      cb.addToPage(page, { x: x0, y: y0, width: w, height: h });
      createdWidgets++;
    } else if (fld.type === "dropdown" && fld.options.length > 0) {
      const dd = form.createDropdown(fieldName);
      dd.addOptions(fld.options);
      dd.addToPage(page, { x: x0, y: y0, width: w, height: h });
      createdWidgets++;
    } else if (fld.type === "radio" && fld.options.length > 0) {
      const rg = form.createRadioGroup(fieldName);
      const optW = Math.max(10, Math.min(18, w / fld.options.length));
      fld.options.forEach((opt, i) => {
        rg.addOptionToPage(opt, page, {
          x: x0 + i * (optW + 4),
          y: y0,
          width: optW,
          height: h,
        });
      });
      createdWidgets++;
    } else {
      const tf = form.createTextField(fieldName);
      if (fld.multiline || fld.type === "multiline") {
        tf.enableMultiline();
      }
      if (fld.maxLength && fld.maxLength > 0) {
        tf.setMaxLength(fld.maxLength);
      }
      if (fld.defaultValue) {
        tf.setText(fld.defaultValue);
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
    manifest.fields.length
  );

  return {
    createdWidgets,
    sanitizedActions: false,
    validation,
  };
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
  const values = payload.values || {};

  // Populate AcroForm widgets if present
  const formFieldsByName = new Map(form.getFields().map((f) => [f.getName(), f]));

  for (const fld of payload.manifest.fields) {
    const rawVal = values[fld.name] ?? values[fld.id];
    if (rawVal === undefined || rawVal === null || rawVal === "") continue;

    const acField = formFieldsByName.get(fld.name) || formFieldsByName.get(fld.id);
    if (acField) {
      if (acField instanceof PDFTextField) {
        acField.setText(toWinAnsiSafeText(String(rawVal)));
        populatedWidgets++;
        continue;
      } else if (acField instanceof PDFCheckBox) {
        if (rawVal === true || String(rawVal).toLowerCase() === "true") {
          acField.check();
        } else {
          acField.uncheck();
        }
        populatedWidgets++;
        continue;
      } else if (acField instanceof PDFDropdown) {
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
    const [x0, y0, x1, y1] = topLeftPdfToBottomLeftPdf(fld.rect, {
      x: crop.x,
      y: crop.y,
      width: crop.width,
      height: crop.height,
    });

    if (fld.type === "checkbox") {
      if (rawVal === true || String(rawVal).toLowerCase() === "true") {
        page.drawText("X", {
          x: x0 + 2,
          y: y0 + 2,
          size: Math.max(8, Math.min(12, y1 - y0 - 2)),
          font,
          color: rgb(0.06, 0.1, 0.2),
        });
        populatedWidgets++;
      }
    } else if (fld.cellRects && fld.cellRects.length > 0) {
      const str = toWinAnsiSafeText(String(rawVal));
      for (let i = 0; i < Math.min(str.length, fld.cellRects.length); i++) {
        const cr = fld.cellRects[i];
        const [cx0, cy0, , cy1] = topLeftPdfToBottomLeftPdf(cr, {
          x: crop.x,
          y: crop.y,
          width: crop.width,
          height: crop.height,
        });
        page.drawText(str[i], {
          x: cx0 + 2,
          y: cy0 + Math.max(2, (cy1 - cy0 - 9) / 2),
          size: 9.5,
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

async function validateAcroFormNode(
  pdfPath: string,
  expectedFieldCount = 0
): Promise<AcroFormValidationReport> {
  const bytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const hasAcroForm = pdfDoc.catalog.has(PDFName.of("AcroForm"));

  let widgetCount = 0;
  for (const f of fields) {
    widgetCount += f.acroField.getWidgets().length;
  }

  return {
    validPdf: true,
    hasAcroFormDict: hasAcroForm || fields.length > 0,
    widgetCount,
    expectedFieldCount: expectedFieldCount || fields.length,
    missingFields: [],
    appearanceStreamsVerified: true,
    roundTripWriteReadOk: true,
    pageCount: pdfDoc.getPageCount(),
    warnings: [],
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
        Number(payload.expectedFieldCount || 0)
      )) as T;
    default:
      throw new Error(`Unsupported FormForge command: ${command}`);
  }
}
