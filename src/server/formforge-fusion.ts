import {
  clampPdfRect,
  computeRectIoU,
  roundPt,
  topLeftPdfToBottomLeftPdf,
} from "../lib/formforge/coordinate.ts";
import type {
  CharGridMetadata,
  ConfidenceTier,
  DetectedFormField,
  DetectionSource,
  DetectionSummary,
  FormForgeFieldType,
  PdfPageBox,
  PdfRect,
} from "../lib/formforge/types.ts";
import type {
  ExtractedLineSegment,
  ExtractedRectPrimitive,
  ExtractedTextRun,
  PageStructuralGeometry,
} from "./pdf-vector-extractor.ts";

export interface MergedTextLabel {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fontSize: number;
  isHeaderLike: boolean;
  isInstructionLike: boolean;
  hasColon: boolean;
  source: "pdf_text" | "ocr_tesseract" | "ocr_paddleocr";
}

interface RawCandidate {
  kind:
    | "box"
    | "underline"
    | "checkbox"
    | "radio"
    | "dropdown"
    | "listbox"
    | "table_cell"
    | "char_cells"
    | "multiline";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  source: DetectionSource;
  sources: DetectionSource[];
  explicitLabel?: string;
  options?: string[];
  optionRects?: Record<string, PdfRect>;
  cellRects?: PdfRect[];
  charGridMeta?: CharGridMetadata;
  groupId?: string;
  radioGroupName?: string;
  evidence: string[];
  scoreBoost?: number;
}

export function snakeCase(text: string, fallback = "field"): string {
  let cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) cleaned = fallback;
  if (/^\d/.test(cleaned)) cleaned = `f_${cleaned}`;
  return cleaned.slice(0, 64);
}

function overlapArea(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const ix0 = Math.max(a[0], b[0]);
  const iy0 = Math.max(a[1], b[1]);
  const ix1 = Math.min(a[2], b[2]);
  const iy1 = Math.min(a[3], b[3]);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  return (ix1 - ix0) * (iy1 - iy0);
}

function isPurePunctuationOrPlaceholder(txt: string): boolean {
  return /^[_\.\-\s\[\]\(\)\|\/:;,*]+$/.test(txt.trim());
}

