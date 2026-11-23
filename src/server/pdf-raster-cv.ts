import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { imagePxToTopLeftPdf, roundPt } from "../lib/formforge/coordinate.ts";
import type {
  ExtractedCirclePrimitive,
  ExtractedLineSegment,
  ExtractedRectPrimitive,
} from "./pdf-vector-extractor.ts";

const execFileAsync = promisify(execFile);

let cachedGsFontmapDir: string | null = null;

/**
 * Locate installed TrueType system fonts and build a minimal Ghostscript Fontmap.GS
 * so Ghostscript 9.x renders PDFs with unembedded Standard14 fonts (Helvetica, Times, Courier)
 * cleanly even on minimal Linux containers without URW Type1 font packs.
 */
export function getGsFontmapArgs(): string[] {
  if (cachedGsFontmapDir && fs.existsSync(path.join(cachedGsFontmapDir, "Fontmap.GS"))) {
    return [`-I${cachedGsFontmapDir}`];
  }

  const pickFirst = (candidates: string[]): string | null =>
    candidates.find((p) => fs.existsSync(p)) ?? null;

  const sansReg = pickFirst([
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ]);
  const sansBold = pickFirst([
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    sansReg ?? "",
  ]);
  const sansItal = pickFirst([
    "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
    sansReg ?? "",
  ]);
  const sansBoldItal = pickFirst([
    "/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf",
    sansBold ?? "",
  ]);
  const serifReg = pickFirst([
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    sansReg ?? "",
  ]);
  const serifBold = pickFirst([
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    sansBold ?? "",
  ]);
  const monoReg = pickFirst([
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    sansReg ?? "",
  ]);
  const monoBold = pickFirst([
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    sansBold ?? "",
  ]);

  if (!sansReg) return [];

  const entries: Array<[string, string | null]> = [
    ["Helvetica", sansReg],
    ["Helvetica-Bold", sansBold],
    ["Helvetica-Oblique", sansItal],
    ["Helvetica-BoldOblique", sansBoldItal],
    ["NimbusSans-Regular", sansReg],
    ["NimbusSans-Bold", sansBold],
    ["NimbusSans-Italic", sansItal],
    ["NimbusSans-BoldItalic", sansBoldItal],
    ["Times-Roman", serifReg],
    ["Times-Bold", serifBold],
    ["NimbusRoman-Regular", serifReg],
    ["NimbusRoman-Bold", serifBold],
    ["Courier", monoReg],
    ["Courier-Bold", monoBold],
    ["NimbusMonoPS-Regular", monoReg],
    ["NimbusMonoPS-Bold", monoBold],
  ];

  const dir = path.join(os.tmpdir(), "formforge-gs-fontmap");
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, fontPath]) => `/${name} (${fontPath}) ;`);
  fs.writeFileSync(path.join(dir, "Fontmap.GS"), `${lines.join("\n")}\n`, "utf-8");
  cachedGsFontmapDir = dir;
  return [`-I${dir}`];
}

export interface RasterPageImage {
  width: number;
  height: number;
  dpi: number;
  gray: Uint8Array;
}

export interface RasterCvExtractionResult {
  hLines: ExtractedLineSegment[];
  vLines: ExtractedLineSegment[];
  rects: ExtractedRectPrimitive[];
  circles: ExtractedCirclePrimitive[];
  deskewAngle: number;
  bmpBuffer: Buffer;
  width: number;
  height: number;
}

/**
 * Parse binary P5 PGM buffer produced by Ghostscript `-sDEVICE=pgmraw`.
 */
export function parsePgmBuffer(buf: Buffer): {
  width: number;
  height: number;
  gray: Uint8Array;
} {
  let offset = 0;
  const readToken = (): string => {
    while (offset < buf.length) {
      const b = buf[offset];
      if (b === 35) {
        // '#' comment until newline
        while (offset < buf.length && buf[offset] !== 10 && buf[offset] !== 13) {
          offset++;
        }
      } else if (b === 9 || b === 10 || b === 13 || b === 32) {
        offset++;
      } else {
        break;
      }
    }
    const start = offset;
    while (offset < buf.length) {
      const b = buf[offset];
      if (b === 9 || b === 10 || b === 13 || b === 32 || b === 35) break;
      offset++;
    }
    return buf.subarray(start, offset).toString("ascii");
  };

  const magic = readToken();
  if (magic !== "P5") {
    throw new Error(`Unsupported PGM magic header: ${magic}`);
  }
  const width = Number(readToken());
  const height = Number(readToken());
  const maxVal = Number(readToken());
  // Exactly one whitespace character separates header from binary pixel data
  if (offset < buf.length && (buf[offset] === 10 || buf[offset] === 32 || buf[offset] === 13 || buf[offset] === 9)) {
    offset++;
  }
  const pixelCount = width * height;
  const gray = new Uint8Array(pixelCount);
  const available = Math.min(pixelCount, buf.length - offset);
  if (maxVal === 255) {
    gray.set(buf.subarray(offset, offset + available));
  } else {
    const scale = 255 / Math.max(1, maxVal);
    for (let i = 0; i < available; i++) {
      gray[i] = Math.min(255, Math.round(buf[offset + i] * scale));
    }
  }
  return { width, height, gray };
}

