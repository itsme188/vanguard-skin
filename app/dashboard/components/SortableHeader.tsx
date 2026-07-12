"use client";

import type { SortState } from "@/lib/hooks/useSortParam";

type Align = "left" | "right";

export function SortableHeader<Field extends string>({
  field,
  sort,
  onSort,
  align = "left",
  className = "",
  variant = "default",
  children,
}: {
  field: Field;
  sort: SortState<Field>;
  onSort: (field: Field) => void;
  align?: Align;
  className?: string;
  /** "terminal" opts into the Bloomberg-style uppercase mono header used in MarketDataPanel. */
  variant?: "default" | "terminal";
  children: React.ReactNode;
}) {
  const isActive = sort.field === field;
  const alignClass = align === "right" ? "text-right justify-end" : "text-left";
  const indicator = isActive ? (sort.dir === "asc" ? "\u2191" : "\u2193") : "";

  if (variant === "terminal") {
    return (
      <th
        className={`${alignClass} ${className}`}
        style={{
          padding: "10px 20px",
          background: "#0a0a0a",
          borderBottom: "1px solid #1f1f1f",
        }}
      >
        <button
          type="button"
          onClick={() => onSort(field)}
          className={`relative inline-flex items-center gap-1 transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-[''] ${align === "right" ? "ml-auto" : ""}`}
          style={{
            fontFamily: "var(--font-mono), monospace",
            fontSize: "10px",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontWeight: 400,
            color: isActive ? "#eee" : "#888",
          }}
        >
          <span>{children}</span>
          <span style={{ width: "8px", fontSize: "10px" }}>{indicator}</span>
        </button>
      </th>
    );
  }

  return (
    <th
      className={`${alignClass} px-4 py-2.5 font-medium text-xs ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`relative inline-flex items-center gap-1 transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-[''] ${
          isActive ? "text-ink" : "text-ink-faint hover:text-ink-dim"
        } ${align === "right" ? "ml-auto" : ""}`}
      >
        <span>{children}</span>
        <span className="w-2 text-[10px] tabular-nums">{indicator}</span>
      </button>
    </th>
  );
}
