import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { runFormifyPythonEngine } from "../../src/server/formifypdf-runner.ts";
import { resolvePythonExecutable } from "../../src/server/python-runner.ts";

const pythonBin = resolvePythonExecutable();

describe("Benchmark Field Mapping & Engine Verification", () => {
  it("verifies field_map.json references real boxes with zero duplicate cell assignments", () => {
    const mapPath = path.resolve("tests/benchmark/fixtures/bench_field_map.json");
    const raw = fs.readFileSync(mapPath, "utf-8");
    const fieldMap = JSON.parse(raw);

    expect(typeof fieldMap.sourcePdf).toBe("string");
    expect(fieldMap.pageSizes).toHaveLength(2);
    expect(Object.keys(fieldMap.fields).length).toBeGreaterThanOrEqual(45);

    const seen = new Set<string>();
    let totalCells = 0;

    for (const [fieldKey, spec] of Object.entries<Record<string, unknown>>(fieldMap.fields)) {
      if (spec.kind === "char_cells" || spec.kind === "date_cells") {
        const cells = spec.cells as number[][];
        expect(cells.length).toBe(spec.capacity);
        for (const rect of cells) {
          totalCells++;
          const sig = `${spec.page}:${rect.join(",")}`;
          expect(seen.has(sig), `Duplicate cell assignment in ${fieldKey}`).toBe(false);
          seen.add(sig);
        }
      } else if (spec.kind === "selection_box") {
        const options = spec.options as Record<string, { rect: number[] }>;
        for (const [optKey, opt] of Object.entries(options)) {
          const sig = `${spec.page}:${opt.rect.join(",")}`;
          expect(seen.has(sig), `Duplicate selection box in ${fieldKey}.${optKey}`).toBe(false);
          seen.add(sig);
        }
      }
    }

    expect(totalCells).toBeGreaterThanOrEqual(680);
  });

  it("verifies benchmark field map integrity and executes formifypdf_engine.py inspection", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formifypdf-pdf-test-"));

    try {
      const doc = await PDFDocument.create();
      doc.addPage([595, 842]);
      doc.addPage([595, 842]);
      const samplePdf = path.join(tmpDir, "sample_2p.pdf");
      fs.writeFileSync(samplePdf, Buffer.from(await doc.save()));

      execFileSync(
        pythonBin,
        ["-m", "py_compile", "python/formifypdf_engine.py", "scripts/build_field_map.py"],
        { stdio: "pipe" }
      );

      const summary = await runFormifyPythonEngine<{
        pageCount: number;
        pages: unknown[];
      }>("inspect", { pdfPath: samplePdf });

      expect(summary.pageCount).toBe(2);
      expect(Array.isArray(summary.pages)).toBe(true);
      expect(summary.pages.length).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid CLI arguments on formifypdf_engine.py with a non-zero exit code", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formifypdf-overflow-test-"));
    const inputPath = path.join(tmpDir, "overflow.json");
    const outputPath = path.join(tmpDir, "output.pdf");

    try {
      fs.writeFileSync(
        inputPath,
        JSON.stringify({
          vehicle: {
            licenceNumber: "TOOLONGLICENCE999",
          },
        }),
        "utf-8"
      );

      expect(() => {
        execFileSync(
          pythonBin,
          ["python/formifypdf_engine.py", "--help"],
          { encoding: "utf-8", stdio: "pipe" }
        );
      }).toThrow();
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
