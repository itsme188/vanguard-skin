"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import type {
  AccountSummary,
  PortfolioChartPoint,
} from "@/lib/queries/dashboard";
import { Pct, usePrivateFormatter } from "@/lib/privacy/components";
import apiFetch from "@/lib/http/apiFetch";

const ACCOUNT_COLORS: Record<string, string> = {
  "Vanguard Taxable": "#C9A44E",
  "Vanguard Roth IRA": "#60A5FA",
  IBKR: "#34D399",
};

const BENCHMARK_COLOR = "#94A3B8"; // neutral slate for benchmark line

const BENCHMARK_OPTIONS = [
  { symbol: "SPY", label: "S&P 500" },
  { symbol: "QQQ", label: "Nasdaq 100" },
  { symbol: "DIA", label: "Dow Jones" },
  { symbol: "VTI", label: "Total Market" },
];

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

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatDate(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function formatDateFromTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatFullDate(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatFullDateFromTs(ts: number): string {
  const d = new Date(ts);
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

  const merged = new Map<string, PortfolioChartPoint>();

  for (const point of monthly) {
    merged.set(point.date, { ...point });
  }
  for (const point of daily) {
    const existing = merged.get(point.date);
    if (existing) {
      // Merge: daily values override per-account, but keep monthly values for other accounts
      merged.set(point.date, { ...existing, ...point });
    } else {
      merged.set(point.date, { ...point });
    }
  }

  const sorted = Array.from(merged.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  // Forward-fill missing account values to prevent gaps in stacked area chart.
  // If a date has values for some accounts but not others, carry forward the
  // last known value for each missing account.
  if (sorted.length > 1) {
    const allKeys = new Set<string>();
    for (const point of sorted) {
      for (const key of Object.keys(point)) {
        if (key !== "date") allKeys.add(key);
      }
    }

    const lastKnown: Record<string, number> = {};
    for (const point of sorted) {
      for (const key of allKeys) {
        if (typeof point[key] === "number") {
          lastKnown[key] = point[key] as number;
        } else if (key in lastKnown) {
          point[key] = lastKnown[key];
        }
      }
    }
  }

  return sorted;
}

// ─── Percent-Change Data Conversion ─────────────────────────────

interface PercentChartPoint {
  date: string;
  _ts: number;
  Total: number;
  benchmark?: number;
  [accountName: string]: number | string | undefined;
}

function toPercentChange(
  chartData: PortfolioChartPoint[],
  accountNames: string[],
  benchmarkData?: { date: string; portfolioReturn: number; benchmarkReturn: number }[]
): PercentChartPoint[] {
  if (chartData.length < 2) return [];

  // Compute starting values for total and each account
  const first = chartData[0];
  let startTotal = 0;
  const startByAccount: Record<string, number> = {};
  for (const name of accountNames) {
    const v = (first[name] as number) ?? 0;
    startByAccount[name] = v;
    startTotal += v;
  }
  if (startTotal <= 0) return [];

  // Build benchmark lookup if available
  const benchByDate = new Map<string, number>();
  if (benchmarkData) {
    for (const b of benchmarkData) {
      benchByDate.set(b.date, b.benchmarkReturn);
    }
  }

  return chartData.map((point) => {
    let total = 0;
    const result: PercentChartPoint = {
      date: point.date,
      _ts: new Date(point.date + "T00:00:00").getTime(),
      Total: 0,
    };
    for (const name of accountNames) {
      const v = (point[name] as number) ?? 0;
      total += v;
      if (startByAccount[name] > 0) {
        result[name] = ((v - startByAccount[name]) / startByAccount[name]) * 100;
      }
    }
    result.Total = ((total - startTotal) / startTotal) * 100;
    result.benchmark = benchByDate.get(point.date);
    return result;
  });
}

// ─── Benchmark Stats Display ────────────────────────────────────

interface BenchmarkStats {
  alpha: number;
  trackingError: number | null;
  informationRatio: number | null;
  correlation: number | null;
  portfolioReturn: number;
  benchmarkReturn: number;
}

function BenchmarkStatsBar({ stats, benchLabel }: { stats: BenchmarkStats; benchLabel: string }) {
  return (
    <div className="flex items-center gap-4 text-xs font-mono">
      <span className="text-ink-faint">vs {benchLabel}:</span>
      <span className={stats.alpha >= 0 ? "text-up" : "text-down"}>
        Alpha <Pct value={stats.alpha * 100} digits={2} signed />
      </span>
      {stats.trackingError != null && (
        <span className="text-ink-faint">
          TE <Pct value={stats.trackingError * 100} digits={1} />
        </span>
      )}
      {stats.informationRatio != null && (
        <span className="text-ink-faint">
          IR {stats.informationRatio.toFixed(2)}
        </span>
      )}
      {stats.correlation != null && (
        <span className="text-ink-faint">
          Corr {stats.correlation.toFixed(2)}
        </span>
      )}
    </div>
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
  // Build canonical cutoff dates: accounts with TWS live data have no cutoff (line goes through today)
  // Statement-based accounts show estimated data after their last canonical date
  const canonicalCutoffs = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const a of accounts) {
      map[a.name] = a.dataSource === "tws_live" ? null : (a.canonicalDate ?? null);
    }
    return map;
  }, [accounts]);
  const [selectedRange, setSelectedRange] = useState("All");
  const [chartMode, setChartMode] = useState<"$" | "%">("%");
  const [selectedAccount, setSelectedAccount] = useState<string>("Total");
  const [benchmark, setBenchmark] = useState<string | null>(null);
  const [benchmarkChartData, setBenchmarkChartData] = useState<
    { date: string; portfolioReturn: number; benchmarkReturn: number }[] | null
  >(null);
  const [benchmarkStats, setBenchmarkStats] = useState<BenchmarkStats | null>(null);
  const [availableBenchmarks, setAvailableBenchmarks] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const pctTickFormatter = usePrivateFormatter(formatPercent);
  const currencyTickFormatter = usePrivateFormatter(formatCurrency);

  const accountNames = accounts.map((a) => a.name);
  const hasDaily = (dailyData?.length ?? 0) > 0;

  // Latest canonical date across all statement-based accounts — used for reference line
  const lastCanonicalDate = useMemo(() => {
    const dates = Object.values(canonicalCutoffs).filter((d): d is string => d != null);
    return dates.length > 0 ? dates.sort().pop()! : null;
  }, [canonicalCutoffs]);
  const lastCanonicalTs = lastCanonicalDate
    ? new Date(lastCanonicalDate + "T00:00:00").getTime()
    : null;

  const chartData = useMemo(() => {
    const merged = mergeData(data, dailyData ?? []);
    const filtered = filterByRange(merged, selectedRange);
    // Add Total + numeric timestamp for time-proportional x-axis
    return filtered.map((point) => {
      let total = 0;
      for (const name of accountNames) {
        total += (point[name] as number) ?? 0;
      }
      return { ...point, Total: total, _ts: new Date(point.date + "T00:00:00").getTime() };
    });
  }, [data, dailyData, selectedRange, accountNames]);

  // Check which benchmarks have data
  useEffect(() => {
    fetch("/api/benchmark/prices?mode=available")
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setAvailableBenchmarks(json.data.map((b: { symbol: string }) => b.symbol));
        }
      })
      .catch(() => {});
  }, []);

  // Fetch benchmark chart data when benchmark or range changes
  const fetchBenchmarkData = useCallback(async (sym: string) => {
    try {
      const rangeObj = DATE_RANGES.find(r => r.label === selectedRange);
      const params = new URLSearchParams({ symbol: sym });

      if (selectedRange !== "All" && rangeObj) {
        const now = new Date();
        let cutoff: Date;
        if (selectedRange === "YTD") {
          cutoff = new Date(now.getFullYear(), 0, 1);
        } else if (rangeObj.days) {
          cutoff = new Date(now.getTime() - rangeObj.days * 24 * 3600 * 1000);
        } else {
          cutoff = new Date(0);
        }
        params.set("startDate", cutoff.toISOString().slice(0, 10));
      }

      // Fetch chart data and stats in parallel
      const chartParams = new URLSearchParams(params);
      chartParams.set("mode", "chart");
      const statsParams = new URLSearchParams(params);
      statsParams.set("mode", "stats");

      const [chartRes, statsRes] = await Promise.all([
        fetch(`/api/benchmark/prices?${chartParams}`),
        fetch(`/api/benchmark/prices?${statsParams}`),
      ]);

      const chartJson = await chartRes.json();
      const statsJson = await statsRes.json();

      if (chartJson.success && chartJson.data?.length > 0) {
        setBenchmarkChartData(chartJson.data);
      } else {
        setBenchmarkChartData(null);
      }

      if (statsJson.success && statsJson.data) {
        setBenchmarkStats(statsJson.data);
      } else {
        setBenchmarkStats(null);
      }
    } catch {
      setBenchmarkChartData(null);
      setBenchmarkStats(null);
    }
  }, [selectedRange]);

  useEffect(() => {
    if (benchmark) {
      fetchBenchmarkData(benchmark);
    } else {
      setBenchmarkChartData(null);
      setBenchmarkStats(null);
    }
  }, [benchmark, fetchBenchmarkData]);

  // Sync benchmarks from TWS
  async function syncBenchmarks() {
    setSyncing(true);
    setSyncMessage("Connecting to TWS...");
    try {
      const res = await apiFetch("/api/benchmark/sync", { method: "POST" });
      const reader = res.body?.getReader();
      if (!reader) {
        setSyncMessage("Error: No response from server");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let totalInserted = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: [DONE]")) break;
            if (line.startsWith("data: ")) {
              try {
                const payload = JSON.parse(line.slice(6));

                if (payload.progress) {
                  const p = payload.progress;
                  if (p.status === "fetching") {
                    setSyncMessage(`Fetching ${p.symbol}...`);
                  } else if (p.status === "rate_limited") {
                    setSyncMessage(`Rate limited — waiting ${Math.ceil(p.waitingSeconds ?? 0)}s...`);
                  } else if (p.status === "done") {
                    totalInserted += p.barsInserted ?? 0;
                    setSyncMessage(`${p.symbol}: ${p.barsInserted ?? 0} bars`);
                  } else if (p.status === "error") {
                    setSyncMessage(`${p.symbol}: ${p.error ?? "error"}`);
                  }
                }

                if (payload.error) {
                  setSyncMessage(`Error: ${payload.error}`);
                }

                if (payload.complete) {
                  const results = payload.data as { symbol: string; barsInserted: number; error?: string }[];
                  const errors = results.filter(r => r.error);
                  const inserted = results.reduce((s, r) => s + r.barsInserted, 0);
                  setSyncMessage(
                    errors.length > 0
                      ? `${errors[0].error}`
                      : `Synced ${inserted} bars for ${results.length} benchmarks`
                  );
                  // Refresh available benchmarks
                  const refreshRes = await fetch("/api/benchmark/prices?mode=available");
                  const refreshJson = await refreshRes.json();
                  if (refreshJson.success) {
                    setAvailableBenchmarks(refreshJson.data.map((b: { symbol: string }) => b.symbol));
                  }
                }
              } catch {
                // skip malformed SSE lines
              }
            }
          }
        }
      } catch {
        setSyncMessage("Error: Connection lost during benchmark sync");
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to sync";
      setSyncMessage(`Error: ${msg}`);
    } finally {
      setSyncing(false);
      if (benchmark) fetchBenchmarkData(benchmark);
      // Clear message after 8 seconds
      setTimeout(() => setSyncMessage(null), 8000);
    }
  }

  // Percent-change data
  const percentData = useMemo(
    () => toPercentChange(chartData, accountNames, benchmarkChartData ?? undefined),
    [chartData, accountNames, benchmarkChartData]
  );

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

  const benchmarkLabel = BENCHMARK_OPTIONS.find(b => b.symbol === benchmark)?.label ?? benchmark ?? "";
  const selectedColor = selectedAccount === "Total" ? "#E2E6F0" : (ACCOUNT_COLORS[selectedAccount] ?? "#888");
  const selectedDataKey = selectedAccount; // "Total" or account name — matches keys in chartData and percentData

  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      {/* Header: title, mode toggle, benchmark selector, date range pills */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-medium text-ink-dim">
            Portfolio Over Time
          </h3>
          {hasDaily && (
            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-blue/20 text-blue border border-blue/30">
              Daily
            </span>
          )}
          {/* $ / % toggle */}
          <div className="flex ml-2 border border-edge rounded-lg overflow-hidden">
            <button
              onClick={() => setChartMode("$")}
              className={`px-2 py-0.5 text-xs transition-colors ${
                chartMode === "$"
                  ? "bg-gold/15 text-gold-ink"
                  : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              $
            </button>
            <button
              onClick={() => setChartMode("%")}
              className={`px-2 py-0.5 text-xs transition-colors ${
                chartMode === "%"
                  ? "bg-gold/15 text-gold-ink"
                  : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              %
            </button>
          </div>
          {/* Account selector */}
          <select
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
            className="bg-panel border border-edge rounded-lg px-2 py-0.5 text-xs text-ink-faint focus:outline-none focus:ring-1 focus:ring-gold/50 ml-1"
          >
            <option value="Total">All Accounts</option>
            {accountNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          {/* Benchmark selector */}
          <select
            value={benchmark ?? ""}
            onChange={(e) => setBenchmark(e.target.value || null)}
            className="bg-panel border border-edge rounded-lg px-2 py-0.5 text-xs text-ink-faint focus:outline-none focus:ring-1 focus:ring-gold/50 ml-1"
          >
            <option value="">No Benchmark</option>
            {BENCHMARK_OPTIONS.map((b) => (
              <option
                key={b.symbol}
                value={b.symbol}
                disabled={!availableBenchmarks.includes(b.symbol)}
              >
                {b.label} ({b.symbol}){!availableBenchmarks.includes(b.symbol) ? " — sync needed" : ""}
              </option>
            ))}
          </select>
          {/* Sync button */}
          <button
            onClick={syncBenchmarks}
            disabled={syncing}
            className="text-[10px] text-ink-faint hover:text-ink px-1.5 py-0.5 rounded border border-edge hover:bg-raised disabled:opacity-50 transition-colors"
            title="Fetch benchmark prices from TWS (requires TWS connection)"
          >
            {syncing ? "Syncing..." : "Sync"}
          </button>
          {syncMessage && (
            <span className={`text-[10px] font-mono ${
              syncMessage.startsWith("Error") ? "text-down" : "text-ink-faint"
            }`}>
              {syncMessage}
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
                  ? "bg-gold/15 text-gold-ink border border-gold/30"
                  : "text-ink-faint hover:text-ink-dim hover:bg-raised"
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="h-[240px] sm:h-[280px] md:h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          {chartMode === "%" ? (
            // Percent-change mode
            <LineChart
              data={percentData}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1E2534" vertical={false} />
              <XAxis
                dataKey="_ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatDateFromTs}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                tickFormatter={pctTickFormatter}
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
                labelFormatter={(ts) => formatFullDateFromTs(Number(ts))}
                formatter={(value, name) => {
                  if (String(name) === "_ts") return [null, null];
                  return [pctTickFormatter(Number(value)), String(name)];
                }}
              />
              <Line
                type="monotone"
                dataKey={selectedDataKey}
                stroke={selectedColor}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              {benchmark && benchmarkChartData && (
                <Line
                  type="monotone"
                  dataKey="benchmark"
                  stroke={BENCHMARK_COLOR}
                  strokeWidth={1.5}
                  strokeDasharray="6 3"
                  dot={false}
                  connectNulls
                />
              )}
              {lastCanonicalTs && (
                <ReferenceLine
                  x={lastCanonicalTs}
                  stroke="#4E5668"
                  strokeDasharray="4 3"
                  label={{ value: "est. →", position: "top", fill: "#4E5668", fontSize: 10 }}
                />
              )}
            </LineChart>
          ) : (
            // Absolute $ mode
            <LineChart
              data={chartData}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#1E2534"
                vertical={false}
              />
              <XAxis
                dataKey="_ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatDateFromTs}
                stroke="#4E5668"
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
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
                labelFormatter={(ts) => formatFullDateFromTs(Number(ts))}
                formatter={(value, name) => {
                  if (String(name) === "_ts") return [null, null];
                  return [currencyTickFormatter(Number(value)), String(name)];
                }}
              />
              <Line
                type="monotone"
                dataKey={selectedDataKey}
                stroke={selectedColor}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              {lastCanonicalTs && (
                <ReferenceLine
                  x={lastCanonicalTs}
                  stroke="#4E5668"
                  strokeDasharray="4 3"
                  label={{ value: "est. →", position: "top", fill: "#4E5668", fontSize: 10 }}
                />
              )}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Legend + benchmark stats */}
      <div className="flex items-center gap-5 mt-3 pt-3 border-t border-edge flex-wrap">
        <div className="flex items-center gap-1.5 text-xs text-ink">
          <div className="w-3 h-0.5 rounded-full" style={{ backgroundColor: selectedColor }} />
          {selectedAccount === "Total" ? "All Accounts" : selectedAccount}
        </div>
        {benchmark && chartMode === "%" && (
          <div className="flex items-center gap-1.5 text-xs text-ink-dim">
            <div className="w-4 h-0 border-t border-dashed" style={{ borderColor: BENCHMARK_COLOR }} />
            {benchmarkLabel}
          </div>
        )}
        {lastCanonicalDate && (
          <div className="flex items-center gap-1.5 text-xs text-ink-faint">
            <div className="w-4 h-0 border-t border-dashed" style={{ borderColor: "#4E5668" }} />
            est. after {lastCanonicalDate}
          </div>
        )}
        {benchmarkStats && benchmark && (
          <div className="ml-auto">
            <BenchmarkStatsBar stats={benchmarkStats} benchLabel={benchmarkLabel} />
          </div>
        )}
        {!hasDaily && chartMode === "$" && (
          <span className="ml-auto text-[10px] text-ink-faint">
            Monthly resolution. Fetch historical prices via TWS for daily charts.
          </span>
        )}
      </div>
    </div>
  );
}
