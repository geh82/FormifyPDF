import {
  bottomLeftPdfToTopLeftPdf,
  computeRectIoU,
  imagePxToTopLeftPdf,
  roundPt,
  topLeftPdfToBottomLeftPdf,
} from "../lib/formifypdf/coordinate.ts";
import type {
  CharGridMetadata,
  ConfidenceTier,
  DetectedFormField,
  DetectionSource,
  DetectionSummary,
  FieldManifest,
  FieldValidationRule,
  FormifyFieldType,
  PdfRect,
  VisualAlignmentIssue,
  VisualOverlapWarning,
  VisualVerificationReport,
} from "../lib/formifypdf/types.ts";
import {
  buildMergedTextLabels,
  clusterCharCells,
  detectTickCombBaselines,
  findBestAssociatedLabel,
  fuseAndClassifyPageGeometry,
  inferSemanticType,
  snakeCase,
} from "./formifypdf-fusion.ts";
import type {
  ExtractedCirclePrimitive,
  ExtractedLineSegment,
  ExtractedRectPrimitive,
  ExtractedTextRun,
  PageStructuralGeometry,
} from "./pdf-vector-extractor.ts";
import type { RasterCvExtractionResult } from "./pdf-raster-cv.ts";
import type { LocalOcrPageOutput } from "./pdf-local-ocr.ts";

export interface EngineDetection {
  kind: "box" | "underline" | "checkbox" | "radio" | "table_cell" | "char_cells" | "multiline" | "text";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  source: DetectionSource;
  sources: DetectionSource[];
  score: number;
  evidence: string[];
  label?: string;
  cellRects?: PdfRect[];
  charGridMeta?: CharGridMetadata;
  optionRects?: Record<string, PdfRect>;
  options?: string[];
  groupId?: string;
  radioGroupName?: string;
}

export interface FusionResult {
  fields: DetectedFormField[];
  summary: DetectionSummary;
  visualReport?: VisualVerificationReport;
}

const CONF_HIGH = 0.85;
const CONF_MEDIUM = 0.60;
const CONF_LOW = 0.40;
const MERGE_IOU_THRESHOLD = 0.55;
const AUTO_ACCEPT_CONF = 0.70;
const MIN_FIELD_SIZE_PT = 5.0;

function confidenceToTier(conf: number): ConfidenceTier {
  if (conf >= CONF_HIGH) return "high";
  if (conf >= CONF_MEDIUM) return "medium";
  return "low";
}

function reviewStatusFromConfidence(conf: number): DetectedFormField["reviewStatus"] {
  return conf >= AUTO_ACCEPT_CONF ? "accepted" : "pending";
}

function makeUniqueName(base: string, used: Set<string>): string {
  const clean = snakeCase(base, "field");
  if (!used.has(clean)) {
    used.add(clean);
    return clean;
  }
  let i = 2;
  while (used.has(`${clean}_${i}`)) i++;
  used.add(`${clean}_${i}`);
  return `${clean}_${i}`;
}

