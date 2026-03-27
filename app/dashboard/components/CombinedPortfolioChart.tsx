"use client";

import { useState, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type {
  AccountSummary,
  PortfolioChartPoint,
} from "@/lib/queries/dashboard";

const ACCOUNT_COLORS: Record<string, string> = {
  "Vanguard Taxable": "#C9A44E",
  "Vanguard Roth IRA": "#60A5FA",
  IBKR: "#34D399",
};

// ─── Date Range Periods ─────────────────────────────────────────

interface DateRange {
  label: string;
  days: number | null; // null = special handling
}

const DATE_RANGES: DateRange[] = [
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "YTD", days: null },
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

function formatFullDate(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Date Range Filtering ───────────────────────────────────────

function filterByRange(
  data: PortfolioChartPoint[],
  rangeLabel: string
): PortfolioChartPoint[] {
  if (data.length === 0) return data;

  const range = DATE_RANGES.find((r) => r.label === rangeLabel);
  if (!range) return data;

  if (rangeLabel === "All") return data;

  const now = new Date();
  let cutoff: Date;

  if (rangeLabel === "YTD") {
    cutoff = new Date(now.getFullYear(), 0, 1);
  } else if (range.days !== null) {
    cutoff = new Date(now.getTime() - range.days * 24 * 3600 * 1000);
  } else {
    return data;
  }

  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return data.filter((d) => d.date >= cutoffStr);
}

// ─── Merge Monthly + Daily Data ─────────────────────────────────

function mergeData(
  monthly: PortfolioChartPoint[],
  daily: PortfolioChartPoint[]
): PortfolioChartPoint[] {
  if (daily.length === 0) return monthly;
  if (monthly.length === 0) return daily;

  // Build a map from all data points, daily overrides monthly on same date
  const merged = new Map<string, PortfolioChartPoint>();

  for (const point of monthly) {
    merged.set(point.date, point);
  }
  for (const point of daily) {
    merged.set(point.date, point);
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

// ─── Component ──────────────────────────────────────────────────

export function CombinedPortfolioChart({
  data,
  dailyData,
  accounts,
}: {
  data: PortfolioChartPoint[];
  dailyData?: PortfolioChartPoint[];
  accounts: AccountSummary[];
}) {
  const [selectedRange, setSelectedRange] = useState("All");
  const accountNames = accounts.map((a) => a.name);
  const hasDaily = (dailyData?.length ?? 0) > 0;

  const chartData = useMemo(() => {
    const merged = mergeData(data, dailyData ?? []);
    return filterByRange(merged, selectedRange);
  }, [data, dailyData, selectedRange]);

  if (chartData.length < 2) {
    return (
      <div className="rounded-xl border border-edge bg-panel p-5">
        <h3 className="text-sm font-medium text-ink-dim mb-4">
          Portfolio Over Time
        </h3>
        <div className="h-[240px] flex items-center justify-center text-ink-faint text-sm">
          Not enough data points for a chart. Import more monthly statements.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      {/* Header with title, badge, and date range pills */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-ink-dim">
            Portfolio Over Time
          </h3>
          {hasDaily && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue/10 text-blue border border-blue/20">
              Daily
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {DATE_RANGES.map((range) => (
            <button
              key={range.label}
              onClick={() => setSelectedRange(range.label)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                selectedRange === range.label
                  ? "bg-gold/15 text-gold border border-gold/30"
                  : "text-ink-faint hover:text-ink-dim hover:bg-raised"
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[240px] sm:h-[280px] md:h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
          >
            <defs>
              {accountNames.map((name) => (
                <linearGradient
                  key={name}
                  id={`grad-${name.replace(/\s/g, "")}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={ACCOUNT_COLORS[name] ?? "#888"}
                    stopOpacity={0.25}
                  />
                  <stop
                    offset="100%"
                    stopColor={ACCOUNT_COLORS[name] ?? "#888"}
                    stopOpacity={0.02}
                  />
                </linearGradient>
              ))}
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
              labelFormatter={(label) => formatFullDate(String(label))}
              formatter={(value, name) => [
                `$${Number(value).toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`,
                String(name),
              ]}
            />
            {accountNames.map((name) => (
              <Area
                key={name}
                type="monotone"
                dataKey={name}
                stackId="1"
                stroke={ACCOUNT_COLORS[name] ?? "#888"}
                fill={`url(#grad-${name.replace(/\s/g, "")})`}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-5 mt-3 pt-3 border-t border-edge">
        {accountNames.map((name) => (
          <div
            key={name}
            className="flex items-center gap-1.5 text-xs text-ink-dim"
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: ACCOUNT_COLORS[name] ?? "#888" }}
            />
            {name}
          </div>
        ))}
        {!hasDaily && (
          <span className="ml-auto text-[10px] text-ink-faint">
            Monthly resolution. Fetch historical prices via TWS for daily
            charts.
          </span>
        )}
      </div>
    </div>
  );
}
