"use client";

import { useState } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { MonthlySnapshot } from "@/lib/types";
import type { DailyValuation } from "@/lib/queries/daily-valuations";
import { usePrivateFormatter } from "@/lib/privacy/components";
import { formatUSD } from "@/lib/format";
import {
  anchorDailiesToStatements,
  equityCurveRangeCaption,
  formatAnchoredTooltipValue,
  type AnchoredCurveSummary,
} from "@/lib/chart/equity-curve-anchor";

// Hex colors are intentionally hardcoded here — these must stay visible in both
// light (Amber) and dark (Bloomberg-pro) themes. #60A5FA (blue-400) and #34D399
// (emerald-400) don't map to a single Tailwind token that works cross-theme.
const ACCOUNT_COLORS: Record<string, string> = {
  "Vanguard Taxable": "#C9A44E",
  "Vanguard Roth IRA": "#60A5FA",
  IBKR: "#34D399",
};

// ─── Date Range Periods ─────────────────────────────────────────

interface DateRange {
  label: string;
  days: number | null; // null = all
}

const DATE_RANGES: DateRange[] = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "YTD", days: null }, // special: from Jan 1
  { label: "1Y", days: 365 },
  { label: "All", days: null },
];

// ─── Formatters ─────────────────────────────────────────────────

