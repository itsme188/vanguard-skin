"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import type { PortfolioExposureSummary } from "@/lib/compute/exposure";
import { RiskMetrics } from "./RiskMetrics";
import { PositionRiskCard } from "./PositionRisk";
import { FactorAnalysisCard } from "./FactorAnalysis";
import { ScenarioModelingCard } from "./ScenarioModeling";
import { FixedIncomeCard } from "./FixedIncomeCard";
import { OptionsGreeksCard } from "./OptionsGreeksCard";
import { OptionsStrategies } from "./OptionsStrategies";
import { ExpirationCalendar } from "./ExpirationCalendar";
import { Pct, PrivateText } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import { FactorModeCard } from "./analysis/FactorModeCard";
import { ClassificationCard } from "./analysis/ClassificationCard";
import { DrillDownPanel } from "./analysis/DrillDownPanel";
import type {
  DrillDownFilter,
  ClassificationDimension,
} from "@/lib/queries/drill-down";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
} from "recharts";

// Dimensions supported by the drill-down query. AllocationDimension is a
// superset (includes `account`, `symbol`, `credit_rating`) — clicks on
// unsupported buckets are silently no-op'd.
const DRILL_SUPPORTED_DIMENSIONS: ReadonlySet<string> = new Set([
  "sector",
  "fund_category",
  "geography",
  "market_cap_category",
  "style",
  "asset_class",
  "security_type",
]);

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
  { label: "All", value: "all" },
  { label: "Vanguard", value: "vanguard" },
  { label: "IBKR", value: "ibkr" },
  { label: "Roth", value: "roth" },
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
      net_exposure: rest.reduce((s, r) => s + r.net_exposure, 0),
      exposure_pct: rest.reduce((s, r) => s + r.exposure_pct, 0),
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
  exposureSummary?: PortfolioExposureSummary;
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
  exposureSummary,
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
  const { isPrivate } = usePrivacy();
  const [drillFilter, setDrillFilter] = useState<DrillDownFilter | null>(null);
  const isFactorMode = currentMode === "factors";

  // Classification trigger — pie slice or breakdown table row.
  // "Other (N)" buckets don't map to a single classification value, skip them.
  // Factor mode dimensions are factor columns; route to the factor filter.
  // Unsupported dimensions (account, symbol, credit_rating) → no-op.
  function handleClassificationDrill(bucket: string) {
    if (!bucket || bucket.startsWith("Other (")) return;
    if (isFactorMode) {
      if (!FACTOR_COLUMNS.includes(currentDimension as FactorColumn)) return;
      setDrillFilter({
        kind: "factor",
        factor: currentDimension as FactorColumn,
        bucket,
      });
      return;
    }
    if (!DRILL_SUPPORTED_DIMENSIONS.has(currentDimension)) return;
    setDrillFilter({
      kind: "classification",
      dimension: currentDimension as ClassificationDimension,
      bucket,
    });
  }

  function navigate(updates: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    // AnalysisView only renders inside Diagnostics — keep URLs canonical
    // (?view=diagnostics) even when the user arrived via a legacy ?mode= link.
    params.set("view", "diagnostics");
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push(`/dashboard/analysis?${params.toString()}`);
  }

  const chartData = bucketAllocation(allocation);
  const totalValue = allocation.reduce((s, r) => s + r.total_market_value, 0);

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
          {/* Mode toggle — all breakpoints. The Analysis tab dropdown now lists
              the four sub-views (Workspace | Diagnostics | Performance | Trade
              Reviews); classification vs factors is internal to Diagnostics. */}
          <div className="flex items-center bg-canvas rounded-lg p-0.5 border border-edge" role="group" aria-label="Analysis mode">
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

          <div className="hidden sm:block h-5 w-px bg-edge" />

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
                  onClick={(data: { group_name?: string } | undefined) => {
                    if (data?.group_name) handleClassificationDrill(data.group_name);
                  }}
                  style={{ cursor: "pointer" }}
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
          <div className="flex items-baseline justify-between mb-4 gap-2 flex-wrap">
            <h3 className="text-sm font-medium text-ink">Breakdown</h3>
            {exposureSummary && exposureSummary.net_ratio != null && (
              <span
                className="text-xs text-ink-faint"
                title="Delta-adjusted: stocks at market value, options at delta × underlying notional (puts negative). Net = signed sum; gross = magnitude of all bets including hedges. 100% = fully invested, unlevered."
              >
                Net exposure{" "}
                <span className="font-mono text-ink-dim">
                  <Pct value={exposureSummary.net_ratio * 100} digits={0} />
                </span>
                {" · gross "}
                <span className="font-mono text-ink-dim">
                  <Pct value={(exposureSummary.gross_ratio ?? 0) * 100} digits={0} />
                </span>
                {" of holdings"}
              </span>
            )}
          </div>
          <div className="overflow-y-auto max-h-[280px] md:max-h-[380px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-ink-faint">
                  <th className="text-left py-2 pr-4">{getDimensionLabel(currentDimension)}</th>
                  <th className="text-right py-2 pr-4">Value</th>
                  <th className="text-right py-2 pr-4">%</th>
                  <th
                    className="text-right py-2 pr-4"
                    title="Delta-adjusted exposure as % of holdings — options count at delta × underlying notional (puts negative), so this is what actually moves with the market"
                  >
                    Net exp %
                  </th>
                  <th className="text-right py-2">Positions</th>
                </tr>
              </thead>
              <tbody>
                {allocation.map((row, i) => (
                  <tr
                    key={row.group_name}
                    className="border-b border-edge/50 hover:bg-raised/50 cursor-pointer"
                    onClick={() => handleClassificationDrill(row.group_name)}
                    title="Click to drill down"
                  >
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
                    <td
                      className={`text-right py-2 pr-4 font-mono ${
                        row.exposure_pct < 0 ? "text-down" : "text-ink-dim"
                      }`}
                    >
                      <Pct value={row.exposure_pct} digits={1} />
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

      {/* Mode-specific subcomponents */}
      {isFactorMode ? (
        <FactorModeCard factorHeatmap={factorHeatmap} factorCoverage={factorCoverage} scope={currentScope} />
      ) : (
        <ClassificationCard concentration={concentration} coverage={coverage} />
      )}

      {/* ── Quantitative Factor Analysis ── */}
      <FactorAnalysisCard scope={currentScope} />

      {/* ── Scenario Modeling ── */}
      <ScenarioModelingCard scope={currentScope} />

      {/* ── Options Greeks & Strategies ── */}
      <OptionsGreeksCard scope={currentScope} />
      <OptionsStrategies scope={currentScope} />
      <ExpirationCalendar scope={currentScope} />

      {/* ── Fixed Income Exposure ── */}
      <FixedIncomeCard scope={currentScope} />

      {/* ── Risk Decomposition ── */}
      <RiskMetrics scope={currentScope} />
      <PositionRiskCard scope={currentScope} />

      {/* P3 Slice C — drill-down panel for classification pie / breakdown clicks */}
      <DrillDownPanel
        open={drillFilter !== null}
        onClose={() => setDrillFilter(null)}
        scope={currentScope}
        filter={drillFilter}
      />
    </div>
  );
}
