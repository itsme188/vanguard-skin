"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type {
  AllocationEntry,
  ConcentrationMetrics,
  ClassificationCoverage,
  AllocationDimension,
} from "@/lib/queries/analysis";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
} from "recharts";

// ─── Constants ───────────────────────────────────────────────────

const DIMENSION_LABELS: Record<AllocationDimension, string> = {
  fund_category: "Category",
  geography: "Geography",
  market_cap_category: "Market Cap",
  style: "Style",
  sector: "Sector",
  asset_class: "Asset Class",
  security_type: "Type",
  account: "Account",
  symbol: "Symbol",
};

const DIMENSION_ORDER: AllocationDimension[] = [
  "fund_category", "geography", "market_cap_category", "style",
  "sector", "asset_class", "account",
];

const CHART_COLORS = [
  "#C9A44E", // gold
  "#60A5FA", // blue-400
  "#34D399", // emerald-400
  "#F87171", // rose-400
  "#A78BFA", // violet-400
  "#FBBF24", // amber-400
  "#2DD4BF", // teal-400
  "#FB923C", // orange-400
  "#818CF8", // indigo-400
  "#E879F9", // fuchsia-400
  "#4ADE80", // green-400
  "#F472B6", // pink-400
  "#38BDF8", // sky-400
  "#FACC15", // yellow-400
  "#94A3B8", // slate-400
];

