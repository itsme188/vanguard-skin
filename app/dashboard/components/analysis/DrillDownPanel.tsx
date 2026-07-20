"use client";

/**
 * P3 Slice C — DrillDownPanel.
 *
 * Slide-in panel from the right edge (480px wide on desktop, full-screen on
 * mobile) that renders the holdings list returned by `getHoldingsInBucket`.
 *
 * Mounted by C3 trigger surfaces (classification cells, factor heatmap cells,
 * sector tilt rows, top-N risk button). Owns its own fetch + sort state. The
 * caller controls visibility via `open` + `onClose`; transitioning closed →
 * open re-fetches the data fresh.
 *
 * Privacy-aware: weights via `<Pct>`, market values via `<Money>`. Tickers
 * link to /dashboard/security/[id].
 *
 * TODO (future enhancement): filter chips above the table for client-side
 * refinement (e.g., toggle "AI=High" or "Beta>1" to narrow the result set
 * without a re-fetch). For v1 the header title carries the active filter.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Money, Pct } from "@/lib/privacy/components";
import { SortableHeader } from "../SortableHeader";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";
import {
  FACTOR_LABELS,
  FACTOR_LABELS_SHORT,
  type FactorColumn,
} from "@/lib/factors";
import type { DrillDownRow, DrillDownFilter } from "@/lib/queries/drill-down";

interface Props {
  open: boolean;
  onClose: () => void;
  scope: string;
  filter: DrillDownFilter | null;
}

type SortField =
  | "symbol"
  | "weight"
  | "marketValue"
  | "sector"
  | "ai"
  | "reg"
  | "beta";

export function DrillDownPanel({ open, onClose, scope, filter }: Props) {
  const [rows, setRows] = useState<DrillDownRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sort, setSort } = useSortParam<SortField>(
    "drill",
    "marketValue",
    "desc"
  );

  // Re-fetch when the panel opens or the filter changes. Closed → open
  // reloads fresh data so a user who triggered "Sector: Tech" earlier and
  // re-opens later sees today's holdings + weights, not last week's.
  useEffect(() => {
    if (!open || !filter) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRows([]);

    const params = new URLSearchParams({ scope, kind: filter.kind });
    if (filter.kind === "classification") {
      params.set("dimension", filter.dimension);
      params.set("bucket", filter.bucket);
    } else if (filter.kind === "factor") {
      params.set("factor", filter.factor);
      params.set("bucket", filter.bucket);
    } else if (filter.kind === "sector") {
      params.set("sector", filter.sector);
    } else if (filter.kind === "risk" && filter.topN != null) {
      params.set("topN", String(filter.topN));
    }

    fetch(`/api/analysis/drill-down?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) setRows(data.rows as DrillDownRow[]);
        else setError(data.error ?? "Failed to load drill-down");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, scope, filter]);

  // ESC dismisses the panel. Listener mounted only while open so background
  // pages don't pay the keydown cost.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const sorted = useMemo(() => {
    if (!sort.field) return rows;
    return sortRows(rows, sort.field, sort.dir);
  }, [rows, sort.field, sort.dir]);

  if (!open) return null;

  const title = titleFor(filter, rows.length);

  return (
    <>
      {/* Backdrop — click anywhere outside the panel to dismiss. */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <aside
        className="fixed right-0 top-0 bottom-0 z-50 w-full md:w-[480px] bg-canvas border-l border-edge overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="flex items-center justify-between p-4 border-b border-edge sticky top-0 bg-canvas z-10">
          <h2 className="text-sm font-mono uppercase tracking-wider text-ink">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-faint hover:text-ink p-1 text-lg leading-none"
            aria-label="Close drill-down"
          >
            ×
          </button>
        </header>

        {loading && (
          <div className="p-4 text-xs text-ink-faint font-mono">
            Loading…
          </div>
        )}
        {error && (
          <div className="p-4 text-xs text-down font-mono">{error}</div>
        )}
        {!loading && !error && rows.length === 0 && (
          <div className="p-4 text-xs text-ink-faint font-mono">
            No holdings match this filter.
          </div>
        )}
        {!loading && !error && rows.length > 0 && (
          <table className="w-full text-xs">
            <thead className="bg-panel border-b border-edge text-ink-faint">
              <tr>
                <SortableHeader
                  field="symbol"
                  sort={sort}
                  onSort={setSort}
                >
                  Ticker
                </SortableHeader>
                <SortableHeader
                  field="weight"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                >
                  Weight
                </SortableHeader>
                <SortableHeader
                  field="marketValue"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                >
                  Value
                </SortableHeader>
                <SortableHeader
                  field="sector"
                  sort={sort}
                  onSort={setSort}
                >
                  Sector
                </SortableHeader>
                <SortableHeader field="ai" sort={sort} onSort={setSort}>
                  <span title={FACTOR_LABELS.ai_exposure}>
                    {FACTOR_LABELS_SHORT.ai_exposure}
                  </span>
                </SortableHeader>
                <SortableHeader field="reg" sort={sort} onSort={setSort}>
                  <span title={FACTOR_LABELS.regulatory_risk}>
                    {FACTOR_LABELS_SHORT.regulatory_risk}
                  </span>
                </SortableHeader>
                <SortableHeader
                  field="beta"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                >
                  Beta
                </SortableHeader>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.securityId}
                  className="border-b border-edge/40 hover:bg-panel/30"
                >
                  <td className="px-4 py-2 font-mono">
                    <Link
                      href={`/dashboard/security/${r.securityId}`}
                      className="text-gold-ink hover:underline"
                      onClick={onClose}
                    >
                      {r.symbol}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    <Pct value={r.weight * 100} digits={1} />
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    <Money value={r.marketValue} />
                  </td>
                  <td className="px-4 py-2 text-ink-dim">
                    {r.sector ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-ink-dim">
                    {factorOrDash(r.factors.ai_exposure)}
                  </td>
                  <td className="px-4 py-2 text-ink-dim">
                    {factorOrDash(r.factors.regulatory_risk)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {r.beta != null ? r.beta.toFixed(2) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </aside>
    </>
  );
}

function factorOrDash(v: string | undefined): string {
  return v && v.length > 0 ? v : "—";
}

function titleFor(filter: DrillDownFilter | null, count: number): string {
  if (!filter) return "Drill-down";
  const suffix = `· ${count} holding${count === 1 ? "" : "s"}`;
  if (filter.kind === "classification") {
    return `${prettifyDimension(filter.dimension)}: ${filter.bucket} ${suffix}`;
  }
  if (filter.kind === "factor") {
    const label =
      FACTOR_LABELS[filter.factor as FactorColumn] ?? filter.factor;
    return `${label}: ${filter.bucket} ${suffix}`;
  }
  if (filter.kind === "sector") {
    return `Sector: ${filter.sector} ${suffix}`;
  }
  return `Top ${filter.topN ?? 10} by Risk`;
}

function prettifyDimension(dim: string): string {
  switch (dim) {
    case "sector":
      return "Sector";
    case "fund_category":
      return "Fund Category";
    case "geography":
      return "Geography";
    case "market_cap_category":
      return "Market Cap";
    case "style":
      return "Style";
    case "asset_class":
      return "Asset Class";
    case "security_type":
      return "Security Type";
    default:
      return dim;
  }
}

function sortRows(
  rows: DrillDownRow[],
  field: SortField,
  dir: "asc" | "desc"
): DrillDownRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = sortValue(a, field);
    const bv = sortValue(b, field);
    return compareValues(av, bv, dir);
  });
  return copy;
}

function sortValue(row: DrillDownRow, field: SortField): unknown {
  switch (field) {
    case "symbol":
      return row.symbol;
    case "weight":
      return row.weight;
    case "marketValue":
      return row.marketValue;
    case "sector":
      return row.sector;
    case "ai":
      return row.factors.ai_exposure ?? null;
    case "reg":
      return row.factors.regulatory_risk ?? null;
    case "beta":
      return row.beta;
  }
}
