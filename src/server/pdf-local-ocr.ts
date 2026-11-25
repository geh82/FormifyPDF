import fs from "node:fs";
import path from "node:path";
import { createWorker } from "tesseract.js";
import { imagePxToTopLeftPdf, roundPt } from "../lib/formifypdf/coordinate.ts";
import type { ExtractedTextRun } from "./pdf-vector-extractor.ts";

export interface LocalOcrPageOutput {
  textRuns: ExtractedTextRun[];
  wordCount: number;
  extractedChars: number;
  durationMs: number;
  language: string;
}

export interface LocalOcrSession {
  recognizePage: (
    bmpBuffer: Buffer,
    dpi: number,
    pageWidthPt: number,
    pageHeightPt: number
  ) => Promise<LocalOcrPageOutput>;
  terminate: () => Promise<void>;
}

function resolveLocalTrainedDataDir(): { dir: string; hasEng: boolean } {
  const candidateDirs = [
    path.resolve(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int"),
    path.resolve(process.cwd(), "node_modules", "@tesseract.js-data", "eng"),
  ];
  for (const dir of candidateDirs) {
    if (
      fs.existsSync(path.join(dir, "eng.traineddata.gz")) ||
      fs.existsSync(path.join(dir, "eng.traineddata"))
    ) {
      return { dir, hasEng: true };
    }
  }
  return { dir: candidateDirs[0], hasEng: false };
}

function isOcrBorderArtifact(txt: string, conf: number, wPt: number, hPt: number): boolean {
  const clean = txt.trim();
  if (!clean) return true;
  // Grid lines and character-box walls commonly misread by OCR as |, ||, _, [, ]
  if (/^[|¦_~`\[\]]+$/.test(clean)) return true;
  if (clean.length === 1 && /^[Il1!]$/.test(clean) && conf < 62 && wPt <= 4.5 && hPt >= 8) {
    return true;
  }
  if (clean.length <= 2 && /^[^\w/:().,-]+$/.test(clean) && conf < 70) {
    return true;
  }
  return false;
}

export async function createLocalOcrSession(requestedLanguage = "eng"): Promise<LocalOcrSession> {
  const { dir, hasEng } = resolveLocalTrainedDataDir();
  if (!hasEng) {
    throw new Error(
      `Local Tesseract traineddata not found in ${dir}; offline OCR unavailable`
    );
  }

  // Strictly enforce offline local language packs (never download from remote CDN)
  const effectiveLang =
    fs.existsSync(path.join(dir, `${requestedLanguage}.traineddata.gz`)) ||
    fs.existsSync(path.join(dir, `${requestedLanguage}.traineddata`))
      ? requestedLanguage
      : "eng";

  const isGzip = fs.existsSync(path.join(dir, `${effectiveLang}.traineddata.gz`));

  const worker = await createWorker(effectiveLang, 1, {
    langPath: dir,
    gzip: isGzip,
    cacheMethod: "none",
    logger: () => {},
  });

  return {
    async recognizePage(
      bmpBuffer: Buffer,
      dpi: number,
      pageWidthPt: number,
      pageHeightPt: number
    ): Promise<LocalOcrPageOutput> {
      const started = Date.now();
      const res = await worker.recognize(bmpBuffer, {}, { blocks: true });
      const textRuns: ExtractedTextRun[] = [];
      let extractedChars = 0;

      const blocks = res.data.blocks || [];
      for (const blk of blocks) {
        for (const para of blk.paragraphs || []) {
          for (const line of para.lines || []) {
            for (const word of line.words || []) {
              const txt = (word.text || "").trim();
              const conf = Number(word.confidence || 0);
              if (!txt || conf < 26) continue;

              const bbox = word.bbox;
              if (!bbox) continue;
              const pxW = Math.max(1, bbox.x1 - bbox.x0);
              const pxH = Math.max(1, bbox.y1 - bbox.y0);
              const rectPt = imagePxToTopLeftPdf(
                { x: bbox.x0, y: bbox.y0, width: pxW, height: pxH },
                dpi,
                pageWidthPt,
                pageHeightPt
              );

              if (isOcrBorderArtifact(txt, conf, rectPt.width, rectPt.height)) {
                continue;
              }

              const fontSize = roundPt(Math.max(5.5, Math.min(24, rectPt.height * 0.85)));
              const isCheckboxGlyph = /^[☐☑☒□▢■]$/.test(txt);
              const isRadioGlyph = /^[○◯●◉]$/.test(txt);
              const isDropdownArrow = /^[▼▾▽]$/.test(txt);

              extractedChars += txt.length;
              textRuns.push({
                text: txt,
                x0: rectPt.x,
                y0: rectPt.y,
                x1: roundPt(rectPt.x + rectPt.width),
                y1: roundPt(rectPt.y + rectPt.height),
                fontSize,
                fontName: "ocr-tesseract",
                isCheckboxGlyph,
                isRadioGlyph,
                isDropdownArrow,
              });
            }
          }
        }
      }

      return {
        textRuns,
        wordCount: textRuns.length,
        extractedChars,
        durationMs: Math.max(1, Date.now() - started),
        language: effectiveLang,
      };
    },
    async terminate() {
      await worker.terminate();
    },
  };
}
