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

// ─── Component ──────────────────────────────────────────────────

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

  // Use daily data if available, otherwise fall back to monthly
  const hasDaily = dailyValuations && dailyValuations.length > 0;

  const rawData: ChartPoint[] = hasDaily
    ? dailyValuations.map((d) => ({
        date: d.valuation_date,
        total: d.total_value,
        holdings: d.holdings_value,
        cash: d.cash_balance,
      }))
    : snapshots.map((s) => ({
        date: s.month_end_date,
        total: s.total_value,
      }));

  const data = filterByRange(rawData, selectedRange);
  const color = ACCOUNT_COLORS[accountName] ?? "#C9A44E";
  const hasCashData = hasDaily && data.some((d) => (d.cash ?? 0) > 0);

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
              className={`text-[10px] px-2 py-1 rounded transition-colors ${
                showLines
                  ? "bg-gold-glow text-gold"
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
                className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                  i === selectedRange
                    ? "bg-gold-glow text-gold"
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
                tickFormatter={formatDate}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={formatCurrency}
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
                  `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
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
                tickFormatter={formatDate}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={formatCurrency}
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
                  `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
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
