"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useToast } from "./Toast";
import type {
  AllocationEntry,
  ConcentrationMetrics,
  ClassificationCoverage,
  AnalysisDataCoverage,
  AllocationDimension,
  FactorHeatmapRow,
  FactorCoverage,
} from "@/lib/queries/analysis";
import { FACTOR_LABELS, type FactorColumn, FACTOR_COLUMNS } from "@/lib/factors";
import { FactorHeatmap } from "./FactorHeatmap";
import { RiskMetrics } from "./RiskMetrics";
import { PositionRiskCard } from "./PositionRisk";
import { FactorAnalysisCard } from "./FactorAnalysis";
import { ScenarioModelingCard } from "./ScenarioModeling";
import { FixedIncomeCard } from "./FixedIncomeCard";
import { OptionsGreeksCard } from "./OptionsGreeksCard";
import { OptionsStrategies } from "./OptionsStrategies";
import { ExpirationCalendar } from "./ExpirationCalendar";
import { Pct, PrivateText, usePrivateFormatter } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
} from "recharts";

// ─── Constants ───────────────────────────────────────────────────

const CLASSIFICATION_LABELS: Record<string, string> = {
  fund_category: "Category",
  geography: "Geography",
  market_cap_category: "Market Cap",
  style: "Style",
  credit_rating: "Credit Rating",
  sector: "Sector",
  asset_class: "Asset Class",
  security_type: "Type",
  account: "Account",
  symbol: "Symbol",
};

const CLASSIFICATION_ORDER: AllocationDimension[] = [
  "fund_category", "geography", "market_cap_category", "style",
  "sector", "asset_class", "credit_rating", "account",
];

const FACTOR_ORDER: FactorColumn[] = [...FACTOR_COLUMNS];

function getDimensionLabel(dim: AllocationDimension): string {
  return CLASSIFICATION_LABELS[dim] ?? FACTOR_LABELS[dim as FactorColumn] ?? dim;
}

const SCOPE_OPTIONS = [
  { label: "Vanguard", value: "vanguard" },
  { label: "IBKR", value: "ibkr" },
  { label: "All", value: "all" },
];

const CHART_COLORS = [
  "#C9A44E", "#60A5FA", "#34D399", "#F87171", "#A78BFA",
  "#FBBF24", "#2DD4BF", "#FB923C", "#818CF8", "#E879F9",
  "#4ADE80", "#F472B6", "#38BDF8", "#FACC15", "#94A3B8",
];

const OTHER_COLOR = "#64748B";
const MAX_SLICES = 8;

