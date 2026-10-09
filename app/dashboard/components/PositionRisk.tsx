"use client";

import { PERCENT_BASIS } from "@/lib/analysis/percent-bases";
import { useState, useEffect } from "react";
import type {
  PositionRisk,
  CorrelationEntry,
  PositionRiskResult,
} from "@/lib/compute/risk";
import { Pct, PrivateText } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import { NarrativeBlock } from "./analysis/NarrativeBlock";
import { ScrollFade } from "./ScrollFade";
import { DrillDownPanel } from "./analysis/DrillDownPanel";
import { WeekOverWeekBadge } from "./analysis/WeekOverWeekBadge";
import type { DrillDownFilter } from "@/lib/queries/drill-down";

// ─── W-o-W delta helper ───────────────────────────────────────────

/**
 * Pure helper: compute the change in riskContribution for a position
 * relative to the prior week's snapshot. Returns null when week-ago data
 * is absent or the symbol didn't exist in the prior top-N list.
 *
 * Exported for unit testing.
 */
export function computeWeekOverWeekDelta(
  current: { symbol: string; riskContribution: number | null },
  past: Array<{ symbol: string; riskContribution: number | null }> | null | undefined
): number | null {
  if (!past || past.length === 0) return null;
  if (current.riskContribution == null) return null;
  const match = past.find((p) => p.symbol === current.symbol);
  if (!match || match.riskContribution == null) return null;
  return current.riskContribution - match.riskContribution;
}

// ─── Formatters ──────────────────────────────────────────────────

function formatCorr(value: number): string {
  return value.toFixed(2);
}

// ─── Correlation color ───────────────────────────────────────────

function corrColor(corr: number): string {
  // High positive correlation = warm (red-ish), low/negative = cool (blue-ish)
  if (corr >= 0.8) return "bg-down/30 text-down";
  if (corr >= 0.5) return "bg-warn/15 text-warn";
  if (corr >= 0.2) return "bg-ink-faint/15 text-ink-dim";
  if (corr >= -0.2) return "bg-up/20 text-up";
  return "bg-blue-500/20 text-blue-400";
}

function corrBg(corr: number): string {
  const abs = Math.abs(corr);
  if (abs >= 0.8) return "rgba(248, 113, 113, 0.25)";
  if (abs >= 0.5) return "rgba(251, 191, 36, 0.15)";
  if (abs >= 0.2) return "rgba(148, 163, 184, 0.1)";
  return "rgba(52, 211, 153, 0.1)";
}

// ─── Blank reasons ───────────────────────────────────────────────

/**
 * A risk row as this card reads it. `cashEquivalent` is published by
 * computePositionRisk from isCashEquivalentSecurity; it is optional here so
 * a response without it degrades to the "insufficient data" reason below
 * rather than to a guess. This card never infers cash from a symbol or name.
 */
type RiskRow = PositionRisk & { cashEquivalent?: boolean };

export interface RiskBlank {
  kind: "cash-equivalent" | "insufficient-data";
  /** Short text shown in the cell itself (readable on touch). */
  label: string;
  /** The cause, shown beside the label where there is room and as a title. */
  detail: string;
}

function insufficient(detail: string): RiskBlank {
  return { kind: "insufficient-data", label: "insufficient data", detail };
}

/**
 * Why a row has no risk figures at all, or null when it has them.
 *
 * A cash equivalent (a constant-price money-market fund) has no price
 * movement to measure, so the blank is the answer and is labelled as such.
 * Any other row is blank because its price history is too thin for the
 * engine's minimum; the row says so and gives the count it found. Nothing is
 * computed or defaulted here.
 *
 * Exported for unit testing.
 */
export function riskRowBlank(pos: RiskRow): RiskBlank | null {
  const anyBlank =
    pos.annualizedVol == null ||
    pos.correlationWithPortfolio == null ||
    pos.riskContribution == null;
  if (pos.cashEquivalent && anyBlank) {
    return {
      kind: "cash-equivalent",
      label: "cash equivalent, no market risk",
      detail: "A cash fund holds a constant price, so there is no price movement to measure.",
    };
  }
  if (pos.annualizedVol != null) return null;
  if (pos.dataPoints <= 0) {
    return insufficient("no usable daily price history in the past year");
  }
  return insufficient(
    `only ${pos.dataPoints} usable daily ${pos.dataPoints === 1 ? "return" : "returns"} in the past year`
  );
}