function mergeDetections(a: EngineDetection, b: EngineDetection): EngineDetection {
  const merged: EngineDetection = {
    ...a,
    score: Math.max(a.score, b.score),
    sources: [...new Set([...a.sources, ...b.sources])],
    evidence: [...new Set([...a.evidence, ...b.evidence])],
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
  if (!merged.label && b.label) merged.label = b.label;
  if (!merged.cellRects && b.cellRects) merged.cellRects = b.cellRects;
  if (!merged.charGridMeta && b.charGridMeta) merged.charGridMeta = b.charGridMeta;
  if (!merged.optionRects && b.optionRects) merged.optionRects = b.optionRects;
  if (!merged.options && b.options) merged.options = b.options;
  return merged;
}

function iouRect(a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): number {
  const ix0 = Math.max(a.x0, b.x0);
  const iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1);
  const iy1 = Math.min(a.y1, b.y1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function clusterOverlappingDetections(dets: EngineDetection[]): EngineDetection[] {
  const used = new Array<boolean>(dets.length).fill(false);
  const merged: EngineDetection[] = [];
  for (let i = 0; i < dets.length; i++) {
    if (used[i]) continue;
    let current = { ...dets[i] };
    used[i] = true;
    for (let j = i + 1; j < dets.length; j++) {
      if (used[j]) continue;
      if (iouRect(current, dets[j]) >= MERGE_IOU_THRESHOLD) {
        current = mergeDetections(current, dets[j]);
        used[j] = true;
      }
    }
    merged.push(current);
  }
  return merged;
}

function classifyDetection(
  det: EngineDetection,
  labels: { text: string; x0: number; y0: number; x1: number; y1: number; fontSize: number; isHeaderLike: boolean; isInstructionLike: boolean; isSubCaption: boolean; hasColon: boolean }[],
  pageIndex: number,
  cropBox: { x: number; y: number; width: number; height: number },
  rotation: 0 | 90 | 180 | 270,
  usedNames: Set<string>,
): DetectedFormField | null {
  const { x0, y0, x1, y1, kind, source, sources, score, evidence, label, cellRects, charGridMeta, optionRects, options, groupId, radioGroupName } = det;

  const width = x1 - x0;
  const height = y1 - y0;

  if (width < MIN_FIELD_SIZE_PT || height < MIN_FIELD_SIZE_PT) return null;

  const pdfBLRect = topLeftPdfToBottomLeftPdf(
  { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  cropBox,
  rotation
);

  let fieldLabel = label || "";
  let bestLabelDist = 1e9;

  if (labels.length > 0) {
    const tlRect: [number, number, number, number] = [x0, y0, x1, y1];
    const labelResult = findBestAssociatedLabel(
      tlRect,
      labels as any,
      kind === "checkbox" || kind === "radio",
    );
    if (labelResult.label) {
      fieldLabel = labelResult.label;
      bestLabelDist = labelResult.score;
    }
  }

  if (!fieldLabel) {
    fieldLabel = snakeCase(kind === "char_cells" ? `char_field_p${pageIndex + 1}` : `field_p${pageIndex + 1}`);
  }

  const fieldName = makeUniqueName(snakeCase(fieldLabel, "field"), usedNames);
  const semantic = inferSemanticType(fieldLabel, width, height, kind, cellRects ? cellRects.length : 0);

  const sourceBonus = Math.min(0.15, (sources.length - 1) * 0.05);
  const labelBonus = fieldLabel && fieldLabel.length > 2 ? 0.10 : 0.0;
  const rawConfidence = Math.min(1.0, score + sourceBonus + labelBonus + bestLabelDist * 0.001);
  const confidence = Math.round(rawConfidence * 100) / 100;
  const tier = confidenceToTier(confidence);
  const reviewStatus = reviewStatusFromConfidence(confidence);

  const confidenceEvidence: string[] = [...evidence];
  if (sourceBonus > 0) confidenceEvidence.push(`Detected by ${sources.length} engines`);
  if (labelBonus > 0) confidenceEvidence.push(`Label "${fieldLabel}" associated`);
  if (bestLabelDist < 50) confidenceEvidence.push("Label in close proximity");

  const reviewFlagReason = tier === "low" ? `Low confidence (${confidence}) — manual review recommended` : undefined;

  const validation: FieldValidationRule = {};
  if (semantic.validation && Object.keys(semantic.validation).length > 0) {
    Object.assign(validation, semantic.validation);
  }

  const field: DetectedFormField = {
    id: "",
    name: fieldName,
    label: fieldLabel,
    type: semantic.type,
    page: pageIndex,
    rect: { x: roundPt(x0), y: roundPt(y0), width: roundPt(width), height: roundPt(height) },
    originalDetectedRect: { x: roundPt(x0), y: roundPt(y0), width: roundPt(width), height: roundPt(height) },
    pdfBottomLeftRect: pdfBLRect,
    cellRects,
    charGridMeta,
    optionRects,
    coordinateSpace: "top_left_pdf_pt",
    originalLabelText: fieldLabel,
    detectionSource: source,
    detectionSources: sources,
    confidence,
    confidenceTier: tier,
    confidenceEvidence,
    required: semantic.required,
    defaultValue: "",
    maxLength: semantic.maxLength,
    multiline: semantic.multiline,
    options: options || semantic.options || [],
    validation,
    groupId,
    radioGroupName,
    relatedFieldIds: [],
    fontSize: undefined,
    alignment: semantic.alignment,
    reviewStatus,
    reviewFlagReason,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return field;
}

function buildDetectionSummary(fields: DetectedFormField[], engineMode: DetectionSummary["engineMode"]): DetectionSummary {
  const countsByType: Record<string, number> = {};
  const countsBySource: Record<string, number> = {};
  let high = 0, medium = 0, low = 0;
  let charGridGroupCount = 0;
  let combFieldCount = 0;
  let reviewRecommendedCount = 0;

  for (const f of fields) {
    countsByType[f.type] = (countsByType[f.type] || 0) + 1;
    for (const s of (f.detectionSources || [f.detectionSource])) {
      countsBySource[s] = (countsBySource[s] || 0) + 1;
    }
    if (f.confidenceTier === "high") high++;
    else if (f.confidenceTier === "medium") medium++;
    else low++;
    if (f.reviewStatus === "pending") reviewRecommendedCount++;
    if (f.type === "char_cells") {
      charGridGroupCount++;
      if (f.charGridMeta?.acroformStrategy === "comb") combFieldCount++;
    }
  }

  return {
    totalDetectedFields: fields.length,
    countsByType,
    countsBySource,
    confidenceBreakdown: { high, medium, low },
    reviewRecommendedCount,
    charGridGroupCount,
    combFieldCount,
    engineMode,
  };
}

function normalizeRotationFromPdf(angle: number): 0 | 90 | 180 | 270 {
  const normalized = (((Math.round(Number(angle || 0) / 90) * 90) % 360) + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
  return 0;
}

export async function verifyVisualAlignment(
  pdfPath: string,
  fields: DetectedFormField[],
): Promise<VisualVerificationReport> {
  const { PDFDocument } = await import("pdf-lib");
  const fs = await import("node:fs");
  const bytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes);
  const pages = pdfDoc.getPages();
  const form = pdfDoc.getForm();

  const extractedWidgets: Array<{ name: string; page: number; rect: PdfRect }> = [];
  const duplicateNames: string[] = [];
  const nameCounts = new Map<string, number>();

  for (const f of form.getFields()) {
    const fname = f.getName();
    nameCounts.set(fname, (nameCounts.get(fname) || 0) + 1);
    const widgets = f.acroField.getWidgets();
    for (const w of widgets) {
      const pIdx = Number(w.P()?.toString().split(" ")[0] || 0) - 1;
      const page = pages[pIdx] || pages[0];
      const crop = page.getCropBox();
      const rot = normalizeRotationFromPdf(page.getRotation().angle);
      const r = w.getRectangle();
      extractedWidgets.push({
        name: fname,
        page: pIdx,
        rect: bottomLeftPdfToTopLeftPdf([r.x, r.y, r.x + r.width, r.y + r.height], { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, rot),
      });
    }
  }

  for (const [name, count] of nameCounts.entries()) {
    if (count > 1) duplicateNames.push(name);
  }

  const misplacedFields: VisualAlignmentIssue[] = [];
  const oversizedFields: VisualAlignmentIssue[] = [];
  const undersizedFields: VisualAlignmentIssue[] = [];
  const missingFields: string[] = [];
  const overlappingWidgetPairs: VisualOverlapWarning[] = [];

  let checkedWidgets = 0;
  let alignedCount = 0;
  let iouSum = 0;
  let minIoU = 1;

  for (const target of fields) {
    const matching = extractedWidgets.filter(
      (w) => w.page === target.page && (w.name === target.name || w.name.startsWith(`${target.name}_cell_`)),
    );
    if (matching.length === 0) {
      missingFields.push(target.name);
      continue;
    }

    const ux0 = Math.min(...matching.map((m) => m.rect.x));
    const uy0 = Math.min(...matching.map((m) => m.rect.y));
    const ux1 = Math.max(...matching.map((m) => m.rect.x + m.rect.width));
    const uy1 = Math.max(...matching.map((m) => m.rect.y + m.rect.height));
    const unionRect: PdfRect = { x: roundPt(ux0), y: roundPt(uy0), width: roundPt(ux1 - ux0), height: roundPt(uy1 - uy0) };

    const iou = computeRectIoU(target.rect, unionRect);
    const targetArea = Math.max(1, target.rect.width * target.rect.height);
    const widgetArea = Math.max(1, unionRect.width * unionRect.height);
    const areaRatio = roundPt(widgetArea / targetArea);
    const centerOffsetPt = roundPt(
      Math.hypot(
        unionRect.x + unionRect.width / 2 - (target.rect.x + target.rect.width / 2),
        unionRect.y + unionRect.height / 2 - (target.rect.y + target.rect.height / 2),
      ),
    );

    checkedWidgets++;
    iouSum += iou;
    if (iou < minIoU) minIoU = iou;

    if (areaRatio > 1.85) {
      oversizedFields.push({ fieldId: target.id, fieldName: target.name, page: target.page, issue: "oversized", iou, areaRatio, centerOffsetPt, detail: `Widget area ${areaRatio}x target area` });
    } else if (areaRatio < 0.45) {
      undersizedFields.push({ fieldId: target.id, fieldName: target.name, page: target.page, issue: "undersized", iou, areaRatio, centerOffsetPt, detail: `Widget area ${areaRatio}x target area` });
    } else if (iou < 0.6) {
      misplacedFields.push({ fieldId: target.id, fieldName: target.name, page: target.page, issue: "misplaced", iou, areaRatio, centerOffsetPt, detail: `Alignment IoU ${iou} (< 0.60), center offset ${centerOffsetPt}pt` });
    } else {
      alignedCount++;
    }
  }

  for (let i = 0; i < extractedWidgets.length; i++) {
    for (let j = i + 1; j < extractedWidgets.length; j++) {
      const a = extractedWidgets[i];
      const b = extractedWidgets[j];
      if (a.page !== b.page || a.name === b.name) continue;
      const iou = computeRectIoU(a.rect, b.rect);
      if (iou > 0.35) {
        overlappingWidgetPairs.push({ fieldA: a.name, fieldB: b.name, page: a.page, iou });
      }
    }
  }

  const meanIoU = checkedWidgets > 0 ? roundPt(iouSum / checkedWidgets) : 0;
  const passed = alignedCount === checkedWidgets && missingFields.length === 0 && overlappingWidgetPairs.length === 0 && duplicateNames.length === 0;

  return {
    checkedWidgets,
    alignedCount,
    meanIoU,
    minIoU,
    combFieldCount: fields.filter((f) => f.type === "char_cells" && f.charGridMeta?.acroformStrategy === "comb").length,
    misplacedFields,
    oversizedFields,
    undersizedFields,
    missingFields,
    overlappingWidgetPairs,
    duplicateWidgetNames: duplicateNames,
    passed,
    summary: passed
      ? `All ${checkedWidgets} widgets visually aligned, no missing fields, no overlaps.`
      : `${misplacedFields.length} misplaced, ${missingFields.length} missing, ${overlappingWidgetPairs.length} overlapping, ${duplicateNames.length} duplicate names.`,
  };
}