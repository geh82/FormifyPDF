import { z } from "zod";

export const ALV_FIELD_CAPACITIES = {
  ownerIdentificationNumber: 13,
  ownerCountryOfIssue: 27,
  ownerSurnameOrOrganisation: 32,
  ownerInitials: 3,
  ownerFirstNames: 20,
  ownerEmail: 31,
  phoneCode: 5,
  phoneNumber: 8,
  cellphone: 10,
  addressLine1: 30,
  addressLine2: 25,
  addressLine3: 25,
  addressSuburb: 25,
  addressCity: 25,
  postalCode: 4,
  proxyIdentificationNumber: 13,
  proxyCountryOfIssue: 28,
  proxySurname: 27,
  proxyInitials: 3,
  repIdentificationNumber: 13,
  repCountryOfIssue: 28,
  repSurname: 27,
  repInitials: 3,
  licenceNumber: 9,
  vehicleRegisterNumber: 7,
  chassisVin: 17,
  vehicleMake: 30,
  seriesName: 30,
  odometerReading: 6,
  declarationPlace: 32,
} as const;

export const OWNER_ID_TYPES = [
  "traffic_register",
  "rsa_id",
  "foreign_id",
  "business_reg",
] as const;

export const PERSON_ID_TYPES = [
  "traffic_register",
  "rsa_id",
  "foreign_id",
] as const;

export const NOTICES_ADDRESS_OPTIONS = ["postal", "street"] as const;
export const STEERING_POSITIONS = ["drawn", "left", "centre", "right"] as const;
export const SIGNATORY_ROLES = [
  "owner",
  "organisation_proxy",
  "organisation_representative",
] as const;

export type OwnerIdType = (typeof OWNER_ID_TYPES)[number];
export type PersonIdType = (typeof PERSON_ID_TYPES)[number];
export type NoticesAddressOption = (typeof NOTICES_ADDRESS_OPTIONS)[number];
export type SteeringPosition = (typeof STEERING_POSITIONS)[number];
export type SignatoryRole = (typeof SIGNATORY_ROLES)[number];

/**
 * Strip ASCII control characters, collapse internal whitespace runs, and trim.
 */
