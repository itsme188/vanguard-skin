"use client";

import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
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
      {/* chart-chrome / chart-status-gold: no effect on a light surface. Inside
          the always-dark chart module (the Levels list on a security page)
          they swap the light theme's dark ink, which measured 2.68:1 (label)
          and 2.10:1 (active pill) on near-black, for the module's own. */}
      <span className="chart-chrome text-[11px] text-ink-faint mr-1">{label}</span>
      {options.map((opt) => {
        const active = sort.field === opt.field;
        const indicator = active ? (sort.dir === "asc" ? " \u2191" : " \u2193") : "";
        return (
          <button
            key={opt.field}
            type="button"
            onClick={() => onSort(opt.field)}
            className={`relative px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-0.5 ${
              active
                ? `chart-status-gold ${CHIP_TONE_CLASSES.gold}`
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