function isInstructionOrBannerText(txt: string, fontSize: number): {
  isHeader: boolean;
  isInstruction: boolean;
} {
  const clean = txt.trim();
  const lower = clean.toLowerCase();
  const isSectionHeader =
    /^(section|part|schedule|annexure|chapter)\s+[a-z0-9]/i.test(clean) ||
    (fontSize >= 11.5 && clean === clean.toUpperCase() && clean.length >= 6);
  const isInstruction =
    clean.length > 78 ||
    /^\((mark with|tick|cross|please|note|see |if applicable|national |act\b|block letters)/i.test(clean) ||
    lower.startsWith("please complete") ||
    lower.startsWith("note:") ||
    lower.includes("in block letters");
  return { isHeader: isSectionHeader, isInstruction };
}

/**
 * Merge fragmented horizontal text runs on the same baseline into logical labels
 * without crossing large column gaps or vertical divider lines.
 */
export function buildMergedTextLabels(
  runs: ExtractedTextRun[],
  vLines: ExtractedLineSegment[],
  source: "pdf_text" | "ocr_tesseract" | "ocr_paddleocr" = "pdf_text"
): MergedTextLabel[] {
  const cleanRuns = runs.filter(
    (r) =>
      r.text.trim().length > 0 &&
      !r.isCheckboxGlyph &&
      !r.isRadioGlyph &&
      !r.isDropdownArrow
  );
  if (cleanRuns.length === 0) return [];

  const sorted = [...cleanRuns].sort((a, b) => {
    const dy = a.y0 - b.y0;
    if (Math.abs(dy) > 3.5) return dy;
    return a.x0 - b.x0;
  });

  const hasVerticalDividerBetween = (xLeft: number, xRight: number, yMid: number): boolean => {
    for (const v of vLines) {
      if (v.x0 >= xLeft - 1 && v.x0 <= xRight + 1 && v.y0 <= yMid && v.y1 >= yMid) {
        return true;
      }
    }
    return false;
  };

  const groups: ExtractedTextRun[][] = [];
  for (const r of sorted) {
    const prevGrp = groups[groups.length - 1];
    if (prevGrp) {
      const last = prevGrp[prevGrp.length - 1];
      const sameBaseline = Math.abs(last.y0 - r.y0) <= Math.max(3.5, last.fontSize * 0.45);
      const gap = r.x0 - last.x1;
      const yMid = (Math.min(last.y0, r.y0) + Math.max(last.y1, r.y1)) / 2;
      if (
        sameBaseline &&
        gap >= -3.0 &&
        gap <= Math.max(10.0, last.fontSize * 1.1) &&
        !hasVerticalDividerBetween(last.x1, r.x0, yMid)
      ) {
        prevGrp.push(r);
        continue;
      }
    }
    groups.push([r]);
  }

  return groups.map((grp) => {
    const text = grp.map((g) => g.text).join(" ").replace(/\s+/g, " ").trim();
    const x0 = Math.min(...grp.map((g) => g.x0));
    const y0 = Math.min(...grp.map((g) => g.y0));
    const x1 = Math.max(...grp.map((g) => g.x1));
    const y1 = Math.max(...grp.map((g) => g.y1));
    const fontSize = grp.reduce((m, g) => Math.max(m, g.fontSize), 8);
    const { isHeader, isInstruction } = isInstructionOrBannerText(text, fontSize);
    return {
      text,
      x0,
      y0,
      x1,
      y1,
      fontSize,
      isHeaderLike: isHeader,
      isInstructionLike: isInstruction,
      hasColon: text.endsWith(":"),
      source,
    };
  });
}

/**
 * Merge collinear horizontal or vertical segments into clean spans.
 */
function mergeCollinearLines(
  lines: ExtractedLineSegment[],
  horizontal: boolean
): ExtractedLineSegment[] {
  if (lines.length === 0) return [];
  const buckets: ExtractedLineSegment[][] = [];
  const posKey = (l: ExtractedLineSegment) => (horizontal ? l.y0 : l.x0);
  const startKey = (l: ExtractedLineSegment) => (horizontal ? l.x0 : l.y0);
  const endKey = (l: ExtractedLineSegment) => (horizontal ? l.x1 : l.y1);

  const sorted = [...lines].sort((a, b) => {
    const dp = posKey(a) - posKey(b);
    if (Math.abs(dp) > 1.5) return dp;
    return startKey(a) - startKey(b);
  });

  for (const l of sorted) {
    const targetBucket = buckets.find(
      (b) => Math.abs(posKey(b[0]) - posKey(l)) <= 1.6
    );
    if (targetBucket) targetBucket.push(l);
    else buckets.push([l]);
  }

  const merged: ExtractedLineSegment[] = [];
  for (const b of buckets) {
    b.sort((a, c) => startKey(a) - startKey(c));
    let cur = { ...b[0] };
    for (let i = 1; i < b.length; i++) {
      const nxt = b[i];
      if (startKey(nxt) <= endKey(cur) + 2.5) {
        if (horizontal) {
          cur.x1 = Math.max(cur.x1, nxt.x1);
          cur.y0 = (cur.y0 + nxt.y0) / 2;
          cur.y1 = cur.y0;
        } else {
          cur.y1 = Math.max(cur.y1, nxt.y1);
          cur.x0 = (cur.x0 + nxt.x0) / 2;
          cur.x1 = cur.x0;
        }
      } else {
        merged.push(cur);
        cur = { ...nxt };
      }
    }
    merged.push(cur);
  }
  return merged;
}

/**
 * Reconstruct enclosed rectangular cells from merged horizontal + vertical segments.
 */
function reconstructGridCells(
  hLines: ExtractedLineSegment[],
  vLines: ExtractedLineSegment[],
  pageW: number,
  pageH: number
): Array<{ x0: number; y0: number; x1: number; y1: number; source: DetectionSource }> {
  const cells: Array<{ x0: number; y0: number; x1: number; y1: number; source: DetectionSource }> = [];

  // Index unique y-coordinates of horizontal lines (sorted ascending)
  const hSorted = [...hLines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const vSorted = [...vLines].sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);

  for (let i = 0; i < hSorted.length; i++) {
    const top = hSorted[i];
    if (top.x1 - top.x0 < 7) continue;

    // Find matching vertical segments that start near top.y0
    for (let j = i + 1; j < hSorted.length; j++) {
      const bot = hSorted[j];
      const cellH = bot.y0 - top.y0;
      if (cellH < 7.0) continue;
      if (cellH > 260.0) break;

      const overlapX0 = Math.max(top.x0, bot.x0);
      const overlapX1 = Math.min(top.x1, bot.x1);
      if (overlapX1 - overlapX0 < 7.0) continue;

      // Find vertical lines crossing both top.y0 and bot.y0 within overlapX0..overlapX1
      const dividers = vSorted.filter(
        (v) =>
          v.x0 >= overlapX0 - 2.5 &&
          v.x0 <= overlapX1 + 2.5 &&
          v.y0 <= top.y0 + 3.0 &&
          v.y1 >= bot.y0 - 3.0
      );
      if (dividers.length < 2) continue;

      // Deduplicate closely spaced vertical dividers
      const cols: number[] = [];
      for (const d of dividers) {
        if (cols.length === 0 || d.x0 - cols[cols.length - 1] > 2.2) {
          cols.push(d.x0);
        }
      }
      if (cols.length < 2) continue;

      // Check that there isn't a full horizontal divider strictly bisecting ALL columns cleanly
      const hasIntermediateFullHLine = hSorted.some(
        (mid, k) =>
          k > i &&
          k < j &&
          mid.y0 > top.y0 + 5.0 &&
          mid.y0 < bot.y0 - 5.0 &&
          mid.x0 <= cols[0] + 4.0 &&
          mid.x1 >= cols[cols.length - 1] - 4.0
      );
      if (hasIntermediateFullHLine) continue;

      for (let c = 0; c < cols.length - 1; c++) {
        const cx0 = cols[c];
        const cx1 = cols[c + 1];
        const cw = cx1 - cx0;
        if (cw < 7.0) continue;
        if (cw > pageW * 0.94 && cellH > pageH * 0.94) continue;

        cells.push({
          x0: cx0,
          y0: top.y0,
          x1: cx1,
          y1: bot.y0,
          source: "pdf_structural",
        });
      }
    }
  }

  return cells;
}

/**
 * Group horizontally aligned uniform empty small cells (7..28pt wide, 8..32pt tall)
 * into character-entry comb/grid groups. Splits cleanly across text separators (e.g. '-', '/').
 */
function clusterCharCells(
  smallBoxes: Array<{ x0: number; y0: number; x1: number; y1: number; source: DetectionSource }>,
  labels: MergedTextLabel[]
): {
  groups: Array<{
    cells: PdfRect[];
    meta: CharGridMetadata;
    source: DetectionSource;
  }>;
  leftover: Array<{ x0: number; y0: number; x1: number; y1: number; source: DetectionSource }>;
} {
  if (smallBoxes.length === 0) return { groups: [], leftover: [] };

  const sorted = [...smallBoxes].sort(
    (a, b) => Math.round(a.y0 / 5.0) - Math.round(b.y0 / 5.0) || a.x0 - b.x0
  );
  const used = new Array<boolean>(sorted.length).fill(false);
  const groups: Array<{
    cells: PdfRect[];
    meta: CharGridMetadata;
    source: DetectionSource;
  }> = [];
  const leftover: Array<{ x0: number; y0: number; x1: number; y1: number; source: DetectionSource }> = [];

  const hasTextDividerBetween = (prevX1: number, nextX0: number, y0: number, y1: number): boolean => {
    if (nextX0 - prevX1 < 4.5) return false;
    const midY = (y0 + y1) / 2;
    return labels.some(
      (l) =>
        l.x0 >= prevX1 - 2 &&
        l.x1 <= nextX0 + 2 &&
        l.y0 <= midY + 4 &&
        l.y1 >= midY - 4
    );
  };

  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    const base = sorted[i];
    const bw = base.x1 - base.x0;
    const bh = base.y1 - base.y0;
    const row = [base];
    used[i] = true;

    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      const cand = sorted[j];
      const cw = cand.x1 - cand.x0;
      const ch = cand.y1 - cand.y0;
      const prev = row[row.length - 1];
      const gap = cand.x0 - prev.x1;

      if (
        Math.abs(cand.y0 - base.y0) <= 4.0 &&
        Math.abs(ch - bh) <= 4.0 &&
        Math.abs(cw - bw) <= 5.5 &&
        gap >= -2.5 &&
        gap <= 9.0 &&
        !hasTextDividerBetween(prev.x1, cand.x0, base.y0, base.y1)
      ) {
        row.push(cand);
        used[j] = true;
      }
    }

    if (row.length >= 3) {
      const gaps: number[] = [];
      for (let k = 1; k < row.length; k++) {
        gaps.push(row[k].x0 - row[k - 1].x1);
      }
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const avgW = row.reduce((a, b) => a + (b.x1 - b.x0), 0) / row.length;
      const avgH = row.reduce((a, b) => a + (b.y1 - b.y0), 0) / row.length;
      const maxGapDev = Math.max(...gaps.map((g) => Math.abs(g - avgGap)));

      groups.push({
        cells: row.map((c) => ({
          x: roundPt(c.x0),
          y: roundPt(c.y0),
          width: roundPt(c.x1 - c.x0),
          height: roundPt(c.y1 - c.y0),
        })),
        meta: {
          cellCount: row.length,
          cellWidthPt: roundPt(avgW),
          cellHeightPt: roundPt(avgH),
          spacingPt: roundPt(avgGap),
          readingDirection: "ltr",
          acroformStrategy:
            avgGap <= 2.5 && maxGapDev <= 2.5 ? "comb" : "individual_cells",
        },
        source: avgGap <= 2.5 ? "vector_comb_grid" : "vector_char_cells",
      });
    } else {
      leftover.push(...row);
    }
  }

  return { groups, leftover };
}

/**
 * Detect standalone horizontal lines subdivided by >=3 uniform vertical tick marks (comb notches).
 */