export function sanitizeString(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validates a 13-digit South African Identity Number including YYMMDD date
 * plausibility and the standard Luhn check digit.
 */
export function isValidSouthAfricanId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;

  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  if ([4, 6, 9, 11].includes(mm) && dd > 30) return false;
  if (mm === 2 && dd > 29) return false;

  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let digit = Number(id[i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function isValidYYMMDD(yymmdd: string): boolean {
  if (!/^\d{6}$/.test(yymmdd)) return false;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const fullYear = 2000 + yy;
  const dt = new Date(Date.UTC(fullYear, mm - 1, dd));
  return (
    dt.getUTCFullYear() === fullYear &&
    dt.getUTCMonth() === mm - 1 &&
    dt.getUTCDate() === dd
  );
}

const cleanText = (maxLen: number) =>
  z.preprocess(
    (v) => (v === undefined || v === null ? "" : sanitizeString(v)),
    z.string().max(maxLen, `Must be at most ${maxLen} characters`)
  );

const digitsOnly = (maxLen: number) =>
  z.preprocess(
    (v) => (v === undefined || v === null ? "" : sanitizeString(v)),
    z
      .string()
      .max(maxLen, `Must be at most ${maxLen} digits`)
      .refine((s) => s === "" || /^\d+$/.test(s), "Must contain digits only")
  );

const addressSchema = z
  .object({
    line1: cleanText(ALV_FIELD_CAPACITIES.addressLine1).refine(
      (s) => s.length >= 2,
      "Address line 1 is required"
    ),
    line2: cleanText(ALV_FIELD_CAPACITIES.addressLine2),
    line3: cleanText(ALV_FIELD_CAPACITIES.addressLine3),
    suburb: cleanText(ALV_FIELD_CAPACITIES.addressSuburb),
    city: cleanText(ALV_FIELD_CAPACITIES.addressCity).refine(
      (s) => s.length >= 2,
      "City / Town is required"
    ),
    postalCode: cleanText(ALV_FIELD_CAPACITIES.postalCode).refine(
      (s) => /^\d{4}$/.test(s),
      "South African postal code must be 4 digits"
    ),
  })
  .strict();

const personPartySchema = (countryMax: number, surnameMax: number) =>
  z
    .object({
      identificationType: z.enum(PERSON_ID_TYPES),
      identificationNumber: cleanText(13),
      countryOfIssue: cleanText(countryMax),
      surname: cleanText(surnameMax),
      initials: cleanText(3),
    })
    .strict();

export const alvSubmissionSchema = z
  .object({
    owner: z
      .object({
        identificationType: z.enum(OWNER_ID_TYPES),
        identificationNumber: cleanText(ALV_FIELD_CAPACITIES.ownerIdentificationNumber).refine(
          (s) => s.length >= 4,
          "Identification number is required"
        ),
        countryOfIssue: cleanText(ALV_FIELD_CAPACITIES.ownerCountryOfIssue),
        surnameOrOrganisation: cleanText(ALV_FIELD_CAPACITIES.ownerSurnameOrOrganisation).refine(
          (s) => s.length >= 2,
          "Surname or organisation name is required"
        ),
        initials: cleanText(ALV_FIELD_CAPACITIES.ownerInitials),
        firstNames: cleanText(ALV_FIELD_CAPACITIES.ownerFirstNames),
        email: cleanText(ALV_FIELD_CAPACITIES.ownerEmail).refine(
          (s) => s === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
          "Enter a valid email address (max 31 characters)"
        ),
        homePhoneCode: digitsOnly(ALV_FIELD_CAPACITIES.phoneCode),
        homePhoneNumber: digitsOnly(ALV_FIELD_CAPACITIES.phoneNumber),
        dayPhoneCode: digitsOnly(ALV_FIELD_CAPACITIES.phoneCode),
        dayPhoneNumber: digitsOnly(ALV_FIELD_CAPACITIES.phoneNumber),
        faxCode: digitsOnly(ALV_FIELD_CAPACITIES.phoneCode),
        faxNumber: digitsOnly(ALV_FIELD_CAPACITIES.phoneNumber),
        cellphone: digitsOnly(ALV_FIELD_CAPACITIES.cellphone).refine(
          (s) => s === "" || /^\d{10}$/.test(s),
          "South African cellphone number must be 10 digits (e.g. 0825551234)"
        ),
      })
      .strict(),
    postalAddress: addressSchema,
    streetAddress: addressSchema,
    sameAsPostal: z.boolean().default(false),
    noticesAddress: z.enum(NOTICES_ADDRESS_OPTIONS),
    hasOrganisationProxy: z.boolean().default(false),
    proxy: personPartySchema(
      ALV_FIELD_CAPACITIES.proxyCountryOfIssue,
      ALV_FIELD_CAPACITIES.proxySurname
    ).optional(),
    hasOrganisationRepresentative: z.boolean().default(false),
    representative: personPartySchema(
      ALV_FIELD_CAPACITIES.repCountryOfIssue,
      ALV_FIELD_CAPACITIES.repSurname
    ).optional(),
    vehicle: z
      .object({
        licenceNumber: cleanText(ALV_FIELD_CAPACITIES.licenceNumber).refine(
          (s) => s.length >= 2 && /^[A-Za-z0-9\s-]+$/.test(s),
          "Enter a valid licence number (max 9 characters)"
        ),
        registerNumber: cleanText(ALV_FIELD_CAPACITIES.vehicleRegisterNumber).refine(
          (s) => s === "" || /^[A-Za-z0-9]+$/.test(s),
          "Register number must be alphanumeric (max 7 characters)"
        ),
        chassisVin: cleanText(ALV_FIELD_CAPACITIES.chassisVin).refine(
          (s) => s.length >= 5 && /^[A-Za-z0-9]+$/.test(s),
          "Chassis number / VIN must be 5 to 17 alphanumeric characters"
        ),
        make: cleanText(ALV_FIELD_CAPACITIES.vehicleMake).refine(
          (s) => s.length >= 2,
          "Vehicle make is required"
        ),
        seriesName: cleanText(ALV_FIELD_CAPACITIES.seriesName).refine(
          (s) => s.length >= 1,
          "Series name is required"
        ),
        noOdometer: z.boolean().default(false),
        odometerReading: digitsOnly(ALV_FIELD_CAPACITIES.odometerReading),
        steeringPosition: z.enum(STEERING_POSITIONS),
      })
      .strict(),
    declaration: z
      .object({
        signatoryRole: z.enum(SIGNATORY_ROLES),
        signatoryName: cleanText(64).refine(
          (s) => s.length >= 2,
          "Signatory full name is required for review"
        ),
        place: cleanText(ALV_FIELD_CAPACITIES.declarationPlace).refine(
          (s) => s.length >= 2,
          "Declaration place is required"
        ),
        dateYYMMDD: cleanText(6).refine(
          (s) => isValidYYMMDD(s),
          "Enter a valid declaration date (YYMMDD)"
        ),
        physicalSignatureAcknowledged: z
          .boolean()
          .refine(
            (v) => v === true,
            "You must acknowledge that the printed PDF requires a physical handwritten signature"
          ),
      })
      .strict(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const { owner } = data;

    // Owner identification rules
    if (owner.identificationType === "rsa_id") {
      if (!isValidSouthAfricanId(owner.identificationNumber)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["owner", "identificationNumber"],
          message: "Enter a valid 13-digit South African ID number",
        });
      }
    } else if (owner.identificationType === "foreign_id") {
      if (owner.countryOfIssue.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["owner", "countryOfIssue"],
          message: "Country of issue is required for foreign identification",
        });
      }
    } else if (owner.identificationType === "traffic_register") {
      if (!/^[A-Za-z0-9]{5,13}$/.test(owner.identificationNumber)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["owner", "identificationNumber"],
          message: "Traffic register number must be 5 to 13 alphanumeric characters",
        });
      }
    } else if (owner.identificationType === "business_reg") {
      if (!/^[A-Za-z0-9/]{5,13}$/.test(owner.identificationNumber)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["owner", "identificationNumber"],
          message:
            "Business registration number must fit within the 13 form boxes (omit spaces/extra slashes if needed)",
        });
      }
    }

    // Individual owners require initials and first names; organisations do not
    if (owner.identificationType !== "business_reg") {
      if (owner.initials.length < 1 || !/^[A-Za-z]+$/.test(owner.initials)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["owner", "initials"],
          message: "Initials are required (1 to 3 letters)",
        });
      }
      if (owner.firstNames.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["owner", "firstNames"],
          message: "First names are required for individual vehicle owners",
        });
      }
    }

    // Paired telephone code/number checks
    const phonePairs: Array<[string, string, string]> = [
      ["homePhoneCode", "homePhoneNumber", "Home telephone"],
      ["dayPhoneCode", "dayPhoneNumber", "Day telephone"],
      ["faxCode", "faxNumber", "Facsimile"],
    ];
    for (const [codeKey, numKey, label] of phonePairs) {
      const code = owner[codeKey as keyof typeof owner] as string;
      const num = owner[numKey as keyof typeof owner] as string;
      if ((code && !num) || (!code && num)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["owner", code ? numKey : codeKey],
          message: `${label} requires both dialing code and number`,
        });
      }
    }

    // At least one contact mechanism
    if (!owner.cellphone && !owner.dayPhoneNumber && !owner.homePhoneNumber && !owner.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["owner", "cellphone"],
        message: "Provide at least a cellphone number, telephone number, or email address",
      });
    }

    // Street address suburb required
    if (data.streetAddress.suburb.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["streetAddress", "suburb"],
        message: "Street address suburb is required",
      });
    }

    // Proxy validation when enabled or chosen as signatory
    const needProxy =
      data.hasOrganisationProxy || data.declaration.signatoryRole === "organisation_proxy";
    if (needProxy) {
      if (!data.proxy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proxy", "identificationNumber"],
          message: "Organisation proxy details are required",
        });
      } else {
        validatePersonParty(data.proxy, "proxy", ctx);
      }
    }

    // Representative validation when enabled or chosen as signatory
    const needRep =
      data.hasOrganisationRepresentative ||
      data.declaration.signatoryRole === "organisation_representative";
    if (needRep) {
      if (!data.representative) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["representative", "identificationNumber"],
          message: "Organisation representative details are required",
        });
      } else {
        validatePersonParty(data.representative, "representative", ctx);
      }
    }

    // Odometer mutual exclusivity
    if (data.vehicle.noOdometer && data.vehicle.odometerReading !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vehicle", "odometerReading"],
        message: "Odometer reading must be blank when 'No odometer' is selected",
      });
    }
  });