/**
 * Encode an 8-bit grayscale buffer into an uncompressed 24-bit BMP Buffer
 * (accepted natively by Tesseract / Leptonica without temporary files or extra libs).
 */
export function encodeGrayToBmpBuffer(
  gray: Uint8Array,
  width: number,
  height: number
): Buffer {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const fileSize = 54 + pixelBytes;
  const out = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER (14 bytes)
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(0, 6);
  out.writeUInt32LE(54, 10);

  // BITMAPINFOHEADER (40 bytes)
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22); // positive = bottom-up
  out.writeUInt16LE(1, 26); // planes
  out.writeUInt16LE(24, 28); // bpp
  out.writeUInt32LE(0, 30); // BI_RGB
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  out.writeUInt32LE(0, 46);
  out.writeUInt32LE(0, 50);

  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width;
    const dstRow = 54 + y * rowStride;
    for (let x = 0; x < width; x++) {
      const v = gray[srcRow + x];
      const p = dstRow + x * 3;
      out[p] = v;
      out[p + 1] = v;
      out[p + 2] = v;
    }
  }

  return out;
}

/**
 * Render a single PDF page to a grayscale raster via Ghostscript.
 */
export async function renderPdfPageGray(
  pdfPath: string,
  pageIndex: number,
  dpi = 180
): Promise<RasterPageImage> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formforge-gs-"));
  const outPgm = path.join(tmpDir, `page_${pageIndex + 1}.pgm`);
  try {
    await execFileAsync(
      "gs",
      [
        "-q",
        ...getGsFontmapArgs(),
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-sDEVICE=pgmraw",
        `-r${dpi}`,
        `-dFirstPage=${pageIndex + 1}`,
        `-dLastPage=${pageIndex + 1}`,
        `-sOutputFile=${outPgm}`,
        pdfPath,
      ],
      { timeout: 30000 }
    );
    const raw = fs.readFileSync(outPgm);
    const { width, height, gray } = parsePgmBuffer(raw);
    return { width, height, dpi, gray };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Render PNG thumbnails for all pages of a PDF into `outDir`.
 */
export async function renderPageThumbnails(
  pdfPath: string,
  outDir: string,
  pageCount: number,
  dpi = 100
): Promise<Array<string | null>> {
  const results = new Array<string | null>(pageCount).fill(null);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const pattern = path.join(outDir, "page_%03d.png");
    await execFileAsync(
      "gs",
      [
        "-q",
        ...getGsFontmapArgs(),
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-sDEVICE=png16m",
        `-r${dpi}`,
        `-sOutputFile=${pattern}`,
        pdfPath,
      ],
      { timeout: 45000 }
    );
    for (let i = 0; i < pageCount; i++) {
      const name = `page_${String(i + 1).padStart(3, "0")}.png`;
      if (fs.existsSync(path.join(outDir, name))) {
        results[i] = name;
      }
    }
  } catch {
    // Non-fatal: thumbnails are optional visual aids
  }
  return results;
}

/**
 * Integral-image adaptive thresholding (Bradley-Roth) combined with global dark-ink safety
 * and 3x3 isolated speckle removal. Returns binary foreground mask (`1` = ink/line, `0` = white).
 */