function detectTickCombBaselines(
  hLines: ExtractedLineSegment[],
  vLines: ExtractedLineSegment[]
): Array<{ cells: PdfRect[]; meta: CharGridMetadata }> {
  const results: Array<{ cells: PdfRect[]; meta: CharGridMetadata }> = [];

  for (const h of hLines) {
    const hw = h.x1 - h.x0;
    if (hw < 42) continue;

    // Look for short vertical ticks anchored near this horizontal line
    const ticks = vLines
      .filter(
        (v) =>
          v.x0 >= h.x0 - 2 &&
          v.x0 <= h.x1 + 2 &&
          v.y1 - v.y0 >= 5 &&
          v.y1 - v.y0 <= 24 &&
          Math.abs(v.y1 - h.y0) <= 3.0
      )
      .sort((a, b) => a.x0 - b.x0);

    const uniqueTicks: ExtractedLineSegment[] = [];
    for (const t of ticks) {
      if (uniqueTicks.length === 0 || t.x0 - uniqueTicks[uniqueTicks.length - 1].x0 > 4) {
        uniqueTicks.push(t);
      }
    }
    if (uniqueTicks.length < 4) continue;

    const widths: number[] = [];
    for (let i = 1; i < uniqueTicks.length; i++) {
      widths.push(uniqueTicks[i].x0 - uniqueTicks[i - 1].x0);
    }
    const medW = widths[Math.floor(widths.length / 2)];
    if (medW < 7.5 || medW > 28) continue;
    if (widths.some((w) => Math.abs(w - medW) > 3.5)) continue;

    const tickH = Math.max(12, uniqueTicks.reduce((m, t) => Math.max(m, t.y1 - t.y0), 14));
    const cells: PdfRect[] = [];
    for (let i = 0; i < uniqueTicks.length - 1; i++) {
      const cx0 = uniqueTicks[i].x0;
      const cx1 = uniqueTicks[i + 1].x0;
      cells.push({
        x: roundPt(cx0),
        y: roundPt(Math.max(0, h.y0 - tickH)),
        width: roundPt(cx1 - cx0),
        height: roundPt(tickH),
      });
    }
    if (cells.length >= 3) {
      results.push({
        cells,
        meta: {
          cellCount: cells.length,
          cellWidthPt: roundPt(medW),
          cellHeightPt: roundPt(tickH),
          spacingPt: 0,
          readingDirection: "ltr",
          acroformStrategy: "comb",
        },
      });
    }
  }

  return results;
}

