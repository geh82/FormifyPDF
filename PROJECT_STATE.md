# FormifyPDF — Project State & Resume Log

> This file is maintained as a session-resume checkpoint. If work is interrupted, read this file first to pick up exactly where we left off.

## Current Session Context
- **Platform:** Windows (PowerShell)
- **Working Directory:** `c:\Projects\FormifyPDF`
- **Git Branch:** `main` (up to date with `origin/main`)
- **Latest Commit:** `390d616a9c4e95eb5e95143979362d5eb90f9825`
- **TypeScript:** Compiles clean (`npx tsc --noEmit` passes)
- **Directive:** Critical Engineering Directive — Rebuild Universal PDF Form Detection & AcroForm Conversion Engine for 100% production-ready accuracy

---

## ENGINEERING AUDIT — COMPLETE

### Existing Pipeline Components
| Layer | File | Role |
|-------|------|------|
| PDF Structural Extraction | `src/server/pdf-vector-extractor.ts` | pdfjs-dist → lines, rects, circles, text runs |
| Raster CV Pipeline | `src/server/pdf-raster-cv.ts` | Render → binarize → deskew → contour extraction → BMP |
| Local OCR | `src/server/pdf-local-ocr.ts` | Tesseract.js OCR on rasterized pages |
| Fusion & Classification | `src/server/formifypdf-fusion.ts` | `fuseAndClassifyPageGeometry`, `clusterCharCells`, `findBestAssociatedLabel` |
| Node AcroForm Engine | `src/server/formifypdf-node-engine.ts` | `analyzePdfNode`, `generateAcroFormNode`, `renderPdfNode`, `validateAcroFormNode` |
| Coordinate Transform | `src/lib/formifypdf/coordinate.ts` | Top-left PDF ↔ bottom-left PDF ↔ image pixel transforms |
| Types | `src/lib/formifypdf/types.ts` | FieldManifest, DetectedFormField, AcroFormValidationReport schemas |
| Python Engine | `python/formifypdf_engine.py` | PyMuPDF + pdfplumber + OpenCV + Tesseract (Engine A) |

### Root Cause: ~2% Detection Rate
`fuseAndClassifyPageGeometryCore` only emits fields when strict conditions met:
1. **Grid cell reconstruction**: Requires ≥2 vertical dividers between two horizontal lines
2. **Char cell clustering**: Requires ≥3 uniform small boxes in a row with tight tolerances
3. **Vector rect detection**: Only emits boxes ≥7pt×7pt, filtered by banner checks
4. **Label association**: Heuristic distance-based, fails on complex/bilingual layouts
5. **No AI document understanding**: Pure geometric heuristics only
6. **No fusion**: Structural, CV, OCR, AI signals not merged
7. **Aggressive filtering**: Shaded banner detection discards valid fields

### What Works (Must Preserve)
- ✅ Coordinate transformation module (`coordinate.ts`)
- ✅ AcroForm widget generation (`generateAcroFormNode`)
- ✅ Visual alignment validation (`validateAcroFormNode`)
- ✅ Authentication, RBAC, storage, ZIP uploads
- ✅ TypeScript compiles cleanly

---

## Modified Files (Uncommitted — from Prior Session)

### `src/server/formifypdf-fusion.ts`
`clusterCharCells` tolerance thresholds relaxed (y0: 4→5, height: 4→5, width: 4→7)

### `src/server/pdf-raster-cv.ts`
- `estimateAndDeskew` skew threshold: 0.3°→0.15°, score ratio 1.015→1.008
- Box fill-ratio threshold: 0.68→0.62

---

## Untracked Files
- `package-lock.json`
- `PROJECT_STATE.md` (this file)

---

## Test Status — `tests/benchmark/detection-benchmark.test.ts`

| Scenario | Result | Details |
|----------|--------|---------|
| Scenario 2: Scanned image-only PDF CV+OCR | ✅ PASS | recall >=0.9, charGridGroupCount >=24 |
| **Scenario 3: Skewed (~2.1°) scanned form deskew** | ❌ **FAIL** | 2 fields detected, expected ≥3 — analysis completed; root cause: identity code cells (8×20pt) not grouping into char_cells after deskew interpolation due to gap tolerance limits; making gap tolerance wider breaks Scenarios 1-2 |
| Scenario 4: Mixed paper size + AcroForm round-trip | ✅ PASS | Full AcroForm generation, validation, visual verification pass |

---

## REBUILD PLAN — Multi-Engine Detection Architecture