/** Why "Corr w/ Port" is blank on a row that has a volatility. Exported for unit testing. */
export function correlationBlank(pos: RiskRow): RiskBlank | null {
  if (pos.correlationWithPortfolio != null) return null;
  return insufficient("too few trading days in common with the top-10 basket");
}

/** Why "Risk Contrib" is blank on a row that has a volatility. Exported for unit testing. */
export function riskContributionBlank(
  pos: RiskRow,
  portfolioVol: number | null
): RiskBlank | null {
  if (pos.riskContribution != null) return null;
  const upstream = correlationBlank(pos);
  if (upstream) return upstream;
  return insufficient(
    portfolioVol == null
      ? "the top-10 basket volatility could not be computed"
      : "the top-10 basket volatility is zero"
  );
}

/** A pair of positions with no entry in the pairwise matrix. */
export const PAIR_BLANK: RiskBlank = insufficient(
  "too few trading days in common between the two price histories"
);

/**
 * The visible marker for a blank. The label is real text (not hover-only);
 * `showDetail` also prints the cause where the cell is wide enough.
 */
function BlankMarker({
  blank,
  showDetail = false,
}: {
  blank: RiskBlank | null;
  showDetail?: boolean;
}) {
  if (!blank) return null;
  return (
    <span className="text-xs text-ink-dim" title={blank.detail}>
      {blank.label}
      {showDetail && blank.kind === "insufficient-data" ? ` · ${blank.detail}` : ""}
    </span>
  );
}

// ─── Component ───────────────────────────────────────────────────