export function binarizeAndDenoise(
  gray: Uint8Array,
  width: number,
  height: number,
  dpi: number
): Uint8Array {
  const n = width * height;
  const integral = new Float64Array((width + 1) * (height + 1));
  const iw = width + 1;

  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    const srcOff = (y - 1) * width;
    const dstOff = y * iw;
    const prevOff = (y - 1) * iw;
    for (let x = 1; x <= width; x++) {
      rowSum += gray[srcOff + (x - 1)];
      integral[dstOff + x] = integral[prevOff + x] + rowSum;
    }
  }

  const radius = Math.max(8, Math.round(dpi * 0.12));
  const rawBin = new Uint8Array(n);

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * iw + (x1 + 1)] -
        integral[y0 * iw + (x1 + 1)] -
        integral[(y1 + 1) * iw + x0] +
        integral[y0 * iw + x0];
      const localMean = sum / count;
      const g = gray[y * width + x];
      // Foreground if significantly darker than local window OR clearly dark ink/rules
      if (g < localMean * 0.87 || (g < 170 && g < localMean - 12)) {
        rawBin[y * width + x] = 1;
      }
    }
  }

  // Light 3x3 isolated-pixel noise cleanup (removes 1px scan dust without breaking 1px lines)
  const denoised = new Uint8Array(rawBin);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (rawBin[idx] === 0) continue;
      const neighbors =
        rawBin[idx - 1] +
        rawBin[idx + 1] +
        rawBin[idx - width] +
        rawBin[idx + width] +
        rawBin[idx - width - 1] +
        rawBin[idx - width + 1] +
        rawBin[idx + width - 1] +
        rawBin[idx + width + 1];
      if (neighbors === 0) {
        denoised[idx] = 0;
      }
    }
  }
  return denoised;
}

/**
 * Estimate dominant page skew angle in degrees (-6°..+6°) using projection profile variance
 * on downsampled foreground points, then rotate image back when |skew| >= 0.3°.
 */
export function estimateAndDeskew(
  gray: Uint8Array,
  binary: Uint8Array,
  width: number,
  height: number
): {
  deskewAngle: number;
  gray: Uint8Array;
  binary: Uint8Array;
} {
  // Collect strided sample of foreground pixel coordinates for fast projection scoring
  const ptsX: number[] = [];
  const ptsY: number[] = [];
  const stride = width * height > 2_000_000 ? 3 : 2;
  const xMargin = Math.floor(width * 0.04);
  const yMargin = Math.floor(height * 0.04);

  for (let y = yMargin; y < height - yMargin; y += stride) {
    const row = y * width;
    for (let x = xMargin; x < width - xMargin; x += stride) {
      if (binary[row + x]) {
        ptsX.push(x - width / 2);
        ptsY.push(y - height / 2);
      }
    }
  }

  if (ptsX.length < 60) {
    return { deskewAngle: 0, gray, binary };
  }

  const scoreAngle = (deg: number): number => {
    const rad = (deg * Math.PI) / 180;
    const sinA = Math.sin(rad);
    const cosA = Math.cos(rad);
    const binHeight = Math.ceil(height / 2) + 8;
    const hist = new Int32Array(binHeight);
    const halfH = height / 2;
    for (let i = 0; i < ptsX.length; i++) {
      const ry = Math.round((-ptsX[i] * sinA + ptsY[i] * cosA + halfH) / 2);
      if (ry >= 0 && ry < binHeight) {
        hist[ry]++;
      }
    }
    let energy = 0;
    for (let i = 0; i < hist.length; i++) {
      const v = hist[i];
      energy += v * v;
    }
    return energy;
  };

  let bestAngle = 0;
  let bestScore = scoreAngle(0);
  for (let a = -6.0; a <= 6.01; a += 0.5) {
    const s = scoreAngle(a);
    if (s > bestScore) {
      bestScore = s;
      bestAngle = a;
    }
  }
  const coarseBest = bestAngle;
  for (let a = coarseBest - 0.5; a <= coarseBest + 0.501; a += 0.1) {
    const s = scoreAngle(a);
    if (s > bestScore) {
      bestScore = s;
      bestAngle = a;
    }
  }

  const zeroScore = scoreAngle(0);
  // Require meaningful skew improvement so perfectly digital/axis-aligned pages stay 0°
  if (Math.abs(bestAngle) < 0.3 || bestScore <= zeroScore * 1.015) {
    return { deskewAngle: 0, gray, binary };
  }

  const rad = (-bestAngle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  const outGray = new Uint8Array(width * height).fill(255);
  const outBin = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    const dstRow = y * width;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      // Inverse map destination pixel back into source coordinates
      const sx = dx * cosA + dy * sinA + cx;
      const sy = -dx * sinA + dy * cosA + cy;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      if (ix >= 0 && ix < width - 1 && iy >= 0 && iy < height - 1) {
        const fx = sx - ix;
        const fy = sy - iy;
        const i00 = iy * width + ix;
        const g = Math.round(
          gray[i00] * (1 - fx) * (1 - fy) +
            gray[i00 + 1] * fx * (1 - fy) +
            gray[i00 + width] * (1 - fx) * fy +
            gray[i00 + width + 1] * fx * fy
        );
        outGray[dstRow + x] = g;
        // Preserve binary ink near interpolated edges cleanly
        const nnX = Math.round(sx);
        const nnY = Math.round(sy);
        outBin[dstRow + x] = binary[nnY * width + nnX] || g < 150 ? 1 : 0;
      }
    }
  }

  return {
    deskewAngle: roundPt(bestAngle),
    gray: outGray,
    binary: outBin,
  };
}