export function formatCurrency(value: number): string {
  // One decimal place is not enough resolution for an axis tick: a gridline at
  // $1,350,000 rendered as "$1.4M" mislabels the line by $50K. Keep up to two
  // decimals and strip trailing zeros so round values stay compact ($2M, $1.5M)
  // while a half-step tick reads honestly ($1.35M). The same rounding defect
  // exists one magnitude down ($12,500 -> "$13K" mislabels by $500), so the K
  // band uses the identical two-decimals-trimmed rule.
  if (value >= 1_000_000) return `$${trimZeros((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `$${trimZeros((value / 1_000).toFixed(2))}K`;
  return `$${value.toFixed(0)}`;
}

function trimZeros(fixed: string): string {
  return fixed.replace(/\.?0+$/, "");
}

function formatDate(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function formatDateFull(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * One tick per calendar month (the first data point of each month), thinned
 * to at most `maxTicks` by even stepping. Used for the "All" range where
 * Recharts' evenly-spaced auto ticks land several times inside the dense
 * daily-data stretch and the month-year formatter then repeats itself.
 */
function monthStartTicks<T extends { date: string }>(
  data: T[],
  maxTicks = 12
): string[] {
  const seen = new Set<string>();
  const ticks: string[] = [];
  for (const d of data) {
    const monthKey = d.date.slice(0, 7);
    if (!seen.has(monthKey)) {
      seen.add(monthKey);
      ticks.push(d.date);
    }
  }
  if (ticks.length <= maxTicks) return ticks;
  const step = Math.ceil(ticks.length / maxTicks);
  return ticks.filter((_, i) => i % step === 0);
}

// ─── Data filtering ─────────────────────────────────────────────

/** First date the selected range shows (YYYY-MM-DD); null for All. */
function rangeCutoffIso(rangeIndex: number): string | null {
  const range = DATE_RANGES[rangeIndex];
  const today = new Date();
  if (range.label === "All") return null;
  let cutoff: Date;
  if (range.label === "YTD") {
    cutoff = new Date(today.getFullYear(), 0, 1);
  } else if (range.days) {
    cutoff = new Date(today.getTime() - range.days * 24 * 3600 * 1000);
  } else {
    return null;
  }
  return cutoff.toISOString().slice(0, 10);
}

function filterByRange<T extends { date: string }>(
  data: T[],
  rangeIndex: number
): T[] {
  if (data.length === 0) return data;
  const cutoffStr = rangeCutoffIso(rangeIndex);
  if (cutoffStr === null) return data;
  return data.filter((d) => d.date >= cutoffStr);
}

// ─── Chart data types ───────────────────────────────────────────

interface ChartPoint {
  date: string;
  total: number;
  /** Recorded daily valuation behind this point; null for a statement anchor. */
  recordedValue: number | null;
  holdings?: number;
  cash?: number;
}

// ─── Data merging ───────────────────────────────────────────────

/**
 * Statement values (month-end snapshots) plot exactly; recorded daily values
 * keep their shape and are corrected additively onto the statements. The math
 * lives in `lib/chart/equity-curve-anchor.ts` (pure, unit-tested).
 */
function buildChartData(
  snapshots: MonthlySnapshot[],
  dailyValuations?: DailyValuation[]
): { points: ChartPoint[]; summary: AnchoredCurveSummary } {
  const { points, summary } = anchorDailiesToStatements(
    snapshots.map((s) => ({ date: s.month_end_date, value: s.total_value })),
    (dailyValuations ?? []).map((d) => ({ date: d.valuation_date, value: d.total_value }))
  );
  return {
    points: points.map((p) => ({ date: p.date, total: p.value, recordedValue: p.recordedValue })),
    summary,
  };
}

// ─── Performance benchmark overlay chart ────────────────────────

export interface PerformanceCurveData {
  date: string;
  portfolio: number; // normalized to 100 at period start
  benchmark: number; // normalized to 100 at period start
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

export function PerformanceCurveChart({
  data,
  benchmarkSymbol,
}: {
  data: PerformanceCurveData[];
  benchmarkSymbol: string;
}) {
  // Portfolio values are portfolio-derived — mask under privacy mode
  const fmt = usePrivateFormatter((v: number) => `${v.toFixed(1)}`);

  if (data.length === 0) {
    return (
      <div className="bg-panel rounded-xl p-4 text-sm text-ink-faint">
        No equity curve data available for this period.
      </div>
    );
  }

  return (
    <div className="bg-panel rounded-xl p-4 card-elev">
      <h3 className="text-sm font-medium text-ink mb-3">
        Equity curve{" "}
        <span className="text-ink-faint font-normal">(indexed to 100)</span>
      </h3>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            minTickGap={40}
            tick={{ fontSize: 11, fill: "var(--ink-faint)" }}
          />
          <YAxis
            tickFormatter={fmt}
            tick={{ fontSize: 11, fill: "var(--ink-faint)" }}
            width={42}
          />
          <Tooltip
            formatter={(value: unknown, name: unknown) => [
              fmt(Number(value)),
              String(name ?? ""),
            ]}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            labelFormatter={(label: any) => shortDate(String(label))}
            contentStyle={{
              background: "var(--panel)",
              border: "1px solid var(--edge)",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            formatter={(name) => (
              <span style={{ color: "var(--ink-dim)" }}>{name}</span>
            )}
          />
          <Line
            type="monotone"
            dataKey="portfolio"
            stroke="#C9A44E"
            strokeWidth={2}
            dot={false}
            name="Portfolio"
          />
          <Line
            type="monotone"
            dataKey="benchmark"
            stroke="#60A5FA"
            strokeWidth={2}
            dot={false}
            name={benchmarkSymbol}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Per-account historical curve ────────────────────────────────

export function EquityCurveChart({
  snapshots,
  dailyValuations,
  accountName,
  showBreakdown = false,
}: {
  snapshots: MonthlySnapshot[];
  dailyValuations?: DailyValuation[];
  accountName: string;
  showBreakdown?: boolean;
}) {
  const [selectedRange, setSelectedRange] = useState(5); // default: All
  const [showLines, setShowLines] = useState(showBreakdown);
  const currencyTickFormatter = usePrivateFormatter(formatCurrency);
  const currencyTooltipFormatter = usePrivateFormatter(formatUSD);

  // Statement values are authoritative and plot exactly; recorded daily values
  // keep their shape, corrected additively onto the statements.
  const { points: rawData, summary: anchorSummary } = buildChartData(snapshots, dailyValuations);
  const hasDaily = dailyValuations && dailyValuations.length > 0;
  const anchorCaption = equityCurveRangeCaption(anchorSummary, rangeCutoffIso(selectedRange));

  const data = filterByRange(rawData, selectedRange);
  const color = ACCOUNT_COLORS[accountName] ?? "#C9A44E";
  const hasCashData = hasDaily && data.some((d) => (d.cash ?? 0) > 0);

  // Day-level ticks for intra-year ranges — the month-year formatter repeated
  // "Jun 26" for every daily tick on 1M/3M/6M/YTD (deep-QA finding). The
  // multi-year "All" range keeps month-year but needs EXPLICIT month-start
  // ticks: evenly-spaced auto-ticks cluster inside the dense daily stretch
  // (sparse monthly anchors early, daily bars recent), emitting "Apr 26" ×3
  // (deep-QA 2026-07-07). One tick per month, thinned to ≤12.
  const isAllRange = DATE_RANGES[selectedRange].label === "All";
  const xTickFormatter = isAllRange ? formatDate : shortDate;
  const xTicks = isAllRange ? monthStartTicks(data) : undefined;

  if (rawData.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
        <p className="text-ink-faint text-sm">
          No snapshot data for this account yet. Import monthly statements to
          see the equity curve.
        </p>
      </div>
    );
  }

  const dateFormatter = hasDaily ? formatDateFull : formatDate;

  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-ink-dim">Equity Curve</h3>
          {hasDaily && (
            <span className="text-[10px] text-ink-faint bg-raised px-1.5 py-0.5 rounded">
              Daily
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Breakdown toggle (only when daily data with cash is available) */}
          {hasCashData && (
            <button
              onClick={() => setShowLines((v) => !v)}
              className={`text-[11px] font-medium px-2 py-1 rounded transition-colors ${
                showLines
                  ? "bg-gold/20 text-gold-ink"
                  : "text-ink-faint hover:text-ink hover:bg-raised"
              }`}
            >
              Split
            </button>
          )}

          {/* Date range pills */}
          <div className="flex items-center gap-0.5">
            {DATE_RANGES.map((range, i) => (
              <button
                key={range.label}
                onClick={() => setSelectedRange(i)}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                  i === selectedRange
                    ? "bg-gold/20 text-gold-ink"
                    : "text-ink-faint hover:text-ink hover:bg-raised"
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="h-[220px] sm:h-[250px] md:h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          {showLines && hasCashData ? (
            // Multi-line chart: Total + Holdings + Cash
            <LineChart
              data={data}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#1E2534"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tickFormatter={xTickFormatter}
                ticks={xTicks}
                minTickGap={40}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={currencyTickFormatter}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  background: "#151A24",
                  border: "1px solid #2A3244",
                  borderRadius: "8px",
                  color: "#E2E6F0",
                  fontSize: 12,
                }}
                labelFormatter={(label) => dateFormatter(String(label))}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(value: any, name: any, item: any) => [
                  String(name) === "total"
                    ? formatAnchoredTooltipValue(
                        Number(value),
                        (item?.payload as ChartPoint | undefined)?.recordedValue,
                        currencyTooltipFormatter
                      )
                    : currencyTooltipFormatter(Number(value)),
                  String(name) === "total"
                    ? "Total Value"
                    : String(name) === "holdings"
                      ? "Holdings"
                      : "Cash",
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, color: "#8891A5" }}
                formatter={(value: string) =>
                  value === "total"
                    ? "Total"
                    : value === "holdings"
                      ? "Holdings"
                      : "Cash"
                }
              />
              <Line
                type="monotone"
                dataKey="total"
                stroke={color}
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="holdings"
                stroke="#60A5FA"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="cash"
                stroke="#34D399"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                dot={false}
              />
            </LineChart>
          ) : (
            // Single area chart (default)
            <AreaChart
              data={data}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient
                  id={`eq-${accountName.replace(/\s/g, "")}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#1E2534"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tickFormatter={xTickFormatter}
                ticks={xTicks}
                minTickGap={40}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={currencyTickFormatter}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  background: "#151A24",
                  border: "1px solid #2A3244",
                  borderRadius: "8px",
                  color: "#E2E6F0",
                  fontSize: 12,
                }}
                labelFormatter={(label) => dateFormatter(String(label))}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(value: any, _name: any, item: any) => [
                  formatAnchoredTooltipValue(
                    Number(value),
                    (item?.payload as ChartPoint | undefined)?.recordedValue,
                    currencyTooltipFormatter
                  ),
                  "Value",
                ]}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke={color}
                fill={`url(#eq-${accountName.replace(/\s/g, "")})`}
                strokeWidth={2}
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>

      {anchorCaption && (
        <p className="text-[10px] text-ink-faint mt-2">{anchorCaption}</p>
      )}
      {!hasDaily && (
        <p className="text-[10px] text-ink-faint mt-2">
          Monthly resolution. Fetch historical prices via TWS for daily charts.
        </p>
      )}
    </div>
  );
}
