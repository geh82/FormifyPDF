import {
  ALV_FIELD_CAPACITIES,
  type ALVSubmission,
  type FieldErrorMap,
} from "./types.ts";
import { CellInput, RadioCardGroup, SectionHeader } from "./FormControls.tsx";

interface VehicleDetailsProps {
  data: ALVSubmission;
  errors: FieldErrorMap;
  onUpdateVehicle: (patch: Partial<ALVSubmission["vehicle"]>) => void;
}

const STEERING_OPTIONS = [
  { value: "right", label: "Right (Regs)", sublabel: "Standard right-hand drive" },
  { value: "left", label: "Left (Links)", sublabel: "Left-hand drive vehicle" },
  { value: "centre", label: "Centre (Middel)", sublabel: "Centre-mounted steering" },
  { value: "drawn", label: "Drawn (Gesleep)", sublabel: "Trailer / caravan / drawn" },
] as const;

export function VehicleDetails({
  data,
  errors,
  onUpdateVehicle,
}: VehicleDetailsProps) {
  const { vehicle } = data;

  return (
    <div>
      <SectionHeader
        title="4. Identification of Motor Vehicle"
        afrikaansTitle="Identifikasie van Motorvoertuig"
        description="Provide the vehicle's licence plate number, VIN/chassis number, make, series name, odometer reading, and steering-wheel configuration from your current licence disc or registration certificate."
      />

      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <CellInput
            id="vehicle.licenceNumber"
            label="Licence number"
            bilingualHint="(Lisensienommer)"
            required
            mono
            uppercase
            value={vehicle.licenceNumber}
            maxLength={ALV_FIELD_CAPACITIES.licenceNumber}
            placeholder="GP442198"
            onChange={(val) =>
              onUpdateVehicle({
                licenceNumber: val.replace(/[^A-Za-z0-9\s-]/g, ""),
              })
            }
            error={errors["vehicle.licenceNumber"]}
          />
          <CellInput
            id="vehicle.registerNumber"
            label="Vehicle register number"
            bilingualHint="(if available)"
            mono
            uppercase
            value={vehicle.registerNumber}
            maxLength={ALV_FIELD_CAPACITIES.vehicleRegisterNumber}
            placeholder="ABC1234"
            onChange={(val) =>
              onUpdateVehicle({
                registerNumber: val.replace(/[^A-Za-z0-9]/g, ""),
              })
            }
            error={errors["vehicle.registerNumber"]}
          />
          <CellInput
            id="vehicle.chassisVin"
            label="Chassis number / VIN"
            bilingualHint="(Onderstelnommer)"
            required
            mono
            uppercase
            value={vehicle.chassisVin}
            maxLength={ALV_FIELD_CAPACITIES.chassisVin}
            placeholder="WBA3A5C50CF256981"
            onChange={(val) =>
              onUpdateVehicle({
                chassisVin: val.replace(/[^A-Za-z0-9]/g, ""),
              })
            }
            error={errors["vehicle.chassisVin"]}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <CellInput
            id="vehicle.make"
            label="Make"
            bilingualHint="(Fabrikaat)"
            required
            uppercase
            value={vehicle.make}
            maxLength={ALV_FIELD_CAPACITIES.vehicleMake}
            placeholder="TOYOTA"
            onChange={(val) => onUpdateVehicle({ make: val })}
            error={errors["vehicle.make"]}
          />
          <CellInput
            id="vehicle.seriesName"
            label="Series name (describe in full)"
            bilingualHint="(Reeksnaam)"
            required
            uppercase
            value={vehicle.seriesName}
            maxLength={ALV_FIELD_CAPACITIES.seriesName}
            placeholder="COROLLA 1.8 XR CVT"
            onChange={(val) => onUpdateVehicle({ seriesName: val })}
            error={errors["vehicle.seriesName"]}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-end rounded-md border border-slate-200 bg-slate-50/70 p-4">
          <CellInput
            id="vehicle.odometerReading"
            label="Odometer reading (km / hour)"
            bilingualHint="(if available)"
            mono
            inputMode="numeric"
            disabled={vehicle.noOdometer}
            value={vehicle.noOdometer ? "" : vehicle.odometerReading}
            maxLength={ALV_FIELD_CAPACITIES.odometerReading}
            placeholder={vehicle.noOdometer ? "No odometer" : "124500"}
            onChange={(val) =>
              onUpdateVehicle({ odometerReading: val.replace(/\D/g, "") })
            }
            error={errors["vehicle.odometerReading"]}
          />

          <label className="inline-flex items-center gap-2.5 rounded-md border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 cursor-pointer min-h-[42px]">
            <input
              type="checkbox"
              checked={vehicle.noOdometer}
              onChange={(e) =>
                onUpdateVehicle({
                  noOdometer: e.target.checked,
                  odometerReading: e.target.checked ? "" : vehicle.odometerReading,
                })
              }
              className="h-4 w-4 rounded accent-emerald-800"
            />
            <span>No odometer fitted (Geen odometer)</span>
          </label>
        </div>

        <RadioCardGroup
          name="steering-position"
          label="Position of steering wheel"
          bilingualHint="(Posisie van stuurwiel)"
          value={vehicle.steeringPosition}
          options={STEERING_OPTIONS}
          columns={4}
          onChange={(val) => onUpdateVehicle({ steeringPosition: val })}
          error={errors["vehicle.steeringPosition"]}
        />
      </div>
    </div>
  );
}
