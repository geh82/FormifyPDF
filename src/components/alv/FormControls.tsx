import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface CellInputProps {
  id: string;
  label: string;
  bilingualHint?: string;
  value: string;
  maxLength: number;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  mono?: boolean;
  uppercase?: boolean;
  inputMode?: "text" | "numeric" | "email" | "tel";
  helpText?: string;
}

export function CellInput({
  id,
  label,
  bilingualHint,
  value,
  maxLength,
  onChange,
  error,
  placeholder,
  required = false,
  disabled = false,
  mono = false,
  uppercase = false,
  inputMode = "text",
  helpText,
}: CellInputProps) {
  const count = value.length;
  const nearLimit = count >= maxLength;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-slate-800">
          {label}
          {required && <span className="ml-1 text-red-600" aria-hidden="true">*</span>}
          {bilingualHint && (
            <span className="ml-1.5 text-xs font-normal text-slate-500">
              {bilingualHint}
            </span>
          )}
        </label>
        <span
          className={`font-mono text-xs tabular-nums shrink-0 ${
            nearLimit ? "text-amber-700 font-medium" : "text-slate-400"
          }`}
        >
          {count}/{maxLength} boxes
        </span>
      </div>
      <input
        id={id}
        name={id}
        type={inputMode === "email" ? "email" : "text"}
        inputMode={inputMode}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : helpText ? `${id}-help` : undefined}
        onChange={(e) => {
          const next = uppercase ? e.target.value.toUpperCase() : e.target.value;
          onChange(next.slice(0, maxLength));
        }}
        className={`w-full min-h-[42px] rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-800/25 ${
          mono || uppercase ? "font-mono tracking-wide" : ""
        } ${
          disabled
            ? "bg-slate-100 text-slate-500 border-slate-200 cursor-not-allowed"
            : error
            ? "bg-white text-slate-900 border-red-500 focus-visible:border-red-600"
            : "bg-white text-slate-900 border-slate-300 hover:border-slate-400 focus-visible:border-emerald-800"
        }`}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="flex items-center gap-1.5 text-xs font-medium text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : helpText ? (
        <p id={`${id}-help`} className="text-xs text-slate-500">
          {helpText}
        </p>
      ) : null}
    </div>
  );
}

interface OptionItem<T extends string> {
  value: T;
  label: string;
  sublabel?: string;
}

interface RadioCardGroupProps<T extends string> {
  name: string;
  label: string;
  bilingualHint?: string;
  value: T;
  options: readonly OptionItem<T>[];
  onChange: (val: T) => void;
  error?: string;
  columns?: 2 | 3 | 4;
}

export function RadioCardGroup<T extends string>({
  name,
  label,
  bilingualHint,
  value,
  options,
  onChange,
  error,
  columns = 4,
}: RadioCardGroupProps<T>) {
  const gridClass =
    columns === 2
      ? "grid-cols-1 sm:grid-cols-2"
      : columns === 3
      ? "grid-cols-1 sm:grid-cols-3"
      : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4";

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-slate-800 mb-1">
        {label}
        <span className="ml-1 text-red-600" aria-hidden="true">*</span>
        {bilingualHint && (
          <span className="ml-1.5 text-xs font-normal text-slate-500">
            {bilingualHint}
          </span>
        )}
      </legend>
      <div className={`grid ${gridClass} gap-2.5`}>
        {options.map((opt) => {
          const selected = value === opt.value;
          return (
            <label
              key={opt.value}
              className={`flex items-start gap-2.5 rounded-md border p-3 cursor-pointer transition-colors min-h-[44px] ${
                selected
                  ? "border-emerald-800 bg-emerald-50/60 text-slate-900"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              }`}
            >
              <input
                type="radio"
                name={name}
                value={opt.value}
                checked={selected}
                onChange={() => onChange(opt.value)}
                className="mt-0.5 h-4 w-4 accent-emerald-800 shrink-0"
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium leading-snug">{opt.label}</span>
                {opt.sublabel && (
                  <span className="text-xs text-slate-500 mt-0.5">{opt.sublabel}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-xs font-medium text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </fieldset>
  );
}

export function SectionHeader({
  title,
  afrikaansTitle,
  description,
}: {
  title: string;
  afrikaansTitle?: string;
  description: string;
}) {
  return (
    <div className="border-b border-slate-200 pb-4 mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold text-slate-900 tracking-tight">{title}</h2>
        {afrikaansTitle && (
          <span className="text-xs font-medium text-slate-500">{afrikaansTitle}</span>
        )}
      </div>
      <p className="mt-1.5 text-sm text-slate-600 leading-relaxed max-w-3xl">
        {description}
      </p>
    </div>
  );
}

export function ModalDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
    >
      <div className="w-full max-w-xl rounded-lg border border-slate-200 bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h3 id="modal-dialog-title" className="text-base font-semibold text-slate-900">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 whitespace-nowrap"
          >
            Close
          </button>
        </div>
        <div className="px-6 py-5 text-sm text-slate-700 leading-relaxed max-h-[75vh] overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
