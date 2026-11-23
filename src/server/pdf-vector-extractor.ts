import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfRect } from "../lib/formforge/types.ts";

export interface ExtractedLineSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thickness: number;
  source: "stroke" | "thin_fill" | "rect_edge";
}

export interface ExtractedRectPrimitive {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
  kind: "stroke" | "fill" | "fill_stroke";
  fillColor?: string;
  isShaded: boolean;
  isDarkFill: boolean;
}

export interface ExtractedCirclePrimitive {
  cx: number;
  cy: number;
  r: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ExtractedTextRun {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fontSize: number;
  fontName: string;
  isCheckboxGlyph: boolean;
  isRadioGlyph: boolean;
  isDropdownArrow: boolean;
}

export interface ExtractedImageRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
}

export interface PageStructuralGeometry {
  pageIndex: number;
  pageWidthPt: number;
  pageHeightPt: number;
  hLines: ExtractedLineSegment[];
  vLines: ExtractedLineSegment[];
  rects: ExtractedRectPrimitive[];
  circles: ExtractedCirclePrimitive[];
  textRuns: ExtractedTextRun[];
  imageRegions: ExtractedImageRegion[];
  drawingOpCount: number;
}

function mulMat(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMat(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function parseHexLuminance(hexColor: string | undefined): number {
  if (!hexColor || !hexColor.startsWith("#") || hexColor.length < 7) return 1.0;
  const r = parseInt(hexColor.slice(1, 3), 16) / 255;
  const g = parseInt(hexColor.slice(3, 5), 16) / 255;
  const b = parseInt(hexColor.slice(5, 7), 16) / 255;
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 1.0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function classifyStrokeFillOp(paintOp: number): "stroke" | "fill" | "fill_stroke" {
  const OPS = pdfjsLib.OPS;
  if (
    paintOp === OPS.fill ||
    paintOp === OPS.eoFill
  ) {
    return "fill";
  }
  if (
    paintOp === OPS.fillStroke ||
    paintOp === OPS.eoFillStroke ||
    paintOp === OPS.closeFillStroke ||
    paintOp === OPS.closeEOFillStroke
  ) {
    return "fill_stroke";
  }
  return "stroke";
}

function recordLineOrBox(
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  kind: "stroke" | "fill" | "fill_stroke",
  fillColor: string | undefined,
  lineWidth: number,
  hLines: ExtractedLineSegment[],
  vLines: ExtractedLineSegment[],
  rects: ExtractedRectPrimitive[]
) {
  const x0 = Math.min(rx0, rx1);
  const y0 = Math.min(ry0, ry1);
  const x1 = Math.max(rx0, rx1);
  const y1 = Math.max(ry0, ry1);
  const rw = x1 - x0;
  const rh = y1 - y0;

  // Thin horizontal bar or stroked line
  if (rh <= 3.2 && rw >= 6.0) {
    hLines.push({
      x0,
      y0: (y0 + y1) / 2,
      x1,
      y1: (y0 + y1) / 2,
      thickness: Math.max(0.4, rh || lineWidth),
      source: kind === "fill" ? "thin_fill" : "stroke",
    });
    return;
  }

  // Thin vertical bar or stroked line
  if (rw <= 3.2 && rh >= 5.0) {
    vLines.push({
      x0: (x0 + x1) / 2,
      y0,
      x1: (x0 + x1) / 2,
      y1,
      thickness: Math.max(0.4, rw || lineWidth),
      source: kind === "fill" ? "thin_fill" : "stroke",
    });
    return;
  }

  if (rw < 4.0 || rh < 4.0) return;

  const lum = parseHexLuminance(fillColor);
  const isFill = kind === "fill" || kind === "fill_stroke";
  const isShaded = isFill && lum < 0.96;
  const isDarkFill = isFill && lum < 0.65;

  rects.push({
    x0,
    y0,
    x1,
    y1,
    width: rw,
    height: rh,
    kind,
    fillColor,
    isShaded,
    isDarkFill,
  });

  // Also decompose stroked rectangle edges into line segments for unified grid intersection
  if (kind === "stroke" || kind === "fill_stroke") {
    hLines.push(
      { x0, y0, x1, y1: y0, thickness: lineWidth, source: "rect_edge" },
      { x0, y0: y1, x1, y1, thickness: lineWidth, source: "rect_edge" }
    );
    vLines.push(
      { x0, y0, x1: x0, y1, thickness: lineWidth, source: "rect_edge" },
      { x0: x1, y0, x1, y1, thickness: lineWidth, source: "rect_edge" }
    );
  }
}

function parseConstructPath(
  args: unknown[],
  ctm: number[],
  fillColor: string | undefined,
  lineWidth: number,
  hLines: ExtractedLineSegment[],
  vLines: ExtractedLineSegment[],
  rects: ExtractedRectPrimitive[],
  circles: ExtractedCirclePrimitive[]
) {
  const paintOp = Number(args[0] ?? pdfjsLib.OPS.stroke);
  const opsData = args[1];
  const minMax = args[2] as ArrayLike<number> | undefined;
  const kind = classifyStrokeFillOp(paintOp);

  // pdfjs-dist DrawOPS encoded inside constructPath buffer:
  // 0 = moveTo(x,y), 1 = lineTo(x,y), 2 = curveTo(6 args), 3 = quadraticCurveTo(4 args), 4 = closePath()
  const DRAW_MOVE_TO = 0;
  const DRAW_LINE_TO = 1;
  const DRAW_CURVE_TO = 2;
  const DRAW_QUAD_CURVE_TO = 3;
  const DRAW_CLOSE_PATH = 4;

  const dataArr: number[] = [];
  if (Array.isArray(opsData) && opsData.length > 0 && opsData[0] && typeof opsData[0] === "object") {
    const first = opsData[0] as ArrayLike<number> & Record<string, number>;
    if (ArrayBuffer.isView(first)) {
      const view = first as unknown as ArrayLike<number>;
      for (let i = 0; i < view.length; i++) dataArr.push(Number(view[i]));
    } else if (typeof first.length === "number") {
      for (let i = 0; i < first.length; i++) dataArr.push(Number(first[i] ?? 0));
    } else {
      const len = Object.keys(first).length;
      for (let i = 0; i < len; i++) dataArr.push(Number(first[String(i)] ?? 0));
    }
  } else if (ArrayBuffer.isView(opsData)) {
    const view = opsData as unknown as ArrayLike<number>;
    for (let i = 0; i < view.length; i++) dataArr.push(Number(view[i]));
  } else if (Array.isArray(opsData) && typeof opsData[0] === "number") {
    for (const v of opsData) dataArr.push(Number(v));
  }

  // Fallback to bounding box when opsData is empty
  if (dataArr.length === 0 && minMax && minMax.length >= 4) {
    const [x0, y0] = applyMat(ctm, Number(minMax[0]), Number(minMax[1]));
    const [x1, y1] = applyMat(ctm, Number(minMax[2]), Number(minMax[3]));
    recordLineOrBox(x0, y0, x1, y1, kind, fillColor, lineWidth, hLines, vLines, rects);
    return;
  }

  let i = 0;
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;
  let hasCurves = false;
  let subPathSegments = 0;
  let pts: Array<[number, number]> = [];
  let curvePts: Array<[number, number]> = [];
  let minPx = Infinity;
  let minPy = Infinity;
  let maxPx = -Infinity;
  let maxPy = -Infinity;

  const trackPt = (px: number, py: number) => {
    if (px < minPx) minPx = px;
    if (py < minPy) minPy = py;
    if (px > maxPx) maxPx = px;
    if (py > maxPy) maxPy = py;
  };

  const resetSubpath = () => {
    hasCurves = false;
    subPathSegments = 0;
    pts = [];
    curvePts = [];
    minPx = Infinity;
    minPy = Infinity;
    maxPx = -Infinity;
    maxPy = -Infinity;
  };

  const flushSubpath = () => {
    if (pts.length < 2 && !hasCurves) {
      resetSubpath();
      return;
    }

    const bw = maxPx - minPx;
    const bh = maxPy - minPy;

    // 1. Detect circular radio button outlines constructed from 3-4 Bezier curves
    if (
      hasCurves &&
      curvePts.length >= 3 &&
      bw >= 6.5 &&
      bw <= 24.0 &&
      bh >= 6.5 &&
      bh <= 24.0 &&
      Math.abs(bw - bh) <= 3.5
    ) {
      circles.push({
        cx: (minPx + maxPx) / 2,
        cy: (minPy + maxPy) / 2,
        r: (bw + bh) / 4,
        x0: minPx,
        y0: minPy,
        x1: maxPx,
        y1: maxPy,
      });
      resetSubpath();
      return;
    }

    // 2. Single stroked line segment (handles duplicate initial moveTo points cleanly)
    if (subPathSegments === 1 && pts.length >= 2 && kind !== "fill") {
      const [p0x, p0y] = pts[pts.length - 2];
      const [p1x, p1y] = pts[pts.length - 1];
      const dx = Math.abs(p1x - p0x);
      const dy = Math.abs(p1y - p0y);
      if (dy <= 1.6 && dx >= 6.0) {
        hLines.push({
          x0: Math.min(p0x, p1x),
          y0: (p0y + p1y) / 2,
          x1: Math.max(p0x, p1x),
          y1: (p0y + p1y) / 2,
          thickness: lineWidth,
          source: "stroke",
        });
      } else if (dx <= 1.6 && dy >= 5.0) {
        vLines.push({
          x0: (p0x + p1x) / 2,
          y0: Math.min(p0y, p1y),
          x1: (p0x + p1x) / 2,
          y1: Math.max(p0y, p1y),
          thickness: lineWidth,
          source: "stroke",
        });
      }
      resetSubpath();
      return;
    }

    // 3. Closed boxes, polygons, or thin filled bars (3+ points)
    if (minPx < maxPx && minPy < maxPy && (subPathSegments >= 2 || kind === "fill" || kind === "fill_stroke")) {
      recordLineOrBox(
        minPx,
        minPy,
        maxPx,
        maxPy,
        kind,
        fillColor,
        lineWidth,
        hLines,
        vLines,
        rects
      );
    }

    resetSubpath();
  };

  while (i < dataArr.length) {
    const op = dataArr[i++];
    if (op === DRAW_MOVE_TO && i + 1 < dataArr.length) {
      if (subPathSegments > 0) {
        flushSubpath();
      } else if (pts.length > 0) {
        resetSubpath();
      }
      const [px, py] = applyMat(ctm, dataArr[i], dataArr[i + 1]);
      i += 2;
      curX = px;
      curY = py;
      startX = px;
      startY = py;
      pts.push([px, py]);
      trackPt(px, py);
    } else if (op === DRAW_LINE_TO && i + 1 < dataArr.length) {
      const [px, py] = applyMat(ctm, dataArr[i], dataArr[i + 1]);
      i += 2;
      pts.push([px, py]);
      trackPt(px, py);
      subPathSegments++;
      curX = px;
      curY = py;
    } else if (op === DRAW_CURVE_TO && i + 5 < dataArr.length) {
      const [c1x, c1y] = applyMat(ctm, dataArr[i], dataArr[i + 1]);
      const [c2x, c2y] = applyMat(ctm, dataArr[i + 2], dataArr[i + 3]);
      const [px, py] = applyMat(ctm, dataArr[i + 4], dataArr[i + 5]);
      i += 6;
      hasCurves = true;
      subPathSegments++;
      trackPt(c1x, c1y);
      trackPt(c2x, c2y);
      trackPt(px, py);
      pts.push([px, py]);
      curvePts.push([px, py]);
      curX = px;
      curY = py;
    } else if (op === DRAW_QUAD_CURVE_TO && i + 3 < dataArr.length) {
      const [c1x, c1y] = applyMat(ctm, dataArr[i], dataArr[i + 1]);
      const [px, py] = applyMat(ctm, dataArr[i + 2], dataArr[i + 3]);
      i += 4;
      hasCurves = true;
      subPathSegments++;
      trackPt(c1x, c1y);
      trackPt(px, py);
      pts.push([px, py]);
      curvePts.push([px, py]);
      curX = px;
      curY = py;
    } else if (op === DRAW_CLOSE_PATH) {
      if (Math.hypot(startX - curX, startY - curY) > 0.5) {
        subPathSegments++;
      }
      curX = startX;
      curY = startY;
      flushSubpath();
    } else {
      break;
    }
  }

  flushSubpath();
}

function formatRgbColor(args: unknown[]): string | undefined {
  if (!args || args.length === 0) return undefined;
  const first = args[0];
  if (typeof first === "string") {
    return first.startsWith("#") ? first : undefined;
  }
  const toByte = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v <= 1 && !Number.isInteger(v) ? v * 255 : v)));
  if (args.length >= 3 && typeof args[0] === "number") {
    const r = toByte(Number(args[0]));
    const g = toByte(Number(args[1]));
    const b = toByte(Number(args[2]));
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }
  if (first && typeof first === "object" && "length" in first) {
    const arr = first as ArrayLike<number>;
    if (arr.length >= 3) {
      const r = toByte(Number(arr[0]));
      const g = toByte(Number(arr[1]));
      const b = toByte(Number(arr[2]));
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }
  }
  return undefined;
}

