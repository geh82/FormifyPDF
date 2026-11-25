import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFCheckBox, PDFDocument, PDFName, PDFDict, PDFRadioGroup, PDFRawStream, PDFTextField } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AcroFormValidationReport, FieldManifest } from "../../src/lib/formifypdf/types.ts";
import { runFormifyNodeEngine } from "../../src/server/formifypdf-node-engine.ts";

describe("ALV-009 Real-World 2-Page Form End-to-End Conversion Accuracy", () => {
  let tmpDir: string;
  const alvPdfPath = path.resolve(
    process.cwd(),
    "public/assets/aistudio/ALV-009-20260713-175634_e6028031.pdf"
  );

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "formifypdf-alv009-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects all 57 real ALV-009 fields with zero phantoms, proper YYMMDD date combs, clean labels, and clean widget positioning", async () => {
    const analyzed = await runFormifyNodeEngine<{
      manifest: FieldManifest;
    }>("analyze", {
      pdfPath: alvPdfPath,
      options: { documentId: "alv009_accuracy_check" },
    });

    const fields = analyzed.manifest.fields;
    expect(fields.length).toBe(57);

    const p1Fields = fields.filter((f) => f.page === 0);
    const p2Fields = fields.filter((f) => f.page === 1);
    expect(p1Fields.length).toBe(32);
    expect(p2Fields.length).toBe(25);

    // 42 comb char_cells fields across both pages (including both 6-digit YYMMDD dates)
    const combFields = fields.filter(
      (f) => f.type === "char_cells" && f.charGridMeta?.acroformStrategy === "comb"
    );
    expect(combFields.length).toBe(42);

    // Zero phantom horizontal rule detections
    const phantom = fields.find((f) =>
      /imprisonment_or_both|gevangenisstraf_of_beide|for_office_use|net_vir_kantoorgebruik/i.test(
        `${f.name} ${f.label}`
      )
    );
    expect(phantom).toBeUndefined();

    // Both YYMMDD 6-digit date fields after preprinted "2:0"
    const declDate = fields.find((f) => f.page === 1 && f.name === "date");
    expect(declDate).toBeDefined();
    expect(declDate?.type).toBe("char_cells");
    expect(declDate?.cellRects?.length).toBe(6);
    expect(declDate?.rect.width).toBeLessThan(85);

    const appDate = fields.find((f) => f.page === 1 && f.name === "date_of_application");
    expect(appDate).toBeDefined();
    expect(appDate?.type).toBe("char_cells");
    expect(appDate?.cellRects?.length).toBe(6);
    expect(appDate?.rect.width).toBeLessThan(85);

    // Clean contextual labeling & semantic type inference
    const counterName = fields.find((f) => f.name === "counter_official_name");
    const dataName = fields.find((f) => f.name === "data_capturing_official_name");
    expect(counterName?.semanticType).toBe("text");
    expect(dataName?.semanticType).toBe("text");
    expect(fields.find((f) => f.name === "counter_official_signature")?.type).toBe("signature");
    expect(fields.find((f) => f.name === "data_capturing_official_signature")?.type).toBe("signature");
    expect(fields.some((f) => f.label === "First names")).toBe(true);
    expect(fields.some((f) => f.label === "Postal address (Line 2)")).toBe(true);
    expect(fields.some((f) => f.label === "Street address (Line 2)")).toBe(true);

    // Dotted inline Place & Signature fields must clear left printed text cleanly
    const placeField = fields.find((f) => f.name === "place");
    const sigField = fields.find((f) => f.name === "signature");
    expect(placeField?.rect.x).toBeGreaterThanOrEqual(205);
    expect(sigField?.rect.x).toBeGreaterThanOrEqual(225);

    // Generate AcroForm and audit transparency, visual alignment & round-trip fidelity
    const acroPath = path.join(tmpDir, "alv009_acroform.pdf");
    const generated = await runFormifyNodeEngine<{
      createdWidgets: number;
      validation: AcroFormValidationReport;
    }>("generate-acroform", {
      pdfPath: alvPdfPath,
      manifest: analyzed.manifest,
      outputPdfPath: acroPath,
    });

    expect(generated.validation.passed).toBe(true);
    expect(generated.validation.duplicateWidgetNames).toEqual([]);
    expect(generated.validation.visualVerification?.passed).toBe(true);
    expect(generated.validation.visualVerification?.alignedFields).toBe(57);
    expect(generated.validation.visualVerification?.meanIoU).toBeGreaterThanOrEqual(0.99);
    expect(generated.validation.visualVerification?.missingFields).toBe(0);
    expect(generated.validation.visualVerification?.overlappingWidgets).toBe(0);

    // Audit PDF-level widget transparency, zero /MK /BG opaque boxes, and readable font sizes
    const acroDoc = await PDFDocument.load(fs.readFileSync(acroPath));
    const acroForm = acroDoc.getForm();
    for (const f of acroForm.getFields()) {
      for (const w of f.acroField.getWidgets()) {
        const mk = w.dict.lookupMaybe(PDFName.of("MK"), PDFDict);
        expect(mk?.has(PDFName.of("BG")) ?? false).toBe(false);
        expect(mk?.has(PDFName.of("BC")) ?? false).toBe(false);
        if (f instanceof PDFCheckBox || f instanceof PDFRadioGroup) {
          const apN = w.dict.lookupMaybe(PDFName.of("AP"), PDFDict)?.lookupMaybe(PDFName.of("N"), PDFDict);
          const offStream = apN?.lookupMaybe(PDFName.of("Off"), PDFRawStream);
          expect(offStream?.contents.length ?? 0).toBe(0);
        }
      }
    }

    // Fillable round-trip render across comb, YYMMDD date, fuzzy radio label, and underline text fields
    const filledPath = path.join(tmpDir, "alv009_filled.pdf");
    const rendered = await runFormifyNodeEngine<{ populatedWidgets: number }>("render-pdf", {
      templatePdfPath: acroPath,
      manifest: analyzed.manifest,
      values: {
        surname_or_organisation_name: "ACME LOGISTICS",
        licence_number: "GP12345GP",
        make: "TOYOTA",
        type_of_identification_2: "RSA ID",
        position_of_steering_wheel: "right / regs",
        i_the: "owner / eienaar",
        place: "JOHANNESBURG",
        date: "260713",
        date_of_application: "260713",
        counter_official_name: "J. VAN DER MERWE",
        data_capturing_official_name: "N. ZULU",
      },
      outputPdfPath: filledPath,
      outputMode: "fillable",
    });

    expect(rendered.populatedWidgets).toBeGreaterThanOrEqual(11);

    const readBackDoc = await PDFDocument.load(fs.readFileSync(filledPath));
    const readForm = readBackDoc.getForm();
    expect((readForm.getField("licence_number") as PDFTextField).getText()).toBe("GP12345GP");
    expect((readForm.getField("place") as PDFTextField).getText()).toBe("JOHANNESBURG");
    expect((readForm.getField("date") as PDFTextField).getText()).toBe("260713");
    expect((readForm.getField("date_of_application") as PDFTextField).getText()).toBe("260713");
    expect((readForm.getField("counter_official_name") as PDFTextField).getText()).toBe("J. VAN DER MERWE");
    expect((readForm.getField("type_of_identification_2") as PDFRadioGroup).getSelected()).toBe("rsa_id");
    expect((readForm.getField("position_of_steering_wheel") as PDFRadioGroup).getSelected()).toBe("right_regs");
    expect((readForm.getField("i_the") as PDFRadioGroup).getSelected()).toBe("owner_eienaar");
  });
});
