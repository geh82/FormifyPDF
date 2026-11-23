import {
  ALV_FIELD_CAPACITIES,
  type ALVSubmission,
  type FieldErrorMap,
} from "./types.ts";
import { CellInput, RadioCardGroup, SectionHeader } from "./FormControls.tsx";

interface OrganisationDetailsProps {
  data: ALVSubmission;
  errors: FieldErrorMap;
  onToggleProxy: (enabled: boolean) => void;
  onUpdateProxy: (patch: Partial<NonNullable<ALVSubmission["proxy"]>>) => void;
  onToggleRepresentative: (enabled: boolean) => void;
  onUpdateRepresentative: (
    patch: Partial<NonNullable<ALVSubmission["representative"]>>
  ) => void;
}

const PERSON_ID_OPTIONS = [
  { value: "rsa_id", label: "RSA ID", sublabel: "13-digit SA Identity Number" },
  { value: "traffic_register", label: "Traffic register no.", sublabel: "Verkeersregisternr." },
  { value: "foreign_id", label: "Foreign ID", sublabel: "Buitelandse ID / Passport" },
] as const;

export function OrganisationDetails({
  data,
  errors,
  onToggleProxy,
  onUpdateProxy,
  onToggleRepresentative,
  onUpdateRepresentative,
}: OrganisationDetailsProps) {
  const isBusinessOwner = data.owner.identificationType === "business_reg";
  const proxy = data.proxy || {
    identificationType: "rsa_id" as const,
    identificationNumber: "",
    countryOfIssue: "",
    surname: "",
    initials: "",
  };
  const rep = data.representative || {
    identificationType: "rsa_id" as const,
    identificationNumber: "",
    countryOfIssue: "",
    surname: "",
    initials: "",
  };

  return (
    <div>
      <SectionHeader
        title="3. Organisation's Proxy & Representative"
        afrikaansTitle="Instelling se Gevolmagtigde & Verteenwoordiger"
        description="Complete this section only if the vehicle belongs to an organisation or if an authorised proxy or representative is acting on behalf of the owner."
      />

      {!isBusinessOwner && (
        <div className="mb-6 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Individual vehicle owners who are licensing their own vehicle in person can skip both toggles below and continue directly to Vehicle Details.
        </div>
      )}

      <div className="space-y-8">
        {/* Organisation's Proxy */}
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Organisation's Proxy
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Instelling se Gevolmagtigde — designated natural person acting as proxy for a juristic entity
              </p>
            </div>
            <label className="inline-flex items-center gap-2.5 text-sm font-medium text-slate-800 cursor-pointer min-h-[40px]">
              <input
                type="checkbox"
                checked={data.hasOrganisationProxy}
                onChange={(e) => onToggleProxy(e.target.checked)}
                className="h-4 w-4 rounded accent-emerald-800"
              />
              <span>Include Organisation's Proxy</span>
            </label>
          </div>

          {data.hasOrganisationProxy && (
            <div className="mt-5 pt-5 border-t border-slate-200 space-y-5">
              <RadioCardGroup
                name="proxy-id-type"
                label="Proxy type of identification"
                value={proxy.identificationType}
                options={PERSON_ID_OPTIONS}
                columns={3}
                onChange={(val) =>
                  onUpdateProxy({
                    identificationType: val,
                    countryOfIssue: val === "foreign_id" ? proxy.countryOfIssue : "",
                  })
                }
                error={errors["proxy.identificationType"]}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <CellInput
                  id="proxy.identificationNumber"
                  label="Proxy identification number"
                  required
                  mono
                  uppercase
                  inputMode={proxy.identificationType === "rsa_id" ? "numeric" : "text"}
                  value={proxy.identificationNumber}
                  maxLength={ALV_FIELD_CAPACITIES.proxyIdentificationNumber}
                  placeholder="7901015009089"
                  onChange={(val) =>
                    onUpdateProxy({
                      identificationNumber:
                        proxy.identificationType === "rsa_id"
                          ? val.replace(/\D/g, "")
                          : val,
                    })
                  }
                  error={errors["proxy.identificationNumber"]}
                />
                {proxy.identificationType === "foreign_id" && (
                  <CellInput
                    id="proxy.countryOfIssue"
                    label="Country of issue"
                    required
                    uppercase
                    value={proxy.countryOfIssue}
                    maxLength={ALV_FIELD_CAPACITIES.proxyCountryOfIssue}
                    placeholder="BOTSWANA"
                    onChange={(val) => onUpdateProxy({ countryOfIssue: val })}
                    error={errors["proxy.countryOfIssue"]}
                  />
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
                <div className="md:col-span-3">
                  <CellInput
                    id="proxy.surname"
                    label="Proxy surname"
                    required
                    uppercase
                    value={proxy.surname}
                    maxLength={ALV_FIELD_CAPACITIES.proxySurname}
                    placeholder="NKOSI"
                    onChange={(val) => onUpdateProxy({ surname: val })}
                    error={errors["proxy.surname"]}
                  />
                </div>
                <div className="md:col-span-1">
                  <CellInput
                    id="proxy.initials"
                    label="Initials"
                    required
                    uppercase
                    value={proxy.initials}
                    maxLength={ALV_FIELD_CAPACITIES.proxyInitials}
                    placeholder="TM"
                    onChange={(val) =>
                      onUpdateProxy({ initials: val.replace(/[^A-Za-z]/g, "") })
                    }
                    error={errors["proxy.initials"]}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Organisation's Representative */}
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Organisation's Representative
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Instelling se Verteenwoordiger — authorised representative submitting on behalf of an organisation
              </p>
            </div>
            <label className="inline-flex items-center gap-2.5 text-sm font-medium text-slate-800 cursor-pointer min-h-[40px]">
              <input
                type="checkbox"
                checked={data.hasOrganisationRepresentative}
                onChange={(e) => onToggleRepresentative(e.target.checked)}
                className="h-4 w-4 rounded accent-emerald-800"
              />
              <span>Include Organisation's Representative</span>
            </label>
          </div>

          {data.hasOrganisationRepresentative && (
            <div className="mt-5 pt-5 border-t border-slate-200 space-y-5">
              <RadioCardGroup
                name="rep-id-type"
                label="Representative type of identification"
                value={rep.identificationType}
                options={PERSON_ID_OPTIONS}
                columns={3}
                onChange={(val) =>
                  onUpdateRepresentative({
                    identificationType: val,
                    countryOfIssue: val === "foreign_id" ? rep.countryOfIssue : "",
                  })
                }
                error={errors["representative.identificationType"]}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <CellInput
                  id="representative.identificationNumber"
                  label="Representative identification number"
                  required
                  mono
                  uppercase
                  inputMode={rep.identificationType === "rsa_id" ? "numeric" : "text"}
                  value={rep.identificationNumber}
                  maxLength={ALV_FIELD_CAPACITIES.repIdentificationNumber}
                  placeholder="8203125009083"
                  onChange={(val) =>
                    onUpdateRepresentative({
                      identificationNumber:
                        rep.identificationType === "rsa_id"
                          ? val.replace(/\D/g, "")
                          : val,
                    })
                  }
                  error={errors["representative.identificationNumber"]}
                />
                {rep.identificationType === "foreign_id" && (
                  <CellInput
                    id="representative.countryOfIssue"
                    label="Country of issue"
                    required
                    uppercase
                    value={rep.countryOfIssue}
                    maxLength={ALV_FIELD_CAPACITIES.repCountryOfIssue}
                    placeholder="NAMIBIA"
                    onChange={(val) =>
                      onUpdateRepresentative({ countryOfIssue: val })
                    }
                    error={errors["representative.countryOfIssue"]}
                  />
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
                <div className="md:col-span-3">
                  <CellInput
                    id="representative.surname"
                    label="Representative surname"
                    required
                    uppercase
                    value={rep.surname}
                    maxLength={ALV_FIELD_CAPACITIES.repSurname}
                    placeholder="BOTHA"
                    onChange={(val) => onUpdateRepresentative({ surname: val })}
                    error={errors["representative.surname"]}
                  />
                </div>
                <div className="md:col-span-1">
                  <CellInput
                    id="representative.initials"
                    label="Initials"
                    required
                    uppercase
                    value={rep.initials}
                    maxLength={ALV_FIELD_CAPACITIES.repInitials}
                    placeholder="CL"
                    onChange={(val) =>
                      onUpdateRepresentative({
                        initials: val.replace(/[^A-Za-z]/g, ""),
                      })
                    }
                    error={errors["representative.initials"]}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
