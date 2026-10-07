"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatUSDPrecise } from "@/lib/format";
import { formatChartPrice } from "@/lib/chart/price-formatter";
import { SecurityChart } from "./SecurityChart";
import { MultiChart } from "./MultiChart";
import { EmptySection } from "./EmptySection";
import {
  readLastChartSymbolId,
  writeLastChartSymbolId,
} from "../charts/last-symbol";

interface ChartableSecurity {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  currency: string | null;
}

type ViewMode = "single" | "multi";

/** An `?id=` that was asked for and cannot be charted (page.tsx builds it). */
export interface UnavailableChartRequest {
  /** null when no security matches the id at all. */
  securityId: number | null;
  symbol: string | null;
  reason: "no_contract" | "mutual_fund" | "not_found";
}

/** Empty-state copy for a chart request the page cannot serve. */
export function unavailableChartCopy(req: UnavailableChartRequest): {
  title: string;
  reason: string;
  hubHref: string | null;
} {
  if (req.securityId == null || req.symbol == null) {
    return {
      title: "Security not found",
      reason:
        "This link points at a security that is not in the book. Pick a security above.",
      hubHref: null,
    };
  }
  return {
    title: `No chart for ${req.symbol}`,
    reason:
      req.reason === "mutual_fund"
        ? `${req.symbol} is a mutual fund, and mutual funds have no traded price history to chart. Pick a security above.`
        : `${req.symbol} has no IBKR contract id yet, so there is no price history to chart. Pick a security above.`,
    hubHref: `/dashboard/security/${req.securityId}`,
  };
}

/**
 * Header close for the single chart. Public market data: plain formatters,
 * never a privacy wrapper.
 *
 * `usd` is the close converted at the stored rate; `native` is the same
 * prices row unconverted — the frame the chart's axis and last-price badge
 * use. For a foreign security both are shown, the native one with its
 * currency code, so the two prices on the page reconcile. When the two are
 * equal for a foreign currency there is no usable rate (a missing rate
 * reads as 1.0), so only the native figure is shown: a dollar sign on a
 * native magnitude would be a wrong number.
 */
export function chartHeaderPrice(
  usd: number,
  native: number | null,
  currency: string | null,
): { primary: string; native: string | null } {
  const code = (currency ?? "").trim().toUpperCase();
  if (code === "" || code === "USD" || native == null) {
    return { primary: formatUSDPrecise(usd), native: null };
  }
  const nativeLabel = `${formatChartPrice(code, native)} ${code}`;
  if (usd === native) return { primary: nativeLabel, native: null };
  return { primary: formatUSDPrecise(usd), native: nativeLabel };
}

