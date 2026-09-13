/**
 * Pure-module unit test for lib/analysis/drillable-dimensions.ts — the
 * single source of truth for which classification dimensions the drill-down
 * query (lib/queries/drill-down.ts) can filter on.
 *
 * Mirrors ALLOWED_CLASSIFICATION_DIMENSIONS from lib/queries/drill-down.ts
 * exactly: account/credit_rating/symbol are NOT drillable (getHoldingsInBucket
 * has no `a.name` accounts join, no credit_rating filter branch, and no
 * symbol filter branch — see lib/queries/analysis.ts's classificationBucketSql
 * comment). Everything else in AllocationDimension's classification subset is.
 */
import { describe, it, expect } from "vitest";
import {
  DRILLABLE_CLASSIFICATION_DIMENSIONS,
  isDrillableDimension,
} from "@/lib/analysis/drillable-dimensions";

describe("DRILLABLE_CLASSIFICATION_DIMENSIONS", () => {
  it("matches the exact allowlist getHoldingsInBucket supports", () => {
    expect([...DRILLABLE_CLASSIFICATION_DIMENSIONS].sort()).toEqual(
      [
        "sector",
        "fund_category",
        "geography",
        "market_cap_category",
        "style",
        "asset_class",
        "security_type",
      ].sort()
    );
  });
});

describe("isDrillableDimension", () => {
  it.each(["sector", "fund_category", "geography", "market_cap_category", "style", "asset_class", "security_type"])(
    "%s is drillable",
    (dim) => {
      expect(isDrillableDimension(dim)).toBe(true);
    }
  );

  it.each(["account", "credit_rating", "symbol"])(
    "%s is NOT drillable (getHoldingsInBucket has no matching join/branch)",
    (dim) => {
      expect(isDrillableDimension(dim)).toBe(false);
    }
  );

  it("rejects factor columns and garbage strings", () => {
    expect(isDrillableDimension("tariff_exposure")).toBe(false);
    expect(isDrillableDimension("")).toBe(false);
    expect(isDrillableDimension("bogus")).toBe(false);
  });
});
