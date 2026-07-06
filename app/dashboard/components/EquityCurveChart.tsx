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

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
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

// ─── Data filtering ─────────────────────────────────────────────

function filterByRange<T extends { date: string }>(
  data: T[],
  rangeIndex: number
): T[] {
  if (data.length === 0) return data;

  const range = DATE_RANGES[rangeIndex];
  const today = new Date();

  if (range.label === "All") return data;

  let cutoff: Date;
  if (range.label === "YTD") {
    cutoff = new Date(today.getFullYear(), 0, 1);
  } else if (range.days) {
    cutoff = new Date(today.getTime() - range.days * 24 * 3600 * 1000);
  } else {
    return data;
  }

  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return data.filter((d) => d.date >= cutoffStr);
}

// ─── Chart data types ───────────────────────────────────────────

interface ChartPoint {
  date: string;
  total: number;
  holdings?: number;
  cash?: number;
}

// ─── Data merging ───────────────────────────────────────────────

/**
 * Merge monthly snapshots (authoritative) with daily valuations (inter-month shape).
 *
 * Monthly snapshots come from actual Vanguard statements and are always correct.
 * Daily valuations are computed and structurally lower (missing cash, incomplete
 * holdings). We use daily data only for inter-month *shape* (relative movement),
 * not absolute values. The algorithm:
 *
 * 1. Monthly snapshots are exact anchor points: snapA at date1, snapB at date2
 * 2. Daily values between them are normalized to map onto the snapA→snapB range
 *    proportionally — preserving the shape of daily fluctuations while ensuring
 *    the curve smoothly connects the monthly anchors with zero discontinuity
 * 3. If a segment has no usable daily data, the monthly points just connect directly
 */
function mergeSnapshotsAndDaily(
  snapshots: MonthlySnapshot[],
  dailyValuations?: DailyValuation[]
): ChartPoint[] {
  const sortedSnapshots = [...snapshots].sort(
    (a, b) => a.month_end_date.localeCompare(b.month_end_date)
  );

  if (!dailyValuations || dailyValuations.length === 0 || sortedSnapshots.length === 0) {
    return sortedSnapshots.map((s) => ({ date: s.month_end_date, total: s.total_value }));
  }

  const result: ChartPoint[] = [];

  for (let i = 0; i < sortedSnapshots.length; i++) {
    const snap = sortedSnapshots[i];
    result.push({ date: snap.month_end_date, total: snap.total_value });

    const nextSnap = sortedSnapshots[i + 1];
    if (!nextSnap) {
      // After last snapshot: append daily data scaled by last snapshot ratio
      addTrailingDailyData(result, snap, dailyValuations);
      continue;
    }

    // Collect daily values strictly between the two snapshot dates
    const between = dailyValuations.filter(
      (d) => d.valuation_date > snap.month_end_date && d.valuation_date < nextSnap.month_end_date
    );
    if (between.length === 0) continue;

    // Data quality gate: skip daily data when it's too noisy or incomplete.
    // Check if daily values are internally consistent (max/min range < 30% of mean).
    // Wild internal swings indicate incomplete holdings extraction that month.
    const dailyValues = between.map((d) => d.total_value);
    const dailyMin = Math.min(...dailyValues);
    const dailyMax = Math.max(...dailyValues);
    const dailyMean = dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length;
    if (dailyMean > 0 && (dailyMax - dailyMin) / dailyMean > 0.3) continue;

    // Shape-preserving normalization: map daily relative movement onto snapshot range.
    const dailyFirst = between[0].total_value;
    const dailyLast = between[between.length - 1].total_value;
    const dailyRange = dailyLast - dailyFirst;
    const snapRange = nextSnap.total_value - snap.total_value;
    const internalRange = dailyMax - dailyMin;

    // If the end-to-end change is small relative to internal swings, the data
    // is effectively "noisy flat" and shape normalization would amplify noise.
    // Fall back to time-based interpolation in that case.
    const useTimeInterpolation =
      Math.abs(dailyRange) < 1 ||
      Math.abs(dailyRange) < internalRange * 0.3;

    const daysBetween = (new Date(nextSnap.month_end_date).getTime() - new Date(snap.month_end_date).getTime()) / 86400000;

    for (let j = 0; j < between.length; j++) {
      const d = between[j];
      const daysIn = (new Date(d.valuation_date).getTime() - new Date(snap.month_end_date).getTime()) / 86400000;
      const t = daysIn / daysBetween;
      let total: number;

      if (useTimeInterpolation) {
        // Interpolate linearly by time between snapshots
        total = snap.total_value + t * snapRange;
      } else {
        // Map daily progress (0→1) onto snapshot range
        const progress = (d.total_value - dailyFirst) / dailyRange;
        total = snap.total_value + progress * snapRange;
      }

      result.push({ date: d.valuation_date, total });
    }
  }

  return result.sort((a, b) => a.date.localeCompare(b.date));
}

/** After the last monthly snapshot, append daily data using a fixed scale factor. */
function addTrailingDailyData(
  result: ChartPoint[],
  lastSnap: MonthlySnapshot,
  dailyValuations: DailyValuation[]
): void {
  const trailing = dailyValuations.filter(
    (d) => d.valuation_date > lastSnap.month_end_date
  );
  if (trailing.length === 0) return;

  // Find the daily value closest to the snapshot date for the scale reference
  const firstDaily = trailing[0];
  if (firstDaily.total_value === 0) return;

  const scale = lastSnap.total_value / firstDaily.total_value;
  if (scale > 2 || scale < 0.5) return; // daily data is too far off

  for (const d of trailing) {
    result.push({ date: d.valuation_date, total: d.total_value * scale });
  }
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

  // Merge monthly snapshots (authoritative) with daily valuations (inter-month granularity).
  // Monthly snapshots come from actual statements and are always correct.
  // Daily valuations are computed and may be inaccurate when holdings data is incomplete.
  const rawData: ChartPoint[] = mergeSnapshotsAndDaily(snapshots, dailyValuations);
  const hasDaily = dailyValuations && dailyValuations.length > 0;

  const data = filterByRange(rawData, selectedRange);
  const color = ACCOUNT_COLORS[accountName] ?? "#C9A44E";
  const hasCashData = hasDaily && data.some((d) => (d.cash ?? 0) > 0);

  // Day-level ticks for intra-year ranges — the month-year formatter repeated
  // "Jun 26" for every daily tick on 1M/3M/6M/YTD (deep-QA finding). The
  // multi-year "All" range keeps month-year; minTickGap thins dense daily data.
  const xTickFormatter =
    DATE_RANGES[selectedRange].label === "All" ? formatDate : shortDate;

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
                  ? "bg-gold/20 text-gold"
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
                    ? "bg-gold/20 text-gold"
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
                formatter={(value: any, name: any) => [
                  currencyTickFormatter(Number(value)),
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
                formatter={(value: any) => [
                  currencyTickFormatter(Number(value)),
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

      {!hasDaily && (
        <p className="text-[10px] text-ink-faint mt-2">
          Monthly resolution. Fetch historical prices via TWS for daily charts.
        </p>
      )}
    </div>
  );
}