### Phase 1: Audit Complete (✅ Done)
Full technical audit completed. Root causes identified.

### Phase 2: Build Multi-Engine Detection Pipeline
**A. PDF Structural Analysis** — Extend `pdf-vector-extractor.ts`: all text spans with font info, all vector drawings, existing AcroForm annotations, page boxes (MediaBox/CropBox), page rotation, images, soft masks.

**B. OCR + Computer Vision** — Enhance `pdf-raster-cv.ts` + `pdf-local-ocr.ts`: OpenCV morphology for lines/boxes/checkboxes/radio circles, deskew, orientation correction, noise reduction, Tesseract OCR with layout preservation.

**C. AI Document Understanding** — Integrate local model (LayoutLMv3 or equivalent): distinguish labels vs instructions vs fields vs decorative elements. Local processing only (privacy).

**D. Detection Fusion Engine** — New fusion module: combine structural + CV + OCR + AI signals, merge duplicates with confidence-weighted scoring, preserve complementary detections, assign confidence score + provenance per field.

### Phase 3: Character Box Recognition (Critical for SA Forms)
Detect sequences of adjacent small boxes as char_entry groups. Determine cell count, dimensions, spacing, reading direction. Associate with printed label. Choose Comb field vs individual cells appropriately. Never mistake char grid for single text field.

### Phase 4: Coordinate Transformation Verification
Verify all transforms (top-left PDF ↔ bottom-left PDF ↔ image pixels). Handle rotation, CropBox, MediaBox, different page sizes, DPI. Automated visual alignment tests with IoU thresholds.

### Phase 5: Rebuild FieldManifest
Ensure all required fields present (id, name, type, label, rect, confidence, source, etc.). Separate detection, classification, widget generation stages.

### Phase 6: Intelligent Detection Validation
Report detection coverage, classification confidence, coordinate validation. Flag low-confidence fields for review (don't silently discard). Generate meaningful statistics (counts by type, source, confidence).

### Phase 7: Automatic AcroForm Generation
Support all field types: text, comb, multiline, checkbox, radio, dropdown, listbox, signature. Preserve original PDF background. Correct dimensions, appearance, field names, values. Test in independent PDF readers.

### Phase 8: Automated Visual Verification
Render generated PDF, extract widgets, overlay on original. Check alignment IoU, sizing, missing fields, overlaps, duplicates. Produce visual verification report.

### Phase 9: Benchmark Against Established Tools
Compare with iLovePDF, PDF24, Adobe Acrobat. Build ground-truth dataset with multiple document types. Calculate precision, recall, F1.

### Phase 10: Acceptance Test
Upload unfamiliar government PDF → detect all fields → generate AcroForm → visual verification → fill in independent reader.

---

## Non-Negotiable Constraints
2. **Do not remove** upload, signed-document verification, SHA-256, or storage functionality
4. **Local processing only** — no third-party AI uploads without approval
6. **Production ready** — 100% functioning, no misalignments, bugs, or errors

---

## Next Steps (To Resume Work)
1. Build multi-engine detection pipeline (Phase 2)
2. Implement char cell recognition (Phase 3)
3. Verify coordinate transforms (Phase 4)
4. Rebuild FieldManifest (Phase 5)
5. Add intelligent validation (Phase 6)
6. Verify AcroForm generation (Phase 7)
7. Add visual verification (Phase 8)
8. Build benchmark suite (Phase 9)
9. Run acceptance test (Phase 10)
11. Run `npm test` full suite
12. Commit all changes

---

## Relevant Commands
```powershell
# Type check
npx tsc --noEmit

# Run the failing benchmark test
npx vitest run tests/benchmark/detection-benchmark.test.ts -t "Scenario 3"

# Run full test suite
npm test

# View git diff
git diff src/server/formifypdf-fusion.ts src/server/pdf-raster-cv.ts
```

---

## Resume Checklist
- [ ] Read `PROJECT_STATE.md`
- [ ] Review engineering audit findings above
- [ ] Build multi-engine detection pipeline (Phase 2)
- [ ] Implement char cell recognition (Phase 3)
- [ ] Verify coordinate transforms (Phase 4)
- [ ] Rebuild FieldManifest (Phase 5)
- [ ] Add intelligent validation (Phase 6)
- [ ] Verify AcroForm generation (Phase 7)
- [ ] Add visual verification (Phase 8)
- [ ] Build benchmark suite (Phase 9)
- [ ] Run acceptance test (Phase 10)
- [ ] Run `npm test` full suite
- [ ] Commit all changes