/**
 * Extract horizontal & vertical rule lines, dotted raster lines, hollow contour boxes,
 * radio circle contours, and shaded banner rectangles from the binary + grayscale raster.
 */
export function extractCvGeometryFromRaster(
  gray: Uint8Array,
  binary: Uint8Array,
  width: number,
  height: number,
  dpi: number,
  pageWidthPt: number,
  pageHeightPt: number
): {
  hLines: ExtractedLineSegment[];
  vLines: ExtractedLineSegment[];
  rects: ExtractedRectPrimitive[];
  circles: ExtractedCirclePrimitive[];
} {
  const pxPerPt = dpi / 72.0;
  const minHLenPx = Math.max(8, Math.round(7.5 * pxPerPt));
  const minVLenPx = Math.max(8, Math.round(6.5 * pxPerPt));
  const maxThickPx = Math.max(3, Math.round(3.6 * pxPerPt));

  const hLines: ExtractedLineSegment[] = [];
  const vLines: ExtractedLineSegment[] = [];
  const rects: ExtractedRectPrimitive[] = [];
  const circles: ExtractedCirclePrimitive[] = [];

  // 1. Morphological horizontal line detection (bridging 1px scan gaps)
  const rawHSpans: Array<{ x0: number; x1: number; y: number }> = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      if (!binary[row + x]) {
        x++;
        continue;
      }
      const start = x;
      let lastInk = x;
      let gaps = 0;
      x++;
      while (x < width) {
        if (binary[row + x]) {
          lastInk = x;
          gaps = 0;
        } else {
          gaps++;
          if (gaps > 2) break;
        }
        x++;
      }
      if (lastInk - start + 1 >= minHLenPx) {
        rawHSpans.push({ x0: start, x1: lastInk + 1, y });
      }
    }
  }

  // Merge adjacent scanlines belonging to the same physical horizontal stroke
  const hMergedBands: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  for (const sp of rawHSpans) {
    const band = hMergedBands.find(
      (b) =>
        sp.y - b.y1 <= 2 &&
        Math.min(sp.x1, b.x1) - Math.max(sp.x0, b.x0) >=
          Math.min(sp.x1 - sp.x0, b.x1 - b.x0) * 0.6
    );
    if (band) {
      band.x0 = Math.min(band.x0, sp.x0);
      band.x1 = Math.max(band.x1, sp.x1);
      band.y1 = sp.y;
    } else {
      hMergedBands.push({ x0: sp.x0, x1: sp.x1, y0: sp.y, y1: sp.y });
    }
  }

  for (const b of hMergedBands) {
    const thick = b.y1 - b.y0 + 1;
    if (thick > maxThickPx * 2) continue; // solid filled dark bar, not a line
    const pt = imagePxToTopLeftPdf(
      { x: b.x0, y: (b.y0 + b.y1) / 2, width: b.x1 - b.x0, height: 1 },
      dpi,
      pageWidthPt,
      pageHeightPt
    );
    hLines.push({
      x0: pt.x,
      y0: pt.y,
      x1: roundPt(pt.x + pt.width),
      y1: pt.y,
      thickness: roundPt(Math.max(0.5, thick / pxPerPt)),
      source: "stroke",
    });
  }

  // 2. Raster dotted-line detector (e.g., "Place . . . . . . . . . . .")
  const dotMaxW = Math.max(3, Math.round(3.8 * pxPerPt));
  const dotMaxGap = Math.max(6, Math.round(9.5 * pxPerPt));
  for (let y = 2; y < height - 2; y += 2) {
    const dots: Array<{ x0: number; x1: number }> = [];
    let x = 0;
    while (x < width) {
      // Check tiny vertical neighborhood for a dot
      const hasInk =
        binary[y * width + x] ||
        binary[(y - 1) * width + x] ||
        binary[(y + 1) * width + x];
      if (!hasInk) {
        x++;
        continue;
      }
      const start = x;
      while (
        x < width &&
        (binary[y * width + x] || binary[(y - 1) * width + x] || binary[(y + 1) * width + x])
      ) {
        x++;
      }
      const w = x - start;
      if (w >= 1 && w <= dotMaxW) {
        // Confirm it's a low-height dot, not a tall letter stem
        let inkUp = 0;
        let inkDown = 0;
        for (let dy = 1; dy <= Math.max(4, Math.round(4 * pxPerPt)); dy++) {
          if (y - dy >= 0 && binary[(y - dy) * width + start]) inkUp++;
          if (y + dy < height && binary[(y + dy) * width + start]) inkDown++;
        }
        if (inkUp <= 2 && inkDown <= 2) {
          dots.push({ x0: start, x1: x });
        }
      }
    }
    if (dots.length < 7) continue;
    let runStart = dots[0].x0;
    let runEnd = dots[0].x1;
    let count = 1;
    for (let k = 1; k < dots.length; k++) {
      const gap = dots[k].x0 - dots[k - 1].x1;
      if (gap >= 1 && gap <= dotMaxGap) {
        runEnd = dots[k].x1;
        count++;
      } else {
        if (count >= 7 && (runEnd - runStart) / pxPerPt >= 28) {
          const pt = imagePxToTopLeftPdf(
            { x: runStart, y, width: runEnd - runStart, height: 1 },
            dpi,
            pageWidthPt,
            pageHeightPt
          );
          hLines.push({
            x0: pt.x,
            y0: pt.y,
            x1: roundPt(pt.x + pt.width),
            y1: pt.y,
            thickness: 0.75,
            source: "stroke",
          });
        }
        runStart = dots[k].x0;
        runEnd = dots[k].x1;
        count = 1;
      }
    }
    if (count >= 7 && (runEnd - runStart) / pxPerPt >= 28) {
      const pt = imagePxToTopLeftPdf(
        { x: runStart, y, width: runEnd - runStart, height: 1 },
        dpi,
        pageWidthPt,
        pageHeightPt
      );
      hLines.push({
        x0: pt.x,
        y0: pt.y,
        x1: roundPt(pt.x + pt.width),
        y1: pt.y,
        thickness: 0.75,
        source: "stroke",
      });
    }
  }

  // 3. Morphological vertical line detection
  const rawVSpans: Array<{ x: number; y0: number; y1: number }> = [];
  for (let x = 0; x < width; x++) {
    let y = 0;
    while (y < height) {
      if (!binary[y * width + x]) {
        y++;
        continue;
      }
      const start = y;
      let lastInk = y;
      let gaps = 0;
      y++;
      while (y < height) {
        if (binary[y * width + x]) {
          lastInk = y;
          gaps = 0;
        } else {
          gaps++;
          if (gaps > 2) break;
        }
        y++;
      }
      if (lastInk - start + 1 >= minVLenPx) {
        rawVSpans.push({ x, y0: start, y1: lastInk + 1 });
      }
    }
  }

  const vMergedBands: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  for (const sp of rawVSpans) {
    const band = vMergedBands.find(
      (b) =>
        sp.x - b.x1 <= 2 &&
        Math.min(sp.y1, b.y1) - Math.max(sp.y0, b.y0) >=
          Math.min(sp.y1 - sp.y0, b.y1 - b.y0) * 0.6
    );
    if (band) {
      band.y0 = Math.min(band.y0, sp.y0);
      band.y1 = Math.max(band.y1, sp.y1);
      band.x1 = sp.x;
    } else {
      vMergedBands.push({ x0: sp.x, x1: sp.x, y0: sp.y0, y1: sp.y1 });
    }
  }

  for (const b of vMergedBands) {
    const thick = b.x1 - b.x0 + 1;
    if (thick > maxThickPx * 2) continue;
    const pt = imagePxToTopLeftPdf(
      { x: (b.x0 + b.x1) / 2, y: b.y0, width: 1, height: b.y1 - b.y0 },
      dpi,
      pageWidthPt,
      pageHeightPt
    );
    vLines.push({
      x0: pt.x,
      y0: pt.y,
      x1: pt.x,
      y1: roundPt(pt.y + pt.height),
      thickness: roundPt(Math.max(0.5, thick / pxPerPt)),
      source: "stroke",
    });
  }

  // 4. Connected-component contour analysis for enclosed white boxes, small checkboxes & circular radio rings
  //    We label enclosed background (white = 0) components that do not touch the image boundary.
  const n = width * height;
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);

  // Mark exterior background via flood fill from border pixels
  let qHead = 0;
  let qTail = 0;
  const enqueueExterior = (idx: number) => {
    if (!visited[idx] && binary[idx] === 0) {
      visited[idx] = 1;
      queue[qTail++] = idx;
    }
  };
  for (let x = 0; x < width; x++) {
    enqueueExterior(x);
    enqueueExterior((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    enqueueExterior(y * width);
    enqueueExterior(y * width + (width - 1));
  }
  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % width;
    const cy = (cur - cx) / width;
    if (cx > 0) enqueueExterior(cur - 1);
    if (cx < width - 1) enqueueExterior(cur + 1);
    if (cy > 0) enqueueExterior(cur - width);
    if (cy < height - 1) enqueueExterior(cur + width);
  }

  // Remaining unvisited white pixels are enclosed inside drawn contours/boxes/circles
  const minBoxPx = Math.max(7, Math.round(6.0 * pxPerPt));
  const maxPageAreaPx = n * 0.55;

  for (let i = 0; i < n; i++) {
    if (visited[i] || binary[i] !== 0) continue;
    visited[i] = 1;
    qHead = 0;
    qTail = 0;
    queue[qTail++] = i;

    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let area = 0;
    let graySum = 0;

    while (qHead < qTail) {
      const cur = queue[qHead++];
      const cx = cur % width;
      const cy = (cur - cx) / width;
      area++;
      graySum += gray[cur];
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      if (cx > 0 && !visited[cur - 1] && binary[cur - 1] === 0) {
        visited[cur - 1] = 1;
        queue[qTail++] = cur - 1;
      }
      if (cx < width - 1 && !visited[cur + 1] && binary[cur + 1] === 0) {
        visited[cur + 1] = 1;
        queue[qTail++] = cur + 1;
      }
      if (cy > 0 && !visited[cur - width] && binary[cur - width] === 0) {
        visited[cur - width] = 1;
        queue[qTail++] = cur - width;
      }
      if (cy < height - 1 && !visited[cur + width] && binary[cur + width] === 0) {
        visited[cur + width] = 1;
        queue[qTail++] = cur + width;
      }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < minBoxPx || bh < minBoxPx || bw * bh > maxPageAreaPx) continue;

    const wPt = bw / pxPerPt;
    const hPt = bh / pxPerPt;
    if (wPt < 6.0 || hPt < 6.0 || wPt > pageWidthPt * 0.94 || hPt > pageHeightPt * 0.85) {
      continue;
    }

    const fillRatio = area / (bw * bh);
    const ptRect = imagePxToTopLeftPdf(
      { x: Math.max(0, minX - 1), y: Math.max(0, minY - 1), width: bw + 2, height: bh + 2 },
      dpi,
      pageWidthPt,
      pageHeightPt
    );

    // Circular radio button ring interior: aspect ~1:1, small diameter (6..22pt), circle area/bbox ~ 0.62..0.85
    if (
      wPt >= 6.0 &&
      wPt <= 22.0 &&
      hPt >= 6.0 &&
      hPt <= 22.0 &&
      Math.abs(wPt - hPt) <= 2.5 &&
      fillRatio >= 0.56 &&
      fillRatio <= 0.86
    ) {
      // Confirm corner pixels of the bounding box are foreground/border or exterior rather than white interior
      const cornersWhite =
        (binary[minY * width + minX] === 0 ? 1 : 0) +
        (binary[minY * width + maxX] === 0 ? 1 : 0) +
        (binary[maxY * width + minX] === 0 ? 1 : 0) +
        (binary[maxY * width + maxX] === 0 ? 1 : 0);
      if (cornersWhite <= 2) {
        circles.push({
          cx: roundPt(ptRect.x + ptRect.width / 2),
          cy: roundPt(ptRect.y + ptRect.height / 2),
          r: roundPt((ptRect.width + ptRect.height) / 4),
          x0: ptRect.x,
          y0: ptRect.y,
          x1: roundPt(ptRect.x + ptRect.width),
          y1: roundPt(ptRect.y + ptRect.height),
        });
        continue;
      }
    }

    // Rectangular form box / character cell / checkbox outline (high fillRatio)
    if (fillRatio >= 0.68) {
      const meanGray = graySum / Math.max(1, area);
      const isShaded = meanGray < 238;
      const isDarkFill = meanGray < 165;
      const grayHex = Math.max(0, Math.min(255, Math.round(meanGray)))
        .toString(16)
        .padStart(2, "0");

      rects.push({
        x0: ptRect.x,
        y0: ptRect.y,
        x1: roundPt(ptRect.x + ptRect.width),
        y1: roundPt(ptRect.y + ptRect.height),
        width: ptRect.width,
        height: ptRect.height,
        kind: isShaded ? "fill_stroke" : "stroke",
        fillColor: isShaded ? `#${grayHex}${grayHex}${grayHex}` : undefined,
        isShaded,
        isDarkFill,
      });
    }
  }

  // 5. Shaded header banner detector from horizontal gray strips (for scanned forms where banner text breaks white CC)
  const minBannerW = Math.round(120 * pxPerPt);
  const minBannerH = Math.round(10 * pxPerPt);
  const maxBannerH = Math.round(32 * pxPerPt);
  const rowMeanGray = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let count = 0;
    const row = y * width;
    for (let x = Math.floor(width * 0.08); x < Math.floor(width * 0.92); x += 2) {
      const g = gray[row + x];
      if (g > 90) {
        // exclude pure black text/rule pixels to sample background paper shade
        sum += g;
        count++;
      }
    }
    rowMeanGray[y] = count > 0 ? sum / count : 255;
  }

  let bStart = -1;
  for (let y = 0; y <= height; y++) {
    const shadedRow = y < height && rowMeanGray[y] >= 120 && rowMeanGray[y] <= 232;
    if (shadedRow && bStart === -1) {
      bStart = y;
    } else if (!shadedRow && bStart !== -1) {
      const bh = y - bStart;
      if (bh >= minBannerH && bh <= maxBannerH) {
        // Measure horizontal extent of shaded fill in middle row
        const midY = Math.floor((bStart + y) / 2);
        let sx0 = -1;
        let sx1 = -1;
        for (let x = 0; x < width; x++) {
          if (gray[midY * width + x] <= 236) {
            if (sx0 === -1) sx0 = x;
            sx1 = x;
          }
        }
        if (sx0 >= 0 && sx1 - sx0 >= minBannerW) {
          const pt = imagePxToTopLeftPdf(
            { x: sx0, y: bStart, width: sx1 - sx0, height: bh },
            dpi,
            pageWidthPt,
            pageHeightPt
          );
          rects.push({
            x0: pt.x,
            y0: pt.y,
            x1: roundPt(pt.x + pt.width),
            y1: roundPt(pt.y + pt.height),
            width: pt.width,
            height: pt.height,
            kind: "fill_stroke",
            fillColor: "#cccccc",
            isShaded: true,
            isDarkFill: false,
          });
        }
      }
      bStart = -1;
    }
  }

  return { hLines, vLines, rects, circles };
}

/**
 * Full per-page raster CV preprocessing pipeline: render via Ghostscript,
 * binarize & denoise, deskew if rotated, extract CV geometry, and encode BMP for OCR.
 */
export async function runRasterCvOnPdfPage(
  pdfPath: string,
  pageIndex: number,
  pageWidthPt: number,
  pageHeightPt: number,
  dpi = 180
): Promise<RasterCvExtractionResult> {
  const rendered = await renderPdfPageGray(pdfPath, pageIndex, dpi);
  const initialBin = binarizeAndDenoise(
    rendered.gray,
    rendered.width,
    rendered.height,
    dpi
  );
  const { deskewAngle, gray, binary } = estimateAndDeskew(
    rendered.gray,
    initialBin,
    rendered.width,
    rendered.height
  );

  const geom = extractCvGeometryFromRaster(
    gray,
    binary,
    rendered.width,
    rendered.height,
    dpi,
    pageWidthPt,
    pageHeightPt
  );

  const bmpBuffer = encodeGrayToBmpBuffer(gray, rendered.width, rendered.height);

  return {
    ...geom,
    deskewAngle,
    bmpBuffer,
    width: rendered.width,
    height: rendered.height,
  };
}
