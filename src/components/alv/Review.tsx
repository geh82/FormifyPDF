import { yymmddToIso, type ALVSubmission, type WizardStep } from "./types.ts";

interface ReviewProps {
  data: ALVSubmission;
  onEditStep: (step: WizardStep) => void;
}

function ReviewRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-slate-100 last:border-b-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd
        className={`text-sm text-slate-900 sm:text-right break-words ${
          mono ? "font-mono tabular-nums" : ""
        }`}
      >
        {value && value.trim() !== "" ? value : "—"}
      </dd>
    </div>
  );
}

function formatIdType(type: string): string {
  switch (type) {
    case "rsa_id":
      return "RSA ID";
    case "traffic_register":
      return "Traffic Register No.";
    case "foreign_id":
      return "Foreign ID";
    case "business_reg":
      return "Business Reg. No.";
    default:
      return type;
  }
}

function formatSteering(pos: string): string {
  switch (pos) {
    case "right":
      return "Right (Regs)";
    case "left":
      return "Left (Links)";
    case "centre":
      return "Centre (Middel)";
    case "drawn":
      return "Drawn (Gesleep)";
    default:
      return pos;
  }
}

function formatRole(role: string): string {
  switch (role) {
    case "owner":
      return "Owner (Eienaar)";
    case "organisation_proxy":
      return "Organisation's Proxy";
    case "organisation_representative":
      return "Organisation's Representative";
    default:
      return role;
  }
}

export function Review({ data, onEditStep }: ReviewProps) {
  const street = data.sameAsPostal ? data.postalAddress : data.streetAddress;
  const homeTel = data.owner.homePhoneNumber
    ? `${data.owner.homePhoneCode}-${data.owner.homePhoneNumber}`
    : "";
  const dayTel = data.owner.dayPhoneNumber
    ? `${data.owner.dayPhoneCode}-${data.owner.dayPhoneNumber}`
    : "";
  const faxTel = data.owner.faxNumber
    ? `${data.owner.faxCode}-${data.owner.faxNumber}`
    : "";

  return (
    <div className="mt-8 border-t border-slate-200 pt-8">
      <div className="mb-5">
        <h3 className="text-lg font-semibold text-slate-900">
          Application Review Summary
        </h3>
        <p className="text-sm text-slate-600 mt-1">
          Verify every section below before generating the official ALV PDF. Click Edit on any section to make corrections.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Owner */}
        <section className="rounded-lg border border-slate-200 bg-slate-50/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-slate-900">1. Owner Particulars</h4>
            <button
              type="button"
              onClick={() => onEditStep(1)}
              className="text-xs font-medium text-emerald-800 hover:underline whitespace-nowrap"
            >
              Edit
            </button>
          </div>
          <dl>
            <ReviewRow label="Identification type" value={formatIdType(data.owner.identificationType)} />
            <ReviewRow label="Identification number" value={data.owner.identificationNumber} mono />
            {data.owner.identificationType === "foreign_id" && (
              <ReviewRow label="Country of issue" value={data.owner.countryOfIssue} />
            )}
            <ReviewRow label="Surname / Organisation" value={data.owner.surnameOrOrganisation} />
            {data.owner.identificationType !== "business_reg" && (
              <ReviewRow
                label="Initials & first names"
                value={`${data.owner.initials} — ${data.owner.firstNames}`}
              />
            )}
            <ReviewRow label="Cellphone" value={data.owner.cellphone} mono />
            <ReviewRow label="Email" value={data.owner.email} />
            <ReviewRow label="Home / Day / Fax" value={[homeTel, dayTel, faxTel].filter(Boolean).join(" · ")} mono />
          </dl>
        </section>

        {/* Addresses */}
        <section className="rounded-lg border border-slate-200 bg-slate-50/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-slate-900">2. Addresses & Notices</h4>
            <button
              type="button"
              onClick={() => onEditStep(2)}
              className="text-xs font-medium text-emerald-800 hover:underline whitespace-nowrap"
            >
              Edit
            </button>
          </div>
          <dl>
            <ReviewRow
              label="Postal address"
              value={[
                data.postalAddress.line1,
                data.postalAddress.line2,
                data.postalAddress.suburb,
                data.postalAddress.city,
                data.postalAddress.postalCode,
              ]
                .filter(Boolean)
                .join(", ")}
            />
            <ReviewRow
              label="Street address"
              value={[
                street.line1,
                street.line2,
                street.suburb,
                street.city,
                street.postalCode,
              ]
                .filter(Boolean)
                .join(", ")}
            />
            <ReviewRow
              label="Notices served at"
              value={data.noticesAddress === "postal" ? "Postal address" : "Street address"}
            />
          </dl>
        </section>

        {/* Organisation Proxy & Rep */}
        <section className="rounded-lg border border-slate-200 bg-slate-50/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-slate-900">3. Proxy & Representative</h4>
            <button
              type="button"
              onClick={() => onEditStep(3)}
              className="text-xs font-medium text-emerald-800 hover:underline whitespace-nowrap"
            >
              Edit
            </button>
          </div>
          <dl>
            <ReviewRow
              label="Organisation's proxy"
              value={
                data.hasOrganisationProxy && data.proxy
                  ? `${data.proxy.surname} ${data.proxy.initials} (${formatIdType(data.proxy.identificationType)}: ${data.proxy.identificationNumber})`
                  : "Not applicable"
              }
            />
            <ReviewRow
              label="Organisation's representative"
              value={
                data.hasOrganisationRepresentative && data.representative
                  ? `${data.representative.surname} ${data.representative.initials} (${formatIdType(data.representative.identificationType)}: ${data.representative.identificationNumber})`
                  : "Not applicable"
              }
            />
          </dl>
        </section>

        {/* Vehicle & Declaration */}
        <section className="rounded-lg border border-slate-200 bg-slate-50/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-slate-900">4. Vehicle & Declaration</h4>
            <button
              type="button"
              onClick={() => onEditStep(4)}
              className="text-xs font-medium text-emerald-800 hover:underline whitespace-nowrap"
            >
              Edit Vehicle
            </button>
          </div>
          <dl>
            <ReviewRow label="Licence number" value={data.vehicle.licenceNumber} mono />
            <ReviewRow label="Register number" value={data.vehicle.registerNumber} mono />
            <ReviewRow label="Chassis / VIN" value={data.vehicle.chassisVin} mono />
            <ReviewRow
              label="Make & series"
              value={`${data.vehicle.make} — ${data.vehicle.seriesName}`}
            />
            <ReviewRow
              label="Odometer"
              value={
                data.vehicle.noOdometer
                  ? "No odometer fitted"
                  : data.vehicle.odometerReading
                  ? `${data.vehicle.odometerReading} km`
                  : "Not specified"
              }
              mono={!data.vehicle.noOdometer}
            />
            <ReviewRow
              label="Steering position"
              value={formatSteering(data.vehicle.steeringPosition)}
            />
            <ReviewRow label="Signatory" value={`${data.declaration.signatoryName} (${formatRole(data.declaration.signatoryRole)})`} />
            <ReviewRow
              label="Place & date"
              value={`${data.declaration.place} · ${yymmddToIso(data.declaration.dateYYMMDD)}`}
              mono
            />
          </dl>
        </section>
      </div>
    </div>
  );
}
