import type { DocumentPageInfo, PdfPageBox, PdfRect } from "./types.ts";

/**
 * Canonical FormifyPDF Coordinate Transformation Module
 *
 * Canonical storage space ("top_left_pdf_pt"):
 *   - Origin (0, 0) is top-left of the visible CropBox AFTER PDF /Rotate.
 *   - Units are PDF points (1/72 inch).
 *   - Width/height reflect the effective visual page box after PDF rotation.
 *
 * PDF User-Space / AcroForm space ("bottom_left_pdf_pt"):
 *   - Origin (0, 0) is bottom-left of the unrotated PDF coordinate system.
 *   - CropBox is [cropBox.x, cropBox.y, cropBox.x + cropBox.width, cropBox.y + cropBox.height]
 *     in unrotated PDF user space.
 *   - Correctly handles page rotations 0, 90, 180, 270 and non-zero CropBox offsets.
 *
 * Image Pixel / Browser Viewport space:
 *   - Origin (0, 0) is top-left of the rendered page at DPI (`dpi / 72`) or `zoom` scale.
 */

export interface ViewportSize {
  widthPx: number;
  heightPx: number;
  scale: number;
}

export function normalizeRotation(rot: number | undefined | null): 0 | 90 | 180 | 270 {
  const normalized = (((Math.round(Number(rot || 0) / 90) * 90) % 360) + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized;
  }
  return 0;
}

export function getVisualBoxSizePt(
  cropBox: Pick<PdfPageBox, "width" | "height">,
  rotation: number = 0
): { widthPt: number; heightPt: number } {
  const rot = normalizeRotation(rotation);
  if (rot === 90 || rot === 270) {
    return { widthPt: roundPt(cropBox.height), heightPt: roundPt(cropBox.width) };
  }
  return { widthPt: roundPt(cropBox.width), heightPt: roundPt(cropBox.height) };
}

export function getEffectivePageSizePt(
  page: Pick<DocumentPageInfo, "widthPt" | "heightPt" | "rotation">,
  extraRotation: 0 | 90 | 180 | 270 = 0
): { widthPt: number; heightPt: number } {
  if (extraRotation === 90 || extraRotation === 270) {
    return { widthPt: page.heightPt, heightPt: page.widthPt };
  }
  return { widthPt: page.widthPt, heightPt: page.heightPt };
}

export function pdfRectToViewportPx(
  rect: PdfRect,
  scale: number,
  pageWidthPt: number,
  pageHeightPt: number,
  viewRotation: 0 | 90 | 180 | 270 = 0
): { left: number; top: number; width: number; height: number } {
  let x = rect.x;
  let y = rect.y;
  let w = rect.width;
  let h = rect.height;

  if (viewRotation === 90) {
    const nx = pageHeightPt - (y + h);
    const ny = x;
    x = nx;
    y = ny;
    [w, h] = [h, w];
  } else if (viewRotation === 180) {
    x = pageWidthPt - (x + w);
    y = pageHeightPt - (y + h);
  } else if (viewRotation === 270) {
    const nx = y;
    const ny = pageWidthPt - (x + w);
    x = nx;
    y = ny;
    [w, h] = [h, w];
  }

  return {
    left: x * scale,
    top: y * scale,
    width: Math.max(4, w * scale),
    height: Math.max(4, h * scale),
  };
}

export function viewportPxToPdfRect(
  pxRect: { left: number; top: number; width: number; height: number },
  scale: number,
  pageWidthPt: number,
  pageHeightPt: number,
  viewRotation: 0 | 90 | 180 | 270 = 0
): PdfRect {
  const safeScale = scale > 0 ? scale : 1;
  let x = pxRect.left / safeScale;
  let y = pxRect.top / safeScale;
  let w = pxRect.width / safeScale;
  let h = pxRect.height / safeScale;

  if (viewRotation === 90) {
    const ox = y;
    const oy = pageHeightPt - (x + w);
    x = ox;
    y = oy;
    [w, h] = [h, w];
  } else if (viewRotation === 180) {
    x = pageWidthPt - (x + w);
    y = pageHeightPt - (y + h);
  } else if (viewRotation === 270) {
    const ox = pageWidthPt - (y + h);
    const oy = x;
    x = ox;
    y = oy;
    [w, h] = [h, w];
  }

  return clampPdfRect(
    {
      x: roundPt(x),
      y: roundPt(y),
      width: roundPt(Math.max(6, w)),
      height: roundPt(Math.max(6, h)),
    },
    pageWidthPt,
    pageHeightPt
  );
}

/**
 * Convert rendered image pixels (top-left origin at `dpi`) into canonical top-left PDF points.
 */
export function imagePxToTopLeftPdf(
  pxRect: { x: number; y: number; width: number; height: number },
  dpi: number,
  pageWidthPt?: number,
  pageHeightPt?: number
): PdfRect {
  const scaleToPt = dpi > 0 ? 72.0 / dpi : 1;
  const raw: PdfRect = {
    x: roundPt(pxRect.x * scaleToPt),
    y: roundPt(pxRect.y * scaleToPt),
    width: roundPt(Math.max(1, pxRect.width * scaleToPt)),
    height: roundPt(Math.max(1, pxRect.height * scaleToPt)),
  };
  if (pageWidthPt && pageHeightPt) {
    return clampPdfRect(raw, pageWidthPt, pageHeightPt);
  }
  return raw;
}

/**
 * Convert canonical top-left PDF points into rendered image pixels at `dpi`.
 */
