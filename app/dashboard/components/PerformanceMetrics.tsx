"use client";

import { useState, useCallback } from "react";
import type { PortfolioTotals } from "@/lib/queries/dashboard";
import { Money, Pct } from "@/lib/privacy/components";

export interface TwrPeriod {
  label: string;
  totalReturn: number | null;
  annualizedReturn: number | null;
  xirr?: number | null;
}

/** Format a YYYY-MM-DD string for display */
function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

export function PerformanceMetrics({
  totals,
  twrPeriods = [],
  dataQuality,
}: {
  totals: PortfolioTotals;
  twrPeriods?: TwrPeriod[];
  /** Worst data quality across all accounts: 'live' | 'recent' | 'estimated' | null */
  dataQuality?: string | null;
}) {
  const [selectedPeriod, setSelectedPeriod] = useState(0);
  const [customMode, setCustomMode] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [customResult, setCustomResult] = useState<TwrPeriod | null>(null);
  const [customLoading, setCustomLoading] = useState(false);

  const [customError, setCustomError] = useState<string | null>(null);

  const fetchCustomRange = useCallback(async (start: string, end: string) => {
    setCustomError(null);
    if (!start || !end) return;
    if (start >= end) {
      setCustomError("Start date must be before end date");
      setCustomResult(null);
      return;
    }
    setCustomLoading(true);
    try {
      const [twrRes, xirrRes] = await Promise.all([
        fetch(`/api/compute/twr?startDate=${start}&endDate=${end}`),
        fetch(`/api/compute/xirr?startDate=${start}&endDate=${end}`),
      ]);
      const twrJson = await twrRes.json();
      const xirrJson = await xirrRes.json();
      const twr = twrJson.success ? twrJson.data : null;
      const xirr = xirrJson.success ? xirrJson.data : null;
      setCustomResult({
        label: `${formatDateLabel(start)} – ${formatDateLabel(end)}`,
        totalReturn: twr?.totalReturn ?? null,
        annualizedReturn: twr?.annualizedReturn ?? null,
        xirr: xirr?.xirr ?? null,
      });
    } catch {
      setCustomResult(null);
    } finally {
      setCustomLoading(false);
    }
  }, []);

  if (totals.snapshotCount === 0) {
    return null;
  }

  const activePeriod = customMode ? customResult : (twrPeriods[selectedPeriod] ?? null);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-6 flex-wrap">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-ink-faint uppercase tracking-widest">
              Portfolio Value
            </span>
            {totals.latestDate && (
              <span className="text-[10px] text-ink-faint font-mono">
                as of {totals.oldestDate && totals.oldestDate !== totals.latestDate
                  ? `${formatDateLabel(totals.oldestDate)} – ${formatDateLabel(totals.latestDate)}`
                  : formatDateLabel(totals.latestDate)}
              </span>
            )}
          </div>
          <div className="text-4xl font-semibold font-mono tabular-nums tracking-tight mt-1">
            {dataQuality === "estimated" ? "~" : ""}
            <Money value={totals.totalValue} />
            {dataQuality === "estimated" && (
              <span
                className="text-sm text-gold-ink font-normal ml-2"
                title="Some account data is estimated from stale prices or old statements"
              >
                est.
              </span>
            )}
          </div>
        </div>

        {totals.totalPreviousValue > 0 && (
          <div className="flex items-center gap-3">
            <Money
              value={totals.totalChange}
              signed
              className={`text-lg font-mono tabular-nums ${
                totals.totalChange >= 0 ? "text-up" : "text-down"
              }`}
            />
            <Pct
              value={totals.totalChangePercent}
              digits={2}
              signed
              className={`text-sm px-2 py-0.5 rounded font-mono tabular-nums ${
                totals.totalChangePercent >= 0
                  ? "bg-up/20 text-up"
                  : "bg-down/20 text-down"
              }`}
            />
          </div>
        )}
      </div>

      {twrPeriods.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
            <div className="flex items-center gap-1.5 overflow-x-auto" role="group" aria-label="Performance period">
              {twrPeriods.map((period, i) => (
                <button
                  key={period.label}
                  onClick={() => {
                    setSelectedPeriod(i);
                    setCustomMode(false);
                  }}
                  aria-pressed={!customMode && i === selectedPeriod}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors focus-ring ${
                    !customMode && i === selectedPeriod
                      ? "bg-gold/20 text-gold-ink"
                      : "text-ink-faint hover:text-ink hover:bg-panel"
                  }`}
                >
                  {period.label}
                </button>
              ))}
              <button
                onClick={() => setCustomMode(true)}
                aria-pressed={customMode}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors focus-ring ${
                  customMode
                    ? "bg-gold/20 text-gold-ink"
                    : "text-ink-faint hover:text-ink hover:bg-panel"
                }`}
              >
                Custom
              </button>
            </div>

            {activePeriod && activePeriod.totalReturn !== null && (
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-ink-faint uppercase tracking-widest">
                  TWR
                </span>
                <Pct
                  value={activePeriod.totalReturn * 100}
                  digits={2}
                  signed
                  className={`text-lg font-mono tabular-nums font-semibold ${
                    activePeriod.totalReturn >= 0 ? "text-up" : "text-down"
                  }`}
                />
                {activePeriod.annualizedReturn !== null && (
                  <span className="text-xs text-ink-faint font-mono tabular-nums">
                    (<Pct value={activePeriod.annualizedReturn * 100} digits={2} signed /> ann.)
                  </span>
                )}
              </div>
            )}

            {activePeriod && 'xirr' in activePeriod && (
              <div className="flex items-center gap-3 border-l border-edge pl-3">
                <span className="text-[11px] text-ink-faint uppercase tracking-widest">
                  XIRR
                </span>
                <Pct
                  value={activePeriod.xirr == null ? null : activePeriod.xirr * 100}
                  digits={2}
                  signed
                  className={`text-lg font-mono tabular-nums font-semibold ${
                    activePeriod.xirr == null
                      ? "text-ink-faint"
                      : activePeriod.xirr >= 0 ? "text-up" : "text-down"
                  }`}
                />
              </div>
            )}

            {customMode && customLoading && (
              <span className="text-xs text-ink-faint animate-pulse">Computing...</span>
            )}
          </div>

          {customMode && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <label className="text-[11px] text-ink-faint uppercase tracking-widest">From</label>
              <input
                type="date"
                value={customStart}
                onChange={(e) => {
                  setCustomStart(e.target.value);
                  if (e.target.value && customEnd && e.target.value < customEnd) {
                    fetchCustomRange(e.target.value, customEnd);
                  }
                }}
                className="bg-panel border border-edge rounded-lg px-2.5 py-1.5 text-xs font-mono text-ink focus:outline-none focus:ring-1 focus:ring-gold/50"
              />
              <label className="text-[11px] text-ink-faint uppercase tracking-widest">To</label>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => {
                  setCustomEnd(e.target.value);
                  if (customStart && e.target.value && customStart < e.target.value) {
                    fetchCustomRange(customStart, e.target.value);
                  }
                }}
                className="bg-panel border border-edge rounded-lg px-2.5 py-1.5 text-xs font-mono text-ink focus:outline-none focus:ring-1 focus:ring-gold/50"
              />
              {customError && (
                <span className="text-xs text-down font-mono">{customError}</span>
              )}
              {!customError && customResult && customResult.totalReturn === null && !customLoading && (
                <span className="text-xs text-ink-faint font-mono">No data for this range</span>
              )}
              {customResult && (
                <span className="text-xs text-ink-faint font-mono">
                  {customResult.label}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
