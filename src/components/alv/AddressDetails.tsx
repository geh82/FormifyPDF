import {
  ALV_FIELD_CAPACITIES,
  type ALVSubmission,
  type FieldErrorMap,
} from "./types.ts";
import { CellInput, RadioCardGroup, SectionHeader } from "./FormControls.tsx";

interface AddressDetailsProps {
  data: ALVSubmission;
  errors: FieldErrorMap;
  onUpdatePostal: (patch: Partial<ALVSubmission["postalAddress"]>) => void;
  onUpdateStreet: (patch: Partial<ALVSubmission["streetAddress"]>) => void;
  onToggleSameAsPostal: (same: boolean) => void;
  onChangeNoticesAddress: (val: ALVSubmission["noticesAddress"]) => void;
}

const NOTICES_OPTIONS = [
  {
    value: "postal",
    label: "Postal address",
    sublabel: "Posadres — serve licensing notices to postal address",
  },
  {
    value: "street",
    label: "Street address",
    sublabel: "Straatadres — serve licensing notices to physical address",
  },
] as const;

export function AddressDetails({
  data,
  errors,
  onUpdatePostal,
  onUpdateStreet,
  onToggleSameAsPostal,
  onChangeNoticesAddress,
}: AddressDetailsProps) {
  const streetValues = data.sameAsPostal ? data.postalAddress : data.streetAddress;

  return (
    <div>
      <SectionHeader
        title="2. Postal & Street Address Details"
        afrikaansTitle="Posadres & Straatadres"
        description="Complete both your postal and physical street addresses, then choose where official vehicle licensing notices must be served."
      />

      <div className="space-y-8">
        {/* Postal Address */}
        <div>
          <h3 className="text-sm font-semibold text-slate-900 mb-4">
            Postal Address (Posadres)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <CellInput
              id="postalAddress.line1"
              label="Address line 1"
              required
              uppercase
              value={data.postalAddress.line1}
              maxLength={ALV_FIELD_CAPACITIES.addressLine1}
              placeholder="PO BOX 1420"
              onChange={(val) => onUpdatePostal({ line1: val })}
              error={errors["postalAddress.line1"]}
            />
            <CellInput
              id="postalAddress.line2"
              label="Address line 2"
              uppercase
              value={data.postalAddress.line2}
              maxLength={ALV_FIELD_CAPACITIES.addressLine2}
              placeholder="PRIVATE BAG OR SUITE"
              onChange={(val) => onUpdatePostal({ line2: val })}
              error={errors["postalAddress.line2"]}
            />
            <CellInput
              id="postalAddress.suburb"
              label="Suburb"
              bilingualHint="(Voorstad)"
              uppercase
              value={data.postalAddress.suburb}
              maxLength={ALV_FIELD_CAPACITIES.addressSuburb}
              placeholder="SANDTON"
              onChange={(val) => onUpdatePostal({ suburb: val })}
              error={errors["postalAddress.suburb"]}
            />
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <CellInput
                  id="postalAddress.city"
                  label="City / Town"
                  bilingualHint="(Stad/Dorp)"
                  required
                  uppercase
                  value={data.postalAddress.city}
                  maxLength={ALV_FIELD_CAPACITIES.addressCity}
                  placeholder="JOHANNESBURG"
                  onChange={(val) => onUpdatePostal({ city: val })}
                  error={errors["postalAddress.city"]}
                />
              </div>
              <div className="col-span-1">
                <CellInput
                  id="postalAddress.postalCode"
                  label="Postal code"
                  required
                  mono
                  inputMode="numeric"
                  value={data.postalAddress.postalCode}
                  maxLength={ALV_FIELD_CAPACITIES.postalCode}
                  placeholder="2146"
                  onChange={(val) =>
                    onUpdatePostal({ postalCode: val.replace(/\D/g, "") })
                  }
                  error={errors["postalAddress.postalCode"]}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Street Address */}
        <div className="border-t border-slate-200 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Street Address (Straatadres)
            </h3>
            <label className="inline-flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer select-none min-h-[40px]">
              <input
                type="checkbox"
                checked={data.sameAsPostal}
                onChange={(e) => onToggleSameAsPostal(e.target.checked)}
                className="h-4 w-4 rounded accent-emerald-800"
              />
              <span>Street address is the same as postal address</span>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <CellInput
              id="streetAddress.line1"
              label="Address line 1"
              required
              uppercase
              disabled={data.sameAsPostal}
              value={streetValues.line1}
              maxLength={ALV_FIELD_CAPACITIES.addressLine1}
              placeholder="42 RIVONIA ROAD"
              onChange={(val) => onUpdateStreet({ line1: val })}
              error={errors["streetAddress.line1"]}
            />
            <CellInput
              id="streetAddress.line2"
              label="Address line 2"
              uppercase
              disabled={data.sameAsPostal}
              value={streetValues.line2}
              maxLength={ALV_FIELD_CAPACITIES.addressLine2}
              placeholder="BUILDING OR UNIT"
              onChange={(val) => onUpdateStreet({ line2: val })}
              error={errors["streetAddress.line2"]}
            />
            <CellInput
              id="streetAddress.suburb"
              label="Suburb"
              bilingualHint="(Voorstad)"
              required
              uppercase
              disabled={data.sameAsPostal}
              value={streetValues.suburb}
              maxLength={ALV_FIELD_CAPACITIES.addressSuburb}
              placeholder="SANDHURST"
              onChange={(val) => onUpdateStreet({ suburb: val })}
              error={errors["streetAddress.suburb"]}
            />
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <CellInput
                  id="streetAddress.city"
                  label="City / Town"
                  bilingualHint="(Stad/Dorp)"
                  required
                  uppercase
                  disabled={data.sameAsPostal}
                  value={streetValues.city}
                  maxLength={ALV_FIELD_CAPACITIES.addressCity}
                  placeholder="JOHANNESBURG"
                  onChange={(val) => onUpdateStreet({ city: val })}
                  error={errors["streetAddress.city"]}
                />
              </div>
              <div className="col-span-1">
                <CellInput
                  id="streetAddress.postalCode"
                  label="Postal code"
                  required
                  mono
                  inputMode="numeric"
                  disabled={data.sameAsPostal}
                  value={streetValues.postalCode}
                  maxLength={ALV_FIELD_CAPACITIES.postalCode}
                  placeholder="2196"
                  onChange={(val) =>
                    onUpdateStreet({ postalCode: val.replace(/\D/g, "") })
                  }
                  error={errors["streetAddress.postalCode"]}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Address where notices must be served */}
        <div className="border-t border-slate-200 pt-6">
          <RadioCardGroup
            name="notices-address"
            label="Address where notices must be served"
            bilingualHint="(Adres waar kennisgewings beteken moet word)"
            value={data.noticesAddress}
            options={NOTICES_OPTIONS}
            columns={2}
            onChange={onChangeNoticesAddress}
            error={errors["noticesAddress"]}
          />
        </div>
      </div>
    </div>
  );
}
