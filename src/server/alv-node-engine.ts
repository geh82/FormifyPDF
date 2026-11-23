import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";

interface FieldMapSpec {
  kind: "char_cells" | "date_cells" | "selection_box" | "free_text";
  page: number;
  uppercase?: boolean;
  align?: "left" | "right";
  cells?: [number, number, number, number][];
  options?: Record<string, { rect: [number, number, number, number] }>;
  rect?: [number, number, number, number];
  maxChars?: number;
}

interface FieldMapData {
  pageSizes?: Array<{ page: number; width: number; height: number }>;
  fields?: Record<string, FieldMapSpec>;
}

const INK_COLOR = rgb(0.06, 0.1, 0.2);
const X_MARK_COLOR = rgb(0.05, 0.18, 0.45);

function flattenPayload(
  data: Record<string, unknown>,
  prefix = ""
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenPayload(v as Record<string, unknown>, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function toWinAnsiSafeText(input: string): string {
  // Decompose diacritics (e.g. é -> e, ü -> u) and map common smart punctuation
  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...");
  // Keep printable ASCII + common WinAnsi Latin-1 characters
  return normalized.replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
}

function normalizeText(value: unknown, uppercase = true): string {
  if (value === null || value === undefined) return "";
  const cleaned = toWinAnsiSafeText(
    String(value).replace(/\r/g, " ").replace(/\n/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
  return uppercase ? cleaned.toUpperCase() : cleaned;
}

function drawCharInCell(
  page: PDFPage,
  font: PDFFont,
  rectCoords: [number, number, number, number],
  ch: string,
  fontsize = 9.5
) {
  if (!ch || ch === " ") return;
  const pageHeight = page.getHeight();
  const [x0, y0, x1, y1] = rectCoords;
  const cellW = x1 - x0;
  const cellH = y1 - y0;

  let effectiveSize = fontsize;
  if (cellW < 11.2) {
    effectiveSize = Math.min(fontsize, Math.max(7.5, cellW * 0.72));
  }

  let textW = font.widthOfTextAtSize(ch, effectiveSize);
  while (textW > cellW - 1.8 && effectiveSize > 6.0) {
    effectiveSize -= 0.5;
    textW = font.widthOfTextAtSize(ch, effectiveSize);
  }

  const xPos = x0 + (cellW - textW) / 2.0;
  const topBaselineY =
    cellH >= 18.0 ? y0 + 13.8 : y0 + (cellH + effectiveSize * 0.72) / 2.0;
  const pdfY = pageHeight - topBaselineY;

  page.drawText(ch, {
    x: xPos,
    y: pdfY,
    size: effectiveSize,
    font,
    color: INK_COLOR,
  });
}

function drawXMark(page: PDFPage, rectCoords: [number, number, number, number]) {
  const pageHeight = page.getHeight();
  const [x0, y0, x1, y1] = rectCoords;
  const w = x1 - x0;
  const h = y1 - y0;
  const insetX = Math.max(5.0, Math.min(14.0, w * 0.16));
  const insetY = Math.max(3.5, h * 0.18);

  const pdfYTop = pageHeight - (y0 + insetY);
  const pdfYBottom = pageHeight - (y1 - insetY);

  page.drawLine({
    start: { x: x0 + insetX, y: pdfYTop },
    end: { x: x1 - insetX, y: pdfYBottom },
    thickness: 1.8,
    color: X_MARK_COLOR,
    opacity: 0.48,
  });
  page.drawLine({
    start: { x: x1 - insetX, y: pdfYTop },
    end: { x: x0 + insetX, y: pdfYBottom },
    thickness: 1.8,
    color: X_MARK_COLOR,
    opacity: 0.48,
  });
}

function drawFreeText(
  page: PDFPage,
  font: PDFFont,
  rectCoords: [number, number, number, number],
  text: string,
  maxChars: number,
  fontsize = 9.0
) {
  if (!text) return;
  if (text.length > maxChars) {
    throw new Error(`Free-text value (${text.length} chars) exceeds maximum capacity of ${maxChars} characters`);
  }
  const pageHeight = page.getHeight();
  const [x0, , x1, y1] = rectCoords;
  const availW = x1 - x0 - 4.0;
  let effSize = fontsize;
  while (font.widthOfTextAtSize(text, effSize) > availW && effSize > 6.5) {
    effSize -= 0.5;
  }
  const pdfBaselineY = pageHeight - (y1 - 5.2);
  page.drawText(text, {
    x: x0 + 3.0,
    y: pdfBaselineY,
    size: effSize,
    font,
    color: INK_COLOR,
  });
}

export async function runAlvNodeEngine(
  payload: Record<string, unknown>,
  options: { templatePath?: string; fieldMapPath?: string } = {}
): Promise<{ pdfBuffer: Buffer; stdout: string }> {
  const templatePath = path.resolve(
    options.templatePath || path.join(process.cwd(), "src", "lib", "alv", "ALV_blank.pdf")
  );
  const fieldMapPath = path.resolve(
    options.fieldMapPath || path.join(process.cwd(), "src", "lib", "alv", "field_map.json")
  );

  const [templateBytes, fieldMapRaw] = await Promise.all([
    fs.readFile(templatePath),
    fs.readFile(fieldMapPath, "utf-8"),
  ]);

  const fieldMap = JSON.parse(fieldMapRaw) as FieldMapData;
  const fields = fieldMap.fields || {};
  if (Object.keys(fields).length === 0) {
    throw new Error("field_map.json contains no mapped fields");
  }

  const pdfDoc = await PDFDocument.load(templateBytes);
  const pages = pdfDoc.getPages();
  const expectedPages = fieldMap.pageSizes?.length || 2;
  if (pages.length !== expectedPages) {
    throw new Error(`Template PDF has ${pages.length} pages; expected ${expectedPages}`);
  }

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const flatData = flattenPayload(payload);

  const allowedMeta = new Set([
    "sameAsPostal",
    "hasOrganisationProxy",
    "hasOrganisationRepresentative",
    "signatoryName",
  ]);
  const unmappedKeys: string[] = [];
  for (const [k, v] of Object.entries(flatData)) {
    const tail = k.split(".").pop() || k;
    if (!(k in fields) && !allowedMeta.has(tail) && !allowedMeta.has(k)) {
      if (v !== null && v !== undefined && v !== "" && v !== false) {
        unmappedKeys.push(k);
      }
    }
  }
  if (unmappedKeys.length > 0) {
    throw new Error(`Unmapped input fields encountered: ${unmappedKeys.join(", ")}`);
  }

  const populatedFields: string[] = [];
  for (const [fkey, spec] of Object.entries(fields)) {
    if (!(fkey in flatData)) continue;
    const rawVal = flatData[fkey];
    if (rawVal === null || rawVal === undefined || rawVal === "") continue;

    const pageIdx = Number(spec.page) - 1;
    if (pageIdx < 0 || pageIdx >= pages.length) {
      throw new Error(`Invalid page index ${pageIdx + 1} for field ${fkey}`);
    }
    const page = pages[pageIdx];

    if (spec.kind === "char_cells" || spec.kind === "date_cells") {
      const text = normalizeText(rawVal, spec.uppercase !== false);
      if (!text) continue;
      const cells = spec.cells || [];
      if (text.length > cells.length) {
        throw new Error(
          `Field '${fkey}' (${text.length} chars) exceeds PDF box capacity (${cells.length} cells)`
        );
      }
      const padded =
        spec.align === "right"
          ? text.padStart(cells.length, " ")
          : text.padEnd(cells.length, " ");
      for (let i = 0; i < padded.length; i++) {
        drawCharInCell(page, font, cells[i], padded[i]);
      }
      populatedFields.push(fkey);
    } else if (spec.kind === "selection_box") {
      let keyVal = "";
      if (typeof rawVal === "boolean") {
        if (!rawVal) continue;
        keyVal = "true";
      } else {
        keyVal = String(rawVal).trim();
      }
      const opt = spec.options?.[keyVal];
      if (!opt) {
        throw new Error(
          `Invalid option '${keyVal}' for selection field '${fkey}'`
        );
      }
      drawXMark(page, opt.rect);
      populatedFields.push(fkey);
    } else if (spec.kind === "free_text") {
      const text = normalizeText(rawVal, spec.uppercase !== false);
      if (!text || !spec.rect) continue;
      drawFreeText(page, font, spec.rect, text, Number(spec.maxChars ?? 32));
      populatedFields.push(fkey);
    }
  }

  const outBytes = await pdfDoc.save({ useObjectStreams: false });
  const pdfBuffer = Buffer.from(outBytes);
  if (pdfBuffer.length < 100 || pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Generated output failed PDF signature validation");
  }

  const summary = {
    ok: true,
    engine: "node-pdf-lib",
    bytes: pdfBuffer.length,
    pages: pages.length,
    populatedFieldCount: populatedFields.length,
    populatedFields,
  };

  return { pdfBuffer, stdout: JSON.stringify(summary) };
}
