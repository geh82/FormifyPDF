import {
  ALV_FIELD_CAPACITIES,
  type ALVSubmission,
  type FieldErrorMap,
} from "./types.ts";
import { CellInput, RadioCardGroup, SectionHeader } from "./FormControls.tsx";

interface OwnerDetailsProps {
  data: ALVSubmission;
  errors: FieldErrorMap;
  onUpdateOwner: (patch: Partial<ALVSubmission["owner"]>) => void;
}

const OWNER_ID_OPTIONS = [
  { value: "rsa_id", label: "RSA ID", sublabel: "13-digit SA Identity Number" },
  { value: "traffic_register", label: "Traffic register no.", sublabel: "Verkeersregisternr." },
  { value: "foreign_id", label: "Foreign ID", sublabel: "Buitelandse ID / Passport" },
  { value: "business_reg", label: "Business reg. no.", sublabel: "Besigh.reg.nr. (Company / CC)" },
] as const;

export function OwnerDetails({ data, errors, onUpdateOwner }: OwnerDetailsProps) {
  const { owner } = data;
  const isBusiness = owner.identificationType === "business_reg";
  const isForeign = owner.identificationType === "foreign_id";

  return (
    <div>
      <SectionHeader
        title="1. Particulars of Owner"
        afrikaansTitle="Besonderhede van Eienaar"
        description="Enter the registered vehicle owner's identification and contact details exactly as they appear on your identity document or business registration certificate."
      />

      <div className="space-y-6">
        <RadioCardGroup
          name="owner-identification-type"
          label="Type of identification"
          bilingualHint="(Soort identifikasie)"
          value={owner.identificationType}
          options={OWNER_ID_OPTIONS}
          onChange={(val) =>
            onUpdateOwner({
              identificationType: val,
              countryOfIssue: val === "foreign_id" ? owner.countryOfIssue : "",
            })
          }
          error={errors["owner.identificationType"]}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <CellInput
            id="owner.identificationNumber"
            label="Identification number"
            bilingualHint="(Identifikasienommer)"
            required
            mono
            uppercase
            value={owner.identificationNumber}
            maxLength={ALV_FIELD_CAPACITIES.ownerIdentificationNumber}
            inputMode={owner.identificationType === "rsa_id" ? "numeric" : "text"}
            placeholder={
              owner.identificationType === "rsa_id"
                ? "8506155012089"
                : isBusiness
                ? "202012345607"
                : "ID or register number"
            }
            helpText={
              isBusiness
                ? "Official ALV form provides 13 boxes. Omit extra spaces or slashes if longer."
                : owner.identificationType === "rsa_id"
                ? "13-digit South African ID number."
                : undefined
            }
            onChange={(val) =>
              onUpdateOwner({
                identificationNumber:
                  owner.identificationType === "rsa_id" ? val.replace(/\D/g, "") : val,
              })
            }
            error={errors["owner.identificationNumber"]}
          />

          {isForeign && (
            <CellInput
              id="owner.countryOfIssue"
              label="Country of issue"
              bilingualHint="(Land van uitreiking)"
              required
              uppercase
              value={owner.countryOfIssue}
              maxLength={ALV_FIELD_CAPACITIES.ownerCountryOfIssue}
              placeholder="NAMIBIA"
              onChange={(val) => onUpdateOwner({ countryOfIssue: val })}
              error={errors["owner.countryOfIssue"]}
            />
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
          <div className="md:col-span-6">
            <CellInput
              id="owner.surnameOrOrganisation"
              label={isBusiness ? "Name of organisation" : "Surname"}
              bilingualHint="(Van / Naam van instelling)"
              required
              uppercase
              value={owner.surnameOrOrganisation}
              maxLength={ALV_FIELD_CAPACITIES.ownerSurnameOrOrganisation}
              placeholder={isBusiness ? "CAPE LOGISTICS PTY LTD" : "VAN DER MERWE"}
              onChange={(val) => onUpdateOwner({ surnameOrOrganisation: val })}
              error={errors["owner.surnameOrOrganisation"]}
            />
          </div>

          {!isBusiness && (
            <>
              <div className="md:col-span-2">
                <CellInput
                  id="owner.initials"
                  label="Initials"
                  bilingualHint="(max 3)"
                  required
                  uppercase
                  value={owner.initials}
                  maxLength={ALV_FIELD_CAPACITIES.ownerInitials}
                  placeholder="JP"
                  onChange={(val) =>
                    onUpdateOwner({ initials: val.replace(/[^A-Za-z]/g, "") })
                  }
                  error={errors["owner.initials"]}
                />
              </div>
              <div className="md:col-span-4">
                <CellInput
                  id="owner.firstNames"
                  label="First names"
                  bilingualHint="(Voorname)"
                  required
                  uppercase
                  value={owner.firstNames}
                  maxLength={ALV_FIELD_CAPACITIES.ownerFirstNames}
                  placeholder="JOHANNES PETRUS"
                  onChange={(val) => onUpdateOwner({ firstNames: val })}
                  error={errors["owner.firstNames"]}
                />
              </div>
            </>
          )}
        </div>

        <div className="border-t border-slate-200 pt-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-4">
            Contact Details
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <CellInput
              id="owner.cellphone"
              label="Cellphone number"
              bilingualHint="(Selfoonnommer)"
              mono
              inputMode="numeric"
              value={owner.cellphone}
              maxLength={ALV_FIELD_CAPACITIES.cellphone}
              placeholder="0825551234"
              onChange={(val) =>
                onUpdateOwner({ cellphone: val.replace(/\D/g, "") })
              }
              error={errors["owner.cellphone"]}
            />
            <CellInput
              id="owner.email"
              label="E-mail address"
              bilingualHint="(E-pos adres)"
              inputMode="email"
              value={owner.email}
              maxLength={ALV_FIELD_CAPACITIES.ownerEmail}
              placeholder="owner@example.co.za"
              onChange={(val) => onUpdateOwner({ email: val })}
              error={errors["owner.email"]}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-5">
            <div className="rounded-md border border-slate-200 bg-slate-50/70 p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-700">
                Telephone at home (optional)
              </p>
              <div className="grid grid-cols-5 gap-2.5">
                <div className="col-span-2">
                  <CellInput
                    id="owner.homePhoneCode"
                    label="Code"
                    mono
                    inputMode="numeric"
                    value={owner.homePhoneCode}
                    maxLength={ALV_FIELD_CAPACITIES.phoneCode}
                    placeholder="011"
                    onChange={(val) =>
                      onUpdateOwner({ homePhoneCode: val.replace(/\D/g, "") })
                    }
                    error={errors["owner.homePhoneCode"]}
                  />
                </div>
                <div className="col-span-3">
                  <CellInput
                    id="owner.homePhoneNumber"
                    label="Number"
                    mono
                    inputMode="numeric"
                    value={owner.homePhoneNumber}
                    maxLength={ALV_FIELD_CAPACITIES.phoneNumber}
                    placeholder="4401234"
                    onChange={(val) =>
                      onUpdateOwner({ homePhoneNumber: val.replace(/\D/g, "") })
                    }
                    error={errors["owner.homePhoneNumber"]}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50/70 p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-700">
                Day contact telephone (optional)
              </p>
              <div className="grid grid-cols-5 gap-2.5">
                <div className="col-span-2">
                  <CellInput
                    id="owner.dayPhoneCode"
                    label="Code"
                    mono
                    inputMode="numeric"
                    value={owner.dayPhoneCode}
                    maxLength={ALV_FIELD_CAPACITIES.phoneCode}
                    placeholder="011"
                    onChange={(val) =>
                      onUpdateOwner({ dayPhoneCode: val.replace(/\D/g, "") })
                    }
                    error={errors["owner.dayPhoneCode"]}
                  />
                </div>
                <div className="col-span-3">
                  <CellInput
                    id="owner.dayPhoneNumber"
                    label="Number"
                    mono
                    inputMode="numeric"
                    value={owner.dayPhoneNumber}
                    maxLength={ALV_FIELD_CAPACITIES.phoneNumber}
                    placeholder="8805678"
                    onChange={(val) =>
                      onUpdateOwner({ dayPhoneNumber: val.replace(/\D/g, "") })
                    }
                    error={errors["owner.dayPhoneNumber"]}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50/70 p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-700">
                Facsimile number (optional)
              </p>
              <div className="grid grid-cols-5 gap-2.5">
                <div className="col-span-2">
                  <CellInput
                    id="owner.faxCode"
                    label="Code"
                    mono
                    inputMode="numeric"
                    value={owner.faxCode}
                    maxLength={ALV_FIELD_CAPACITIES.phoneCode}
                    placeholder="011"
                    onChange={(val) =>
                      onUpdateOwner({ faxCode: val.replace(/\D/g, "") })
                    }
                    error={errors["owner.faxCode"]}
                  />
                </div>
                <div className="col-span-3">
                  <CellInput
                    id="owner.faxNumber"
                    label="Number"
                    mono
                    inputMode="numeric"
                    value={owner.faxNumber}
                    maxLength={ALV_FIELD_CAPACITIES.phoneNumber}
                    placeholder="8805679"
                    onChange={(val) =>
                      onUpdateOwner({ faxNumber: val.replace(/\D/g, "") })
                    }
                    error={errors["owner.faxNumber"]}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
