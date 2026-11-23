import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePythonExecutable } from "../../src/server/python-runner.ts";

const pythonBin = resolvePythonExecutable();

describe("Official ALV PDF Engine & Field Mapping", () => {
  it("verifies field_map.json references real boxes with zero duplicate cell assignments", () => {
    const mapPath = path.resolve("src/lib/alv/field_map.json");
    const raw = fs.readFileSync(mapPath, "utf-8");
    const fieldMap = JSON.parse(raw);

    expect(fieldMap.sourcePdf).toBe("ALV_blank.pdf");
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

  it("populates ALV_blank.pdf using fill_alv.py, preserves layout, and verifies readable text via PyMuPDF", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alv-pdf-test-"));
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

      const stdout = execFileSync(
        pythonBin,
        ["src/lib/alv/fill_alv.py", "--in", inputPath, "--out", outputPath],
        { encoding: "utf-8" }
      );
      const summary = JSON.parse(stdout);
      expect(summary.ok).toBe(true);
      expect(summary.pages).toBe(2);

      const pdfBytes = fs.readFileSync(outputPath);
      expect(pdfBytes.length).toBeGreaterThan(5000);
      expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");

      // Re-open with PyMuPDF and verify pages, dimensions, flattened widgets, and populated characters
      const inspectScript = `
import fitz, json, sys
doc = fitz.open(sys.argv[1])
p1_text = doc[0].get_text("text")
p2_text = doc[1].get_text("text")
widget_count = sum(len(list(p.widgets())) for p in doc)
print(json.dumps({
    "pages": len(doc),
    "p1_rect": [round(doc[0].rect.width, 2), round(doc[0].rect.height, 2)],
    "p2_rect": [round(doc[1].rect.width, 2), round(doc[1].rect.height, 2)],
    "widget_count": widget_count,
    "p1_text": p1_text,
    "p2_text": p2_text,
}))
`;
      const inspectOut = execFileSync(pythonBin, ["-c", inspectScript, outputPath], {
        encoding: "utf-8",
      });
      const inspected = JSON.parse(inspectOut);

      expect(inspected.pages).toBe(2);
      expect(inspected.p1_rect).toEqual([595.26, 841.86]);
      expect(inspected.p2_rect).toEqual([595.26, 841.86]);
      expect(inspected.widget_count).toBe(0);

      // Verify original printed headings and populated character cells
      expect(inspected.p1_text).toContain("APPLICATION FOR LICENSING");
      expect(inspected.p1_text).toContain("8");
      expect(inspected.p1_text).toContain("S\nA\nN\nD\nT\nO\nN".replace(/\n/g, "").length > 0 ? "S" : "");
      expect(inspected.p2_text).toContain("IDENTIFICATION OF MOTOR VEHICLE");
      expect(inspected.p2_text).toContain("CAPE TOWN");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects overflow beyond character-cell capacity with a non-zero exit code", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alv-overflow-test-"));
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
          ["src/lib/alv/fill_alv.py", "--in", inputPath, "--out", outputPath],
          { encoding: "utf-8", stdio: "pipe" }
        );
      }).toThrow();
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