export function topLeftPdfToImagePx(
  rect: PdfRect,
  dpi: number
): { x: number; y: number; width: number; height: number } {
  const scale = dpi > 0 ? dpi / 72.0 : 1;
  return {
    x: roundPt(rect.x * scale),
    y: roundPt(rect.y * scale),
    width: roundPt(rect.width * scale),
    height: roundPt(rect.height * scale),
  };
}

/**
 * Transform a canonical visual top-left CropBox rect into unrotated PDF user-space [x0, y0, x1, y1],
 * handling arbitrary CropBox offsets and PDF /Rotate values (0, 90, 180, 270).
 */
export function topLeftPdfToBottomLeftPdf(
  rect: PdfRect,
  cropBox: { x: number; y: number; width: number; height: number },
  rotation: number = 0
): [number, number, number, number] {
  const cx0 = cropBox.x;
  const cy0 = cropBox.y;
  const cx1 = cropBox.x + cropBox.width;
  const cy1 = cropBox.y + cropBox.height;
  const rot = normalizeRotation(rotation);

  if (rot === 90) {
    const x0 = cx0 + rect.y;
    const x1 = x0 + rect.height;
    const y0 = cy0 + rect.x;
    const y1 = y0 + rect.width;
    return [roundPt(x0), roundPt(y0), roundPt(x1), roundPt(y1)];
  }
  if (rot === 180) {
    const x1 = cx1 - rect.x;
    const x0 = x1 - rect.width;
    const y0 = cy0 + rect.y;
    const y1 = y0 + rect.height;
    return [roundPt(x0), roundPt(y0), roundPt(x1), roundPt(y1)];
  }
  if (rot === 270) {
    const x1 = cx1 - rect.y;
    const x0 = x1 - rect.height;
    const y1 = cy1 - rect.x;
    const y0 = y1 - rect.width;
    return [roundPt(x0), roundPt(y0), roundPt(x1), roundPt(y1)];
  }

  // 0 deg: top-left CropBox space -> PDF bottom-left user space
  const x0 = cx0 + rect.x;
  const x1 = x0 + rect.width;
  const y1 = cy1 - rect.y;
  const y0 = y1 - rect.height;
  return [roundPt(x0), roundPt(y0), roundPt(x1), roundPt(y1)];
}

/**
 * Inverse transform: convert unrotated PDF user-space [x0, y0, x1, y1] back into canonical
 * visual top-left CropBox space, handling CropBox offsets and PDF /Rotate (0, 90, 180, 270).
 */
export function bottomLeftPdfToTopLeftPdf(
  coords: [number, number, number, number],
  cropBox: { x: number; y: number; width: number; height: number },
  rotation: number = 0
): PdfRect {
  const x0 = Math.min(coords[0], coords[2]);
  const x1 = Math.max(coords[0], coords[2]);
  const y0 = Math.min(coords[1], coords[3]);
  const y1 = Math.max(coords[1], coords[3]);
  const cx0 = cropBox.x;
  const cy0 = cropBox.y;
  const cx1 = cropBox.x + cropBox.width;
  const cy1 = cropBox.y + cropBox.height;
  const rot = normalizeRotation(rotation);

  if (rot === 90) {
    return {
      x: roundPt(y0 - cy0),
      y: roundPt(x0 - cx0),
      width: roundPt(Math.max(1, y1 - y0)),
      height: roundPt(Math.max(1, x1 - x0)),
    };
  }
  if (rot === 180) {
    return {
      x: roundPt(cx1 - x1),
      y: roundPt(y0 - cy0),
      width: roundPt(Math.max(1, x1 - x0)),
      height: roundPt(Math.max(1, y1 - y0)),
    };
  }
  if (rot === 270) {
    return {
      x: roundPt(cy1 - y1),
      y: roundPt(cx1 - x1),
      width: roundPt(Math.max(1, y1 - y0)),
      height: roundPt(Math.max(1, x1 - x0)),
    };
  }

  return {
    x: roundPt(x0 - cx0),
    y: roundPt(cy1 - y1),
    width: roundPt(Math.max(1, x1 - x0)),
    height: roundPt(Math.max(1, y1 - y0)),
  };
}

export function clampPdfRect(
  rect: PdfRect,
  pageWidthPt: number,
  pageHeightPt: number
): PdfRect {
  const width = Math.min(Math.max(6, rect.width), pageWidthPt);
  const height = Math.min(Math.max(6, rect.height), pageHeightPt);
  const x = Math.min(Math.max(0, rect.x), Math.max(0, pageWidthPt - width));
  const y = Math.min(Math.max(0, rect.y), Math.max(0, pageHeightPt - height));
  return {
    x: roundPt(x),
    y: roundPt(y),
    width: roundPt(width),
    height: roundPt(height),
  };
}

export function computeRectIoU(a: PdfRect, b: PdfRect): number {
  const ax0 = a.x;
  const ay0 = a.y;
  const ax1 = a.x + a.width;
  const ay1 = a.y + a.height;
  const bx0 = b.x;
  const by0 = b.y;
  const bx1 = b.x + b.width;
  const by1 = b.y + b.height;

  const ix0 = Math.max(ax0, bx0);
  const iy0 = Math.max(ay0, by0);
  const ix1 = Math.min(ax1, bx1);
  const iy1 = Math.min(ay1, by1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;

  const inter = (ix1 - ix0) * (iy1 - iy0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? roundPt(inter / union) : 0;
}

export function roundPt(n: number): number {
  return Math.round(n * 100) / 100;
}