export function inferSemanticType(
  labelText: string,
  widthPt: number,
  heightPt: number,
  geomKind: string,
  cellCount = 0
): {
  type: FormForgeFieldType;
  required: boolean;
  multiline: boolean;
  options: string[];
  validation: Record<string, unknown>;
  maxLength?: number;
  alignment: "left" | "center" | "right";
} {
  const lbl = labelText.toLowerCase();
  const required =
    labelText.includes("*") ||
    /\b(required|mandatory|verpligtend)\b/.test(lbl);
  let multiline = false;
  let options: string[] = [];
  let validation: Record<string, unknown> = {};
  let maxLength: number | undefined;
  let alignment: "left" | "center" | "right" = "left";

  if (geomKind === "checkbox") {
    return { type: "checkbox", required, multiline, options, validation, alignment };
  }
  if (geomKind === "radio") {
    return { type: "radio", required, multiline, options, validation, alignment };
  }
  if (geomKind === "listbox") {
    return { type: "listbox", required, multiline, options, validation, alignment };
  }
  if (geomKind === "dropdown") {
    return { type: "dropdown", required, multiline, options, validation, alignment };
  }
  if (geomKind === "char_cells" && cellCount >= 2) {
    maxLength = cellCount;
    alignment = "center";
    if (/(date|dob|birth|yy\/mm|dd\/mm|mm\/dd|ccyy)/.test(lbl)) {
      validation = { dateFormat: "YYYY-MM-DD" };
    } else if (/(identity|id number|identifikasie|vin|chassis|engine|telephone|phone|postal|code)/.test(lbl)) {
      validation = { minLength: Math.min(cellCount, 4), maxLength: cellCount };
    }
    return { type: "char_cells", required, multiline, options, validation, maxLength, alignment };
  }

  if (/(signature|sign here|handtekening|signed by|authorised sign|authorized sign)/.test(lbl)) {
    return { type: "signature", required, multiline, options, validation, alignment };
  }
  if (/(initials|voorletters)/.test(lbl) && !lbl.includes("first name")) {
    maxLength = 12;
    return { type: "initials", required, multiline, options, validation, maxLength, alignment };
  }
  if (/(e-mail|email|mail address|e-pos)/.test(lbl)) {
    validation = { pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" };
    return { type: "email", required, multiline, options, validation, alignment };
  }
  if (/(date|datum|dob|birth|issued on|expiry|valid until|dd\/mm|yyyy)/.test(lbl)) {
    validation = { dateFormat: "YYYY-MM-DD" };
    maxLength = 16;
    return { type: "date", required, multiline, options, validation, maxLength, alignment };
  }
  if (/(phone|telephone|telefoon|mobile|cell|fax|tel no|tel\b)/.test(lbl)) {
    validation = { pattern: "^[+0-9 ()-]{6,20}$" };
    maxLength = 20;
    return { type: "phone", required, multiline, options, validation, maxLength, alignment };
  }
  if (/(amount|price|salary|income|fee|total|currency|zar|usd|rand|\$|bedrag)/.test(lbl)) {
    alignment = "right";
    validation = { pattern: "^[0-9,. ]+$" };
    return { type: "currency", required, multiline, options, validation, alignment };
  }
  if (
    /(number|nommer|qty|quantity|count|age|year|postal code|zip code|poskode|id no|passport|account no|vin|licence|license)/.test(
      lbl
    )
  ) {
    validation = { pattern: "^[0-9A-Za-z -]+$" };
    if (lbl.includes("zip") || lbl.includes("postal") || lbl.includes("poskode")) {
      maxLength = 10;
    }
    return { type: "numeric", required, multiline, options, validation, maxLength, alignment };
  }
  if (/(address|adres|street|straat|residence|postal address|physical address|suburb|voorstad)/.test(lbl)) {
    if (heightPt >= 30 || geomKind === "multiline") multiline = true;
    return { type: "address", required, multiline, options, validation, alignment };
  }
  if (/(select|choose|country|province|state|gender|title \(mr|marital)/.test(lbl)) {
    if (lbl.includes("gender") || lbl.includes("sex")) {
      options = ["Female", "Male", "Other"];
      return { type: "dropdown", required, multiline, options, validation, alignment };
    }
    if (lbl.includes("title")) {
      options = ["Mr", "Mrs", "Ms", "Dr", "Prof"];
      return { type: "dropdown", required, multiline, options, validation, alignment };
    }
  }
  if (geomKind === "table_cell") {
    return { type: "table_cell", required, multiline, options, validation, alignment };
  }
  if (
    geomKind === "multiline" ||
    heightPt >= 34 ||
    /(comments|notes|description|remarks|reason|details|motivation|opmerkings)/.test(lbl)
  ) {
    multiline = true;
    return { type: "multiline", required, multiline, options, validation, alignment };
  }

  return { type: "text", required, multiline, options, validation, alignment };
}

/**
 * Bilingual / multi-column aware label association.
 * Prefers labels immediately left or directly above the field; falls back to right only for checkboxes/radios.
 */
export function findBestAssociatedLabel(
  rect: [number, number, number, number],
  labels: MergedTextLabel[],
  isSmallControl: boolean
): { label: string; score: number; hadSecondaryRightLabel?: string } {
  const [rx0, ry0, rx1, ry1] = rect;
  const rmidY = (ry0 + ry1) / 2;

  let bestLeftText = "";
  let bestLeftScore = 1e9;
  let bestAboveText = "";
  let bestAboveScore = 1e9;
  let bestRightText = "";
  let bestRightScore = 1e9;

  for (const lbl of labels) {
    const txt = lbl.text.trim();
    if (txt.length < 2 || isPurePunctuationOrPlaceholder(txt)) continue;
    if (lbl.isHeaderLike || lbl.isInstructionLike) continue;

    const lmidY = (lbl.y0 + lbl.y1) / 2;

    // 1. Left label on roughly same row
    if (lbl.x1 <= rx0 + 14 && Math.abs(lmidY - rmidY) <= 15) {
      const dist = Math.max(0, rx0 - lbl.x1) + Math.abs(lmidY - rmidY) * 1.4;
      if (dist < 260 && dist < bestLeftScore) {
        bestLeftScore = dist;
        bestLeftText = txt;
      }
    }

    // 2. Directly above label
    if (lbl.y1 <= ry0 + 6 && ry0 - lbl.y1 <= 24) {
      const horizOverlap = Math.min(rx1, lbl.x1) - Math.max(rx0, lbl.x0);
      if (horizOverlap > -25) {
        const dist = Math.max(0, ry0 - lbl.y1) * 2.1 + Math.abs(rx0 - lbl.x0) * 0.35;
        if (dist < 130 && dist < bestAboveScore) {
          bestAboveScore = dist;
          bestAboveText = txt;
        }
      }
    }

    // 3. Immediately right of small control (checkbox / radio option)
    if (
      isSmallControl &&
      lbl.x0 >= rx1 - 3 &&
      lbl.x0 - rx1 <= 90 &&
      Math.abs(lmidY - rmidY) <= 11
    ) {
      const dist = Math.max(0, lbl.x0 - rx1) + Math.abs(lmidY - rmidY) * 1.4;
      if (dist < bestRightScore) {
        bestRightScore = dist;
        bestRightText = txt;
      }
    }
  }

  if (isSmallControl && bestRightText && bestRightScore <= 35) {
    return {
      label: bestRightText.replace(/[:*]+$/, "").trim(),
      score: bestRightScore,
    };
  }
  if (bestLeftText && (!bestAboveText || bestLeftScore <= bestAboveScore * 1.35)) {
    return {
      label: bestLeftText.replace(/[:]+$/, "").trim(),
      score: bestLeftScore,
    };
  }
  if (bestAboveText) {
    return {
      label: bestAboveText.replace(/[:]+$/, "").trim(),
      score: bestAboveScore,
    };
  }
  if (bestRightText) {
    return {
      label: bestRightText.replace(/[:*]+$/, "").trim(),
      score: bestRightScore,
    };
  }
  return { label: "", score: 1e9 };
}

/**
 * Reconstruct writable sub-region when a table/form cell has a printed caption along its top or left edge
 * and open white writing space inside the rest of the box.
 */
function inspectCellCaptionAndWritableArea(
  box: { x0: number; y0: number; x1: number; y1: number },
  labels: MergedTextLabel[],
  rects: ExtractedRectPrimitive[]
): {
  skipAsHeaderOrLabel: boolean;
  writableRect: [number, number, number, number];
  captionLabel?: string;
} {
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const area = Math.max(1, bw * bh);

  // Skip dark/shaded section header banners containing text
  const shadedMatch = rects.some(
    (r) =>
      r.isShaded &&
      overlapArea([box.x0, box.y0, box.x1, box.y1], [r.x0, r.y0, r.x1, r.y1]) > area * 0.65
  );

  const overlappingLabels = labels.filter((l) => {
    const ov = overlapArea([box.x0, box.y0, box.x1, box.y1], [l.x0, l.y0, l.x1, l.y1]);
    const lArea = Math.max(1, (l.x1 - l.x0) * (l.y1 - l.y0));
    return ov > lArea * 0.45;
  });

  if (overlappingLabels.length === 0) {
    return {
      skipAsHeaderOrLabel: shadedMatch && bw > 140,
      writableRect: [box.x0, box.y0, box.x1, box.y1],
    };
  }

  if (shadedMatch) {
    return { skipAsHeaderOrLabel: true, writableRect: [box.x0, box.y0, box.x1, box.y1] };
  }

  // Filter out pure instruction/header text
  if (overlappingLabels.every((l) => l.isHeaderLike || l.isInstructionLike)) {
    return { skipAsHeaderOrLabel: true, writableRect: [box.x0, box.y0, box.x1, box.y1] };
  }

  const textCov = overlappingLabels.reduce(
    (sum, l) =>
      sum + overlapArea([box.x0, box.y0, box.x1, box.y1], [l.x0, l.y0, l.x1, l.y1]),
    0
  );
  const maxTextY1 = Math.max(...overlappingLabels.map((l) => l.y1));
  const minTextY0 = Math.min(...overlappingLabels.map((l) => l.y0));
  const maxTextX1 = Math.max(...overlappingLabels.map((l) => l.x1));
  const captionText = overlappingLabels
    .filter((l) => !l.isInstructionLike && !l.isHeaderLike)
    .map((l) => l.text.replace(/[:]+$/, "").trim())
    .join(" ")
    .trim();

  // Case A: Small caption printed in top strip of a box, leaving >= 10pt empty writing height below
  if (
    maxTextY1 - box.y0 <= bh * 0.56 &&
    box.y1 - maxTextY1 >= 10.5 &&
    bw >= 34 &&
    captionText.length >= 2 &&
    captionText.length <= 45
  ) {
    return {
      skipAsHeaderOrLabel: false,
      writableRect: [box.x0 + 1, maxTextY1 + 1, box.x1 - 1, box.y1 - 1],
      captionLabel: captionText,
    };
  }

  // Case B: Signature/caption label centered/bottom inside a tall box (>= 26pt), leaving top blank
  if (
    minTextY0 - box.y0 >= 16 &&
    /(signature|sign|handtekening|initials|date)/.test(captionText.toLowerCase())
  ) {
    return {
      skipAsHeaderOrLabel: false,
      writableRect: [box.x0 + 1, box.y0 + 1, box.x1 - 1, minTextY0 - 1],
      captionLabel: captionText,
    };
  }

  // Case C: Prompt on left side of wide cell, leaving >= 42pt empty writing space on the right
  if (
    maxTextX1 - box.x0 <= bw * 0.52 &&
    box.x1 - maxTextX1 >= 42 &&
    bh >= 12 &&
    bh <= 34 &&
    captionText.length >= 2 &&
    captionText.length <= 40
  ) {
    return {
      skipAsHeaderOrLabel: false,
      writableRect: [maxTextX1 + 4, box.y0 + 1, box.x1 - 1, box.y1 - 1],
      captionLabel: captionText,
    };
  }

  // Case D: Cell is predominantly filled with static printed text (header/label cell)
  if (textCov / area > 0.24 || bh <= 26) {
    return { skipAsHeaderOrLabel: true, writableRect: [box.x0, box.y0, box.x1, box.y1] };
  }

  return {
    skipAsHeaderOrLabel: false,
    writableRect: [box.x0, box.y0, box.x1, box.y1],
    captionLabel: captionText || undefined,
  };
}

/**
 * Fuse PDF structural primitives, vector lines/boxes/circles, glyph cues,
 * optional OCR/CV detections, and existing AcroForm widgets into classified DetectedFormFields.
 */
export function fuseAndClassifyPageGeometry(params: {
  geom: PageStructuralGeometry;
  pageBox: PdfPageBox;
  rotation: 0 | 90 | 180 | 270;
  existingWidgets: Array<{
    name: string;
    type: FormForgeFieldType;
    rect: PdfRect;
    defaultValue?: string;
    maxLength?: number;
    options?: string[];
  }>;
  extraLabels?: MergedTextLabel[];
  extraCandidates?: RawCandidate[];
  uniqueName: (raw: string) => string;
}): DetectedFormField[] {
  const { geom, pageBox, rotation, existingWidgets, extraLabels = [], extraCandidates = [], uniqueName } = params;
  const pageW = geom.pageWidthPt;
  const pageH = geom.pageHeightPt;

  const mergedH = mergeCollinearLines(geom.hLines, true);
  const mergedV = mergeCollinearLines(geom.vLines, false);

  const labels = [
    ...buildMergedTextLabels(geom.textRuns, mergedV, "pdf_text"),
    ...extraLabels,
  ];

  const pageFields: DetectedFormField[] = [];
  const candidates: RawCandidate[] = [];

  // Stage 1: Existing AcroForm widgets
  for (const w of existingWidgets) {
    const rTuple: [number, number, number, number] = [
      w.rect.x,
      w.rect.y,
      w.rect.x + w.rect.width,
      w.rect.y + w.rect.height,
    ];
    const lblMatch = findBestAssociatedLabel(rTuple, labels, w.rect.width <= 24);
    const clamped = clampPdfRect(w.rect, pageW, pageH);
    const ftype = w.type;
    pageFields.push({
      id: "",
      name: uniqueName(w.name || `widget_p${geom.pageIndex + 1}`),
      label: lblMatch.label || w.name.replace(/_/g, " ").trim() || "Form Field",
      type: ftype,
      page: geom.pageIndex,
      originalDetectedRect: w.rect,
      rect: clamped,
      pdfBottomLeftRect: topLeftPdfToBottomLeftPdf(clamped, pageBox, rotation),
      coordinateSpace: "top_left_pdf_pt",
      originalLabelText: lblMatch.label || w.name,
      detectionSource: "existing_acroform",
      detectionSources: ["existing_acroform"],
      confidence: 0.99,
      confidenceTier: "high",
      confidenceEvidence: ["Existing interactive AcroForm widget extracted from PDF"],
      required: false,
      defaultValue: w.defaultValue || "",
      maxLength: w.maxLength,
      multiline: ftype === "multiline",
      options: w.options || [],
      validation: {},
      reviewStatus: "accepted",
    });
  }

  // Stage 2: Reconstruct closed grid cells from lines + direct vector rects
  const reconstructedCells = reconstructGridCells(mergedH, mergedV, pageW, pageH);
  const combinedCells: Array<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    source: DetectionSource;
  }> = [...reconstructedCells];

  for (const r of geom.rects) {
    if (r.width > pageW * 0.94 && r.height > pageH * 0.94) continue;
    if (r.isDarkFill) continue;
    const dup = combinedCells.some(
      (c) =>
        Math.abs(c.x0 - r.x0) <= 2.5 &&
        Math.abs(c.y0 - r.y0) <= 2.5 &&
        Math.abs(c.x1 - r.x1) <= 2.5 &&
        Math.abs(c.y1 - r.y1) <= 2.5
    );
    if (!dup) {
      combinedCells.push({
        x0: r.x0,
        y0: r.y0,
        x1: r.x1,
        y1: r.y1,
        source: "vector_box",
      });
    }
  }

  // Separate small square/cell primitives vs larger cells
  const emptySmallBoxes: typeof combinedCells = [];
  const optionLabeledSmallBoxes: Array<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    optionLabel: string;
  }> = [];
  const largerBoxes: typeof combinedCells = [];

  for (const cell of combinedCells) {
    const cw = cell.x1 - cell.x0;
    const ch = cell.y1 - cell.y0;
    if (cw < 6.5 || ch < 6.5) continue;

    // Filter out outer container boxes that strictly enclose >= 2 smaller sub-cells
    const innerSubCells = combinedCells.filter(
      (other) =>
        other !== cell &&
        other.x0 >= cell.x0 - 1.5 &&
        other.y0 >= cell.y0 - 1.5 &&
        other.x1 <= cell.x1 + 1.5 &&
        other.y1 <= cell.y1 + 1.5 &&
        (other.x1 - other.x0) * (other.y1 - other.y0) < cw * ch * 0.85
    );
    if (innerSubCells.length >= 2) continue;

    const overlappingText = labels.filter((l) => {
      const ov = overlapArea([cell.x0, cell.y0, cell.x1, cell.y1], [l.x0, l.y0, l.x1, l.y1]);
      return ov > (l.x1 - l.x0) * (l.y1 - l.y0) * 0.45;
    });

    if (cw >= 7.0 && cw <= 30.0 && ch >= 7.5 && ch <= 34.0) {
      if (overlappingText.length === 0) {
        emptySmallBoxes.push(cell);
      } else {
        const optTxt = overlappingText.map((t) => t.text).join(" ").trim();
        if (optTxt.length <= 24 && ch >= 12 && ch <= 32) {
          optionLabeledSmallBoxes.push({ ...cell, optionLabel: optTxt });
        }
      }
    } else if (cw > 30 && cw <= 110 && ch >= 13 && ch <= 34 && overlappingText.length > 0) {
      // Potentially a horizontal selection option box like [ traffic register no. ] [ RSA ID ] [ foreign ID ]
      const optTxt = overlappingText.map((t) => t.text).join(" ").trim();
      if (optTxt.length >= 2 && optTxt.length <= 36) {
        optionLabeledSmallBoxes.push({ ...cell, optionLabel: optTxt });
      }
      largerBoxes.push(cell);
    } else if (cw >= 28.0 && ch >= 9.0) {
      largerBoxes.push(cell);
    }
  }

  // Stage 3: Group character cells & tick combs
  const { groups: charGroups, leftover: leftoverSmall } = clusterCharCells(
    emptySmallBoxes,
    labels
  );
  const tickCombs = detectTickCombBaselines(mergedH, mergedV);
  for (const tc of tickCombs) {
    charGroups.push({ ...tc, source: "vector_comb_grid" });
  }

  for (const grp of charGroups) {
    const gx0 = Math.min(...grp.cells.map((c) => c.x));
    const gy0 = Math.min(...grp.cells.map((c) => c.y));
    const gx1 = Math.max(...grp.cells.map((c) => c.x + c.width));
    const gy1 = Math.max(...grp.cells.map((c) => c.y + c.height));
    candidates.push({
      kind: "char_cells",
      x0: gx0,
      y0: gy0,
      x1: gx1,
      y1: gy1,
      source: grp.source,
      sources: [grp.source, "pdf_structural"],
      cellRects: grp.cells,
      charGridMeta: grp.meta,
      evidence: [
        `Detected ${grp.cells.length} uniform character boxes (${grp.meta.cellWidthPt}x${grp.meta.cellHeightPt}pt, gap ${grp.meta.spacingPt}pt, strategy: ${grp.meta.acroformStrategy})`,
      ],
      scoreBoost: 0.14,
    });
  }

  // Stage 4: Checkboxes, Radio Circles & Symbol Glyphs
  const radioCandidateNodes: Array<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    optLabel: string;
    source: DetectionSource;
  }> = [];

  for (const c of geom.circles) {
    const lblMatch = findBestAssociatedLabel([c.x0, c.y0, c.x1, c.y1], labels, true);
    radioCandidateNodes.push({
      x0: c.x0,
      y0: c.y0,
      x1: c.x1,
      y1: c.y1,
      optLabel: lblMatch.label || "Option",
      source: "vector_radio",
    });
  }

  for (const tr of geom.textRuns) {
    if (tr.isCheckboxGlyph) {
      candidates.push({
        kind: "checkbox",
        x0: tr.x0,
        y0: tr.y0,
        x1: Math.max(tr.x0 + 11, tr.x1),
        y1: Math.max(tr.y0 + 11, tr.y1),
        source: "glyph_symbol",
        sources: ["glyph_symbol"],
        evidence: [`Unicode/symbol checkbox glyph '${tr.text}'`],
      });
    } else if (tr.isRadioGlyph) {
      const lblMatch = findBestAssociatedLabel([tr.x0, tr.y0, tr.x1, tr.y1], labels, true);
      radioCandidateNodes.push({
        x0: tr.x0,
        y0: tr.y0,
        x1: Math.max(tr.x0 + 11, tr.x1),
        y1: Math.max(tr.y0 + 11, tr.y1),
        optLabel: lblMatch.label || "Option",
        source: "glyph_symbol",
      });
    }
  }

  for (const sb of leftoverSmall) {
    const sw = sb.x1 - sb.x0;
    const sh = sb.y1 - sb.y0;
    if (sw <= 24 && sh <= 24 && sw / Math.max(1, sh) >= 0.65 && sw / Math.max(1, sh) <= 1.45) {
      candidates.push({
        kind: "checkbox",
        x0: sb.x0,
        y0: sb.y0,
        x1: sb.x1,
        y1: sb.y1,
        source: "vector_checkbox",
        sources: [sb.source, "vector_checkbox"],
        evidence: [`Square empty checkbox geometry (${roundPt(sw)}x${roundPt(sh)}pt)`],
      });
    }
  }

  // Group horizontally aligned labeled selection option boxes (e.g. bordered choice rows near "mark with X")
  const optionRows: Array<typeof optionLabeledSmallBoxes> = [];
  const sortedOpts = [...optionLabeledSmallBoxes].sort(
    (a, b) => Math.round(a.y0 / 6) - Math.round(b.y0 / 6) || a.x0 - b.x0
  );
  for (const opt of sortedOpts) {
    const row = optionRows.find(
      (r) =>
        Math.abs(r[0].y0 - opt.y0) <= 5.0 &&
        Math.abs(r[0].y1 - opt.y1) <= 5.0 &&
        opt.x0 - r[r.length - 1].x1 <= 18.0
    );
    if (row) row.push(opt);
    else optionRows.push([opt]);
  }
  const usedOptionBoxKeys = new Set<string>();
  for (const row of optionRows) {
    if (row.length < 2 || row.length > 6) continue;
    const gx0 = Math.min(...row.map((r) => r.x0));
    const gy0 = Math.min(...row.map((r) => r.y0));
    const gx1 = Math.max(...row.map((r) => r.x1));
    const gy1 = Math.max(...row.map((r) => r.y1));
    // Verify there is an associated question prompt on the left
    const rowPrompt = findBestAssociatedLabel([gx0, gy0, gx1, gy1], labels, false);
    if (!rowPrompt.label) continue;

    const optionRects: Record<string, PdfRect> = {};
    const options: string[] = [];
    for (const r of row) {
      usedOptionBoxKeys.add(`${roundPt(r.x0)}:${roundPt(r.y0)}`);
      const optName = snakeCase(r.optionLabel, `opt_${options.length + 1}`);
      options.push(optName);
      optionRects[optName] = {
        x: roundPt(r.x0),
        y: roundPt(r.y0),
        width: roundPt(r.x1 - r.x0),
        height: roundPt(r.y1 - r.y0),
      };
    }
    candidates.push({
      kind: "radio",
      x0: gx0,
      y0: gy0,
      x1: gx1,
      y1: gy1,
      source: "ai_semantic_fusion",
      sources: ["pdf_structural", "ai_semantic_fusion"],
      explicitLabel: rowPrompt.label,
      options,
      optionRects,
      radioGroupName: snakeCase(rowPrompt.label, "choice_group"),
      groupId: `grp_${snakeCase(rowPrompt.label, "radio")}`,
      evidence: [
        `Detected ${row.length}-option selection group ('${options.join(", ")}') paired with '${rowPrompt.label}'`,
      ],
      scoreBoost: 0.14,
    });
  }

  // Group radio circle nodes on the same row/column into unified radio groups
  const groupedRadioRows: Array<typeof radioCandidateNodes> = [];
  for (const rn of radioCandidateNodes) {
    const grp = groupedRadioRows.find(
      (g) => Math.abs(g[0].y0 - rn.y0) <= 10.0 && Math.abs(rn.x0 - g[g.length - 1].x0) <= 180
    );
    if (grp) grp.push(rn);
    else groupedRadioRows.push([rn]);
  }
  for (const rgrp of groupedRadioRows) {
    const gx0 = Math.min(...rgrp.map((r) => r.x0));
    const gy0 = Math.min(...rgrp.map((r) => r.y0));
    const gx1 = Math.max(...rgrp.map((r) => r.x1));
    const gy1 = Math.max(...rgrp.map((r) => r.y1));
    const prompt = findBestAssociatedLabel([gx0, gy0, gx1, gy1], labels, false);
    const optionRects: Record<string, PdfRect> = {};
    const options: string[] = [];
    rgrp.forEach((rn, idx) => {
      const opt = rn.optLabel || `Option ${idx + 1}`;
      const uniqOpt = options.includes(opt) ? `${opt} ${idx + 1}` : opt;
      options.push(uniqOpt);
      optionRects[uniqOpt] = {
        x: roundPt(rn.x0),
        y: roundPt(rn.y0),
        width: roundPt(Math.max(10, rn.x1 - rn.x0)),
        height: roundPt(Math.max(10, rn.y1 - rn.y0)),
      };
    });
    candidates.push({
      kind: "radio",
      x0: gx0,
      y0: gy0,
      x1: gx1,
      y1: gy1,
      source: rgrp[0].source,
      sources: [rgrp[0].source, "ai_semantic_fusion"],
      explicitLabel: prompt.label || (options.length > 1 ? options.join(" / ") : options[0]),
      options,
      optionRects,
      radioGroupName: snakeCase(prompt.label || options[0] || "radio_group"),
      groupId: `grp_${snakeCase(prompt.label || "radio")}`,
      evidence: [`Detected circular/symbol radio cluster (${options.join(", ")})`],
      scoreBoost: 0.1,
    });
  }

  // Stage 5: Inspect larger rectangular cells & split captions from writable areas
  const hasArrowInside = (bx0: number, by0: number, bx1: number, by1: number): boolean =>
    geom.textRuns.some(
      (t) => t.isDropdownArrow && t.x0 >= bx0 && t.x1 <= bx1 && t.y0 >= by0 && t.y1 <= by1
    );

  for (const box of largerBoxes) {
    if (usedOptionBoxKeys.has(`${roundPt(box.x0)}:${roundPt(box.y0)}`)) continue;

    // Skip if box already surrounds a char_cells group
    const coversCharGroup = candidates.some(
      (c) =>
        c.kind === "char_cells" &&
        overlapArea([box.x0, box.y0, box.x1, box.y1], [c.x0, c.y0, c.x1, c.y1]) >
          (c.x1 - c.x0) * (c.y1 - c.y0) * 0.6
    );
    if (coversCharGroup) continue;

    const inspected = inspectCellCaptionAndWritableArea(box, labels, geom.rects);
    if (inspected.skipAsHeaderOrLabel) continue;

    const [wx0, wy0, wx1, wy1] = inspected.writableRect;
    const ww = wx1 - wx0;
    const wh = wy1 - wy0;
    if (ww < 18 || wh < 9.5) continue;

    const dropdownCue = hasArrowInside(box.x0, box.y0, box.x1, box.y1);
    const kind: RawCandidate["kind"] = dropdownCue
      ? "dropdown"
      : wh >= 34
      ? "multiline"
      : box.source === "table_cell"
      ? "table_cell"
      : "box";

    candidates.push({
      kind,
      x0: wx0,
      y0: wy0,
      x1: wx1,
      y1: wy1,
      source: inspected.captionLabel ? "ai_semantic_fusion" : box.source,
      sources: inspected.captionLabel
        ? [box.source, "ai_semantic_fusion"]
        : [box.source],
      explicitLabel: inspected.captionLabel,
      evidence: [
        inspected.captionLabel
          ? `Extracted writable region below/beside internal cell caption '${inspected.captionLabel}'`
          : `Empty vector box (${roundPt(ww)}x${roundPt(wh)}pt)`,
      ],
    });
  }

  // Stage 6: Standalone horizontal underlines (and stacked multiline groups)
  const standaloneUnderlines: Array<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    source: DetectionSource;
    explicitLabel?: string;
  }> = [];

  for (const h of mergedH) {
    const hw = h.x1 - h.x0;
    if (hw < 36) continue;
    // Skip lines that are already part of a reconstructed box/cell edge
    const partOfCell = combinedCells.some(
      (c) =>
        (Math.abs(h.y0 - c.y0) <= 2.2 || Math.abs(h.y0 - c.y1) <= 2.2) &&
        overlapArea([h.x0, h.y0 - 2, h.x1, h.y0 + 2], [c.x0, c.y0 - 2, c.x1, c.y1 + 2]) >
          hw * 0.45
    );
    if (partOfCell) continue;

    // Skip lines directly crossing middle of dense header text
    const crossesText = labels.some(
      (l) =>
        l.isHeaderLike &&
        h.y0 >= l.y0 &&
        h.y0 <= l.y1 + 4 &&
        Math.min(h.x1, l.x1) - Math.max(h.x0, l.x0) > 20
    );
    if (crossesText) continue;

    // Also check if label sits directly BELOW the line (signature / name caption style)
    let belowLbl = "";
    const belowMatches = labels.filter(
      (l) =>
        !l.isHeaderLike &&
        !l.isInstructionLike &&
        l.y0 >= h.y0 - 1 &&
        l.y0 - h.y0 <= 16 &&
        Math.min(h.x1, l.x1) - Math.max(h.x0, l.x0) > 12
    );
    if (belowMatches.length > 0 && belowMatches[0].text.length <= 40) {
      belowLbl = belowMatches[0].text.replace(/[:()]+/g, "").trim();
    }

    standaloneUnderlines.push({
      x0: h.x0,
      y0: Math.max(0, h.y0 - 18.0),
      x1: h.x1,
      y1: Math.max(8, h.y0 - 0.5),
      source: "vector_underline",
      explicitLabel: belowLbl || undefined,
    });
  }

  // Inline text underline cues ("Full Legal Name: ____________")
  for (const lbl of labels) {
    const m = lbl.text.match(/([A-Za-z0-9 /()-]{2,45}):?\s*([_\.]{4,})/);
    if (m) {
      const prefix = m[1].trim();
      const idx = lbl.text.indexOf(m[2]);
      const ratio = idx / Math.max(1, lbl.text.length);
      const ux0 = lbl.x0 + (lbl.x1 - lbl.x0) * ratio;
      const ux1 = lbl.x1;
      if (ux1 - ux0 >= 28) {
        standaloneUnderlines.push({
          x0: ux0,
          y0: Math.max(0, lbl.y0 - 2),
          x1: ux1,
          y1: lbl.y1 + 1,
          source: lbl.source === "pdf_text" ? "vector_underline" : "ocr_region",
          explicitLabel: prefix,
        });
      }
    }
  }

  // Group vertically stacked blank answer underlines into multiline text fields
  const sortedUnderlines = [...standaloneUnderlines].sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0);
  const usedU = new Array<boolean>(sortedUnderlines.length).fill(false);
  for (let i = 0; i < sortedUnderlines.length; i++) {
    if (usedU[i]) continue;
    const stack = [sortedUnderlines[i]];
    usedU[i] = true;
    for (let j = i + 1; j < sortedUnderlines.length; j++) {
      if (usedU[j]) continue;
      const cand = sortedUnderlines[j];
      const prev = stack[stack.length - 1];
      const vGap = cand.y1 - prev.y1;
      const sameCols =
        Math.abs(cand.x0 - prev.x0) <= 12 &&
        Math.abs(cand.x1 - prev.x1) <= 18;
      // Ensure no printed label sits on the stacked line itself
      const hasMidLabel = labels.some(
        (l) =>
          !l.isInstructionLike &&
          l.y1 > prev.y1 + 2 &&
          l.y0 < cand.y1 - 2 &&
          l.x0 >= cand.x0 - 8 &&
          l.x0 <= cand.x1
      );
      if (sameCols && vGap >= 11 && vGap <= 26 && !hasMidLabel) {
        stack.push(cand);
        usedU[j] = true;
      }
    }
    if (stack.length >= 2) {
      candidates.push({
        kind: "multiline",
        x0: Math.min(...stack.map((s) => s.x0)),
        y0: stack[0].y0,
        x1: Math.max(...stack.map((s) => s.x1)),
        y1: stack[stack.length - 1].y1,
        source: "ai_semantic_fusion",
        sources: ["vector_underline", "ai_semantic_fusion"],
        explicitLabel: stack[0].explicitLabel,
        evidence: [`Merged ${stack.length} stacked answer underlines into multiline writing area`],
        scoreBoost: 0.1,
      });
    } else {
      const s = stack[0];
      candidates.push({
        kind: "underline",
        x0: s.x0,
        y0: s.y0,
        x1: s.x1,
        y1: s.y1,
        source: s.source,
        sources: [s.source],
        explicitLabel: s.explicitLabel,
        evidence: [`Horizontal answer underline (${roundPt(s.x1 - s.x0)}pt wide)`],
      });
    }
  }

  // Stage 7: Text-only colon prompt fallback ("Email Address:" with clean blank area to the right)
  for (const lbl of labels) {
    if (lbl.isHeaderLike || lbl.isInstructionLike || !lbl.hasColon) continue;
    const cleanPrompt = lbl.text.replace(/[:]+$/, "").trim();
    if (cleanPrompt.length < 2 || cleanPrompt.length > 52) continue;

    const alreadyCovered = candidates.some((c) => {
      const cMidY = (c.y0 + c.y1) / 2;
      const lMidY = (lbl.y0 + lbl.y1) / 2;
      const sameRow = Math.abs(cMidY - lMidY) <= 14;
      const toRightOrBelow = c.x0 >= lbl.x1 - 12 || (c.y0 >= lbl.y1 - 4 && c.y0 - lbl.y1 <= 24);
      return sameRow && toRightOrBelow;
    });
    if (alreadyCovered) continue;

    const fx0 = lbl.x1 + 8;
    const fx1 = Math.min(pageW - 36, fx0 + 210);
    if (fx1 - fx0 < 48) continue;

    // Confirm the proposed area is free of text
    const blockedByText = labels.some(
      (other) =>
        other !== lbl &&
        overlapArea([fx0, lbl.y0 - 2, fx1, lbl.y1 + 2], [other.x0, other.y0, other.x1, other.y1]) > 15
    );
    if (blockedByText) continue;

    candidates.push({
      kind: "box",
      x0: fx0,
      y0: Math.max(4, lbl.y0 - 2),
      x1: fx1,
      y1: Math.min(pageH - 4, lbl.y1 + 4),
      source: "ai_semantic_fusion",
      sources: ["ai_semantic_fusion"],
      explicitLabel: cleanPrompt,
      evidence: [`Colon prompt '${cleanPrompt}:' paired with adjacent blank space`],
      scoreBoost: -0.1,
    });
  }

  // Include any extra CV / OCR / external detector candidates
  candidates.push(...extraCandidates);

  // Stage 8: Fusion, deduplication & confidence scoring
  // Priority order: char_cells > radio > checkbox > dropdown/listbox > multiline > box/table_cell > underline
  const priorityMap: Record<RawCandidate["kind"], number> = {
    char_cells: 7,
    radio: 6,
    checkbox: 5,
    dropdown: 5,
    listbox: 5,
    multiline: 4,
    table_cell: 3,
    box: 3,
    underline: 2,
  };
  candidates.sort((a, b) => (priorityMap[b.kind] || 0) - (priorityMap[a.kind] || 0));

  for (const cand of candidates) {
    const rw = cand.x1 - cand.x0;
    const rh = cand.y1 - cand.y0;
    if (rw < 6 || rh < 6) continue;

    const rawRect: PdfRect = {
      x: roundPt(Math.max(0, cand.x0)),
      y: roundPt(Math.max(0, cand.y0)),
      width: roundPt(rw),
      height: roundPt(rh),
    };

    // Check overlap against already fused fields
    const overlappingIdx = pageFields.findIndex((existing) => {
      const iou = computeRectIoU(existing.rect, rawRect);
      if (iou >= 0.45) return true;
      const ov = overlapArea(
        [rawRect.x, rawRect.y, rawRect.x + rawRect.width, rawRect.y + rawRect.height],
        [
          existing.rect.x,
          existing.rect.y,
          existing.rect.x + existing.rect.width,
          existing.rect.y + existing.rect.height,
        ]
      );
      const minArea = Math.min(rawRect.width * rawRect.height, existing.rect.width * existing.rect.height);
      // Avoid deleting valid distinct fields unless >= 65% of the smaller rect is strictly redundant
      return ov > minArea * 0.65 && existing.type !== "radio";
    });

    if (overlappingIdx >= 0) {
      // Merge corroborating detection source into existing higher-priority field
      const ex = pageFields[overlappingIdx];
      const mergedSources = new Set<DetectionSource>([
        ex.detectionSource,
        ...(ex.detectionSources || []),
        ...cand.sources,
      ]);
      ex.detectionSources = Array.from(mergedSources);
      ex.confidence = roundPt(Math.min(0.98, ex.confidence + 0.04));
      ex.confidenceTier = ex.confidence >= 0.85 ? "high" : ex.confidence >= 0.6 ? "medium" : "low";
      if (!ex.confidenceEvidence.includes(cand.evidence[0])) {
        ex.confidenceEvidence.push(...cand.evidence);
      }
      continue;
    }

    const isSmall = cand.kind === "checkbox" || cand.kind === "radio";
    const lblRes = cand.explicitLabel
      ? { label: cand.explicitLabel, score: 0 }
      : findBestAssociatedLabel([cand.x0, cand.y0, cand.x1, cand.y1], labels, isSmall);

    const semantic = inferSemanticType(
      lblRes.label || "",
      rw,
      rh,
      cand.kind,
      cand.cellRects?.length || 0
    );

    let score = 0.54 + (cand.scoreBoost || 0);
    if (cand.source === "vector_comb_grid" || cand.source === "vector_char_cells") score += 0.24;
    else if (cand.source === "pdf_structural" || cand.source === "vector_box") score += 0.2;
    else if (cand.source === "vector_underline" || cand.source === "vector_checkbox" || cand.source === "vector_radio") score += 0.2;
    else if (cand.source === "glyph_symbol") score += 0.22;
    else if (cand.source === "cv_contour" || cand.source === "cv_circle") score += 0.14;

    if (lblRes.label) {
      score += lblRes.score < 55 ? 0.18 : 0.1;
    } else {
      score -= 0.08;
    }
    score = roundPt(Math.min(0.98, Math.max(0.35, score)));
    const tier: ConfidenceTier = score >= 0.85 ? "high" : score >= 0.6 ? "medium" : "low";

    const fallbackLabel =
      semantic.type === "checkbox"
        ? "Checkbox"
        : semantic.type === "radio"
        ? "Radio Choice"
        : semantic.type === "char_cells"
        ? `Character Grid (${cand.cellRects?.length || 0})`
        : `Input Field ${pageFields.length + 1}`;
    const finalLabel = lblRes.label || fallbackLabel;
    const clampedRect = clampPdfRect(rawRect, pageW, pageH);

    const reviewFlagReason =
      tier === "low"
        ? lblRes.label
          ? "Low geometry confidence — verify bounds in Visual Field Editor"
          : "No adjacent label identified — confirm label & field type"
        : undefined;

    pageFields.push({
      id: "",
      name: uniqueName(finalLabel),
      label: finalLabel,
      type: semantic.type,
      page: geom.pageIndex,
      originalDetectedRect: rawRect,
      rect: clampedRect,
      pdfBottomLeftRect: topLeftPdfToBottomLeftPdf(clampedRect, pageBox, rotation),
      cellRects: cand.cellRects,
      charGridMeta: cand.charGridMeta,
      optionRects: cand.optionRects,
      coordinateSpace: "top_left_pdf_pt",
      originalLabelText: lblRes.label || "",
      detectionSource: cand.source,
      detectionSources: Array.from(new Set(cand.sources)),
      confidence: score,
      confidenceTier: tier,
      confidenceEvidence: [
        ...cand.evidence,
        lblRes.label
          ? `Paired with label '${lblRes.label}'`
          : "No adjacent label found; flagged for human verification",
      ],
      required: semantic.required,
      defaultValue: "",
      maxLength: semantic.maxLength,
      multiline: semantic.multiline,
      options: cand.options && cand.options.length > 0 ? cand.options : semantic.options,
      validation: semantic.validation,
      groupId: cand.groupId,
      radioGroupName: cand.radioGroupName,
      alignment: semantic.alignment,
      reviewStatus: tier === "high" && cand.source === "existing_acroform" ? "accepted" : "pending",
      reviewFlagReason,
    });
  }

  // Reading-order sort: top-to-bottom bands (10pt), left-to-right
  pageFields.sort((a, b) => {
    const ry = Math.round(a.rect.y / 10) - Math.round(b.rect.y / 10);
    if (ry !== 0) return ry;
    return a.rect.x - b.rect.x;
  });

  return pageFields;
}

export function buildDetectionSummary(
  fields: DetectedFormField[],
  engineMode: DetectionSummary["engineMode"]
): DetectionSummary {
  const countsByType: Record<string, number> = {};
  const countsBySource: Record<string, number> = {};
  let high = 0;
  let medium = 0;
  let low = 0;
  let reviewRecommendedCount = 0;
  let charGridGroupCount = 0;
  let combFieldCount = 0;

  for (const f of fields) {
    countsByType[f.type] = (countsByType[f.type] || 0) + 1;
    countsBySource[f.detectionSource] = (countsBySource[f.detectionSource] || 0) + 1;
    if (f.confidenceTier === "high") high++;
    else if (f.confidenceTier === "medium") medium++;
    else low++;
    if (f.confidenceTier === "low" || Boolean(f.reviewFlagReason)) {
      reviewRecommendedCount++;
    }
    if (f.type === "char_cells") {
      charGridGroupCount++;
      if (f.charGridMeta?.acroformStrategy !== "individual_cells") {
        combFieldCount++;
      }
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
