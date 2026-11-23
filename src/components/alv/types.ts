import {
  ALV_FIELD_CAPACITIES,
  alvSubmissionSchema,
  type ALVSubmission,
} from "../../lib/validation/alv-schema.ts";

export type { ALVSubmission };
export { ALV_FIELD_CAPACITIES };

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

export interface GeneratedDocumentInfo {
  id: string;
  downloadUrl: string;
  inlineUrl: string;
  filename: string;
  generatedAt: string;
}

export interface SignedUploadConfirmation {
  documentId: string;
  reference: string;
  byteSize: number;
  sha256: string;
  uploadedAt: string;
}

export function getTodayYYMMDD(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

export function yymmddToIso(yymmdd: string): string {
  if (!/^\d{6}$/.test(yymmdd)) return "";
  return `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

export function isoToYymmdd(iso: string): string {
  const m = /^20(\d{2})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  return `${m[1]}${m[2]}${m[3]}`;
}

export function createInitialFormState(): ALVSubmission {
  return {
    owner: {
      identificationType: "rsa_id",
      identificationNumber: "",
      countryOfIssue: "",
      surnameOrOrganisation: "",
      initials: "",
      firstNames: "",
      email: "",
      homePhoneCode: "",
      homePhoneNumber: "",
      dayPhoneCode: "",
      dayPhoneNumber: "",
      faxCode: "",
      faxNumber: "",
      cellphone: "",
    },
    postalAddress: {
      line1: "",
      line2: "",
      line3: "",
      suburb: "",
      city: "",
      postalCode: "",
    },
    streetAddress: {
      line1: "",
      line2: "",
      line3: "",
      suburb: "",
      city: "",
      postalCode: "",
    },
    sameAsPostal: false,
    noticesAddress: "postal",
    hasOrganisationProxy: false,
    proxy: {
      identificationType: "rsa_id",
      identificationNumber: "",
      countryOfIssue: "",
      surname: "",
      initials: "",
    },
    hasOrganisationRepresentative: false,
    representative: {
      identificationType: "rsa_id",
      identificationNumber: "",
      countryOfIssue: "",
      surname: "",
      initials: "",
    },
    vehicle: {
      licenceNumber: "",
      registerNumber: "",
      chassisVin: "",
      make: "",
      seriesName: "",
      noOdometer: false,
      odometerReading: "",
      steeringPosition: "right",
    },
    declaration: {
      signatoryRole: "owner",
      signatoryName: "",
      place: "",
      dateYYMMDD: getTodayYYMMDD(),
      physicalSignatureAcknowledged: true,
    },
  };
}

export type FieldErrorMap = Record<string, string>;

/**
 * Validate either the full submission or errors belonging to a specific step.
 */
export function validateStep(step: WizardStep, data: ALVSubmission): FieldErrorMap {
  // For step 1–4 validation, ensure declaration placeholder values don't block earlier steps
  const candidate: ALVSubmission = {
    ...data,
    streetAddress: data.sameAsPostal ? { ...data.postalAddress } : data.streetAddress,
    declaration: {
      ...data.declaration,
      physicalSignatureAcknowledged: true,
    },
  };

  const result = alvSubmissionSchema.safeParse(
    step === 5 ? { ...data, streetAddress: candidate.streetAddress } : candidate
  );

  if (result.success) {
    return {};
  }

  const allErrors: FieldErrorMap = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".");
    if (!allErrors[key]) {
      allErrors[key] = issue.message;
    }
  }

  if (step === 5 || step === 6) {
    return allErrors;
  }

  const prefixesByStep: Record<number, string[]> = {
    1: ["owner."],
    2: ["postalAddress.", "streetAddress.", "noticesAddress", "sameAsPostal"],
    3: ["proxy.", "representative.", "hasOrganisationProxy", "hasOrganisationRepresentative"],
    4: ["vehicle."],
  };

  const prefixes = prefixesByStep[step] || [];
  const filtered: FieldErrorMap = {};
  for (const [k, msg] of Object.entries(allErrors)) {
    if (prefixes.some((p) => k === p || k.startsWith(p))) {
      filtered[k] = msg;
    }
  }
  return filtered;
}
