// tests/securities/normalize-market-cap.test.ts
//
// Pins the market_cap_category vocabulary normalizer: the Claude classification
// fallback (classifyUnresolvedWithClaude) emits bare cap-size labels ("Large",
// "Mid", "Small") per its prompt enum, while every other classification source
// (static lookup, auto_option, manual) writes the "X Cap" scheme ("Large Cap",
// "Mid Cap", "Small Cap"). Without normalizing, one cap-size bucket fragments
// into two rows on the Allocation donut (Large 12% + Large Cap 34% are the same
// exposure). Synonyms merge to the canonical scheme; everything else passes
// through unchanged.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  normalizeMarketCapCategory,
  marketCapCategoryBucketSql,
} from "@/lib/securities/normalize-market-cap";

describe("normalizeMarketCapCategory", () => {
  it("maps bare cap-size labels to the canonical 'X Cap' scheme", () => {
    expect(normalizeMarketCapCategory("Large")).toBe("Large Cap");
    expect(normalizeMarketCapCategory("Mid")).toBe("Mid Cap");
    expect(normalizeMarketCapCategory("Small")).toBe("Small Cap");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeMarketCapCategory("  large ")).toBe("Large Cap");
    expect(normalizeMarketCapCategory("MID")).toBe("Mid Cap");
    expect(normalizeMarketCapCategory("small")).toBe("Small Cap");
  });

  it("passes canonical and unrelated labels through unchanged", () => {
    expect(normalizeMarketCapCategory("Large Cap")).toBe("Large Cap");
    expect(normalizeMarketCapCategory("Mid Cap")).toBe("Mid Cap");
    expect(normalizeMarketCapCategory("Small Cap")).toBe("Small Cap");
    expect(normalizeMarketCapCategory("Multi-Cap")).toBe("Multi-Cap");
  });

  it("returns null/undefined/empty input as null", () => {
    expect(normalizeMarketCapCategory(null)).toBeNull();
    expect(normalizeMarketCapCategory(undefined)).toBeNull();
    expect(normalizeMarketCapCategory("")).toBeNull();
    expect(normalizeMarketCapCategory("   ")).toBeNull();
  });
});

// The read side (lib/queries/analysis.ts's classificationBucketSql /
// classificationGroupSql) cannot call the JS function — it composes a SQL
// GROUP BY expression. marketCapCategoryBucketSql is the SQL twin, generated
// from the SAME ALIASES table, so a legacy bare-label row ("Large") already
// sitting in the database collapses into the same bucket as a freshly
// classified "Large Cap" row without a backfill. This suite proves the two
// implementations agree, by running the SQL twin for real against an
// in-memory better-sqlite3 connection (a one-row CTE standing in for a
// securities row) and comparing its output to the JS function for the same
// input.
describe("marketCapCategoryBucketSql", () => {
  function evalSql(rawValue: string | null): string | null {
    const db = new Database(":memory:");
    try {
      const row = db
        .prepare(
          `WITH one_row(cap_value) AS (SELECT ?)
           SELECT ${marketCapCategoryBucketSql("cap_value")} AS bucket FROM one_row`
        )
        .get(rawValue) as { bucket: string | null };
      return row.bucket;
    } finally {
      db.close();
    }
  }

  const alias_inputs = ["Large", "Mid", "Medium", "Small", "  large ", "MID", "small"];
  const passthrough_inputs = ["Large Cap", "Mid Cap", "Small Cap", "Multi-Cap", "null"];

  it.each(alias_inputs)("agrees with the JS function for alias input %j", (raw) => {
    expect(evalSql(raw)).toBe(normalizeMarketCapCategory(raw));
  });

  it.each(passthrough_inputs)("agrees with the JS function for passthrough input %j", (raw) => {
    // normalizeMarketCapCategory("null") passes the literal string through
    // unchanged too (never returns null for a non-empty string) — callers
    // apply their own NULLIF('null') guard around both implementations,
    // which this SQL twin deliberately does not replicate (see the
    // file-level doc comment).
    expect(evalSql(raw)).toBe(normalizeMarketCapCategory(raw));
  });

  it("passes a NULL column value through unchanged (matching the JS null passthrough shape)", () => {
    expect(evalSql(null)).toBeNull();
  });
});
