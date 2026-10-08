"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ScenarioResult } from "@/lib/compute/scenarios";
import { findRecipe } from "@/lib/compute/scenario-recipes";
import { isOptionSecurityType } from "@/lib/compute/option-elasticity";
import { VOL_MOVE_MIN, VOL_MOVE_MAX, type OptionIvSource, type OptionUnmodelledReason } from "@/lib/compute/option-reprice";
import { FUND_DEFAULT_DURATION_YEARS, type BondUnmodelledReason } from "@/lib/compute/bond-duration";
import { Count, Pct, PrivateText } from "@/lib/privacy/components";
import { formatCompactOptionSymbol } from "@/lib/format";
import apiFetch from "@/lib/http/apiFetch";

function findRecipeMethodology(id: string): string | null {
  return findRecipe(id)?.methodology ?? null;
}

// An option row carries no beta: its move comes from repricing the contract
// at the shocked underlying, so the row names where its volatility came from.
const IV_SOURCE_LABEL: Record<OptionIvSource, string> = {
  "own-price": "vol from its price",
  "broker-underlying": "vol from IBKR",
};
const IV_SOURCE_TITLE: Record<OptionIvSource, string> = {
  "own-price": "Volatility solved from this contract's own last price.",
  "broker-underlying": "This contract's price gave no usable volatility, so IBKR's figure for the underlying was used.",
};
const UNMODELLED_REASON_LABEL: Record<OptionUnmodelledReason, string> = {
  "no-option-terms": "strike, expiry or type missing",
  "expired": "expired",
  "no-option-price": "no price for the contract",
  "no-underlying-price": "no price for the underlying",
  "no-volatility": "no usable volatility",
};
// A bond the rate move could not price: no duration, coupon or yield is ever
// assumed for it, so the row names the stored input that is missing.
// A stored coupon is used first, then the one the bond's stored name states;
// with neither, the bond is left out. (Only the broker source may ever store
// a coupon, and it is not wired yet, so today the name is the working source.)
const BOND_UNMODELLED_REASON_LABEL: Record<BondUnmodelledReason, string> = {
  "no-maturity": "no maturity date",
  "matured": "past its maturity date",
  "no-coupon": "no coupon from the broker, and none readable in the bond's name",
  "unusable-coupon": "the stored coupon is not a usable figure",
  "no-price": "no price",
  "no-yield": "price gives no usable yield",
};
const BETA_TITLE = "Beta vs the market: 1.0 moves with the index.";

// ─── Formatters ──────────────────────────────────────────────────

function formatMoney(value: number, opts?: { signed?: boolean }): string {
  const abs = Math.abs(value);
  const sign = opts?.signed === false ? (value < 0 ? "-" : "") : value < 0 ? "-" : value > 0 ? "+" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatPct(value: number): string {
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

// ─── Category icons ──────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, string> = {
  crash: "\u{1F4C9}", // chart down
  rate: "\u{1F3E6}",  // bank
  sector: "\u{1F504}", // arrows
  custom: "\u{1F527}", // wrench
};

// ─── Component ───────────────────────────────────────────────────

const SECTORS = [
  "Technology", "Healthcare", "Financials", "Consumer Discretionary",
  "Communication Services", "Industrials", "Consumer Staples",
  "Energy", "Utilities", "Real Estate", "Materials",
];

const GICS_SECTORS = new Set(SECTORS);

function nonShockableBucket(pos: ScenarioResult["positionImpacts"][number]): string | null {
  if ((pos.securityType ?? "").trim().toLowerCase() === "bond") return "Fixed Income";
  const sector = pos.sector?.trim();
  if (!sector || GICS_SECTORS.has(sector)) return null;
  return sector;
}

// Custom-scenario input bounds (owner ruling 2026-10-07, QA option 1): a rate
// move past +/-1000 bp or a sector override past +/-50% is refused, with the
// input named. Nothing is clamped or replaced by another figure.
export const CUSTOM_RATE_MOVE_LIMIT_BP = 1000;
export const CUSTOM_SECTOR_MOVE_LIMIT_PCT = 50;

export function customScenarioInputProblems(
  rateMoveBp: number,
  sectorOverrides: { sector: string; move: number }[],
): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(rateMoveBp) || Math.abs(rateMoveBp) > CUSTOM_RATE_MOVE_LIMIT_BP) {
    problems.push(
      `Rate move must be between -${CUSTOM_RATE_MOVE_LIMIT_BP} and +${CUSTOM_RATE_MOVE_LIMIT_BP} basis points.`,
    );
  }
  for (const o of sectorOverrides) {
    if (!o.sector) continue;
    if (!Number.isFinite(o.move) || Math.abs(o.move) > CUSTOM_SECTOR_MOVE_LIMIT_PCT) {
      problems.push(
        `${o.sector} override must be between -${CUSTOM_SECTOR_MOVE_LIMIT_PCT}% and +${CUSTOM_SECTOR_MOVE_LIMIT_PCT}%.`,
      );
    }
  }
  return problems;
}

