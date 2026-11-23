import { useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Check, FileCheck2 } from "lucide-react";
import { AddressDetails } from "./AddressDetails.tsx";
import { Declaration } from "./Declaration.tsx";
import { ModalDialog } from "./FormControls.tsx";
import { OrganisationDetails } from "./OrganisationDetails.tsx";
import { OwnerDetails } from "./OwnerDetails.tsx";
import { PDFCompletion } from "./PDFCompletion.tsx";
import { Review } from "./Review.tsx";
import { VehicleDetails } from "./VehicleDetails.tsx";
import {
  createInitialFormState,
  validateStep,
  type ALVSubmission,
  type FieldErrorMap,
  type GeneratedDocumentInfo,
  type SignedUploadConfirmation,
  type WizardStep,
} from "./types.ts";

const STEP_ITEMS: Array<{ step: WizardStep; title: string; shortLabel: string }> = [
  { step: 1, title: "Owner Details", shortLabel: "Owner" },
  { step: 2, title: "Addresses", shortLabel: "Addresses" },
  { step: 3, title: "Proxy & Rep", shortLabel: "Organisation" },
  { step: 4, title: "Vehicle Details", shortLabel: "Vehicle" },
  { step: 5, title: "Declaration & Review", shortLabel: "Review" },
  { step: 6, title: "Download & Sign", shortLabel: "Complete" },
];

export type InfoModalTopic = "documents" | "popia" | "guide" | null;

interface ALVWizardProps {
  activeModal: InfoModalTopic;
  onCloseModal: () => void;
  resetSignal: number;
}