export async function extractPageStructuralGeometry(
  jsPage: pdfjsLib.PDFPageProxy,
  pageIndex: number
): Promise<PageStructuralGeometry> {
  const viewport = jsPage.getViewport({ scale: 1 });
  const [opList, textContent] = await Promise.all([
    jsPage.getOperatorList(),
    jsPage.getTextContent(),
  ]);

  const OPS = pdfjsLib.OPS;
  let ctm = [...viewport.transform];
  const stateStack: Array<{ ctm: number[]; fillColor: string; lineWidth: number }> = [];
  let fillColor = "#000000";
  let lineWidth = 0.8;
  let drawingOpCount = 0;

  const hLines: ExtractedLineSegment[] = [];
  const vLines: ExtractedLineSegment[] = [];
  const rects: ExtractedRectPrimitive[] = [];
  const circles: ExtractedCirclePrimitive[] = [];
  const imageRegions: ExtractedImageRegion[] = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] || [];

    if (fn === OPS.save) {
      stateStack.push({ ctm: [...ctm], fillColor, lineWidth });
    } else if (fn === OPS.restore) {
      const prev = stateStack.pop();
      if (prev) {
        ctm = prev.ctm;
        fillColor = prev.fillColor;
        lineWidth = prev.lineWidth;
      } else {
        ctm = [...viewport.transform];
      }
    } else if (fn === OPS.transform && args.length >= 6) {
      ctm = mulMat(ctm, args as number[]);
    } else if (fn === OPS.setFillRGBColor && args.length >= 1) {
      fillColor = formatRgbColor(args) || fillColor;
    } else if (fn === OPS.setFillGray && args.length >= 1) {
      const rawG = Number(args[0]);
      const g = Math.max(0, Math.min(255, Math.round(rawG <= 1 ? rawG * 255 : rawG)));
      const h = g.toString(16).padStart(2, "0");
      fillColor = `#${h}${h}${h}`;
    } else if (fn === OPS.setFillCMYKColor && args.length >= 4) {
      const [c, m, y, k] = args.map((v: unknown) => Math.max(0, Math.min(1, Number(v) || 0)));
      const r = Math.round(255 * (1 - c) * (1 - k));
      const g = Math.round(255 * (1 - m) * (1 - k));
      const b = Math.round(255 * (1 - y) * (1 - k));
      fillColor = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    } else if (fn === OPS.setLineWidth && args.length >= 1) {
      lineWidth = Math.max(0.25, Number(args[0] || 0.8));
    } else if (fn === OPS.constructPath) {
      drawingOpCount++;
      parseConstructPath(
        args,
        ctm,
        fillColor,
        lineWidth,
        hLines,
        vLines,
        rects,
        circles
      );
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject
    ) {
      const [p0x, p0y] = applyMat(ctm, 0, 0);
      const [p1x, p1y] = applyMat(ctm, 1, 1);
      const x0 = Math.min(p0x, p1x);
      const y0 = Math.min(p0y, p1y);
      const x1 = Math.max(p0x, p1x);
      const y1 = Math.max(p0y, p1y);
      if (x1 - x0 >= 12 && y1 - y0 >= 12) {
        imageRegions.push({
          x0,
          y0,
          x1,
          y1,
          width: x1 - x0,
          height: y1 - y0,
        });
      }
    }
  }

  const textRuns: ExtractedTextRun[] = [];
  const styles = (textContent.styles || {}) as Record<string, { fontFamily?: string }>;
  for (const item of textContent.items) {
    if (!("str" in item) || typeof item.str !== "string") continue;
    const txt = item.str;
    if (!txt.trim()) continue;

    // Transform item coordinates into visual top-left viewport space, handling 0/90/180/270 page rotations
    const tm = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontScale = Math.hypot(tm[0], tm[1]);
    const fontSize = Math.max(5.5, Number(item.height || fontScale || 9));
    const rawW = Math.max(2, Number(item.width || txt.length * fontSize * 0.45));

    // Unit direction along text baseline in visual space
    const dirLen = Math.hypot(tm[0], tm[1]) || 1;
    const ux = tm[0] / dirLen;
    const uy = tm[1] / dirLen;
    // Perpendicular up-direction in visual space (towards ascenders, which is -y for normal unrotated LTR)
    const nx = uy;
    const ny = -ux;

    const bx = tm[4];
    const by = tm[5];
    const asc = fontSize * 0.88;
    const desc = fontSize * 0.2;

    const corners: Array<[number, number]> = [
      [bx + nx * asc, by + ny * asc],
      [bx + ux * rawW + nx * asc, by + uy * rawW + ny * asc],
      [bx - nx * desc, by - ny * desc],
      [bx + ux * rawW - nx * desc, by + uy * rawW - ny * desc],
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const x0 = Math.max(0, Math.min(...xs));
    const y0 = Math.max(0, Math.min(...ys));
    const x1 = Math.min(viewport.width, Math.max(...xs));
    const y1 = Math.min(viewport.height, Math.max(...ys));

    const trimmed = txt.trim();
    const fontName = String(item.fontName || styles[String(item.fontName || "")]?.fontFamily || "");
    const lowerFont = fontName.toLowerCase();
    const isSymbolFont =
      lowerFont.includes("dingbat") || lowerFont.includes("wingding") || lowerFont.includes("symbol");

    const isCheckboxGlyph =
      /^[☐☑☒□▢■❏❑❐]$/.test(trimmed) ||
      /^\[\s*\]$/.test(trimmed) ||
      (isSymbolFont && trimmed.length === 1 && ["o", "q", "n", "p", "\x6f", "\xa8", "\xfe"].includes(trimmed));
    const isRadioGlyph =
      /^[○◯●◉❍◎]$/.test(trimmed) || /^\(\s*\)$/.test(trimmed);
    const isDropdownArrow = /^[▼▾▽]$/.test(trimmed);

    textRuns.push({
      text: trimmed,
      x0,
      y0,
      x1: Math.max(x0 + 1, x1),
      y1: Math.max(y0 + 1, y1),
      fontSize,
      fontName,
      isCheckboxGlyph,
      isRadioGlyph,
      isDropdownArrow,
    });
  }

  return {
    pageIndex,
    pageWidthPt: viewport.width,
    pageHeightPt: viewport.height,
    hLines,
    vLines,
    rects,
    circles,
    textRuns,
    imageRegions,
    drawingOpCount,
  };
}

export function rectContainsPoint(r: PdfRect, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height;
}
