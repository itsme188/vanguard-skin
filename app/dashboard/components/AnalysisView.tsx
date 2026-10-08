"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatCompactUSD } from "@/lib/format";
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
import { ScrollFade } from "./ScrollFade";
import { PositionRiskCard } from "./PositionRisk";
import { FactorAnalysisCard } from "./FactorAnalysis";
import { ScenarioModelingCard } from "./ScenarioModeling";
import { FixedIncomeCard } from "./FixedIncomeCard";
import { OptionsGreeksCard } from "./OptionsGreeksCard";
import { OptionsStrategies } from "./OptionsStrategies";
import { ExpirationCalendar } from "./ExpirationCalendar";
import { Count, Money, Pct, PrivateText } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import { FactorModeCard } from "./analysis/FactorModeCard";
import { ClassificationCard } from "./analysis/ClassificationCard";
import { DrillDownPanel } from "./analysis/DrillDownPanel";
import type { DrillDownFilter } from "@/lib/queries/drill-down";
import { isDrillableDimension } from "@/lib/analysis/drillable-dimensions";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
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
  // No label on file: read the stored key as words, never print it raw.
  return (
    CLASSIFICATION_LABELS[dim] ??
    FACTOR_LABELS[dim as FactorColumn] ??
    dim.replace(/[_-]+/g, " ")
  );
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

