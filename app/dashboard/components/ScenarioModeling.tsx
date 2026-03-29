"use client";

import { useState, useEffect } from "react";
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

export function ScenarioModelingCard() {
  const [scenarios, setScenarios] = useState<ScenarioResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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
        {scenarios.map((result) => {
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
    </div>
  );
}
