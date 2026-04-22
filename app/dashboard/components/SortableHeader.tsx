"use client";

import type { SortState } from "@/lib/hooks/useSortParam";

type Align = "left" | "right";

export function SortableHeader<Field extends string>({
  field,
  sort,
  onSort,
  align = "left",
  className = "",
  children,
}: {
  field: Field;
  sort: SortState<Field>;
  onSort: (field: Field) => void;
  align?: Align;
  className?: string;
  children: React.ReactNode;
}) {
  const isActive = sort.field === field;
  const alignClass = align === "right" ? "text-right justify-end" : "text-left";
  const indicator = isActive ? (sort.dir === "asc" ? "\u2191" : "\u2193") : "";

  return (
    <th
      className={`${alignClass} px-4 py-2.5 font-medium text-xs ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`inline-flex items-center gap-1 transition-colors ${
          isActive ? "text-ink" : "text-ink-faint hover:text-ink-dim"
        } ${align === "right" ? "ml-auto" : ""}`}
      >
        <span>{children}</span>
        <span className="w-2 text-[10px] tabular-nums">{indicator}</span>
      </button>
    </th>
  );
}