export function PositionRiskCard({ scope }: { scope?: string }) {
  const [data, setData] = useState<PositionRiskResult | null>(null);
  const [weekAgoPosns, setWeekAgoPosns] = useState<PositionRisk[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drillFilter, setDrillFilter] = useState<DrillDownFilter | null>(null);
  const { isPrivate } = usePrivacy();

  useEffect(() => {
    setLoading(true);
    const scopeParam = scope && scope !== "all" ? `&scope=${scope}` : "";
    fetch(`/api/compute/position-risk?topN=10${scopeParam}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setData(json.data);
          setWeekAgoPosns(json.weekAgo?.positions ?? null);
        } else {
          setError(json.error ?? "Failed to compute position risk");
        }
      })
      .catch(() => setError("Failed to fetch position risk"))
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Position-Level Risk</h3>
        <div className="text-sm text-ink-faint animate-pulse">Computing position risk...</div>
      </div>
    );
  }

  if (error || !data || data.positions.length === 0) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Position-Level Risk</h3>
        <div className="text-sm text-ink-faint">
          {error ?? "No position data available. Import holdings and prices to see position-level risk."}
        </div>
      </div>
    );
  }

  // Sort by risk contribution (highest first), nulls last
  const sorted = [...data.positions].sort((a, b) => {
    if (a.riskContribution == null && b.riskContribution == null) return 0;
    if (a.riskContribution == null) return 1;
    if (b.riskContribution == null) return -1;
    return b.riskContribution - a.riskContribution;
  });

  // Build correlation matrix
  const corrSymbols = Array.from(
    new Set(data.correlations.flatMap((c) => [c.symbolA, c.symbolB]))
  ).sort();
  const corrMap = new Map<string, number>();
  for (const c of data.correlations) {
    corrMap.set(`${c.symbolA}:${c.symbolB}`, c.correlation);
    corrMap.set(`${c.symbolB}:${c.symbolA}`, c.correlation);
  }

  return (
    <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-medium text-ink">Position-Level Risk</h3>
        <div className="flex items-center gap-3 flex-wrap">
          {data.portfolioVol != null && (
            <span className="text-xs text-ink-faint">
              Top-10 basket vol:{" "}
              <Pct value={data.portfolioVol * 100} digits={1} className="font-mono text-ink" />
              <span className="ml-1 text-[10px] text-ink-faint/70">
                (price-based · 1Y · top 10 positions)
              </span>
            </span>
          )}
          {/* P3 Slice C — drill-down trigger. Single button (not per-row click)
              because the filter is identical regardless of which row is clicked
              — clearer affordance than making rows look interactive for the
              same outcome. */}
          <button
            type="button"
            onClick={() => setDrillFilter({ kind: "risk", topN: 10 })}
            className="relative text-xs text-gold-ink hover:underline focus-ring rounded px-1 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3.5 pointer-coarse:after:-inset-x-1"
            aria-label="Open top 10 by risk in drill-down panel"
          >
            View top 10 by risk →
          </button>
        </div>
      </div>

      <NarrativeBlock scope={scope ?? "all"} surfaceKey="position-risk" />

      <p className="text-xs text-ink-dim mb-2">{PERCENT_BASIS.positionRiskWeightCaption}</p>

      {/* ── Position table ── */}
      <ScrollFade>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge text-ink-faint text-xs">
              <th className="text-left py-2 pr-4 font-medium">Position</th>
              <th className="text-right py-2 px-3 font-medium" title={PERCENT_BASIS.positionRiskWeight}>
                Weight
              </th>
              <th className="text-right py-2 px-3 font-medium">Volatility</th>
              <th className="text-right py-2 px-3 font-medium">Corr w/ Port</th>
              <th className="text-right py-2 pl-3 font-medium">Risk Contrib</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((pos) => {
              const rowBlank = riskRowBlank(pos);
              return (
              <tr key={pos.securityId} className="border-b border-edge/30 last:border-0">
                <td className="py-2 pr-4">
                  <div className="font-mono font-medium text-ink">{pos.symbol}</div>
                  {pos.securityName && pos.securityName !== pos.symbol && (
                    <div className="hidden md:block text-xs text-ink-faint truncate max-w-[180px]">
                      {pos.securityName}
                    </div>
                  )}
                </td>
                <td className="text-right py-2 px-3 font-mono tabular-nums text-ink-dim">
                  <Pct value={pos.weight != null ? pos.weight * 100 : null} digits={1} />
                </td>
                {rowBlank ? (
                  // The three risk cells share one reason, so they merge
                  // into one cell that states it. The row stays in the
                  // table so the weights still match the allocation views.
                  <td colSpan={3} className="text-right py-2 pl-3">
                    <BlankMarker blank={rowBlank} showDetail />
                  </td>
                ) : (
                <>
                <td className="text-right py-2 px-3 font-mono tabular-nums text-ink">
                  <Pct value={pos.annualizedVol != null ? pos.annualizedVol * 100 : null} digits={1} />
                </td>
                <td className="text-right py-2 px-3">
                  {pos.correlationWithPortfolio != null ? (
                    isPrivate ? (
                      // Correlation with the portfolio is derived from this
                      // holder's own position weights, so it masks the same
                      // as Weight/Volatility/Risk Contrib. The color-coded
                      // pill also encodes magnitude (corrColor buckets by
                      // |corr|), so it's neutralized to a flat style here
                      // rather than kept live.
                      <PrivateText className="font-mono tabular-nums text-xs px-1.5 py-0.5 rounded bg-ink-faint/15 text-ink-dim">
                        {null}
                      </PrivateText>
                    ) : (
                      <span
                        className={`font-mono tabular-nums text-xs px-1.5 py-0.5 rounded ${corrColor(pos.correlationWithPortfolio)}`}
                      >
                        {formatCorr(pos.correlationWithPortfolio)}
                      </span>
                    )
                  ) : (
                    <BlankMarker blank={correlationBlank(pos)} />
                  )}
                </td>
                <td className="text-right py-2 pl-3">
                  {pos.riskContribution != null ? (
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-edge rounded-full overflow-hidden">
                        {/* Bar width encodes this row's risk-contribution
                            magnitude — under privacy it collapses to a
                            constant, dimmed fill (matching CoverageBar's
                            pattern) so the bar itself can't be read as a
                            value. NOTE: the table is still sorted by risk
                            contribution, so row order remains a ranking
                            signal on its own regardless of this collapse —
                            a separate product call, not addressed here. */}
                        <div
                          className={`h-full bg-gold rounded-full${isPrivate ? " opacity-30" : ""}`}
                          style={{
                            width: isPrivate
                              ? "100%"
                              : `${Math.min(Math.abs(pos.riskContribution) * 100, 100)}%`,
                          }}
                        />
                      </div>
                      <Pct
                        value={pos.riskContribution != null ? pos.riskContribution * 100 : null}
                        digits={1}
                        className="font-mono tabular-nums text-ink text-xs w-12 text-right"
                      />
                      {/* The 7-day delta is itself a portfolio-derived
                          number (change in risk contribution). Masking
                          lives INSIDE <WeekOverWeekBadge> (it reads
                          usePrivacy() directly) rather than a call-site
                          isPrivate ternary here — a call-site wrapper would
                          fabricate a masked delta even when there's no
                          week-ago data at all (the badge's own null branch
                          never runs). */}
                      <WeekOverWeekBadge
                        value={computeWeekOverWeekDelta(pos, weekAgoPosns)}
                        kind="neutral"
                        asPercent={true}
                        digits={1}
                      />
                    </div>
                  ) : (
                    <span className="text-ink-faint">
                      <BlankMarker blank={riskContributionBlank(pos, data.portfolioVol)} />
                    </span>
                  )}
                </td>
                </>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollFade>

      {/* ── Correlation matrix ── */}
      {corrSymbols.length >= 3 && (
        <div>
          <h4 className="text-xs text-ink-faint uppercase tracking-widest mb-3">
            Pairwise Correlations
          </h4>
          <ScrollFade>
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="pr-2 pb-1" />
                  {corrSymbols.map((s) => (
                    <th
                      key={s}
                      className="px-1.5 pb-1 font-mono font-medium text-ink-faint text-center"
                      style={{ minWidth: "44px" }}
                    >
                      {s.length > 5 ? s.slice(0, 4) + "\u2026" : s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {corrSymbols.map((rowSym) => (
                  <tr key={rowSym}>
                    <td className="pr-2 py-0.5 font-mono font-medium text-ink-faint text-right">
                      {rowSym.length > 5 ? rowSym.slice(0, 4) + "\u2026" : rowSym}
                    </td>
                    {corrSymbols.map((colSym) => {
                      if (rowSym === colSym) {
                        return (
                          <td
                            key={colSym}
                            className="px-1.5 py-0.5 text-center font-mono text-ink-faint"
                            style={{ background: "rgba(148, 163, 184, 0.05)" }}
                          >
                            1.00
                          </td>
                        );
                      }
                      const corr = corrMap.get(`${rowSym}:${colSym}`);
                      if (corr === undefined) {
                        return (
                          <td key={colSym} className="px-1.5 py-0.5 text-center leading-tight">
                            <BlankMarker blank={PAIR_BLANK} />
                          </td>
                        );
                      }
                      if (isPrivate) {
                        // Which pairs move together is read off this
                        // holder's own top positions, so the value masks
                        // like the table above. The background and the
                        // title both encode the magnitude, so neither is
                        // rendered.
                        return (
                          <td
                            key={colSym}
                            className="px-1.5 py-0.5 text-center font-mono tabular-nums text-ink-dim"
                            style={{ background: "rgba(148, 163, 184, 0.05)" }}
                          >
                            <PrivateText>{null}</PrivateText>
                          </td>
                        );
                      }
                      return (
                        <td
                          key={colSym}
                          className="px-1.5 py-0.5 text-center font-mono tabular-nums"
                          style={{ background: corrBg(corr) }}
                          title={`${rowSym} × ${colSym}: ${corr.toFixed(3)}`}
                        >
                          {formatCorr(corr)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFade>
          <div className="flex items-center gap-4 mt-2 text-[10px] text-ink-faint">
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ background: "rgba(52, 211, 153, 0.2)" }} />
              Low (&lt;0.2)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ background: "rgba(148, 163, 184, 0.2)" }} />
              Moderate
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ background: "rgba(251, 191, 36, 0.15)" }} />
              High (&gt;0.5)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 rounded-sm" style={{ background: "rgba(248, 113, 113, 0.25)" }} />
              Very High (&gt;0.8)
            </span>
          </div>
        </div>
      )}

      {/* P3 Slice C — drill-down panel for top-N risk */}
      <DrillDownPanel
        open={drillFilter !== null}
        onClose={() => setDrillFilter(null)}
        scope={scope ?? "all"}
        filter={drillFilter}
      />
    </div>
  );
}