export function ScenarioModelingCard({ scope }: { scope?: string }) {
  const [scenarios, setScenarios] = useState<ScenarioResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [customResult, setCustomResult] = useState<ScenarioResult | null>(null);
  const [customLoading, setCustomLoading] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);

  // Bumped every time the [scope] effect below fires, so an in-flight
  // custom-scenario request can recognize its own response as stale (the
  // user switched scope while it was in the air) and drop it instead of
  // re-seating a result computed for a scope that's no longer selected.
  const requestTokenRef = useRef(0);

  // Custom scenario form state
  const [customMarketMove, setCustomMarketMove] = useState(-10);
  const [customRateMove, setCustomRateMove] = useState(0);
  const [customVolMove, setCustomVolMove] = useState(0);
  const [customSectorOverrides, setCustomSectorOverrides] = useState<
    { sector: string; move: number }[]
  >([]);

  const customInputProblems = customScenarioInputProblems(customRateMove, customSectorOverrides);

  // useCallback must be declared before any early returns (React hooks rules)
  const handleComputeCustom = useCallback(async () => {
    setCustomLoading(true);
    // Snapshot the token up front — if the [scope] effect bumps it before
    // this request resolves, the response below belongs to a scope the
    // user has since left and must be dropped.
    const requestToken = requestTokenRef.current;
    try {
      const inputProblems = customScenarioInputProblems(customRateMove, customSectorOverrides);
      if (inputProblems.length > 0) {
        setCustomError(inputProblems.join(" "));
        return;
      }
      const sectorMoves: Record<string, number> = {};
      const seenSectors = new Set<string>();
      const duplicateSectors = new Set<string>();
      for (const o of customSectorOverrides) {
        if (!o.sector || o.move === 0) continue;
        if (seenSectors.has(o.sector)) {
          duplicateSectors.add(o.sector);
          continue;
        }
        seenSectors.add(o.sector);
        sectorMoves[o.sector] = o.move / 100;
      }
      if (duplicateSectors.size > 0) {
        setCustomError(
          `Remove duplicate sector overrides before computing: ${Array.from(duplicateSectors).join(", ")}.`
        );
        return;
      }

      const res = await apiFetch("/api/compute/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketMove: customMarketMove / 100,
          rateMove: customRateMove || undefined,
          volMove: customVolMove || undefined,
          sectorMoves: Object.keys(sectorMoves).length > 0 ? sectorMoves : undefined,
          scope,
        }),
      });
      const json = await res.json();
      if (requestTokenRef.current !== requestToken) return;
      if (json.success) {
        setCustomError(null);
        setCustomResult(json.data);
        setExpanded("custom");
      } else {
        setCustomError(`Couldn't compute the scenario: ${json.error ?? "unknown error"}.`);
      }
    } catch {
      if (requestTokenRef.current !== requestToken) return;
      setCustomError("Couldn't compute the scenario: could not reach the server.");
    } finally {
      setCustomLoading(false);
    }
  }, [customMarketMove, customRateMove, customVolMove, customSectorOverrides, scope]);

  useEffect(() => {
    setLoading(true);
    // A custom result was computed for the OLD scope. Dropping it here keeps
    // the card list from mixing a stale scope's number with the new presets;
    // the builder inputs stay put so the user can just hit Compute again.
    // Bump the token FIRST so an in-flight custom-scenario request from the
    // old scope (see handleComputeCustom) recognizes its own response as
    // stale when it lands.
    requestTokenRef.current += 1;
    setCustomResult(null);
    setCustomError(null);
    // The preset-fetch error is scope-specific: without resetting it here,
    // a scope whose fetch once failed pins the render guard's `error ?? …`
    // message forever, even after a later scope's fetch succeeds.
    setError(null);
    // Nothing should stay expanded across a scope switch — most obviously
    // "custom", which no longer has a result to show.
    setExpanded(null);
    const params = scope && scope !== "all" ? `?scope=${scope}` : "";
    fetch(`/api/compute/scenarios${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setScenarios(json.data);
        else setError(json.error ?? "Failed to compute scenarios");
      })
      .catch(() => setError("Failed to fetch scenario analysis"))
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Scenario Modeling</h3>
        <div className="text-sm text-ink-faint animate-pulse">Computing scenarios...</div>
      </div>
    );
  }

  if (error || !scenarios || scenarios.length === 0) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Scenario Modeling</h3>
        <div className="text-sm text-ink-faint">
          {error ?? "No position data available for scenario analysis."}
        </div>
      </div>
    );
  }

  const currentValue = scenarios[0].currentPortfolioValue;
  const notShockableValue = scenarios[0].positionImpacts.reduce(
    (sum, pos) => (nonShockableBucket(pos) ? sum + Math.max(pos.currentValue, 0) : sum),
    0
  );
  const notShockableShare = currentValue > 0 ? notShockableValue / currentValue : 0;

  // Combine preset scenarios with custom result
  const allScenarios = customResult
    ? [...scenarios, customResult]
    : scenarios;

  return (
    <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">Scenario Modeling</h3>
        <span className="text-xs text-ink-faint">
          Current: <PrivateText className="font-mono text-ink">{formatMoney(currentValue, { signed: false })}</PrivateText>
        </span>
      </div>

      <p className="text-xs text-ink-faint">
        Estimated portfolio impact under hypothetical shocks. Per-position P&amp;L is computed from
        your factor classifications (rate sensitivity, AI exposure, tariff exposure, etc.)
        — each scenario surfaces its full methodology when expanded. Custom what-if scenarios
        use a market beta per position. Options are repriced in every scenario.
      </p>
      {notShockableShare > 0 && (
        <p className="text-xs text-ink-faint">
          <Pct value={notShockableShare * 100} digits={0} /> of the book (fixed income, Treasury, diversified) cannot be given a sector override; the rate and market shocks still apply to it.
        </p>
      )}

      {/* ── Scenario cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {allScenarios.map((result) => {
          const isExpanded = expanded === result.scenario.id;
          const isPositive = result.estimatedChange >= 0;

          return (
            <button
              key={result.scenario.id}
              onClick={() => setExpanded(isExpanded ? null : result.scenario.id)}
              className={`text-left rounded-xl border p-4 transition-[border-color,background-color,box-shadow] ${
                isExpanded
                  ? "border-gold/50 bg-panel shadow-lg col-span-full"
                  : "border-edge bg-panel hover:border-edge-strong"
              }`}
            >
              {/* Card header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {CATEGORY_ICONS[result.scenario.category] ?? ""}
                  </span>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-sm font-medium text-ink">
                        {result.scenario.name}
                      </div>
                      {result.liveNowReason && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded border bg-amber/20 text-amber border-amber/40 uppercase tracking-wide"
                          title={`Live theme: ${result.liveNowReason}`}
                        >
                          live now
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-ink-faint">
                      {result.scenario.description}
                    </div>
                  </div>
                </div>
              </div>

              {/* Impact summary */}
              <div className="flex items-baseline gap-3 mt-3">
                <PrivateText
                  className={`text-lg font-mono tabular-nums font-semibold ${
                    isPositive ? "text-up" : "text-down"
                  }`}
                >
                  {formatPct(result.estimatedChangePercent)}
                </PrivateText>
                <PrivateText
                  className={`text-sm font-mono tabular-nums ${
                    isPositive ? "text-up/70" : "text-down/70"
                  }`}
                >
                  {formatMoney(result.estimatedChange)}
                </PrivateText>
              </div>

              {/* Estimated new value */}
              <div className="mt-1 text-[10px] text-ink-faint">
                Est. value: <PrivateText className="font-mono">{formatMoney(result.estimatedPortfolioValue, { signed: false })}</PrivateText>
              </div>
              {/* Funds a sector shock could not look through: named, never hidden.
                  Symbols are public data; no portfolio figure is printed here. */}
              {result.fundsWithoutSectorWeights && result.fundsWithoutSectorWeights.length > 0 && (
                <div className="mt-1 text-[10px] text-ink-faint whitespace-normal break-words">
                  <span className="font-mono">{result.fundsWithoutSectorWeights.join(", ")}</span>{" "}
                  {result.fundsWithoutSectorWeights.length === 1 ? "has" : "have"} no sector weights on file: a
                  sector shock applies only the market move to{" "}
                  {result.fundsWithoutSectorWeights.length === 1 ? "it" : "them"}.
                </div>
              )}
              {!isExpanded && result.optionsUnmodelled.count > 0 && (
                <div className="mt-1 text-[10px] text-ink-faint">
                  <Count value={result.optionsUnmodelled.count} />{" "}
                  {result.optionsUnmodelled.count === 1 ? "option" : "options"} not modelled
                </div>
              )}

              {/* ── Expanded detail ── */}
              {isExpanded && (
                <div className="mt-4 pt-4 border-t border-edge space-y-3" onClick={(e) => e.stopPropagation()}>
                  {/* Methodology — surface the recipe's per-factor math */}
                  {findRecipeMethodology(result.scenario.id) && (
                    <div className="bg-canvas border border-edge/60 rounded-lg p-3">
                      <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-1.5">
                        Methodology
                      </h4>
                      <p className="text-xs text-ink-dim leading-relaxed">
                        {findRecipeMethodology(result.scenario.id)}
                      </p>
                    </div>
                  )}

                  {/* Biggest losers */}
                  {result.biggestLosers.length > 0 && (
                    <div>
                      <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-1.5">
                        Most Impacted (Negative)
                      </h4>
                      <div className="space-y-1">
                        {result.biggestLosers.map((pos) => (
                          <div
                            key={pos.securityId}
                            className="flex items-center justify-between text-xs"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className="font-mono font-medium text-ink min-w-[8rem] truncate whitespace-nowrap"
                                title={formatCompactOptionSymbol(pos.symbol)}
                              >
                                {formatCompactOptionSymbol(pos.symbol)}
                              </span>
                              {pos.currentValue < 0 && (
                                <span className="text-[10px] px-1 py-0.5 rounded border border-edge text-ink-faint uppercase shrink-0">
                                  short
                                </span>
                              )}
                              {/* Recipe scenarios are factor-based \u2014 their beta
                                  is a hardcoded 1.0 for type compat, so showing
                                  it would be misleading. */}
                              {pos.ivSource ? (
                                <span
                                  className="text-ink-faint text-[10px] shrink-0 whitespace-nowrap"
                                  title={IV_SOURCE_TITLE[pos.ivSource]}
                                >
                                  {IV_SOURCE_LABEL[pos.ivSource]}
                                </span>
                              ) : (
                                !findRecipe(result.scenario.id) &&
                                !isOptionSecurityType(pos.securityType) && (
                                  <span className="text-ink-faint text-[10px] shrink-0" title={BETA_TITLE}>
                                    {"β"}{pos.beta.toFixed(1)}
                                  </span>
                                )
                              )}
                            </div>
                            <div className="flex items-center gap-3 shrink-0 ml-2">
                              <PrivateText className="font-mono tabular-nums text-down">
                                {formatPct(pos.changePercent)}
                              </PrivateText>
                              <PrivateText className="font-mono tabular-nums text-down/70 w-16 text-right">
                                {formatMoney(pos.estimatedChange)}
                              </PrivateText>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Biggest winners (for mixed scenarios) */}
                  {result.biggestWinners.length > 0 && (
                    <div>
                      <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-1.5">
                        Least Impacted / Positive
                      </h4>
                      <div className="space-y-1">
                        {result.biggestWinners.map((pos) => (
                          <div
                            key={pos.securityId}
                            className="flex items-center justify-between text-xs"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className="font-mono font-medium text-ink min-w-[8rem] truncate whitespace-nowrap"
                                title={formatCompactOptionSymbol(pos.symbol)}
                              >
                                {formatCompactOptionSymbol(pos.symbol)}
                              </span>
                              {pos.currentValue < 0 && (
                                <span className="text-[10px] px-1 py-0.5 rounded border border-edge text-ink-faint uppercase shrink-0">
                                  short
                                </span>
                              )}
                              {pos.ivSource ? (
                                <span
                                  className="text-ink-faint text-[10px] shrink-0 whitespace-nowrap"
                                  title={IV_SOURCE_TITLE[pos.ivSource]}
                                >
                                  {IV_SOURCE_LABEL[pos.ivSource]}
                                </span>
                              ) : (
                                !findRecipe(result.scenario.id) &&
                                !isOptionSecurityType(pos.securityType) && (
                                  <span className="text-ink-faint text-[10px] shrink-0" title={BETA_TITLE}>
                                    {"β"}{pos.beta.toFixed(1)}
                                  </span>
                                )
                              )}
                            </div>
                            <div className="flex items-center gap-3 shrink-0 ml-2">
                              <PrivateText className="font-mono tabular-nums text-up">
                                {formatPct(pos.changePercent)}
                              </PrivateText>
                              <PrivateText className="font-mono tabular-nums text-up/70 w-16 text-right">
                                {formatMoney(pos.estimatedChange)}
                              </PrivateText>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Options the scenario could not reprice: no figure is
                      estimated for them, so they are listed, not hidden. */}
                  {result.optionsUnmodelled.count > 0 && (
                    <div>
                      <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-1.5">
                        Options Not Modelled
                      </h4>
                      <p className="text-xs text-ink-dim mb-1.5">
                        {result.optionsUnmodelled.unpricedCount === result.optionsUnmodelled.count ? (
                          <PrivateText>
                            {result.optionsUnmodelled.count}{" "}
                            {result.optionsUnmodelled.count === 1 ? "option" : "options"}{" "}
                            with no price left out of this total. Their value is unknown, so no share is shown.
                          </PrivateText>
                        ) : (
                          <PrivateText>
                            {result.optionsUnmodelled.count}{" "}
                            {result.optionsUnmodelled.count === 1 ? "option" : "options"} (
                            {(result.optionsUnmodelled.valueShare * 100).toFixed(0)}% of option value) left out of
                            this total.
                            {result.optionsUnmodelled.unpricedCount > 0 &&
                              ` ${result.optionsUnmodelled.unpricedCount} of them ${
                                result.optionsUnmodelled.unpricedCount === 1 ? "has" : "have"
                              } no price, so ${
                                result.optionsUnmodelled.unpricedCount === 1 ? "its" : "their"
                              } value is not in that share.`}
                          </PrivateText>
                        )}{" "}
                        No figure is estimated for them.
                      </p>
                      <div className="space-y-1">
                        {result.positionImpacts
                          .filter((pos) => pos.unmodelledReason)
                          .map((pos) => (
                            <div key={pos.securityId} className="flex items-center justify-between gap-3 text-xs">
                              <span
                                className="font-mono font-medium text-ink truncate whitespace-nowrap min-w-[8rem]"
                                title={formatCompactOptionSymbol(pos.symbol)}
                              >
                                {formatCompactOptionSymbol(pos.symbol)}
                              </span>
                              <span className="text-ink-faint shrink-0">
                                {UNMODELLED_REASON_LABEL[pos.unmodelledReason!]}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Bonds the rate move could not price: no duration is
                      assumed for them, so they are listed, not hidden. */}
                  {result.bondsUnmodelled.count > 0 && (
                    <div>
                      <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-1.5">
                        Bonds Not Modelled
                      </h4>
                      <p className="text-xs text-ink-dim mb-1.5">
                        <PrivateText>
                          {result.bondsUnmodelled.count}{" "}
                          {result.bondsUnmodelled.count === 1 ? "bond" : "bonds"} (
                          {(result.bondsUnmodelled.valueShare * 100).toFixed(0)}% of bond value) left out of the
                          rate move.
                        </PrivateText>{" "}
                        No figure is estimated for them.
                      </p>
                      <div className="space-y-1">
                        {result.positionImpacts
                          .filter((pos) => pos.bondUnmodelledReason)
                          .map((pos) => (
                            <div key={pos.securityId} className="flex items-center justify-between gap-3 text-xs">
                              <span className="font-mono font-medium text-ink truncate whitespace-nowrap">
                                {pos.symbol}
                              </span>
                              <span className="text-ink-faint shrink-0">
                                {BOND_UNMODELLED_REASON_LABEL[pos.bondUnmodelledReason!]}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Fund duration note */}
                  {result.positionImpacts.some((pos) => pos.rateDurationSource === "fund-default") && (
                    <p className="text-[11px] text-ink-faint leading-relaxed">
                      Bond funds move with rates by their duration. A fund&apos;s duration defaults to{" "}
                      {FUND_DEFAULT_DURATION_YEARS} years when unknown.
                    </p>
                  )}

                  {/* Coupon source note */}
                  {result.positionImpacts.some(
                    (pos) => pos.rateDurationSource === "coupon-yield" || pos.rateDurationSource === "coupon-yield-name",
                  ) && (
                    <p className="text-[11px] text-ink-faint leading-relaxed">
                      A coupon bond&apos;s rate move comes from its coupon, maturity and price.
                      {result.positionImpacts.some((pos) => pos.rateDurationSource === "coupon-yield") &&
                        " Coupon from the broker where the broker gives one."}
                      {result.positionImpacts.some((pos) => pos.rateDurationSource === "coupon-yield-name") &&
                        " Coupon read from the bond’s name where the broker gives none."}
                    </p>
                  )}

                  {result.positionImpacts.some((pos) => isOptionSecurityType(pos.securityType)) && (
                    <p className="text-[11px] text-ink-faint leading-relaxed">
                      Options are repriced at the shocked price of their underlying (Black-Scholes, never below
                      exercise value). Held fixed: time to expiry, the interest rate, dividends.
                      {findRecipe(result.scenario.id)
                        ? " Preset scenarios keep option volatility held at today’s level."
                        : " Volatility moves only by the amount you set."}
                    </p>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Custom Scenario Builder ── */}
      <div className="border-t border-edge pt-4">
        <button
          onClick={() => {
            // Collapsing the builder must also drop the custom result — the
            // card had no other way to leave the screen once dismissed.
            // Opening it back up should just re-show the (empty) form.
            if (showBuilder) {
              setCustomResult(null);
              setCustomError(null);
              setExpanded(null);
            }
            setShowBuilder(!showBuilder);
          }}
          className="relative text-xs text-gold-ink hover:brightness-125 transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-2"
        >
          {showBuilder ? "Hide" : "Build"} Custom Scenario{" "}
          <span aria-hidden style={{ letterSpacing: "0.1em" }}>•••</span>
        </button>

        {showBuilder && (
          <div className="mt-3 space-y-3 rounded-xl border border-edge bg-panel p-4">
            {/* Market move */}
            <div>
              <label className="text-[10px] text-ink-faint uppercase tracking-wider block mb-1">
                Market Move
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={-50}
                  max={30}
                  value={customMarketMove}
                  onChange={(e) => setCustomMarketMove(Number(e.target.value))}
                  className="flex-1 accent-gold"
                />
                <span className={`font-mono text-sm tabular-nums w-14 text-right ${customMarketMove >= 0 ? "text-up" : "text-down"}`}>
                  {customMarketMove >= 0 ? "+" : ""}{customMarketMove}%
                </span>
              </div>
            </div>

            {/* Rate move */}
            <div>
              <label className="text-[10px] text-ink-faint uppercase tracking-wider block mb-1">
                Rate Move (basis points)
              </label>
              <input
                type="number"
                min={-CUSTOM_RATE_MOVE_LIMIT_BP}
                max={CUSTOM_RATE_MOVE_LIMIT_BP}
                value={customRateMove}
                onChange={(e) => setCustomRateMove(Number(e.target.value))}
                placeholder="0"
                className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink font-mono w-24 focus-ring"
              />
            </div>

            {/* Volatility change */}
            <div>
              <label className="text-[10px] text-ink-faint uppercase tracking-wider block mb-1">
                Volatility Change (points, options only)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={VOL_MOVE_MIN}
                  max={VOL_MOVE_MAX}
                  step={1}
                  value={customVolMove}
                  onChange={(e) => setCustomVolMove(Number(e.target.value))}
                  aria-label="Volatility change in points"
                  className="flex-1 accent-gold"
                />
                <span className="font-mono text-sm tabular-nums w-14 text-right text-ink">
                  {customVolMove > 0 ? "+" : ""}{customVolMove}
                </span>
              </div>
              <p className="text-[11px] text-ink-faint mt-1">
                Added to each option&apos;s own implied volatility. 0 keeps volatility at today&apos;s level.
              </p>
            </div>

            {/* Sector overrides */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] text-ink-faint uppercase tracking-wider">
                  Sector Overrides
                </label>
                <button
                  onClick={() => {
                    const used = new Set(customSectorOverrides.map((o) => o.sector).filter(Boolean));
                    const nextSector = SECTORS.find((sector) => !used.has(sector));
                    if (!nextSector) return;
                    setCustomSectorOverrides([
                      ...customSectorOverrides,
                      { sector: nextSector, move: -10 },
                    ]);
                  }}
                  disabled={new Set(customSectorOverrides.map((o) => o.sector).filter(Boolean)).size >= SECTORS.length}
                  className="relative text-[10px] text-gold-ink hover:brightness-125 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-2"
                >
                  + Add Sector
                </button>
              </div>
              {customSectorOverrides.map((override, i) => (
                <div key={i} className="flex items-center gap-2 mb-1.5">
                  <select
                    value={override.sector}
                    onChange={(e) => {
                      const updated = [...customSectorOverrides];
                      updated[i] = { ...updated[i], sector: e.target.value };
                      setCustomSectorOverrides(updated);
                    }}
                    className="bg-raised border border-edge rounded-lg px-2 py-1 text-xs text-ink flex-1 focus-ring"
                  >
                    {SECTORS.map((s) => {
                      const usedElsewhere = customSectorOverrides.some((other, j) => j !== i && other.sector === s);
                      return (
                        <option key={s} value={s} disabled={usedElsewhere}>
                          {s}
                        </option>
                      );
                    })}
                  </select>
                  <input
                    type="number"
                    min={-CUSTOM_SECTOR_MOVE_LIMIT_PCT}
                    max={CUSTOM_SECTOR_MOVE_LIMIT_PCT}
                    value={override.move}
                    onChange={(e) => {
                      const updated = [...customSectorOverrides];
                      updated[i] = {
                        ...updated[i],
                        move: Number(e.target.value),
                      };
                      setCustomSectorOverrides(updated);
                    }}
                    className="bg-raised border border-edge rounded-lg px-2 py-1 text-xs text-ink font-mono w-20 text-right focus-ring"
                  />
                  <span className="text-[10px] text-ink-faint">%</span>
                  <button
                    onClick={() =>
                      setCustomSectorOverrides(
                        customSectorOverrides.filter((_, j) => j !== i)
                      )
                    }
                    className="text-ink-faint hover:text-down text-xs"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {/* Compute button */}
            {customInputProblems.map((problem) => (
              <p key={problem} className="text-xs text-down">
                ⚠ {problem} Nothing is computed until it is in range.
              </p>
            ))}
            <button
              onClick={handleComputeCustom}
              disabled={customLoading || customInputProblems.length > 0}
              className="px-4 py-1.5 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 disabled:opacity-50 transition-[filter,scale] active:scale-[0.96] focus-ring"
            >
              {customLoading ? "Computing..." : "Compute Scenario"}
            </button>
            {customError && (
              <p className="text-xs text-down mt-2">{customError}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
