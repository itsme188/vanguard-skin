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
  type EquityFlow,
  equityCurveGranularity,
  equityCurveRangeCaption,
  equityCurveTimeTicks,
  equityCurveTooltipDate,
  equityCurveYAxis,
  formatAnchoredTooltipValue,
  formatEquityCurveDate,
  formatEquityCurveTick,
  isoDateToEpochMs,
  toTimeSeries,
  type AnchoredCurveSummary,
  type EquityCurveGranularity,
} from "@/lib/chart/equity-curve-anchor";

// Hex colors are intentionally hardcoded here — these must stay visible in both
// light (Amber) and dark (Bloomberg-pro) themes. #60A5FA (blue-400) and #34D399
// (emerald-400) don't map to a single Tailwind token that works cross-theme.
const ACCOUNT_COLORS: Record<string, string> = {
  "Vanguard Taxable": "#C9A44E",
  "Vanguard Roth IRA": "#60A5FA",
  IBKR: "#34D399",
};

// Selected state of the range pills and the Split toggle. Plain gold-ink on
// the gold tint is 4.3:1 on the light panel, under the 4.5:1 floor for 11px
// text; the light theme darkens it, the dark theme keeps the plain token.
// Pinned by tests/dashboard/equity-curve-range-pill.test.ts.
const ACTIVE_PILL =
  "bg-gold/20 text-[color:color-mix(in_srgb,var(--gold-ink)_80%,black)] [[data-theme=dark]_&]:text-gold-ink";

// Resolution badge: describes the range on screen, not the whole history.
const GRANULARITY_LABEL: Record<EquityCurveGranularity, string> = {
  daily: "Daily",
  monthly: "Monthly",
  mixed: "Mixed",
};
const GRANULARITY_TITLE: Record<EquityCurveGranularity, string> = {
  daily: "This range has a value for every trading day.",
  monthly: "This range is plotted from statement dates only.",
  mixed: "Daily values cover only part of this range; the rest is plotted from statement or snapshot dates.",
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

// The horizontal axis is elapsed time (epoch ms at UTC midnight), so every
// date label is formatted in UTC by `formatEquityCurveDate`.
function formatDate(date: string): string {
  return formatEquityCurveDate(isoDateToEpochMs(date), "month-year");
}

function formatDateFull(date: string): string {
  return formatEquityCurveDate(isoDateToEpochMs(date), "full");
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
  dailyValuations?: DailyValuation[],
  flows: EquityFlow[] = []
): { points: ChartPoint[]; summary: AnchoredCurveSummary } {
  const { points, summary } = anchorDailiesToStatements(
    snapshots.map((s) => ({ date: s.month_end_date, value: s.total_value })),
    (dailyValuations ?? []).map((d) => ({ date: d.valuation_date, value: d.total_value })),
    flows
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
  return formatEquityCurveDate(isoDateToEpochMs(iso), "day");
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

  // Time axis: each row is placed at its date, in date order.
  const series = toTimeSeries(data);
  const xAxisTime = equityCurveTimeTicks(series[0]?.t, series[series.length - 1]?.t);

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
        <LineChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            ticks={xAxisTime.ticks}
            tickFormatter={(t: number) => formatEquityCurveTick(t, xAxisTime.unit)}
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
            labelFormatter={(label, payload) => shortDate(equityCurveTooltipDate(label, payload) ?? "")}
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
  flows,
  accountName,
  showBreakdown = false,
}: {
  snapshots: MonthlySnapshot[];
  dailyValuations?: DailyValuation[];
  /** External deposits (+) and withdrawals (-) by date; used only by the bad-data spread check, never rendered. */
  flows?: EquityFlow[];
  accountName: string;
  showBreakdown?: boolean;
}) {
  const [selectedRange, setSelectedRange] = useState(5); // default: All
  const [showLines, setShowLines] = useState(showBreakdown);
  const currencyTickFormatter = usePrivateFormatter(formatCurrency);
  const currencyTooltipFormatter = usePrivateFormatter(formatUSD);

  // Statement values are authoritative and plot exactly; recorded daily values
  // keep their shape, corrected additively onto the statements.
  const { points: rawData, summary: anchorSummary } = buildChartData(snapshots, dailyValuations, flows);
  const hasDaily = dailyValuations && dailyValuations.length > 0;
  const anchorCaption = equityCurveRangeCaption(anchorSummary, rangeCutoffIso(selectedRange));

  // Range filter on the real dates, then each point gets its position on the
  // time axis, in date order.
  const data = toTimeSeries(filterByRange(rawData, selectedRange));
  const color = ACCOUNT_COLORS[accountName] ?? "#C9A44E";
  const hasCashData = hasDaily && data.some((d) => (d.cash ?? 0) > 0);
  // Badge and tooltip date follow the points in the selected range: one daily
  // row anywhere used to label four years of month-end points "Daily".
  const granularity = equityCurveGranularity(data.map((d) => d.date));
  // The value axis frames the selected range (a zero-based axis flattened a
  // month's move into a few pixels). Split mode also plots holdings and cash.
  const yAxis = equityCurveYAxis(
    data.flatMap((d) =>
      showLines && hasCashData ? [d.total, d.holdings ?? d.total, d.cash ?? d.total] : [d.total]
    )
  );

  // Calendar ticks sized to the range on screen (week days of the month on
  // 1M, month starts on a year, quarter or year starts on a long history), so
  // a label never repeats and ticks never crowd where the points are dense.
  const xAxisTime = equityCurveTimeTicks(data[0]?.t, data[data.length - 1]?.t);
  const xTickFormatter = (t: number) => formatEquityCurveTick(t, xAxisTime.unit);
  const xTicks = xAxisTime.ticks;

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

  const dateFormatter = granularity === "monthly" ? formatDate : formatDateFull;

  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-ink-dim">Equity Curve</h3>
          {granularity && (
            <span
              title={GRANULARITY_TITLE[granularity]}
              className="text-[10px] text-ink-faint bg-raised px-1.5 py-0.5 rounded"
            >
              {GRANULARITY_LABEL[granularity]}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Breakdown toggle (only when daily data with cash is available) */}
          {hasCashData && (
            <button
              onClick={() => setShowLines((v) => !v)}
              aria-pressed={showLines}
              className={`text-[11px] font-medium px-2 py-1 rounded transition-colors ${
                showLines
                  ? ACTIVE_PILL
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
                aria-pressed={i === selectedRange}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                  i === selectedRange
                    ? ACTIVE_PILL
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
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={xTickFormatter}
                ticks={xTicks}
                minTickGap={40}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={yAxis?.domain}
                ticks={yAxis?.ticks}
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
                labelFormatter={(label, payload) => dateFormatter(equityCurveTooltipDate(label, payload) ?? "")}
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
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={xTickFormatter}
                ticks={xTicks}
                minTickGap={40}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={yAxis?.domain}
                ticks={yAxis?.ticks}
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
                labelFormatter={(label, payload) => dateFormatter(equityCurveTooltipDate(label, payload) ?? "")}
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
