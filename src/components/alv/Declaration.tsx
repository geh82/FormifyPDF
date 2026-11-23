import { AlertCircle, PenLine } from "lucide-react";
import {
  ALV_FIELD_CAPACITIES,
  isoToYymmdd,
  yymmddToIso,
  type ALVSubmission,
  type FieldErrorMap,
} from "./types.ts";
import { CellInput, RadioCardGroup, SectionHeader } from "./FormControls.tsx";

interface DeclarationProps {
  data: ALVSubmission;
  errors: FieldErrorMap;
  onUpdateDeclaration: (patch: Partial<ALVSubmission["declaration"]>) => void;
}

const SIGNATORY_OPTIONS = [
  { value: "owner", label: "Owner", sublabel: "Eienaar" },
  {
    value: "organisation_proxy",
    label: "Organisation's proxy",
    sublabel: "Instelling se gevolmagtigde",
  },
  {
    value: "organisation_representative",
    label: "Organisation's representative",
    sublabel: "Instelling se verteenwoordiger",
  },
] as const;

export function Declaration({
  data,
  errors,
  onUpdateDeclaration,
}: DeclarationProps) {
  const { declaration } = data;
  const isoDate = yymmddToIso(declaration.dateYYMMDD);

  return (
    <div>
      <SectionHeader
        title="5. Declaration & Review"
        afrikaansTitle="Verklaring"
        description="Confirm who is making the statutory declaration, enter the place and date of signing, and review all details before generating the official ALV PDF."
      />

      <div className="space-y-6">
        <RadioCardGroup
          name="declaration-signatory-role"
          label="I, the (Signatory capacity)"
          bilingualHint="(Ek, die)"
          value={declaration.signatoryRole}
          options={SIGNATORY_OPTIONS}
          columns={3}
          onChange={(val) => onUpdateDeclaration({ signatoryRole: val })}
          error={errors["declaration.signatoryRole"]}
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <CellInput
            id="declaration.signatoryName"
            label="Signatory full name (for review record)"
            required
            value={declaration.signatoryName}
            maxLength={64}
            placeholder="Johannes Petrus van der Merwe"
            helpText="Identifies the declarant on review; NOT printed as a digital signature."
            onChange={(val) => onUpdateDeclaration({ signatoryName: val })}
            error={errors["declaration.signatoryName"]}
          />

          <CellInput
            id="declaration.place"
            label="Place of declaration"
            bilingualHint="(Plek)"
            required
            uppercase
            value={declaration.place}
            maxLength={ALV_FIELD_CAPACITIES.declarationPlace}
            placeholder="JOHANNESBURG"
            onChange={(val) => onUpdateDeclaration({ place: val })}
            error={errors["declaration.place"]}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="declaration.date"
              className="text-sm font-medium text-slate-800"
            >
              Declaration date
              <span className="ml-1 text-red-600" aria-hidden="true">*</span>
              <span className="ml-1.5 text-xs font-normal text-slate-500">
                (Datum: 20YY-MM-DD)
              </span>
            </label>
            <input
              id="declaration.date"
              type="date"
              min="2000-01-01"
              max="2099-12-31"
              value={isoDate}
              onChange={(e) => {
                const converted = isoToYymmdd(e.target.value);
                if (converted) {
                  onUpdateDeclaration({ dateYYMMDD: converted });
                }
              }}
              className={`w-full min-h-[42px] rounded-md border px-3 py-2 text-sm font-mono tabular-nums bg-white text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-800/25 ${
                errors["declaration.dateYYMMDD"]
                  ? "border-red-500"
                  : "border-slate-300 focus-visible:border-emerald-800"
              }`}
            />
            {errors["declaration.dateYYMMDD"] && (
              <p role="alert" className="flex items-center gap-1.5 text-xs font-medium text-red-700">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{errors["declaration.dateYYMMDD"]}</span>
              </p>
            )}
          </div>
        </div>

        {/* Statutory Declaration Text & Physical Signature Notice */}
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-5 space-y-3">
          <div className="flex items-start gap-3">
            <PenLine className="h-5 w-5 text-amber-800 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-900">
                Legal Requirement: Physical Signature After Printing
              </h3>
              <p className="text-sm text-slate-700 leading-relaxed">
                The official South African ALV form requires a handwritten signature in ink. Entering your name above does <strong>not</strong> constitute a legal signature. The <strong>Signature / Handtekening</strong> line on the generated PDF will remain blank so you can print, physically sign, and upload the signed PDF in the final step.
              </p>
              <div className="text-xs text-slate-600 space-y-1 pt-1 border-t border-amber-200/80">
                <p>
                  <strong>Statutory Declaration:</strong> I declare that all particulars furnished in this form are true and correct, and realise that a false declaration is punishable with a fine or imprisonment or both.
                </p>
              </div>
            </div>
          </div>

          <label className="flex items-start gap-2.5 pt-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={declaration.physicalSignatureAcknowledged}
              onChange={(e) =>
                onUpdateDeclaration({
                  physicalSignatureAcknowledged: e.target.checked,
                })
              }
              className="mt-0.5 h-4 w-4 rounded accent-emerald-800 shrink-0"
            />
            <span className="text-sm font-medium text-slate-900">
              I confirm the details are true and correct, and I understand I must print and physically sign the generated ALV PDF before uploading it.
            </span>
          </label>
          {errors["declaration.physicalSignatureAcknowledged"] && (
            <p role="alert" className="flex items-center gap-1.5 text-xs font-medium text-red-700">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{errors["declaration.physicalSignatureAcknowledged"]}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