function validatePersonParty(
  party: {
    identificationType: PersonIdType;
    identificationNumber: string;
    countryOfIssue: string;
    surname: string;
    initials: string;
  },
  prefix: "proxy" | "representative",
  ctx: z.RefinementCtx
) {
  if (party.identificationType === "rsa_id") {
    if (!isValidSouthAfricanId(party.identificationNumber)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [prefix, "identificationNumber"],
        message: "Enter a valid 13-digit South African ID number",
      });
    }
  } else if (party.identificationType === "foreign_id") {
    if (party.identificationNumber.length < 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [prefix, "identificationNumber"],
        message: "Foreign identification number is required",
      });
    }
    if (party.countryOfIssue.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [prefix, "countryOfIssue"],
        message: "Country of issue is required for foreign identification",
      });
    }
  } else if (!/^[A-Za-z0-9]{5,13}$/.test(party.identificationNumber)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [prefix, "identificationNumber"],
      message: "Traffic register number must be 5 to 13 alphanumeric characters",
    });
  }

  if (party.surname.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [prefix, "surname"],
      message: "Surname is required",
    });
  }
  if (party.initials.length < 1 || !/^[A-Za-z]+$/.test(party.initials)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [prefix, "initials"],
      message: "Initials are required (1 to 3 letters)",
    });
  }
}

