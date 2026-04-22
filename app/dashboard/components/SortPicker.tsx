"use client";

import type { SortState } from "@/lib/hooks/useSortParam";

export type SortOption<Field extends string> = {
  field: Field;
  label: string;
};

/**
 * Pill-row sort picker for card-list UIs (where column-header sort doesn't
 * apply). Pairs with useSortParam — click a pill to activate that field,
 * click the active pill again to flip direction.
 */
export function SortPicker<Field extends string>({
  options,
  sort,
  onSort,
  label = "Sort:",
}: {
  options: SortOption<Field>[];
  sort: SortState<Field>;
  onSort: (field: Field) => void;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] text-ink-faint mr-1">{label}</span>
      {options.map((opt) => {
        const active = sort.field === opt.field;
        const indicator = active ? (sort.dir === "asc" ? " \u2191" : " \u2193") : "";
        return (
          <button
            key={opt.field}
            type="button"
            onClick={() => onSort(opt.field)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
              active
                ? "bg-gold/20 text-gold"
                : "bg-raised text-ink-dim hover:text-ink"
            }`}
          >
            {opt.label}
            <span className="tabular-nums">{indicator}</span>
          </button>
        );
      })}
    </div>
  );
}
