import { db } from "@/lib/db";
import {
  getAllocationByDimension,
  getConcentrationMetrics,
  getClassificationCoverage,
  type AllocationDimension,
} from "@/lib/queries/analysis";
import { AnalysisView } from "../components/AnalysisView";

interface PageProps {
  searchParams: Promise<{
    dimension?: string;
  }>;
}

const VALID_DIMENSIONS: AllocationDimension[] = [
  "fund_category", "geography", "market_cap_category", "style",
  "sector", "asset_class", "security_type", "account", "symbol",
];

export default async function AnalysisPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const dimension: AllocationDimension =
    VALID_DIMENSIONS.includes(params.dimension as AllocationDimension)
      ? (params.dimension as AllocationDimension)
      : "fund_category";

  const allocation = getAllocationByDimension(db, dimension);
  const concentration = getConcentrationMetrics(db);
  const coverage = getClassificationCoverage(db);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Analysis</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          Portfolio factor analysis, allocation breakdown, and concentration metrics
        </p>
      </div>

      <AnalysisView
        allocation={allocation}
        concentration={concentration}
        coverage={coverage}
        currentDimension={dimension}
      />
    </div>
  );
}