// Delegates to the shared compact formatter so negatives render "-$14K",
// never "$-14K" (QA 2026-08-02: the Breakdown table's sign sat inside the $).
function formatMoney(value: number): string {
  return formatCompactUSD(value);
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

// ─── Long-only donut ─────────────────────────────────────────────
// A pie cannot draw a negative slice: fed a net-short bucket it draws the
// magnitude as an ordinary wedge and mis-sizes every other slice. Owner
// ruling 2026-08-31 (option 1): the donut draws the LONG book only and a
// caption under it discloses the excluded net short
// [qa:analysis-allocation-donut--shorts-rendered-as-positive-slices].

export interface DonutBook {
  /** Buckets with a positive value, in the order given — the only slices. */
  longRows: AllocationEntry[];
  /** Sum of the slices: the denominator every slice is a share of. */
  longTotal: number;
  /** Sum of the net-short buckets — zero or negative. */
  shortTotal: number;
  /** Sum over EVERY bucket: what the Breakdown table adds up to. */
  netTotal: number;
  shortCount: number;
  hasShorts: boolean;
}

export function splitAllocationForDonut(allocation: AllocationEntry[]): DonutBook {
  const longRows = allocation.filter((r) => r.total_market_value > 0);
  const shortRows = allocation.filter((r) => r.total_market_value < 0);
  return {
    longRows,
    longTotal: longRows.reduce((s, r) => s + r.total_market_value, 0),
    shortTotal: shortRows.reduce((s, r) => s + r.total_market_value, 0),
    netTotal: allocation.reduce((s, r) => s + r.total_market_value, 0),
    shortCount: shortRows.length,
    hasShorts: shortRows.length > 0,
  };
}

/** The slices the donut draws: the long book, rolled up past MAX_SLICES. */
export function donutChartData(book: DonutBook): AllocationEntry[] {
  return bucketAllocation(book.longRows);
}

/**
 * Legend-dot colour for each Breakdown row that has a slice, keyed by bucket
 * name and indexed over the LONG rows (the same index the pie colours by), so
 * a short row can never shift a long row onto another slice's colour. A row
 * with no entry is not in the chart.
 */
export function donutSliceColorByGroup(book: DonutBook): Map<string, string> {
  const colors = new Map<string, string>();
  const rolledUp = book.longRows.length > MAX_SLICES;
  book.longRows.forEach((r, i) => {
    colors.set(
      r.group_name,
      !rolledUp || i < MAX_SLICES - 1 ? CHART_COLORS[i % CHART_COLORS.length] : OTHER_COLOR,
    );
  });
  return colors;
}

/**
 * The dimension pills to offer. Credit Rating is offered only while some
 * holding in scope carries a rating: with none stored, the breakdown is one
 * "Unrated 100%" bucket laid over a book whose bonds are Treasuries (owner
 * ruling, option 3: hide it rather than assert that)
 * [qa:analysis-credit-rating--single-unrated-bucket-treasuries-unrated-regression-1].
 */
export function visibleDimensionPills<T extends string>(
  pills: readonly T[],
  creditRatingAvailable: boolean,
): T[] {
  return pills.filter((dim) => dim !== "credit_rating" || creditRatingAvailable);
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
  /** False while no holding in scope carries a credit rating — hides the pill. */
  creditRatingAvailable?: boolean;
}

// ─── Component ───────────────────────────────────────────────────

/** What the coverage banner's percentage is a percentage OF. */
export function coveragePercentBasis(
  coverage: Pick<AnalysisDataCoverage, "cashExcluded" | "unknownCashAccounts">
): string {
  if (!coverage.cashExcluded) return "of the snapshot value";
  return coverage.unknownCashAccounts.length > 0
    ? "of the snapshot value, outside cash where the snapshot states it"
    : "of the snapshot value outside cash";
}

/**
 * The sentences after the coverage banner's figures. The banner never says
 * the gap IS missing holdings when cash could explain it: an account measured
 * outside cash says so, and an account whose snapshot states no cash balance
 * is named, with "may be cash" rather than a guess.
 */
export function coverageBannerNotes(
  coverage: Pick<AnalysisDataCoverage, "cashExcluded" | "unknownCashAccounts" | "missingAccounts">
): string[] {
  const notes: string[] = [];
  if (coverage.cashExcluded) {
    notes.push(
      "Where a snapshot states its cash balance, cash and cash-equivalent funds are left out of both figures."
    );
  }
  if (coverage.unknownCashAccounts.length > 0) {
    notes.push(
      `${coverage.unknownCashAccounts.join(", ")}: the latest snapshot does not state a cash balance, so the whole account value is counted and part of the gap may be cash, not missing holdings.`
    );
  }
  if (coverage.missingAccounts.length > 0) {
    notes.push(`${coverage.missingAccounts.join(", ")}: no holdings on file.`);
  }
  notes.push(
    coverage.unknownCashAccounts.length > 0
      ? "If the gap is not cash, import holdings files or re-import statements."
      : "Import holdings files or re-import statements to close the gap."
  );
  return notes;
}

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
  creditRatingAvailable = true,
}: AnalysisViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isPrivate } = usePrivacy();
  const [drillFilter, setDrillFilter] = useState<DrillDownFilter | null>(null);
  const isFactorMode = currentMode === "factors";

  // Classification trigger — pie slice or breakdown table row.
  // "Other (N)" buckets don't map to a single classification value, skip them.
  // Factor mode dimensions are factor columns; route to the factor filter.
  // Unsupported dimensions (account, symbol, credit_rating) → no-op — see
  // currentDimensionIsDrillable below, which also gates the row's
  // cursor-pointer/hover/title affordance so the UI never advertises a click
  // that would land here as a no-op.
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
    if (!isDrillableDimension(currentDimension)) return;
    setDrillFilter({
      kind: "classification",
      dimension: currentDimension,
      bucket,
    });
  }

  // Whether the CURRENT dimension's breakdown row is actually drillable —
  // single-sourced from lib/analysis/drillable-dimensions.ts (classification
  // mode) / FACTOR_COLUMNS (factor mode), the same predicates
  // handleClassificationDrill above gates on. Drives the row's
  // cursor-pointer / hover / "Click to drill down" title affordance so it's
  // never shown for a dimension that would silently no-op on click
  // [qa:analysis-classification--account-and-credit-rating-rows-advertise-drill-down-but-no-op].
  const currentDimensionIsDrillable: boolean = isFactorMode
    ? FACTOR_COLUMNS.includes(currentDimension as FactorColumn)
    : isDrillableDimension(currentDimension);

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

  const donutBook = splitAllocationForDonut(allocation);
  const chartData = donutChartData(donutBook);
  const sliceColors = donutSliceColorByGroup(donutBook);

  const dimensionPills: AllocationDimension[] = isFactorMode
    ? FACTOR_ORDER
    : visibleDimensionPills(CLASSIFICATION_ORDER, creditRatingAvailable);

  return (
    <div className="space-y-6">
      {/* Data coverage warning */}
      {dataCoverage.coveragePct < 90 && (
        <div role="alert" className="bg-gold/5 border border-gold/20 rounded-lg px-4 py-3 text-sm text-gold-ink">
          Holdings on file add up to <PrivateText>{formatMoney(dataCoverage.holdingsTotal)}</PrivateText> against{" "}
          <PrivateText>{formatMoney(dataCoverage.snapshotTotal)}</PrivateText> in the latest account snapshots (<PrivateText>{dataCoverage.coveragePct}%</PrivateText>{" "}
          {coveragePercentBasis(dataCoverage)}).
          {coverageBannerNotes(dataCoverage).map((note) => (
            <span key={note}> {note}</span>
          ))}
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
                    ? "bg-gold/15 text-gold-ink"
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
                  ? "bg-gold/10 border-gold text-gold-ink"
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
                  onClick={
                    currentDimensionIsDrillable
                      ? (data: { group_name?: string } | undefined) => {
                          if (data?.group_name) handleClassificationDrill(data.group_name);
                        }
                      : undefined
                  }
                  style={{ cursor: currentDimensionIsDrillable ? "pointer" : "default" }}
                >
                  {chartData.map((entry, i) => (
                    <Cell
                      key={entry.group_name || `cell-${i}`}
                      fill={getSliceColor(i, entry.group_name)}
                      style={{
                        cursor:
                          currentDimensionIsDrillable && !entry.group_name.startsWith("Other (")
                            ? "pointer"
                            : "default",
                      }}
                    />
                  ))}
                </Pie>
                <Tooltip
                  // `name` is the slice's own bucket (the Pie's nameKey) —
                  // passing it through names every arc, "Other (N)" included.
                  formatter={(value, name) => [<Money key="v" value={Number(value)} />, name]}
                  contentStyle={{
                    backgroundColor: "var(--color-panel)",
                    border: "1px solid var(--color-edge)",
                    borderRadius: "8px",
                    color: "var(--color-ink)",
                  }}
                  itemStyle={{ color: "var(--color-ink)" }}
                />
                <text
                  x="50%"
                  y="47%"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="var(--color-ink-faint)"
                  fontSize={12}
                >
                  {donutBook.hasShorts ? "Long" : "Total"}
                </text>
                <text
                  x="50%"
                  y="55%"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="var(--color-ink)"
                  fontSize={18}
                  fontWeight={600}
                  fontFamily="var(--font-geist-mono), monospace"
                >
                  {isPrivate ? "•••" : formatMoney(donutBook.longTotal)}
                </text>
              </PieChart>
            </ResponsiveContainer>
          ) : donutBook.hasShorts ? (
            <div className="h-[360px] flex items-center justify-center text-ink-faint text-sm">
              No long exposure to chart: every row in this breakdown is net short.
            </div>
          ) : (
            <div className="h-[360px] flex items-center justify-center text-ink-faint text-sm">
              No allocation data available.{" "}
              {isFactorMode ? "Import a factor CSV or run auto-classify." : "Run classification first."}
            </div>
          )}
          {donutBook.hasShorts && (
            <p className="mt-3 text-xs text-ink-dim">
              Long-only chart: each slice is a share of the{" "}
              <Money value={donutBook.longTotal} /> long book. Shorts excluded:{" "}
              <Money value={donutBook.shortTotal} /> (net{" "}
              <Money value={donutBook.netTotal} />). A hollow dot in the Breakdown
              marks a row with no slice.
            </p>
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
          {/* ScrollFade nests INSIDE the vertical scroller: the fade tracks
              the x-scroller it owns, while the max-h cap keeps vertical
              scrolling on the outer div. */}
          <div className="overflow-y-auto max-h-[280px] md:max-h-[380px]">
            <ScrollFade>
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
                {allocation.map((row) => {
                  // "Other (N)" is only ever minted by bucketAllocation() for
                  // the pie's chartData, never present in the raw allocation
                  // rows the table iterates — this guard is kept anyway so
                  // the table can never silently regain the advertise-but-no-op
                  // bug if that ever changes, and so the predicate matches the
                  // pie's per-slice gate exactly.
                  const rowIsDrillable =
                    currentDimensionIsDrillable && !row.group_name.startsWith("Other (");
                  // No entry = the row has no slice (a net-short or flat
                  // bucket): it gets a hollow dot, never a slice's colour.
                  const sliceColor = sliceColors.get(row.group_name);
                  return (
                  <tr
                    key={row.group_name}
                    className={`border-b border-edge/50 ${
                      rowIsDrillable ? "hover:bg-raised/50 cursor-pointer" : ""
                    }`}
                    onClick={
                      rowIsDrillable
                        ? () => handleClassificationDrill(row.group_name)
                        : undefined
                    }
                    title={rowIsDrillable ? "Click to drill down" : undefined}
                  >
                    <td className="py-2 pr-4 flex items-center gap-2">
                      <span
                        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                          sliceColor ? "" : "border border-ink-faint"
                        }`}
                        style={sliceColor ? { backgroundColor: sliceColor } : undefined}
                      />
                      {/* A real button inside the cell makes the drill-down
                          reachable by Tab and Enter/Space while the row keeps
                          its table semantics. The click bubbles to the row's
                          own handler, so there is one drill path. */}
                      {rowIsDrillable ? (
                        <button
                          type="button"
                          aria-label={`Drill down into ${row.group_name}`}
                          className="text-ink text-left rounded cursor-pointer focus-ring"
                        >
                          {row.group_name}
                        </button>
                      ) : (
                        <span className="text-ink">{row.group_name}</span>
                      )}
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
                      <Count value={row.position_count} />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            </ScrollFade>
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
