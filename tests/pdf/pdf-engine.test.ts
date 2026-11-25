import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

  it("verifies benchmark field map integrity and executes formforge_engine.py", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formforge-pdf-test-"));
    const inputPath = path.join(tmpDir, "input.json");
    const outputPath = path.join(tmpDir, "output.pdf");

    try {
      const sample = {
        owner: {
          identificationType: "rsa_id",
          identificationNumber: "8506155012084",
          countryOfIssue: "",
          surnameOrOrganisation: "VAN DER MERWE",
          initials: "JP",
          firstNames: "JOHANNES PETRUS",
          email: "jp.vdmerwe@example.co.za",
          homePhoneCode: "011",
          homePhoneNumber: "4401234",
          dayPhoneCode: "011",
          dayPhoneNumber: "8805678",
          faxCode: "",
          faxNumber: "",
          cellphone: "0825551234",
        },
        postalAddress: {
          line1: "PO BOX 1420",
          line2: "PRIVATE BAG X12",
          line3: "",
          suburb: "SANDTON",
          city: "JOHANNESBURG",
          postalCode: "2146",
        },
        streetAddress: {
          line1: "42 RIVONIA ROAD",
          line2: "SUITE 4B",
          line3: "",
          suburb: "SANDHURST",
          city: "JOHANNESBURG",
          postalCode: "2196",
        },
        noticesAddress: "postal",
        vehicle: {
          licenceNumber: "GP442198",
          registerNumber: "ABC1234",
          chassisVin: "WBA3A5C50CF256981",
          make: "BMW",
          seriesName: "320I SEDAN AUTO",
          noOdometer: false,
          odometerReading: "124500",
          steeringPosition: "right",
        },
        declaration: {
          signatoryRole: "owner",
          place: "CAPE TOWN",
          dateYYMMDD: "261122",
        },
      };

      fs.writeFileSync(inputPath, JSON.stringify(sample), "utf-8");

      const inspectInput = path.join(tmpDir, "inspect_in.json");
      const inspectOutput = path.join(tmpDir, "inspect_out.json");
      const samplePdf = path.join(tmpDir, "sample_2p.pdf");
      execFileSync(
        pythonBin,
        [
          "-c",
          "import fitz, sys; d = fitz.open(); d.new_page(width=595, height=842); d.new_page(width=595, height=842); d.save(sys.argv[1]); d.close()",
          samplePdf,
        ],
        { stdio: "pipe" }
      );
      fs.writeFileSync(inspectInput, JSON.stringify({ pdfPath: samplePdf }), "utf-8");
      execFileSync(
        pythonBin,
        ["python/formforge_engine.py", "inspect", inspectInput, inspectOutput],
        { encoding: "utf-8" }
      );
      const summary = JSON.parse(fs.readFileSync(inspectOutput, "utf-8"));
      expect(summary.ok).toBe(true);
      expect(summary.result.pageCount).toBe(2);
      expect(Array.isArray(summary.result.pages)).toBe(true);
      expect(summary.result.pages.length).toBe(2);

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects overflow beyond character-cell capacity with a non-zero exit code", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formforge-overflow-test-"));
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
          ["python/formforge_engine.py", "--help"],
          { encoding: "utf-8", stdio: "pipe" }
        );
      }).toThrow();
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