export function ChartsView({
  securities,
  initialSecurity,
  initialPrice,
  initialPriceNative,
  hasExplicitId,
  arrivedSecurityId,
  unavailableRequest,
  watchlistSecurityIds,
}: {
  securities: ChartableSecurity[];
  initialSecurity: ChartableSecurity | null;
  initialPrice: { close_price: number; date: string } | null;
  /** The same close in the security's own currency (null = no price row). */
  initialPriceNative: number | null;
  hasExplicitId: boolean;
  /** The `?id=` when it resolved to a chartable security, else null. */
  arrivedSecurityId: number | null;
  unavailableRequest: UnavailableChartRequest | null;
  /** Active watchlist security ids, in watchlist order. */
  watchlistSecurityIds: number[];
}) {
  const router = useRouter();
  // A request the page cannot chart starts with NOTHING selected — the
  // empty state names it — rather than the default security.
  const [selected, setSelected] = useState<ChartableSecurity | null>(
    unavailableRequest ? null : initialSecurity,
  );
  const [viewMode, setViewMode] = useState<ViewMode>("single");

  const handleSelect = (secId: number) => {
    const sec = securities.find((s) => s.id === secId);
    if (sec) {
      setSelected(sec);
      writeLastChartSymbolId(secId);
      router.replace(`/dashboard/charts?id=${secId}`, { scroll: false });
    }
  };

  // Charts-landing precedence (user ruling, 2026-09-11), RULE 1 — the
  // highest-priority default: restore the last-viewed symbol whenever one
  // is stored, overriding the largest-held pick the server rendered. Done
  // client-side because localStorage isn't readable on the server, which is
  // also why a bare visit briefly shows the server's held-position chart
  // before this swap (see last-symbol.ts on why that flash is kept).
  //
  // ONLY when the URL carried no explicit ?id= — an explicit id is not a
  // default and always wins. Runs once on mount, never during render, to
  // avoid a hydration mismatch against the server-rendered
  // `initialSecurity`.
  useEffect(() => {
    if (hasExplicitId) return;
    const lastId = readLastChartSymbolId();
    if (lastId == null || lastId === selected?.id) return;
    const sec = securities.find((s) => s.id === lastId);
    if (!sec) return; // stale/garbage id (security deleted or unenriched since) — ignore
    setSelected(sec);
    router.replace(`/dashboard/charts?id=${lastId}`, { scroll: false });
    // Deliberately mount-only: this is a one-time "restore last view"
    // check, not a live sync with localStorage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Record the arrival (ruling 2026-09-11, "last viewed first"): any way of
  // landing on a chart counts — a symbol link, a ticker jump, the picker's
  // own URL round-trip — not only the picker's onChange. Keyed on the id the
  // server resolved from `?id=`, so a bare visit (the server's default pick)
  // and a request that cannot be charted record nothing. Declared after the
  // restore above, so a bare visit reads before anything writes.
  useEffect(() => {
    if (arrivedSecurityId == null) return;
    writeLastChartSymbolId(arrivedSecurityId);
  }, [arrivedSecurityId]);

  const headerPrice =
    initialPrice && selected && selected.id === initialSecurity?.id
      ? chartHeaderPrice(
          initialPrice.close_price,
          initialPriceNative,
          selected.currency,
        )
      : null;
  const unavailableCopy =
    unavailableRequest && !selected
      ? unavailableChartCopy(unavailableRequest)
      : null;

  if (securities.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-12 text-center">
        <p className="text-ink-faint text-sm">
          No chartable securities. Run Enrich Securities to populate IB contract
          IDs.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* View mode toggle */}
      {/* flex-wrap + min-w-0: at 390px the toggle (~140px) + 320px-capped
          select exceeded the viewport (deep-QA horizontal-overflow finding). */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <div className="flex gap-0.5 bg-raised rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("single")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === "single" ? "bg-panel text-gold-ink" : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              Single
            </button>
            <button
              onClick={() => setViewMode("multi")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                viewMode === "multi" ? "bg-panel text-gold-ink" : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              Watchlist
            </button>
          </div>

          {/* Single mode: security picker */}
          {viewMode === "single" && (
            <select
              value={selected?.id ?? ""}
              onChange={(e) => handleSelect(Number(e.target.value))}
              className="bg-raised border border-edge rounded-lg px-3 py-2 text-sm font-mono
                text-ink focus:outline-none focus:ring-1 focus:ring-gold max-w-[60vw] sm:max-w-xs truncate"
            >
              {!selected && (
                <option value="" disabled>
                  Choose a security
                </option>
              )}
              {securities.map((sec) => (
                <option key={sec.id} value={sec.id}>
                  {sec.symbol}
                  {sec.name ? ` \u2014 ${sec.name}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Price info (single mode only) */}
        {viewMode === "single" && initialPrice && headerPrice && (
          <div className="text-right">
            <span className="font-mono text-lg text-ink tabular-nums block">
              {headerPrice.primary}
            </span>
            {headerPrice.native && (
              <span className="font-mono text-xs text-ink-dim tabular-nums block">
                {headerPrice.native}
              </span>
            )}
            <div className="text-xs text-ink-faint">
              as of {initialPrice.date}
            </div>
          </div>
        )}
      </div>

      {/* Chart content */}
      {viewMode === "single" ? (
        selected ? (
          <div className="rounded-xl border border-edge bg-panel overflow-hidden h-[400px] md:h-[600px]">
            <SecurityChart
              key={selected.id}
              securityId={selected.id}
              symbol={selected.symbol}
              currency={selected.currency}
              securityType={selected.security_type}
            />
          </div>
        ) : (
          unavailableRequest &&
          unavailableCopy && (
            <div className="space-y-2">
              <EmptySection
                title={unavailableCopy.title}
                reason={unavailableCopy.reason}
              />
              {unavailableCopy.hubHref && (
                <Link
                  href={unavailableCopy.hubHref}
                  className="inline-block text-sm text-gold-ink hover:underline"
                >
                  Back to {unavailableRequest.symbol}
                </Link>
              )}
            </div>
          )
        )
      ) : (
        <MultiChart
          securities={securities}
          initialSecurityId={selected?.id ?? null}
          watchlistIds={watchlistSecurityIds}
        />
      )}
    </div>
  );
}
