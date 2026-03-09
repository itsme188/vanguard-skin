"use client";

import { useState } from "react";
import type { PortfolioTotals } from "@/lib/queries/dashboard";

export interface TwrPeriod {
  label: string;
  totalReturn: number | null;
  annualizedReturn: number | null;
  xirr?: number | null;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatReturn(value: number | null): string {
  if (value === null) return "\u2014";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

export function PerformanceMetrics({
  totals,
  twrPeriods = [],
}: {
  totals: PortfolioTotals;
  twrPeriods?: TwrPeriod[];
}) {
  const [selectedPeriod, setSelectedPeriod] = useState(0);

  if (totals.snapshotCount === 0) {
    return null;
  }

  const activePeriod = twrPeriods[selectedPeriod] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-6 flex-wrap">
        <div>
          <span className="text-[11px] text-ink-faint uppercase tracking-widest">
            Portfolio Value
          </span>
          <div className="text-4xl font-semibold font-mono tabular-nums tracking-tight mt-1">
            {formatCurrency(totals.totalValue)}
          </div>
        </div>

        {totals.totalPreviousValue > 0 && (
          <div className="flex items-center gap-3">
            <span
              className={`text-lg font-mono tabular-nums ${
                totals.totalChange >= 0 ? "text-up" : "text-down"
              }`}
            >
              {totals.totalChange >= 0 ? "+" : ""}
              {formatCurrency(totals.totalChange)}
            </span>
            <span
              className={`text-sm px-2 py-0.5 rounded font-mono tabular-nums ${
                totals.totalChangePercent >= 0
                  ? "bg-up-tint text-up"
                  : "bg-down-tint text-down"
              }`}
            >
              {totals.totalChangePercent >= 0 ? "+" : ""}
              {totals.totalChangePercent.toFixed(2)}%
            </span>
          </div>
        )}
      </div>

      {twrPeriods.length > 0 && (
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            {twrPeriods.map((period, i) => (
              <button
                key={period.label}
                onClick={() => setSelectedPeriod(i)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  i === selectedPeriod
                    ? "bg-gold-glow text-gold"
                    : "text-ink-faint hover:text-ink hover:bg-panel"
                }`}
              >
                {period.label}
              </button>
            ))}
          </div>

          {activePeriod && activePeriod.totalReturn !== null && (
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-ink-faint uppercase tracking-widest">
                TWR
              </span>
              <span
                className={`text-lg font-mono tabular-nums font-semibold ${
                  activePeriod.totalReturn >= 0 ? "text-up" : "text-down"
                }`}
              >
                {formatReturn(activePeriod.totalReturn)}
              </span>
              {activePeriod.annualizedReturn !== null && (
                <span className="text-xs text-ink-faint font-mono tabular-nums">
                  ({formatReturn(activePeriod.annualizedReturn)} ann.)
                </span>
              )}
            </div>
          )}

          {activePeriod && activePeriod.xirr != null && (
            <div className="flex items-center gap-3 border-l border-edge pl-3">
              <span className="text-[11px] text-ink-faint uppercase tracking-widest">
                XIRR
              </span>
              <span
                className={`text-lg font-mono tabular-nums font-semibold ${
                  activePeriod.xirr >= 0 ? "text-up" : "text-down"
                }`}
              >
                {formatReturn(activePeriod.xirr)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
