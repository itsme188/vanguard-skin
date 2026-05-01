"use client";

import { useState, useEffect, type ReactNode } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import type { PortfolioRiskMetrics, PositionWeight } from "@/lib/compute/risk";
import { Money, Pct, PrivateText, usePrivateFormatter } from "@/lib/privacy/components";

// ─── Formatters ─────────────────────────────────────────────────

function formatPercent(value: number | null | undefined): string {
  if (value == null) return "\u2014";
  return `${(value * 100).toFixed(2)}%`;
}

function formatMoney(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

// ─── Colors ─────────────────────────────────────────────────────

const POSITION_COLORS = [
  "#C9A44E", "#60A5FA", "#34D399", "#F87171", "#A78BFA",
  "#FBBF24", "#2DD4BF", "#FB923C", "#818CF8", "#E879F9",
];
const REST_COLOR = "#64748B";

// ─── Metric Card ────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sublabel,
  color,
}: {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  color?: "up" | "down" | "neutral";
}) {
  const colorClass =
    color === "up" ? "text-up" : color === "down" ? "text-down" : "text-ink";
  return (
    <div className="bg-panel border border-edge rounded-xl p-4">
      <div className="text-[11px] text-ink-faint uppercase tracking-widest mb-1">
        {label}
      </div>
      <div className={`text-xl font-mono tabular-nums font-semibold ${colorClass}`}>
        {value}
      </div>
      {sublabel && (
        <div className="text-xs text-ink-faint mt-1">{sublabel}</div>
      )}
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────

export function RiskMetrics({ scope }: { scope?: string }) {
  const [metrics, setMetrics] = useState<PortfolioRiskMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const concPctTickFormatter = usePrivateFormatter((v: number) => `${(v * 100).toFixed(0)}%`);
  const weightTooltipFormatter = usePrivateFormatter((v: number | string) => formatPercent(Number(v)));

  useEffect(() => {
    setLoading(true);
    const params = scope && scope !== "all" ? `?scope=${scope}` : "";
    fetch(`/api/compute/risk${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setMetrics(json.data);
        else setError(json.error ?? "Failed to compute risk metrics");
      })
      .catch(() => setError("Failed to fetch risk metrics"))
      .finally(() => setLoading(false));
  }, [scope]);

  if (loading) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Risk Decomposition</h3>
        <div className="text-sm text-ink-faint animate-pulse">Computing risk metrics...</div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Risk Decomposition</h3>
        <div className="text-sm text-ink-faint">{error ?? "No data available"}</div>
      </div>
    );
  }

  if (metrics.dataPoints < 5) {
    return (
      <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <h3 className="text-sm font-medium text-ink mb-4">Risk Decomposition</h3>
        <div className="text-sm text-ink-faint">
          Insufficient daily valuations ({metrics.dataPoints} points). Import more data or sync from TWS.
        </div>
      </div>
    );
  }

  // Prepare concentration bar chart data
  const concentrationData = [...metrics.top5Positions];
  const restWeight = 1 - metrics.top5Concentration;
  if (restWeight > 0.001 && metrics.positionCount > 5) {
    concentrationData.push({
      symbol: `Other (${metrics.positionCount - 5})`,
      securityName: null,
      marketValue: 0,
      weight: restWeight,
    });
  }

  return (
    <div className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">Risk Decomposition</h3>
        <span className="text-xs text-ink-faint font-mono">
          {metrics.dataPoints} daily observations
        </span>
      </div>

      {/* ── Metric Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          label="Max Drawdown"
          value={
            metrics.maxDrawdown ? (
              <Pct value={-metrics.maxDrawdown.percent * 100} digits={2} signed />
            ) : (
              "\u2014"
            )
          }
          sublabel={
            metrics.maxDrawdown
              ? `${formatDate(metrics.maxDrawdown.peakDate)} \u2192 ${formatDate(metrics.maxDrawdown.troughDate)}`
              : undefined
          }
          color="down"
        />
        <MetricCard
          label="Current Drawdown"
          value={
            metrics.currentDrawdown ? (
              <Pct value={-metrics.currentDrawdown.percent * 100} digits={2} signed />
            ) : (
              "At High"
            )
          }
          sublabel={
            metrics.currentDrawdown ? (
              <>
                Peak: <PrivateText>{formatMoney(metrics.currentDrawdown.peakValue)}</PrivateText> on{" "}
                {formatDate(metrics.currentDrawdown.peakDate)}
              </>
            ) : (
              "Portfolio at all-time high"
            )
          }
          color={metrics.currentDrawdown ? "down" : "up"}
        />
        <MetricCard
          label="Volatility"
          value={<Pct value={metrics.volatility != null ? metrics.volatility * 100 : null} digits={2} />}
          sublabel="Annualized"
          color="neutral"
        />
        <MetricCard
          label="Sharpe Ratio"
          value={metrics.sharpeRatio != null ? metrics.sharpeRatio.toFixed(2) : "\u2014"}
          sublabel="Risk-free: 4.5%"
          color={
            metrics.sharpeRatio == null
              ? "neutral"
              : metrics.sharpeRatio >= 0.5
                ? "up"
                : "down"
          }
        />
      </div>

      {/* ── Concentration ── */}
      {concentrationData.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs text-ink-faint uppercase tracking-widest">
              Position Concentration
            </h4>
            <div className="flex items-center gap-3 text-xs text-ink-faint">
              <span>
                Herfindahl:{" "}
                <PrivateText className="font-mono text-ink">
                  {metrics.herfindahl != null ? metrics.herfindahl.toFixed(3) : "\u2014"}
                </PrivateText>
              </span>
              <span>
                Top-5:{" "}
                <Pct
                  value={metrics.top5Concentration != null ? metrics.top5Concentration * 100 : null}
                  digits={2}
                  className="font-mono text-ink"
                />
              </span>
            </div>
          </div>

          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={concentrationData}
                layout="vertical"
                margin={{ top: 0, right: 12, bottom: 0, left: 0 }}
              >
                <XAxis
                  type="number"
                  domain={[0, Math.ceil(concentrationData[0]?.weight * 100 + 5) / 100]}
                  tickFormatter={concPctTickFormatter}
                  tick={{ fill: "#64748B", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="symbol"
                  width={80}
                  tick={{ fill: "#94A3B8", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(value) => [weightTooltipFormatter(value as number | string), "Weight"]}
                  contentStyle={{
                    background: "#0F1218",
                    border: "1px solid #1E293B",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  labelStyle={{ color: "#94A3B8" }}
                  itemStyle={{ color: "#E2E8F0" }}
                />
                <Bar dataKey="weight" radius={[0, 4, 4, 0]}>
                  {concentrationData.map((entry, i) => (
                    <Cell
                      key={entry.symbol}
                      fill={
                        entry.symbol.startsWith("Other (")
                          ? REST_COLOR
                          : POSITION_COLORS[i % POSITION_COLORS.length]
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
