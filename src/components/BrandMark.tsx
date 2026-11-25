export function BrandMark({
  size = 28,
  variant = "light",
}: {
  size?: number;
  variant?: "light" | "dark";
}) {
  const bodyFill = variant === "dark" ? "#10B981" : "#064E3B";
  const foldFill = variant === "dark" ? "#34D399" : "#047857";
  const linePrimary = variant === "dark" ? "#052E24" : "#ECFDF5";
  const lineSecondary = variant === "dark" ? "#064E3B" : "#A7F3D0";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M5 3.5C5 2.67157 5.67157 2 6.5 2H17.3787C17.7765 2 18.158 2.15804 18.4393 2.43934L22.5607 6.56066C22.842 6.84196 23 7.2235 23 7.62132V24.5C23 25.3284 22.3284 26 21.5 26H6.5C5.67157 26 5 25.3284 5 24.5V3.5Z"
        fill={bodyFill}
      />
      <path
        d="M17.5 2.2V6.5C17.5 7.05228 17.9477 7.5 18.5 7.5H22.8"
        fill={foldFill}
      />
      <rect x="8.5" y="10.5" width="11" height="2.2" rx="1" fill={linePrimary} />
      <rect x="8.5" y="15" width="7" height="2.2" rx="1" fill={lineSecondary} />
      <rect x="17.2" y="14.8" width="2.5" height="2.5" rx="0.6" fill="#F59E0B" />
      <rect x="8.5" y="19.5" width="11" height="2.2" rx="1" fill={linePrimary} />
    </svg>
  );
}

export function BrandWordmark({
  size = 28,
  variant = "light",
}: {
  size?: number;
  variant?: "light" | "dark";
}) {
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap shrink-0">
      <BrandMark size={size} variant={variant} />
      <span
        className={`text-[17px] font-bold tracking-tight leading-none ${
          variant === "dark" ? "text-white" : "text-slate-900"
        }`}
      >
        Formify
        <span className={variant === "dark" ? "text-emerald-400" : "text-emerald-900"}>
          PDF
        </span>
      </span>
    </span>
  );
}