export function ALVWizard({
  activeModal,
  onCloseModal,
  resetSignal,
}: ALVWizardProps) {
  const [formData, setFormData] = useState<ALVSubmission>(createInitialFormState);
  const [step, setStep] = useState<WizardStep>(1);
  const [maxReachedStep, setMaxReachedStep] = useState<WizardStep>(1);
  const [errors, setErrors] = useState<FieldErrorMap>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedDoc, setGeneratedDoc] = useState<GeneratedDocumentInfo | null>(null);
  const [signedConfirmation, setSignedConfirmation] =
    useState<SignedUploadConfirmation | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [lastResetSignal, setLastResetSignal] = useState(resetSignal);

  if (resetSignal !== lastResetSignal) {
    setLastResetSignal(resetSignal);
    setShowResetConfirm(true);
  }

  const handleConfirmReset = () => {
    setFormData(createInitialFormState());
    setStep(1);
    setMaxReachedStep(1);
    setErrors({});
    setServerError(null);
    setGeneratedDoc(null);
    setSignedConfirmation(null);
    setShowResetConfirm(false);
  };

  const clearErrorsForPrefix = (prefix: string) => {
    setErrors((prev) => {
      const next: FieldErrorMap = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(prefix)) next[k] = v;
      }
      return next;
    });
  };

  const updateOwner = (patch: Partial<ALVSubmission["owner"]>) => {
    setFormData((prev) => {
      const nextOwner = { ...prev.owner, ...patch };
      const switchedToBusiness =
        patch.identificationType === "business_reg" &&
        prev.owner.identificationType !== "business_reg";
      return {
        ...prev,
        owner: nextOwner,
        hasOrganisationProxy: switchedToBusiness ? true : prev.hasOrganisationProxy,
      };
    });
    clearErrorsForPrefix("owner.");
  };

  const updatePostal = (patch: Partial<ALVSubmission["postalAddress"]>) => {
    setFormData((prev) => {
      const nextPostal = { ...prev.postalAddress, ...patch };
      return {
        ...prev,
        postalAddress: nextPostal,
        streetAddress: prev.sameAsPostal ? nextPostal : prev.streetAddress,
      };
    });
    clearErrorsForPrefix("postalAddress.");
  };

  const updateStreet = (patch: Partial<ALVSubmission["streetAddress"]>) => {
    setFormData((prev) => ({
      ...prev,
      streetAddress: { ...prev.streetAddress, ...patch },
    }));
    clearErrorsForPrefix("streetAddress.");
  };

  const toggleSameAsPostal = (same: boolean) => {
    setFormData((prev) => ({
      ...prev,
      sameAsPostal: same,
      streetAddress: same ? { ...prev.postalAddress } : prev.streetAddress,
    }));
    clearErrorsForPrefix("streetAddress.");
  };

  const updateProxy = (patch: Partial<NonNullable<ALVSubmission["proxy"]>>) => {
    setFormData((prev) => ({
      ...prev,
      proxy: {
        identificationType: prev.proxy?.identificationType || "rsa_id",
        identificationNumber: prev.proxy?.identificationNumber || "",
        countryOfIssue: prev.proxy?.countryOfIssue || "",
        surname: prev.proxy?.surname || "",
        initials: prev.proxy?.initials || "",
        ...patch,
      },
    }));
    clearErrorsForPrefix("proxy.");
  };

  const updateRepresentative = (
    patch: Partial<NonNullable<ALVSubmission["representative"]>>
  ) => {
    setFormData((prev) => ({
      ...prev,
      representative: {
        identificationType: prev.representative?.identificationType || "rsa_id",
        identificationNumber: prev.representative?.identificationNumber || "",
        countryOfIssue: prev.representative?.countryOfIssue || "",
        surname: prev.representative?.surname || "",
        initials: prev.representative?.initials || "",
        ...patch,
      },
    }));
    clearErrorsForPrefix("representative.");
  };

  const updateVehicle = (patch: Partial<ALVSubmission["vehicle"]>) => {
    setFormData((prev) => ({
      ...prev,
      vehicle: { ...prev.vehicle, ...patch },
    }));
    clearErrorsForPrefix("vehicle.");
  };

  const updateDeclaration = (patch: Partial<ALVSubmission["declaration"]>) => {
    setFormData((prev) => ({
      ...prev,
      declaration: { ...prev.declaration, ...patch },
    }));
    clearErrorsForPrefix("declaration.");
  };

  const goToStep = (target: WizardStep) => {
    if (target === 6 && !generatedDoc) return;
    if (target <= maxReachedStep || target < step) {
      setErrors({});
      setServerError(null);
      setStep(target);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const handleNext = () => {
    setServerError(null);
    const stepErrors = validateStep(step, formData);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }
    setErrors({});
    const nextStep = Math.min(5, step + 1) as WizardStep;
    setStep(nextStep);
    if (nextStep > maxReachedStep) setMaxReachedStep(nextStep);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleBack = () => {
    setErrors({});
    setServerError(null);
    const prevStep = Math.max(1, step - 1) as WizardStep;
    setStep(prevStep);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleGeneratePdf = async () => {
    setServerError(null);
    const fullErrors = validateStep(5, formData);
    if (Object.keys(fullErrors).length > 0) {
      setErrors(fullErrors);
      // If errors exist in earlier steps, guide user to the first failing step
      const firstKey = Object.keys(fullErrors)[0] || "";
      if (firstKey.startsWith("owner.")) setStep(1);
      else if (firstKey.startsWith("postalAddress.") || firstKey.startsWith("streetAddress.")) setStep(2);
      else if (firstKey.startsWith("proxy.") || firstKey.startsWith("representative.")) setStep(3);
      else if (firstKey.startsWith("vehicle.")) setStep(4);
      return;
    }

    setErrors({});
    setIsGenerating(true);

    const payloadToSend: ALVSubmission = {
      ...formData,
      streetAddress: formData.sameAsPostal
        ? { ...formData.postalAddress }
        : formData.streetAddress,
    };

    try {
      const response = await fetch("/api/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadToSend),
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        if (Array.isArray(result.fieldErrors) && result.fieldErrors.length > 0) {
          const map: FieldErrorMap = {};
          for (const fe of result.fieldErrors) {
            if (fe.path && fe.message && !map[fe.path]) {
              map[fe.path] = fe.message;
            }
          }
          setErrors(map);
        }
        setServerError(
          result.error || "Unable to generate the official ALV PDF. Please review your entries."
        );
        return;
      }

      setGeneratedDoc({
        id: result.id,
        downloadUrl: result.downloadUrl,
        inlineUrl: result.inlineUrl || `${result.downloadUrl}&disposition=inline`,
        filename: result.filename || "ALV_generated.pdf",
        generatedAt: new Date().toISOString(),
      });
      setSignedConfirmation(null);
      setStep(6);
      setMaxReachedStep(6);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setServerError(
        "A network error occurred while communicating with the PDF generation service. Please try again."
      );
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Step Progress Navigation */}
      <nav aria-label="Application steps" className="rounded-lg border border-slate-200 bg-white p-3 sm:p-4">
        <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {STEP_ITEMS.map((item) => {
            const isCurrent = step === item.step;
            const isCompleted =
              (item.step < step) || (item.step === 6 && signedConfirmation !== null);
            const isClickable =
              item.step === 6
                ? generatedDoc !== null
                : item.step <= maxReachedStep;

            return (
              <li key={item.step}>
                <button
                  type="button"
                  disabled={!isClickable}
                  onClick={() => goToStep(item.step)}
                  className={`w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-medium transition-colors min-h-[42px] ${
                    isCurrent
                      ? "bg-emerald-900 text-white"
                      : isCompleted
                      ? "bg-emerald-50 text-emerald-900 hover:bg-emerald-100/70"
                      : isClickable
                      ? "bg-slate-50 text-slate-700 hover:bg-slate-100"
                      : "bg-slate-50/60 text-slate-400 cursor-not-allowed"
                  }`}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-mono tabular-nums ${
                      isCurrent
                        ? "bg-white/20 text-white"
                        : isCompleted
                        ? "bg-emerald-700 text-white"
                        : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {isCompleted && !isCurrent ? (
                      <Check className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      item.step
                    )}
                  </span>
                  <span className="truncate">{item.title}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Server or Validation Banner */}
      {serverError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-900"
        >
          <AlertCircle className="h-5 w-5 text-red-700 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-semibold">PDF Generation Failed</p>
            <p className="mt-0.5 text-red-800">{serverError}</p>
          </div>
        </div>
      )}

      {/* Main Step Viewport */}
      <div className="rounded-lg border border-slate-200 bg-white p-6 md:p-8">
        {step === 1 && (
          <OwnerDetails
            data={formData}
            errors={errors}
            onUpdateOwner={updateOwner}
          />
        )}
        {step === 2 && (
          <AddressDetails
            data={formData}
            errors={errors}
            onUpdatePostal={updatePostal}
            onUpdateStreet={updateStreet}
            onToggleSameAsPostal={toggleSameAsPostal}
            onChangeNoticesAddress={(val) => {
              setFormData((prev) => ({ ...prev, noticesAddress: val }));
              clearErrorsForPrefix("noticesAddress");
            }}
          />
        )}
        {step === 3 && (
          <OrganisationDetails
            data={formData}
            errors={errors}
            onToggleProxy={(enabled) => {
              setFormData((prev) => ({ ...prev, hasOrganisationProxy: enabled }));
              clearErrorsForPrefix("proxy.");
            }}
            onUpdateProxy={updateProxy}
            onToggleRepresentative={(enabled) => {
              setFormData((prev) => ({
                ...prev,
                hasOrganisationRepresentative: enabled,
              }));
              clearErrorsForPrefix("representative.");
            }}
            onUpdateRepresentative={updateRepresentative}
          />
        )}
        {step === 4 && (
          <VehicleDetails
            data={formData}
            errors={errors}
            onUpdateVehicle={updateVehicle}
          />
        )}
        {step === 5 && (
          <div>
            <Declaration
              data={formData}
              errors={errors}
              onUpdateDeclaration={updateDeclaration}
            />
            <Review data={formData} onEditStep={(s) => goToStep(s)} />
          </div>
        )}
        {step === 6 && generatedDoc && (
          <PDFCompletion
            docInfo={generatedDoc}
            signedConfirmation={signedConfirmation}
            onSignedUploadSuccess={(conf) => setSignedConfirmation(conf)}
            onBackToReview={() => setStep(5)}
            onStartNew={handleConfirmReset}
          />
        )}

        {/* Wizard Footer Controls (Steps 1–5) */}
        {step <= 5 && (
          <div className="mt-8 pt-6 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleBack}
              disabled={step === 1 || isGenerating}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed min-h-[42px] whitespace-nowrap"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Previous Step</span>
            </button>

            <div className="flex items-center gap-3">
              {generatedDoc && step === 5 && (
                <button
                  type="button"
                  onClick={() => setStep(6)}
                  className="inline-flex items-center gap-2 rounded-md border border-emerald-800 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-900 hover:bg-emerald-100 min-h-[42px] whitespace-nowrap"
                >
                  <span>Return to Generated PDF</span>
                </button>
              )}

              {step < 5 ? (
                <button
                  type="button"
                  onClick={handleNext}
                  className="inline-flex items-center gap-2 rounded-md bg-emerald-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 min-h-[42px] whitespace-nowrap"
                >
                  <span>Continue</span>
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleGeneratePdf}
                  disabled={isGenerating}
                  className="inline-flex items-center gap-2 rounded-md bg-emerald-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60 min-h-[42px] whitespace-nowrap"
                >
                  <FileCheck2 className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {isGenerating
                      ? "Generating Official ALV PDF..."
                      : "Generate Official ALV PDF"}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Confirmation Dialog for Reset */}
      <ModalDialog
        open={showResetConfirm}
        title="Reset ALV Application Form?"
        onClose={() => setShowResetConfirm(false)}
      >
        <div className="space-y-4">
          <p>
            This will clear all entered owner, address, vehicle, and declaration details from the form so you can start a fresh application.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowResetConfirm(false)}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmReset}
              className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
            >
              Reset Form
            </button>
          </div>
        </div>
      </ModalDialog>

      {/* Informational Dialogs */}
      <ModalDialog
        open={activeModal === "documents"}
        title="Required Supporting Information"
        onClose={onCloseModal}
      >
        <div className="space-y-3">
          <p>To complete your South African ALV application accurately, have the following ready:</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>Vehicle owner's South African ID, Traffic Register Number, Foreign ID/Passport, or Business Registration Certificate.</li>
            <li>Proof of postal and residential/business street address (e.g., recent utility bill).</li>
            <li>For organisations: identity details of the appointed Proxy and/or Representative.</li>
            <li>Current vehicle licence disc or registration certificate showing Licence Number, Register Number, VIN/Chassis Number, Make, and Series Name.</li>
          </ul>
        </div>
      </ModalDialog>

      <ModalDialog
        open={activeModal === "popia"}
        title="POPIA Personal Information & Document Security"
        onClose={onCloseModal}
      >
        <div className="space-y-3">
          <p>
            In compliance with South Africa's <strong>Protection of Personal Information Act (POPIA)</strong>:
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong>Purpose Limitation:</strong> Only fields required on official form ALV(9)(2011/07) under the National Road Traffic Act, 1996 are collected.</li>
            <li><strong>Isolated Storage:</strong> Generated draft PDFs and uploaded signed PDFs are stored in separate protected locations under random 24-character identifiers.</li>
            <li><strong>Private Access:</strong> Signed customer uploads are never exposed via public download links.</li>
            <li><strong>Retention:</strong> Temporary processing inputs are deleted immediately after PDF generation, and stored files expire automatically according to the configured retention policy.</li>
          </ul>
        </div>
      </ModalDialog>

      <ModalDialog
        open={activeModal === "guide"}
        title="Official ALV Form Workflow"
        onClose={onCloseModal}
      >
        <div className="space-y-3">
          <p>
            ALV Form Online populates the official two-page South African <strong>ALV(9)(2011/07)</strong> form directly, preserving every printed bilingual label, line, and character box.
          </p>
          <ol className="list-decimal pl-5 space-y-1.5">
            <li>Complete Steps 1–5 and review every detail.</li>
            <li>Generate the official completed ALV PDF.</li>
            <li>Download or open and print the PDF.</li>
            <li>Sign the <strong>Signature / Handtekening</strong> line physically in ink (printed names are never substituted for a wet-ink signature).</li>
            <li>Scan or save the signed document as a PDF and upload it to receive your verified submission reference.</li>
          </ol>
        </div>
      </ModalDialog>
    </div>
  );
}
