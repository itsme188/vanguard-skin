"use client";

import { useRouter, useSearchParams } from "next/navigation";

function FilterPills({
  paramName,
  options,
  currentValue,
  ariaLabel,
}: {
  paramName: string;
  options: { label: string; value: string }[];
  currentValue: string;
  ariaLabel?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "") {
      params.delete(paramName);
    } else {
      params.set(paramName, value);
    }
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={ariaLabel ?? paramName}>
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => handleChange(opt.value)}
          aria-pressed={opt.value === currentValue}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap focus-ring ${
            opt.value === currentValue
              ? "bg-gold/20 text-gold"
              : "text-ink-dim hover:text-ink hover:bg-panel"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function YearSelector({
  years,
  currentYear,
}: {
  years: number[];
  currentYear: number;
}) {
  return (
    <FilterPills
      paramName="year"
      options={years.map((y) => ({ label: String(y), value: String(y) }))}
      currentValue={String(currentYear)}
      ariaLabel="Tax year"
    />
  );
}

export function AccountSelector({
  accounts,
  currentAccount,
}: {
  accounts: string[];
  currentAccount: string;
}) {
  const options = [
    { label: "All", value: "" },
    ...accounts.map((a) => ({ label: a, value: a })),
  ];

  return (
    <FilterPills
      paramName="account"
      options={options}
      currentValue={currentAccount}
      ariaLabel="Account filter"
    />
  );
}