function formatMoney(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

// ─── Props ───────────────────────────────────────────────────────

interface AnalysisViewProps {
  allocation: AllocationEntry[];
  concentration: ConcentrationMetrics;
  coverage: ClassificationCoverage;
  currentDimension: AllocationDimension;
}

// ─── Component ───────────────────────────────────────────────────

export function AnalysisView({
  allocation,
  concentration,
  coverage,
  currentDimension,
}: AnalysisViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showCoverage, setShowCoverage] = useState(false);
  const [classifyLoading, setClassifyLoading] = useState(false);

  function switchDimension(dim: AllocationDimension) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("dimension", dim);
    router.push(`/dashboard/analysis?${params.toString()}`);
  }

  async function runAutoClassify() {
    setClassifyLoading(true);
    try {
      const res = await fetch("/api/compute/classify", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        router.refresh();
      }
    } finally {
      setClassifyLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Dimension pills */}
      <div className="flex flex-wrap gap-1.5">
        {DIMENSION_ORDER.map((dim) => (
          <button
            key={dim}
            onClick={() => switchDimension(dim)}
            className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
              dim === currentDimension
                ? "bg-gold/10 border-gold text-gold"
                : "bg-panel border-edge text-ink-faint hover:text-ink-dim hover:border-edge-strong"
            }`}
          >
            {DIMENSION_LABELS[dim]}
          </button>
        ))}
      </div>

      {/* Main content: chart + table side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pie Chart */}
        <div className="bg-panel border border-edge rounded-lg p-4">
          <h3 className="text-sm font-medium text-ink mb-4">
            Allocation by {DIMENSION_LABELS[currentDimension]}
          </h3>
          {allocation.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <Pie
                  data={allocation}
                  dataKey="total_market_value"
                  nameKey="group_name"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={120}
                  paddingAngle={1}
                  label={({ name, percent }) => {
                    const p = Number(percent);
                    return p > 0.03 ? `${String(name)} ${(p * 100).toFixed(0)}%` : "";
                  }}
                  labelLine={false}
                >
                  {allocation.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => [formatMoney(Number(value)), "Value"]}
                  contentStyle={{
                    backgroundColor: "#0F1219",
                    border: "1px solid #1E2533",
                    borderRadius: "8px",
                    color: "#E5E7EB",
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[320px] flex items-center justify-center text-ink-faint text-sm">
              No allocation data available. Run classification first.
            </div>
          )}
        </div>

        {/* Breakdown Table */}
        <div className="bg-panel border border-edge rounded-lg p-4">
          <h3 className="text-sm font-medium text-ink mb-4">Breakdown</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-ink-faint">
                  <th className="text-left py-2 pr-4">{DIMENSION_LABELS[currentDimension]}</th>
                  <th className="text-right py-2 pr-4">Value</th>
                  <th className="text-right py-2 pr-4">%</th>
                  <th className="text-right py-2">Positions</th>
                </tr>
              </thead>
              <tbody>
                {allocation.map((row, i) => (
                  <tr key={row.group_name} className="border-b border-edge/50 hover:bg-raised/50">
                    <td className="py-2 pr-4 flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                      <span className="text-ink">{row.group_name}</span>
                    </td>
                    <td className="text-right py-2 pr-4 font-mono text-ink-dim">
                      {formatMoney(row.total_market_value)}
                    </td>
                    <td className="text-right py-2 pr-4 font-mono text-ink-dim">
                      {row.percentage?.toFixed(1) ?? "—"}%
                    </td>
                    <td className="text-right py-2 font-mono text-ink-faint">
                      {row.position_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Concentration Metrics */}
      <div className="bg-panel border border-edge rounded-lg p-4">
        <h3 className="text-sm font-medium text-ink mb-4">Concentration Metrics</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <MetricCard
            label="Herfindahl Index (HHI)"
            value={concentration.hhi.toFixed(4)}
            description={
              concentration.hhi > 0.25
                ? "Highly concentrated"
                : concentration.hhi > 0.15
                ? "Moderately concentrated"
                : concentration.hhi > 0.06
                ? "Moderately diversified"
                : "Well diversified"
            }
            color={
              concentration.hhi > 0.25
                ? "text-down"
                : concentration.hhi > 0.15
                ? "text-gold"
                : "text-up"
            }
          />
          <MetricCard
            label="Effective Positions"
            value={concentration.effective_positions.toFixed(1)}
            description="1/HHI — equivalent equal-weighted positions"
            color="text-blue"
          />
          <MetricCard
            label="Classification Coverage"
            value={`${coverage.coverage_pct}%`}
            description={`${coverage.classified} of ${coverage.total} securities classified`}
            color={coverage.coverage_pct > 90 ? "text-up" : coverage.coverage_pct > 70 ? "text-gold" : "text-down"}
          />
        </div>

        {/* Top positions bar chart */}
        {concentration.top_positions.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-ink-faint uppercase mb-2">Top 10 Positions</h4>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={concentration.top_positions}
                layout="vertical"
                margin={{ left: 60, right: 20 }}
              >
                <XAxis type="number" tickFormatter={(v: number) => `${v.toFixed(0)}%`} tick={{ fill: "#94A3B8", fontSize: 11 }} />
                <YAxis type="category" dataKey="symbol" tick={{ fill: "#E5E7EB", fontSize: 11 }} width={55} />
                <Tooltip
                  formatter={(value) => [`${Number(value).toFixed(1)}%`, "Weight"]}
                  contentStyle={{
                    backgroundColor: "#0F1219",
                    border: "1px solid #1E2533",
                    borderRadius: "8px",
                    color: "#E5E7EB",
                  }}
                />
                <Bar dataKey="weight_pct" fill="#C9A44E" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Concentration warnings */}
        {concentration.warnings.length > 0 && (
          <div className="mt-4 space-y-1">
            {concentration.warnings.slice(0, 8).map((w, i) => (
              <p key={i} className="text-xs text-gold">
                {w}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Classification Coverage Detail (collapsible) */}
      <div className="bg-panel border border-edge rounded-lg p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">Classification</h3>
          <div className="flex gap-2">
            <button
              onClick={runAutoClassify}
              disabled={classifyLoading}
              className="px-3 py-1 text-xs bg-gold/10 text-gold border border-gold/30 rounded hover:bg-gold/20 transition-colors disabled:opacity-50"
            >
              {classifyLoading ? "Classifying..." : "Auto-Classify"}
            </button>
            <button
              onClick={() => setShowCoverage(!showCoverage)}
              className="px-3 py-1 text-xs bg-panel text-ink-faint border border-edge rounded hover:text-ink-dim transition-colors"
            >
              {showCoverage ? "Hide Details" : "Show Details"}
            </button>
          </div>
        </div>

        {/* Coverage by source */}
        <div className="flex gap-4 mt-3">
          {coverage.by_source.map((s) => (
            <span key={s.source} className="text-xs text-ink-faint">
              <span className="text-ink-dim font-mono">{s.count}</span>{" "}
              {s.source}
            </span>
          ))}
        </div>

        {showCoverage && coverage.unclassified_securities.length > 0 && (
          <div className="mt-4">
            <h4 className="text-xs font-medium text-ink-faint uppercase mb-2">
              Unclassified Securities ({coverage.unclassified_securities.length})
            </h4>
            <div className="max-h-60 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-edge text-ink-faint">
                    <th className="text-left py-1 pr-2">Symbol</th>
                    <th className="text-left py-1 pr-2">Name</th>
                    <th className="text-left py-1">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.unclassified_securities.map((s) => (
                    <tr key={s.id} className="border-b border-edge/30">
                      <td className="py-1 pr-2 font-mono text-ink">{s.symbol}</td>
                      <td className="py-1 pr-2 text-ink-faint truncate max-w-xs">{s.name ?? "—"}</td>
                      <td className="py-1 text-ink-faint">{s.security_type ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MetricCard ──────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  description,
  color,
}: {
  label: string;
  value: string;
  description: string;
  color: string;
}) {
  return (
    <div className="bg-raised/50 rounded-lg p-3">
      <p className="text-xs text-ink-faint uppercase">{label}</p>
      <p className={`text-xl font-mono font-medium mt-1 ${color}`}>{value}</p>
      <p className="text-xs text-ink-faint mt-1">{description}</p>
    </div>
  );
}
