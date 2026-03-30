"use client";

import { useState, useEffect, useCallback } from "react";
import type { ScenarioResult } from "@/lib/compute/scenarios";

// ─── Formatters ──────────────────────────────────────────────────

function formatMoney(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
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

export function ScenarioModelingCard() {
  const [scenarios, setScenarios] = useState<ScenarioResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [customResult, setCustomResult] = useState<ScenarioResult | null>(null);
  const [customLoading, setCustomLoading] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  // Custom scenario form state
  const [customMarketMove, setCustomMarketMove] = useState(-10);
  const [customRateMove, setCustomRateMove] = useState(0);
  const [customSectorOverrides, setCustomSectorOverrides] = useState<
    { sector: string; move: number }[]
  >([]);

  // useCallback must be declared before any early returns (React hooks rules)
  const handleComputeCustom = useCallback(async () => {
    setCustomLoading(true);
    try {
      const sectorMoves: Record<string, number> = {};
      for (const o of customSectorOverrides) {
        if (o.sector && o.move !== 0) sectorMoves[o.sector] = o.move / 100;
      }

      const res = await fetch("/api/compute/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketMove: customMarketMove / 100,
          rateMove: customRateMove || undefined,
          sectorMoves: Object.keys(sectorMoves).length > 0 ? sectorMoves : undefined,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setCustomResult(json.data);
        setExpanded("custom");
      }
    } catch {
      // Silently fail
    } finally {
      setCustomLoading(false);
    }
  }, [customMarketMove, customRateMove, customSectorOverrides]);

  useEffect(() => {
    fetch("/api/compute/scenarios")
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setScenarios(json.data);
        else setError(json.error ?? "Failed to compute scenarios");
      })
      .catch(() => setError("Failed to fetch scenario analysis"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-raised border border-edge rounded-2xl p-6">
        <h3 className="text-sm font-medium text-ink mb-4">Scenario Modeling</h3>
        <div className="text-sm text-ink-faint animate-pulse">Computing scenarios...</div>
      </div>
    );
  }

  if (error || !scenarios || scenarios.length === 0) {
    return (
      <div className="bg-raised border border-edge rounded-2xl p-6">
        <h3 className="text-sm font-medium text-ink mb-4">Scenario Modeling</h3>
        <div className="text-sm text-ink-faint">
          {error ?? "No position data available for scenario analysis."}
        </div>
      </div>
    );
  }

  const currentValue = scenarios[0].currentPortfolioValue;

  // Combine preset scenarios with custom result
  const allScenarios = customResult
    ? [...scenarios, customResult]
    : scenarios;

  return (
    <div className="bg-raised border border-edge rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">Scenario Modeling</h3>
        <span className="text-xs text-ink-faint">
          Current: <span className="font-mono text-ink">{formatMoney(currentValue)}</span>
        </span>
      </div>

      <p className="text-xs text-ink-faint">
        Estimated portfolio impact under hypothetical market scenarios. Uses position-level beta
        estimates based on security type, sector, and style.
      </p>

      {/* ── Scenario cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {allScenarios.map((result) => {
          const isExpanded = expanded === result.scenario.id;
          const isPositive = result.estimatedChange >= 0;

          return (
            <button
              key={result.scenario.id}
              onClick={() => setExpanded(isExpanded ? null : result.scenario.id)}
              className={`text-left rounded-xl border p-4 transition-all ${
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
                    <div className="text-sm font-medium text-ink">
                      {result.scenario.name}
                    </div>
                    <div className="text-[10px] text-ink-faint">
                      {result.scenario.description}
                    </div>
                  </div>
                </div>
              </div>

              {/* Impact summary */}
              <div className="flex items-baseline gap-3 mt-3">
                <span
                  className={`text-lg font-mono tabular-nums font-semibold ${
                    isPositive ? "text-up" : "text-down"
                  }`}
                >
                  {formatPct(result.estimatedChangePercent)}
                </span>
                <span
                  className={`text-sm font-mono tabular-nums ${
                    isPositive ? "text-up/70" : "text-down/70"
                  }`}
                >
                  {formatMoney(result.estimatedChange)}
                </span>
              </div>

              {/* Estimated new value */}
              <div className="mt-1 text-[10px] text-ink-faint">
                Est. value: <span className="font-mono">{formatMoney(result.estimatedPortfolioValue)}</span>
              </div>

              {/* ── Expanded detail ── */}
              {isExpanded && (
                <div className="mt-4 pt-4 border-t border-edge space-y-3" onClick={(e) => e.stopPropagation()}>
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
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-medium text-ink w-16">
                                {pos.symbol}
                              </span>
                              <span className="text-ink-faint text-[10px]">
                                {"\u03B2"}{pos.beta.toFixed(1)}
                              </span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="font-mono tabular-nums text-down">
                                {formatPct(pos.changePercent)}
                              </span>
                              <span className="font-mono tabular-nums text-down/70 w-16 text-right">
                                {formatMoney(pos.estimatedChange)}
                              </span>
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
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-medium text-ink w-16">
                                {pos.symbol}
                              </span>
                              <span className="text-ink-faint text-[10px]">
                                {"\u03B2"}{pos.beta.toFixed(1)}
                              </span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="font-mono tabular-nums text-up">
                                {formatPct(pos.changePercent)}
                              </span>
                              <span className="font-mono tabular-nums text-up/70 w-16 text-right">
                                {formatMoney(pos.estimatedChange)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
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
          onClick={() => setShowBuilder(!showBuilder)}
          className="text-xs text-gold hover:brightness-125 transition-colors"
        >
          {showBuilder ? "Hide" : "Build"} Custom Scenario {showBuilder ? "▲" : "▼"}
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
                value={customRateMove}
                onChange={(e) => setCustomRateMove(Number(e.target.value))}
                placeholder="0"
                className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink font-mono w-24 focus-ring"
              />
            </div>

            {/* Sector overrides */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] text-ink-faint uppercase tracking-wider">
                  Sector Overrides
                </label>
                <button
                  onClick={() =>
                    setCustomSectorOverrides([
                      ...customSectorOverrides,
                      { sector: SECTORS[0], move: -10 },
                    ])
                  }
                  className="text-[10px] text-gold hover:brightness-125"
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
                    {SECTORS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
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
            <button
              onClick={handleComputeCustom}
              disabled={customLoading}
              className="px-4 py-1.5 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 disabled:opacity-50 transition-all focus-ring"
            >
              {customLoading ? "Computing..." : "Compute Scenario"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
