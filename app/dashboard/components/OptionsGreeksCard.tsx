"use client";

import { useState, useEffect, type ReactNode } from "react";
import type { PortfolioGreeks, PositionGreeks, GreeksDiagnostic } from "@/lib/compute/options-greeks";
import { PrivateText, Count } from "@/lib/privacy/components";
import { formatUSDPrecise, rendersAsZero } from "@/lib/format";
import { formatOptionExpiry } from "@/lib/format/option-expiry";
import { EmptySection } from "./EmptySection";
import { LoadFailedSection } from "./LoadFailedSection";
import { ScrollFade } from "./ScrollFade";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { SortableHeader } from "./SortableHeader";
import { useSortParam, compareValues, type SortState } from "@/lib/hooks/useSortParam";
import {
  interpretDelta,
  interpretGamma,
  interpretTheta,
  interpretVega,
  toneClass,
  type Interpretation,
} from "@/lib/analysis/interpret";

/**
 * Portfolio-level Greeks summary + per-position Greeks table.
 * Only renders if the portfolio has option positions.
 */
export function OptionsGreeksCard({ scope }: { scope?: string }) {
  const [data, setData] = useState<PortfolioGreeks | null>(null);
  const [loading, setLoading] = useState(true);
  // No sort param = the compute's own order (nearest expiry first).
  const { sort, setSort } = useSortParam<GreeksSortField>("greeks", null, "desc");

  // A load that failed is not "no options": the card says the figures could
  // not be loaded instead of showing the empty state.
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = scope && scope !== "all" ? `?scope=${scope}` : "";
    fetch(`/api/compute/options-greeks${params}`)
      .then((res) => readMutationResult<{ data?: PortfolioGreeks }>(res))
      .then((result) => {
        if (cancelled) return;
        if (!result.ok || !result.data.data) {
          setData(null);
          setLoadError(
            `Couldn't load the option Greeks: ${
              result.ok ? "the server sent no data." : result.message
            }`,
          );
          return;
        }
        setLoadError(null);
        const loaded = result.data.data;
        setData(Array.isArray(loaded.positions) && loaded.positions.length > 0 ? loaded : null);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setLoadError(networkFailureMessage("load the option Greeks"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  if (loading) return null;
  if (loadError) {
    return (
      <LoadFailedSection
        title="Options Greeks"
        message={loadError}
        hint="The option positions themselves are unchanged. Reload the page to try again."
      />
    );
  }
  if (!data) {
    return (
      <EmptySection
        title="Options Greeks"
        reason="No option positions in this scope."
        hint="Greeks (delta, gamma, theta, vega) appear once you hold call or put options. Open an options trade in IBKR or Vanguard to see this section populate."
      />
    );
  }

  // Coverage gate: computedPositions is the count of positions whose Greeks
  // actually solved (greeks !== null); totalPositions is every option row
  // considered. When NOTHING priced, the raw totals are all still 0 (their
  // initialization value, never touched by the loop) — showing them as "Net
  // Delta 0.0 / delta-neutral" would turn "we don't know" into an affirmative
  // risk claim. See the diagnostics block below for WHY each position failed.
  const noCoverage = data.totalPositions > 0 && data.computedPositions === 0;
  const partialCoverage = !noCoverage && data.computedPositions < data.totalPositions;
  // totalPositions counts LIVE contracts only. A scope holding nothing but
  // expired contracts has no Greeks to state at all: the tiles are withheld
  // (their zeros are untouched initializers) and the card says why.
  const allExpired = data.totalPositions === 0;
  const fallbackVolCount = data.fallbackVolPositions ?? 0;
  const unpricedCount = data.unpricedPositions ?? 0;
  const expiredCount = data.expiredPositions ?? 0;
  const footnote = greeksFootnoteGroups(data);
  const rows = sortGreeksPositions(data.positions, sort);
  const anyUnstableIv = data.positions.some(isIvSolveUnstable);
  const hasSnapshotVol = data.positions.some((p) => p.greeks?.ivSource === "ibkr");
  const hasDefaultVol = data.positions.some((p) => p.greeks?.ivSource === "default");

  return (
    <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-4">
      <h3 className="text-sm font-medium text-ink">Options Greeks</h3>

      {/* Portfolio-level summary */}
      {allExpired && (
        <p className="text-xs text-ink-faint">
          Every option position in this scope has expired — there are no live Greeks to show.
        </p>
      )}
      {!allExpired && (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCell
          label="Net Delta"
          value={noCoverage ? <span className="text-ink-dim">—</span> : <PrivateText>{formatNum(data.totalDelta)}</PrivateText>}
          description="Share-equivalents"
          color={noCoverage ? "text-ink-dim" : (data.totalDelta ?? 0) > 0 ? "text-up" : (data.totalDelta ?? 0) < 0 ? "text-down" : "text-ink"}
          interp={noCoverage ? undefined : interpretDelta(data.totalDelta ?? 0)}
        />
        <MetricCell
          label="Net Gamma"
          value={noCoverage ? <span className="text-ink-dim">—</span> : <PrivateText>{formatNum(data.totalGamma)}</PrivateText>}
          description="Per $1 move"
          color={noCoverage ? "text-ink-dim" : "text-ink"}
          interp={noCoverage ? undefined : interpretGamma(data.totalGamma ?? 0)}
        />
        <MetricCell
          label="Daily Theta"
          value={noCoverage ? <span className="text-ink-dim">—</span> : <PrivateText>{formatDollar(data.totalTheta)}</PrivateText>}
          description="Time decay / day"
          color={noCoverage ? "text-ink-dim" : "text-down"}
          interp={noCoverage ? undefined : interpretTheta(data.totalTheta ?? 0)}
        />
        <MetricCell
          label="Net Vega"
          value={noCoverage ? <span className="text-ink-dim">—</span> : <PrivateText>{formatDollar(data.totalVega)}</PrivateText>}
          description="Per 1% IV move"
          color={noCoverage ? "text-ink-dim" : "text-blue"}
          interp={noCoverage ? undefined : interpretVega(data.totalVega ?? 0)}
        />
      </div>
      )}

      {/* Coverage disclosure: never let a partial or empty book read as a
          complete, affirmative Greeks read. */}
      {noCoverage && (
        <p className="text-xs text-ink-faint">
          Greeks unavailable — 0 of <Count value={data.totalPositions} /> positions could be priced
        </p>
      )}
      {partialCoverage && (
        <p className="text-xs text-ink-faint">
          Covers <Count value={data.computedPositions} /> of <Count value={data.totalPositions} /> positions
        </p>
      )}
      {/* A row priced on a fallback volatility IS covered (it feeds the totals
          above) — it is disclosed as an estimate, never as a failure. */}
      {fallbackVolCount > 0 && (
        <p className="text-xs text-ink-faint">
          Priced on a fallback volatility: <Count value={fallbackVolCount} /> (marked {IV_SNAPSHOT_MARK} or {IV_DEFAULT_MARK}, included in the totals)
        </p>
      )}

      {/* Per-position table */}
      <ScrollFade>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-ink-faint border-b border-edge">
              <SortableHeader field="option" sort={sort} onSort={setSort} className="pl-0! pr-3! py-2!">Option</SortableHeader>
              <SortableHeader field="qty" sort={sort} onSort={setSort} align="right" className="hidden md:table-cell px-2! py-2!">Qty</SortableHeader>
              <SortableHeader field="underlying" sort={sort} onSort={setSort} align="right" className="hidden md:table-cell px-2! py-2!">Underlying</SortableHeader>
              <SortableHeader field="dte" sort={sort} onSort={setSort} align="right" className="px-2! py-2!">DTE</SortableHeader>
              <SortableHeader field="iv" sort={sort} onSort={setSort} align="right" className="hidden md:table-cell px-2! py-2!">IV</SortableHeader>
              <SortableHeader field="delta" sort={sort} onSort={setSort} align="right" className="px-2! py-2!">Delta</SortableHeader>
              <SortableHeader field="gamma" sort={sort} onSort={setSort} align="right" className="hidden md:table-cell px-2! py-2!">Gamma</SortableHeader>
              <SortableHeader field="theta" sort={sort} onSort={setSort} align="right" className="px-2! py-2!">Theta</SortableHeader>
              <SortableHeader field="vega" sort={sort} onSort={setSort} align="right" className="hidden md:table-cell px-2! py-2!">Vega</SortableHeader>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const delta = p.greeks?.delta ?? null;
              const gamma = p.greeks?.gamma ?? null;
              const theta = p.greeks?.theta ?? null;
              const vega = p.greeks?.vega ?? null;
              const dte = p.daysToExpiry ?? 0;
              const ivCell = ivCellDisplay(p);

              return (
                <tr key={p.symbol} className="border-b border-edge/50 hover:bg-muted/30">
                  <td className="py-2 pr-3">
                    <span className="font-mono text-ink">{p.underlying}</span>
                    <span className="text-ink-faint ml-1">
                      {formatStrike(p.strike)} {p.optionType[0]} {formatOptionExpiry(p.expiration)}
                    </span>
                  </td>
                  <td className={`hidden md:table-cell text-right py-2 px-2 font-mono ${p.quantity < 0 ? "text-down" : "text-ink"}`}>
                    <PrivateText>{p.quantity > 0 ? `+${p.quantity}` : String(p.quantity)}</PrivateText>
                  </td>
                  <td className="hidden md:table-cell text-right py-2 px-2 font-mono text-ink-dim">
                    {/* 0 means "no underlying price" here (see the Greeks
                        diagnostics) — render — like the Greeks columns do,
                        not a misleading literal $0.00. */}
                    {p.underlyingPrice > 0 ? `$${p.underlyingPrice.toFixed(2)}` : "—"}
                    {p.underlyingPrice > 0 && p.underlyingPriceSource && (
                      <span className="text-gold-ink" title={siblingPriceNote(p)}>{SIBLING_PRICE_MARK}</span>
                    )}
                  </td>
                  <td className={`text-right py-2 px-2 font-mono ${dte <= 7 ? "text-down" : dte <= 30 ? "text-gold-ink" : "text-ink-dim"}`}>
                    {/* p.expired is the compute's own call (lib/compute/options-greeks.ts
                        isExpiredAsOf): a same-day contract (dte===0) is still LIVE until
                        the 16:00 ET close, so dte alone can't tell "expired" from "today".
                        A stale contract that lingers a day before the purge sweep clears
                        it also lands here via dte < 0 as a belt-and-suspenders check. */}
                    {p.expired || dte < 0 ? "expired" : `${dte}d`}
                  </td>
                  <td
                    className={`hidden md:table-cell text-right py-2 px-2 font-mono ${ivCell.flagged ? "text-gold-ink" : "text-ink-dim"}`}
                    title={ivCell.title}
                  >
                    {ivCell.text}
                  </td>
                  <td className={`text-right py-2 px-2 font-mono ${(delta ?? 0) > 0 ? "text-up" : (delta ?? 0) < 0 ? "text-down" : "text-ink-dim"}`}>
                    {delta != null ? delta.toFixed(3) : "—"}
                    {/* The IV column is hidden on a phone, so the fallback-vol
                        mark also rides on Delta, which is always visible. */}
                    {delta != null && ivCell.mark && (
                      <span className="text-gold-ink" title={ivCell.title}>{ivCell.mark}</span>
                    )}
                  </td>
                  <td className="hidden md:table-cell text-right py-2 px-2 font-mono text-ink-dim">
                    {gamma != null ? gamma.toFixed(4) : "—"}
                  </td>
                  <td className="text-right py-2 px-2 font-mono text-down">
                    {theta != null ? (
                      <PrivateText>{formatUSDPrecise(theta)}</PrivateText>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="hidden md:table-cell text-right py-2 px-2 font-mono text-blue">
                    {vega != null ? (
                      <PrivateText>{formatUSDPrecise(vega)}</PrivateText>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollFade>

      {/* Marker legend: visible text, because a title alone is hover-only. */}
      {(fallbackVolCount > 0 || anyUnstableIv || footnote.siblingPriced.length > 0) && (
        <div className="space-y-1 text-xs text-ink-faint">
          {hasSnapshotVol && (
            <p>
              {IV_SNAPSHOT_MARK} {IV_SOURCE_NOTE.ibkr}
            </p>
          )}
          {hasDefaultVol && (
            <p>
              {IV_DEFAULT_MARK} {IV_SOURCE_NOTE.default}
            </p>
          )}
          {anyUnstableIv && (
            <p>
              <span className="text-gold-ink">Amber IV</span>: {IV_UNSTABLE_NOTE}
            </p>
          )}
          {footnote.siblingPriced.length > 0 && (
            <p>
              {SIBLING_PRICE_MARK} Underlying price taken from another share class of the same issuer.
            </p>
          )}
        </div>
      )}

      {/* Coverage detail. Three disjoint groups: not priced, priced on a
          fallback volatility (covered), and expired (outside the coverage
          count). Counts and the rows behind them mask under privacy, like the
          coverage line above. */}
      {(unpricedCount > 0 || fallbackVolCount > 0 || expiredCount > 0 || footnote.siblingPriced.length > 0) && (
        <details className="mt-3">
          <summary className="text-xs text-ink-faint cursor-pointer">
            Coverage detail
            {unpricedCount > 0 && (
              <> · not priced: <Count value={unpricedCount} /></>
            )}
            {fallbackVolCount > 0 && (
              <> · fallback volatility: <Count value={fallbackVolCount} /></>
            )}
            {expiredCount > 0 && (
              <> · expired: <Count value={expiredCount} /></>
            )}
          </summary>
          <div className="mt-2 space-y-3 text-xs text-ink-dim font-mono">
            <FootnoteGroup heading="Not priced (left out of the totals)" rows={footnote.notPriced} />
            <FootnoteGroup heading="Priced on a fallback volatility (in the totals)" rows={footnote.fallbackVol} />
            <FootnoteGroup heading="Underlying priced off another share class (in the totals)" rows={footnote.siblingPriced} />
            <FootnoteGroup heading="Expired (not counted)" rows={footnote.expired} />
          </div>
        </details>
      )}
    </div>
  );
}

// ─── Diagnostics label map ──────────────────────────────────────

const REASON_LABELS: Record<GreeksDiagnostic["reason"], string> = {
  no_underlying_price: "no underlying price",
  expired: "already expired",
  missing_iv: "couldn't solve for IV (using 30% vol fallback)",
  missing_option_price: "no option price (using 30% vol fallback)",
};

// ─── IV provenance + stability ──────────────────────────────────

export const IV_SNAPSHOT_MARK = "†";
export const IV_DEFAULT_MARK = "‡";
export const SIBLING_PRICE_MARK = "*";

export const IV_SOURCE_NOTE = {
  ibkr: "Volatility from the underlying's broker snapshot, not solved from this contract; its Greeks are computed at that figure.",
  default: "Assumed volatility: none could be solved for this contract and the broker has none for the underlying; its Greeks are an estimate at that figure.",
} as const;

/** Owner ruling (QA analysis-options-greeks--implausible-iv-706pct-unflagged):
 *  flag the IV by CONDITION, never by the solved value — there is no ceiling. */
export const IV_UNSTABLE_TITLE = "IV solve unstable: short-dated / deep-ITM";
export const IV_UNSTABLE_NOTE =
  "the solve is unstable (3 days or less to expiry, or deep in the money), so read the figure as indicative.";
/** Short-dated: this many calendar days to expiry or fewer. */
export const IV_UNSTABLE_MAX_DTE = 3;
/** Deep in the money: the underlying is at least this multiple through the
 *  strike (a call with spot >= 1.2 x strike; a put with strike >= 1.2 x spot).
 *  A moneyness cut on the CONTRACT, deliberately not read from the solved IV
 *  or the delta — both are the numbers a bad mark distorts. */
export const IV_DEEP_ITM_MONEYNESS = 1.2;

type IvFlagInput = Pick<
  PositionGreeks,
  "optionType" | "strike" | "underlyingPrice" | "daysToExpiry" | "expired" | "greeks"
>;

export function isDeepInTheMoney(p: Pick<PositionGreeks, "optionType" | "strike" | "underlyingPrice">): boolean {
  if (!(p.underlyingPrice > 0) || !(p.strike > 0)) return false;
  return p.optionType === "CALL"
    ? p.underlyingPrice >= p.strike * IV_DEEP_ITM_MONEYNESS
    : p.strike >= p.underlyingPrice * IV_DEEP_ITM_MONEYNESS;
}

/** True when the row shows an IV SOLVED from the contract's own mark under a
 *  condition where that solve is fragile. A snapshot or assumed vol is not a
 *  solve and carries its own mark instead. */
export function isIvSolveUnstable(p: IvFlagInput): boolean {
  if (p.expired || !p.greeks || p.greeks.iv == null) return false;
  if (p.greeks.ivSource === "ibkr" || p.greeks.ivSource === "default") return false;
  const shortDated = Number.isFinite(p.daysToExpiry) && (p.daysToExpiry as number) <= IV_UNSTABLE_MAX_DTE;
  return shortDated || isDeepInTheMoney(p);
}

function formatVolPct(vol: number): string {
  return `${(vol * 100).toFixed(0)}%`;
}

/** What the IV cell prints: the figure, its provenance mark, the amber flag and the title. */
export function ivCellDisplay(p: IvFlagInput): {
  text: string;
  mark: string | null;
  flagged: boolean;
  title: string | undefined;
} {
  const g = p.greeks;
  if (!g) return { text: "—", mark: null, flagged: false, title: undefined };
  if (g.ivSource === "default") {
    // The Greeks WERE computed at an assumed vol: show that vol, marked, never a bare dash.
    const vol = g.volUsed;
    return {
      text: vol != null ? `${formatVolPct(vol)}${IV_DEFAULT_MARK}` : `—${IV_DEFAULT_MARK}`,
      mark: IV_DEFAULT_MARK,
      flagged: true,
      title: IV_SOURCE_NOTE.default,
    };
  }
  if (g.ivSource === "ibkr") {
    return {
      text: g.iv != null ? `${formatVolPct(g.iv)}${IV_SNAPSHOT_MARK}` : `—${IV_SNAPSHOT_MARK}`,
      mark: IV_SNAPSHOT_MARK,
      flagged: true,
      title: IV_SOURCE_NOTE.ibkr,
    };
  }
  if (g.iv == null) return { text: "—", mark: null, flagged: false, title: undefined };
  const unstable = isIvSolveUnstable(p);
  return {
    text: formatVolPct(g.iv),
    mark: null,
    flagged: unstable,
    title: unstable ? IV_UNSTABLE_TITLE : undefined,
  };
}

function siblingPriceNote(p: Pick<PositionGreeks, "underlying" | "underlyingPriceSource">): string {
  return `priced off ${p.underlyingPriceSource} (${p.underlying} has no stored close)`;
}

// ─── Coverage footnote groups ───────────────────────────────────

export interface GreeksFootnoteRow {
  symbol: string;
  label: string;
}

/**
 * The rows behind the three coverage counts, plus the sibling-priced rows.
 * Disjoint by construction: an expired row is only ever "expired", a row with
 * Greeks is never "not priced". A row priced on a fallback volatility is
 * COVERED — it is listed as an estimate, not as a failure.
 */
export function greeksFootnoteGroups(data: Pick<PortfolioGreeks, "positions" | "diagnostics">): {
  notPriced: GreeksFootnoteRow[];
  fallbackVol: GreeksFootnoteRow[];
  siblingPriced: GreeksFootnoteRow[];
  expired: GreeksFootnoteRow[];
} {
  const reasonBySymbol = new Map<string, GreeksDiagnostic["reason"]>();
  for (const d of data.diagnostics ?? []) reasonBySymbol.set(d.symbol, d.reason);

  const notPriced: GreeksFootnoteRow[] = [];
  const fallbackVol: GreeksFootnoteRow[] = [];
  const siblingPriced: GreeksFootnoteRow[] = [];
  const expired: GreeksFootnoteRow[] = [];

  for (const p of data.positions ?? []) {
    if (p.expired) {
      expired.push({ symbol: p.symbol, label: REASON_LABELS.expired });
      continue;
    }
    if (!p.greeks) {
      const reason = reasonBySymbol.get(p.symbol) ?? "no_underlying_price";
      notPriced.push({ symbol: p.symbol, label: REASON_LABELS[reason] });
      continue;
    }
    if (p.greeks.ivSource === "ibkr") {
      fallbackVol.push({ symbol: p.symbol, label: "volatility from the underlying's broker snapshot" });
    } else if (p.greeks.ivSource === "default") {
      const reason = reasonBySymbol.get(p.symbol);
      const why = reason === "missing_iv" ? "couldn't solve for IV" : "no option price";
      const vol = p.greeks.volUsed;
      fallbackVol.push({
        symbol: p.symbol,
        label: vol != null ? `${why} (assumed ${formatVolPct(vol)} volatility)` : `${why} (assumed volatility)`,
      });
    }
    if (p.underlyingPriceSource) {
      siblingPriced.push({ symbol: p.symbol, label: siblingPriceNote(p) });
    }
  }
  return { notPriced, fallbackVol, siblingPriced, expired };
}

function FootnoteGroup({ heading, rows }: { heading: string; rows: GreeksFootnoteRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="font-sans text-ink-faint">{heading}</p>
      {rows.map((r, i) => (
        <div key={`${r.symbol}-${i}`}>
          <PrivateText>
            {r.symbol} · <span className="text-ink-faint">{r.label}</span>
          </PrivateText>
        </div>
      ))}
    </div>
  );
}

// ─── Sorting ────────────────────────────────────────────────────

export type GreeksSortField =
  | "option"
  | "qty"
  | "underlying"
  | "dte"
  | "iv"
  | "delta"
  | "gamma"
  | "theta"
  | "vega";

function sortValue(p: PositionGreeks, field: GreeksSortField): string | number | null {
  switch (field) {
    case "option":
      return p.underlying;
    case "qty":
      return p.quantity;
    case "underlying":
      return p.underlyingPrice > 0 ? p.underlyingPrice : null;
    case "dte":
      return Number.isFinite(p.daysToExpiry) ? p.daysToExpiry : null;
    case "iv":
      return p.greeks?.iv ?? null;
    case "delta":
      return p.greeks?.delta ?? null;
    case "gamma":
      return p.greeks?.gamma ?? null;
    case "theta":
      return p.greeks?.theta ?? null;
    case "vega":
      return p.greeks?.vega ?? null;
  }
}

/** Rows in the chosen order; no field = the compute's order (nearest expiry
 *  first). Stable, and a row with no value for the field always sorts last. */
export function sortGreeksPositions(
  positions: PositionGreeks[],
  sort: SortState<GreeksSortField>,
): PositionGreeks[] {
  const field = sort.field;
  if (!field) return positions;
  return [...positions].sort((a, b) => compareValues(sortValue(a, field), sortValue(b, field), sort.dir));
}

// ─── Helpers ────────────────────────────────────────────────────

function MetricCell({
  label,
  value,
  description,
  color,
  interp,
}: {
  label: string;
  value: ReactNode;
  description: string;
  color: string;
  interp?: Interpretation;
}) {
  return (
    <div className="bg-raised/50 rounded-lg p-3">
      <p className="text-xs text-ink-faint uppercase">{label}</p>
      <p className={`text-xl font-mono font-medium mt-1 ${color}`}>{value}</p>
      <p className="text-xs text-ink-faint mt-1">{description}</p>
      {interp && (
        // Interpretation embeds portfolio-derived $ / share-equivalents —
        // privacy-mask the whole line (matches the value above it).
        <p className={`text-xs mt-1 ${toneClass(interp.tone)}`}>
          <PrivateText>{interp.text}</PrivateText>
        </p>
      )}
    </div>
  );
}

function formatNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(1);
}

function formatDollar(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  // Sign lives OUTSIDE the "$" ("-$2.1K", never "$-2.1K"); dropped when the
  // rounded body is zero so a tiny negative theta can't render "-$0".
  const abs = Math.abs(n);
  const body = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}K` : `$${abs.toFixed(0)}`;
  const sign = n < 0 && !rendersAsZero(body) ? "-" : "";
  return `${sign}${body}`;
}

function formatStrike(strike: number): string {
  return strike % 1 === 0 ? `$${strike}` : `$${strike.toFixed(2)}`;
}
