import { db } from "@/lib/db";
import {
  getAllocationByDimension,
  getConcentrationMetrics,
  getClassificationCoverage,
  getAnalysisDataCoverage,
  getFactorHeatmap,
  getFactorCoverage,
  type AllocationDimension,
} from "@/lib/queries/analysis";
import { FACTOR_COLUMNS } from "@/lib/factors";
import { AnalysisView, type AnalysisMode } from "../components/AnalysisView";

interface PageProps {
  searchParams: Promise<{
    dimension?: string;
    scope?: string;
    mode?: string;
  }>;
}

const CLASSIFICATION_DIMENSIONS: AllocationDimension[] = [
  "fund_category", "geography", "market_cap_category", "style",
  "sector", "asset_class", "security_type", "account", "symbol",
];

const FACTOR_DIMENSIONS: AllocationDimension[] = [...FACTOR_COLUMNS];

const ALL_DIMENSIONS = [...CLASSIFICATION_DIMENSIONS, ...FACTOR_DIMENSIONS];

const VALID_SCOPES = ["vanguard", "ibkr", "all"] as const;
type AccountScope = (typeof VALID_SCOPES)[number];

function resolveAccountIds(scope: AccountScope): number[] | undefined {
  if (scope === "all") return undefined;

  const rows = db
    .prepare("SELECT id, name FROM accounts")
    .all() as Array<{ id: number; name: string }>;

  if (scope === "vanguard") {
    const ids = rows
      .filter((r) => r.name.toLowerCase().includes("vanguard"))
      .map((r) => r.id);
    return ids.length > 0 ? ids : undefined;
  }

  if (scope === "ibkr") {
    const ids = rows
      .filter((r) => r.name.toLowerCase().includes("ibkr"))
      .map((r) => r.id);
    return ids.length > 0 ? ids : undefined;
  }

  return undefined;
}

export default async function AnalysisPage({ searchParams }: PageProps) {
  const params = await searchParams;

  const mode: AnalysisMode =
    params.mode === "factors" ? "factors" : "classification";

  const defaultDimension: AllocationDimension =
    mode === "factors" ? "tariff_exposure" : "fund_category";

  const dimension: AllocationDimension =
    ALL_DIMENSIONS.includes(params.dimension as AllocationDimension)
      ? (params.dimension as AllocationDimension)
      : defaultDimension;

  const scope: AccountScope =
    VALID_SCOPES.includes(params.scope as AccountScope)
      ? (params.scope as AccountScope)
      : "vanguard";

  const accountIds = resolveAccountIds(scope);

  const allocation = getAllocationByDimension(db, dimension, accountIds);
  const concentration = getConcentrationMetrics(db, accountIds);
  const coverage = getClassificationCoverage(db);
  const dataCoverage = getAnalysisDataCoverage(db, accountIds);

  // Factor-specific data (only when in factor mode)
  const factorHeatmap = mode === "factors" ? getFactorHeatmap(db, accountIds) : undefined;
  const factorCoverage = mode === "factors" ? getFactorCoverage(db) : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Analysis</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          {mode === "factors"
            ? "Thematic factor exposure analysis across your portfolio"
            : "Portfolio factor analysis, allocation breakdown, and concentration metrics"}
        </p>
      </div>

      <AnalysisView
        allocation={allocation}
        concentration={concentration}
        coverage={coverage}
        dataCoverage={dataCoverage}
        currentDimension={dimension}
        currentScope={scope}
        currentMode={mode}
        factorHeatmap={factorHeatmap}
        factorCoverage={factorCoverage}
      />
    </div>
  );
}