export type ALVSubmission = z.infer<typeof alvSubmissionSchema>;

export const DOCUMENT_ID_REGEX = /^[a-f0-9]{24}$/;

export function isValidDocumentId(id: unknown): id is string {
  return typeof id === "string" && DOCUMENT_ID_REGEX.test(id);
}

/**
 * Strips form-control-only flags and normalizes payload for fill_alv.py
 */
export function toPdfEnginePayload(data: ALVSubmission): Record<string, unknown> {
  const street = data.sameAsPostal ? { ...data.postalAddress } : { ...data.streetAddress };
  const payload: Record<string, unknown> = {
    owner: {
      ...data.owner,
      countryOfIssue:
        data.owner.identificationType === "foreign_id" ? data.owner.countryOfIssue : "",
    },
    postalAddress: data.postalAddress,
    streetAddress: street,
    noticesAddress: data.noticesAddress,
    vehicle: {
      ...data.vehicle,
      licenceNumber: data.vehicle.licenceNumber.replace(/\s+/g, ""),
      odometerReading: data.vehicle.noOdometer ? "" : data.vehicle.odometerReading,
    },
    declaration: {
      signatoryRole: data.declaration.signatoryRole,
      place: data.declaration.place,
      dateYYMMDD: data.declaration.dateYYMMDD,
    },
  };

  if (
    (data.hasOrganisationProxy || data.declaration.signatoryRole === "organisation_proxy") &&
    data.proxy
  ) {
    payload.proxy = {
      ...data.proxy,
      countryOfIssue:
        data.proxy.identificationType === "foreign_id" ? data.proxy.countryOfIssue : "",
    };
  }

  if (
    (data.hasOrganisationRepresentative ||
      data.declaration.signatoryRole === "organisation_representative") &&
    data.representative
  ) {
    payload.representative = {
      ...data.representative,
      countryOfIssue:
        data.representative.identificationType === "foreign_id"
          ? data.representative.countryOfIssue
          : "",
    };
  }

  return payload;
}