function formatMoney(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function bucketAllocation(allocation: AllocationEntry[]): AllocationEntry[] {
  if (allocation.length <= MAX_SLICES) return allocation;
  const top = allocation.slice(0, MAX_SLICES - 1);
  const rest = allocation.slice(MAX_SLICES - 1);
  return [
    ...top,
    {
      group_name: `Other (${rest.length})`,
      total_market_value: rest.reduce((s, r) => s + r.total_market_value, 0),
      percentage: rest.reduce((s, r) => s + r.percentage, 0),
      position_count: rest.reduce((s, r) => s + r.position_count, 0),
    },
  ];
}

function getSliceColor(index: number, groupName: string): string {
  if (groupName.startsWith("Other (")) return OTHER_COLOR;
  return CHART_COLORS[index % CHART_COLORS.length];
}

// ─── Props ───────────────────────────────────────────────────────

export type AnalysisMode = "classification" | "factors";

interface AnalysisViewProps {
  allocation: AllocationEntry[];
  concentration: ConcentrationMetrics;
  coverage: ClassificationCoverage;
  dataCoverage: AnalysisDataCoverage;
  currentDimension: AllocationDimension;
  currentScope: string;
  currentMode: AnalysisMode;
  factorHeatmap?: FactorHeatmapRow[];
  factorCoverage?: FactorCoverage;
}

// ─── Component ───────────────────────────────────────────────────

export function AnalysisView({
  allocation,
  concentration,
  coverage,
  dataCoverage,
  currentDimension,
  currentScope,
  currentMode,
  factorHeatmap,
  factorCoverage,
}: AnalysisViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { isPrivate } = usePrivacy();
  const [showCoverage, setShowCoverage] = useState(false);
  const [classifyLoading, setClassifyLoading] = useState(false);
  const [factorClassifyLoading, setFactorClassifyLoading] = useState(false);
  const pctTickFormatter = usePrivateFormatter((v: number) => `${v.toFixed(0)}%`);
  const pctTooltipFormatter = usePrivateFormatter(
    (v: number | string | undefined) => `${Number(v).toFixed(1)}%`,
  );

  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push(`/dashboard/analysis?${params.toString()}`);
  }

  async function runAutoClassify() {
    setClassifyLoading(true);
    try {
      const res = await fetch("/api/compute/classify", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast(
          data.classified > 0
            ? `Classified ${data.classified} securities (${data.skipped} already done)`
            : `All ${data.skipped} securities already classified`,
          "success"
        );
        router.refresh();
      } else {
        toast(`Classification failed: ${data.error}`, "error");
      }
    } catch {
      toast("Failed to connect to server", "error");
    } finally {
      setClassifyLoading(false);
    }
  }

  async function runFactorAutoClassify() {
    setFactorClassifyLoading(true);
    try {
      const res = await fetch("/api/compute/classify-factors", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast(
          `Classified ${data.classified} securities` +
            (data.skipped > 0 ? ` (${data.skipped} skipped)` : "") +
            (data.errors?.length > 0 ? ` · ${data.errors.length} errors` : ""),
          "success"
        );
        router.refresh();
      } else {
        toast(`Factor classification failed: ${data.error}`, "error");
      }
    } catch {
      toast("Failed to connect to server", "error");
    } finally {
      setFactorClassifyLoading(false);
    }
  }

  const chartData = bucketAllocation(allocation);
  const totalValue = allocation.reduce((s, r) => s + r.total_market_value, 0);

  const isFactorMode = currentMode === "factors";
  const dimensionPills = isFactorMode ? FACTOR_ORDER : CLASSIFICATION_ORDER;

  return (
    <div className="space-y-6">
      {/* Data coverage warning */}
      {dataCoverage.coveragePct < 90 && (
        <div role="alert" className="bg-gold/5 border border-gold/20 rounded-lg px-4 py-3 text-sm text-gold">
          Analysis covers <PrivateText>{formatMoney(dataCoverage.holdingsTotal)}</PrivateText> of{" "}
          <PrivateText>{formatMoney(dataCoverage.snapshotTotal)}</PrivateText> (<PrivateText>{dataCoverage.coveragePct}%</PrivateText> of portfolio).
          {dataCoverage.missingAccounts.length > 0 && (
            <> {dataCoverage.missingAccounts.join(", ")} missing holdings data.</>
          )}
          {" "}Import holdings files or re-import statements for complete analysis.
        </div>
      )}

      {/* Mode toggle + Account scope */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          {/* Mode toggle — mobile only; desktop uses the Analysis tab dropdown in TabNav */}
          <div className="md:hidden flex items-center bg-canvas rounded-lg p-0.5 border border-edge" role="group" aria-label="Analysis mode">
            <button
              onClick={() => navigate({ mode: "classification", dimension: "fund_category" })}
              aria-pressed={!isFactorMode}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors focus-ring ${
                !isFactorMode
                  ? "bg-panel text-ink shadow-sm"
                  : "text-ink-faint hover:text-ink"
              }`}
            >
              Classification
            </button>
            <button
              onClick={() => navigate({ mode: "factors", dimension: "tariff_exposure" })}
              aria-pressed={isFactorMode}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors focus-ring ${
                isFactorMode
                  ? "bg-panel text-ink shadow-sm"
                  : "text-ink-faint hover:text-ink"
              }`}
            >
              Factor Exposure
            </button>
          </div>

          <div className="md:hidden h-5 w-px bg-edge" />

          {/* Account scope pills */}
          <div className="flex items-center gap-1.5" role="group" aria-label="Account scope">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => navigate({ scope: opt.value })}
                aria-pressed={opt.value === currentScope}
                className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors whitespace-nowrap focus-ring ${
                  opt.value === currentScope
                    ? "bg-gold/15 text-gold"
                    : "text-ink-faint hover:text-ink hover:bg-panel"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Dimension pills */}
        <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Analysis dimension">
          {dimensionPills.map((dim) => (
            <button
              key={dim}
              onClick={() => navigate({ dimension: dim })}
              aria-pressed={dim === currentDimension}
              className={`px-3 py-1.5 text-sm rounded-full border transition-colors focus-ring ${
                dim === currentDimension
                  ? "bg-gold/10 border-gold text-gold"
                  : "bg-panel border-edge text-ink-dim hover:text-ink hover:border-edge-strong"
              }`}
            >
              {getDimensionLabel(dim)}
            </button>
          ))}
        </div>
      </div>

      {/* Main content: chart + table side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pie Chart */}
        <div className="bg-panel border border-edge rounded-lg p-4">
          <h3 className="text-sm font-medium text-ink mb-4">
            Allocation by {getDimensionLabel(currentDimension)}
          </h3>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={360}>
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="total_market_value"
                  nameKey="group_name"
                  cx="50%"
                  cy="50%"
                  innerRadius={80}
                  outerRadius={140}
                  paddingAngle={1}
                >
                  {chartData.map((entry, i) => (
                    <Cell key={entry.group_name || `cell-${i}`} fill={getSliceColor(i, entry.group_name)} />
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
                  itemStyle={{ color: "#E5E7EB" }}
                />
                <text
                  x="50%"
                  y="47%"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#8891A6"
                  fontSize={12}
                >
                  Total
                </text>
                <text
                  x="50%"
                  y="55%"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#E2E6F0"
                  fontSize={18}
                  fontWeight={600}
                  fontFamily="var(--font-geist-mono), monospace"
                >
                  {isPrivate ? "•••" : formatMoney(totalValue)}
                </text>
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[360px] flex items-center justify-center text-ink-faint text-sm">
              No allocation data available.{" "}
              {isFactorMode ? "Import a factor CSV or run auto-classify." : "Run classification first."}
            </div>
          )}
        </div>

        {/* Breakdown Table */}
        <div className="bg-panel border border-edge rounded-lg p-4">
          <h3 className="text-sm font-medium text-ink mb-4">Breakdown</h3>
          <div className="overflow-y-auto max-h-[280px] md:max-h-[380px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-ink-faint">
                  <th className="text-left py-2 pr-4">{getDimensionLabel(currentDimension)}</th>
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
                        style={{ backgroundColor: i < MAX_SLICES - 1 || allocation.length <= MAX_SLICES
                          ? CHART_COLORS[i % CHART_COLORS.length]
                          : OTHER_COLOR
                        }}
                      />
                      <span className="text-ink">{row.group_name}</span>
                    </td>
                    <td className="text-right py-2 pr-4 font-mono text-ink-dim">
                      <PrivateText>{formatMoney(row.total_market_value)}</PrivateText>
                    </td>
                    <td className="text-right py-2 pr-4 font-mono text-ink-dim">
                      <Pct value={row.percentage} digits={1} />
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

      {/* Factor-specific: heatmap + coverage */}
      {isFactorMode && (
        <>
          {factorHeatmap && <FactorHeatmap rows={factorHeatmap} />}

          {/* Factor Coverage + Auto-Classify */}
          <div className="bg-panel border border-edge rounded-lg p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink">
                Factor Coverage
                {factorCoverage && (
                  <span className="text-ink-faint font-normal ml-2">
                    {factorCoverage.withFactors} of {factorCoverage.totalHoldings} holdings ({factorCoverage.coveragePct}%)
                  </span>
                )}
              </h3>
              <button
                onClick={runFactorAutoClassify}
                disabled={factorClassifyLoading}
                className="px-3 py-1 text-xs bg-gold/10 text-gold border border-gold/30 rounded hover:bg-gold/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
              >
                {factorClassifyLoading ? "Classifying..." : "Auto-Classify Factors"}
              </button>
            </div>
            {factorCoverage && factorCoverage.bySource.length > 0 && (
              <div className="flex gap-4 mt-3">
                {factorCoverage.bySource.map((s) => (
                  <span key={s.source} className="text-xs text-ink-faint">
                    <span className="text-ink-dim font-mono">{s.count}</span>{" "}
                    {s.source}
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Classification-specific: concentration + coverage */}
      {!isFactorMode && (
        <>
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

            {concentration.top_positions.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-ink-faint uppercase mb-2">Top 10 Positions</h4>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    data={concentration.top_positions}
                    layout="vertical"
                    margin={{ left: 60, right: 20 }}
                  >
                    <XAxis type="number" tickFormatter={pctTickFormatter} tick={{ fill: "#94A3B8", fontSize: 11 }} />
                    <YAxis type="category" dataKey="symbol" tick={{ fill: "#E5E7EB", fontSize: 11 }} width={55} />
                    <Tooltip
                      formatter={(value: number | string | undefined) => [pctTooltipFormatter(value), "Weight"]}
                      contentStyle={{
                        backgroundColor: "#0F1219",
                        border: "1px solid #1E2533",
                        borderRadius: "8px",
                        color: "#E5E7EB",
                      }}
                      itemStyle={{ color: "#E5E7EB" }}
                    />
                    <Bar dataKey="weight_pct" fill="#C9A44E" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {concentration.warnings.length > 0 && (
              <div className="mt-4 space-y-1">
                {concentration.warnings.slice(0, 8).map((w, i) => (
                  <p key={i} className="text-xs text-gold">
                    {/\d/.test(w) ? <PrivateText>{w}</PrivateText> : w}
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* Classification Coverage Detail */}
          <div className="bg-panel border border-edge rounded-lg p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink">Classification</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={runAutoClassify}
                  disabled={classifyLoading}
                  className="px-3 py-1 text-xs bg-gold/10 text-gold border border-gold/30 rounded hover:bg-gold/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
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
        </>
      )}

      {/* ── Quantitative Factor Analysis ── */}
      <FactorAnalysisCard scope={currentScope} />

      {/* ── Scenario Modeling ── */}
      <ScenarioModelingCard scope={currentScope} />

      {/* ── Options Greeks & Strategies ── */}
      <OptionsGreeksCard scope={currentScope} />
      <OptionsStrategies />
      <ExpirationCalendar />

      {/* ── Fixed Income Exposure ── */}
      <FixedIncomeCard scope={currentScope} />

      {/* ── Risk Decomposition ── */}
      <RiskMetrics scope={currentScope} />
      <PositionRiskCard scope={currentScope} />
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
