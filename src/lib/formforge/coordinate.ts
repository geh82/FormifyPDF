import type { DocumentPageInfo, PdfRect } from "./types.ts";

/**
 * Canonical FormForge Coordinate Calibration
 *
 * Canonical storage space ("top_left_pdf_pt"):
 *   - Origin (0, 0) is top-left of the visible CropBox (matching PyMuPDF `page.rect`).
 *   - Units are PDF points (1/72 inch).
 *   - Width/height reflect the effective visual page box after PDF rotation.
 *
 * Browser viewport space:
 *   - Origin (0, 0) is top-left of the rendered PDF.js <canvas>.
 *   - Units are CSS pixels at `zoom` scale (`px = pt * zoom`).
 *
 * AcroForm bottom-left PDF space (PDF 1.7 / pypdf native /Rect):
 *   - Origin (0, 0) is bottom-left of MediaBox/CropBox.
 *   - `y_bottom = cropHeight - (y_top + height)`
 */

export interface ViewportSize {
  widthPx: number;
  heightPx: number;
  scale: number;
}

export function getEffectivePageSizePt(
  page: Pick<DocumentPageInfo, "widthPt" | "heightPt" | "rotation">,
  extraRotation: 0 | 90 | 180 | 270 = 0
): { widthPt: number; heightPt: number } {
  const totalRot = ((page.rotation + extraRotation) % 360) as 0 | 90 | 180 | 270;
  if (totalRot === 90 || totalRot === 270) {
    // If viewer adds 90/270 relative to stored page dimensions
    if (extraRotation === 90 || extraRotation === 270) {
      return { widthPt: page.heightPt, heightPt: page.widthPt };
    }
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

export function topLeftPdfToBottomLeftPdf(
  rect: PdfRect,
  cropBox: { x: number; y: number; width: number; height: number }
): [number, number, number, number] {
  const x0 = cropBox.x + rect.x;
  const x1 = x0 + rect.width;
  const y1 = cropBox.y + (cropBox.height - rect.y);
  const y0 = y1 - rect.height;
  return [roundPt(x0), roundPt(y0), roundPt(x1), roundPt(y1)];
}

export function bottomLeftPdfToTopLeftPdf(
  coords: [number, number, number, number],
  cropBox: { x: number; y: number; width: number; height: number }
): PdfRect {
  const [x0, y0, x1, y1] = coords;
  return {
    x: roundPt(x0 - cropBox.x),
    y: roundPt(cropBox.height - (y1 - cropBox.y)),
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

export function roundPt(n: number): number {
  return Math.round(n * 100) / 100;
}
