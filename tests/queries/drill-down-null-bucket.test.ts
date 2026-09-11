// tests/queries/drill-down-null-bucket.test.ts
//
// Pins the fix for [qa:analysis-drilldown--unclassified-category-row-opens-empty-panel-count-mismatch]:
// getAllocationByDimension buckets a classification column via
// COALESCE(col, 'Unclassified') / COALESCE(NULLIF(col,'null'), 'Unknown'), but
// getHoldingsInBucket filtered with a literal `s.<dimension> = ?` — so the
// NULL bucket (and the literal-string-"null" rows) matched nothing and the
// drill-down panel opened empty even though the breakdown row reported real
// positions. Both queries must now agree via the shared
// `classificationBucketSql` helper exported from lib/queries/analysis.ts.
//
// Second half of the same mismatch (2026-09-11): the breakdown ALSO routes an
// option through its UNDERLYING's classification for fund_category /
// geography / market_cap_category / style. Sharing only the bucket column left
// the drill-down without that CASE (and without the `s_u` join it reads), so
// options vanished from the bucket they were counted in and surfaced under
// 'Unknown'. Both queries now compose `classificationGroupSql` +
// `underlyingInheritJoinSql`.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";
import { getAllocationByDimension } from "@/lib/queries/analysis";

let db: Database.Database;

// Migration 002 seeds account id 1 = Vanguard Taxable.
const ACCOUNT_ID = 1;

function seedSecurity(
  symbol: string,
  opts: {
    fund_category?: string | null;
    geography?: string | null;
    market_cap_category?: string | null;
    style?: string | null;
    security_type?: string;
    underlying_symbol?: string | null;
    multiplier?: number;
  } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities
         (symbol, name, security_type, fund_category, geography, market_cap_category, style,
          underlying_symbol, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Inc`,
      opts.security_type ?? "Stock",
      opts.fund_category ?? null,
      opts.geography ?? null,
      opts.market_cap_category ?? null,
      opts.style ?? null,
      opts.underlying_symbol ?? null,
      opts.multiplier ?? 1
    ).lastInsertRowid as number;
}

function seedHolding(securityId: number, quantity: number) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, '2026-06-01', 'test:' || ?)`
  ).run(ACCOUNT_ID, securityId, quantity, securityId);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    `INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-06-01', 'test')`
  ).run(securityId, price);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getHoldingsInBucket agrees with getAllocationByDimension's NULL/'null' bucketing", () => {
  it("fund_category: a NULL fund_category holding drills under 'Unclassified', not under a real category", () => {
    const unclassified = seedSecurity("ZZAAA", { fund_category: null });
    const classified = seedSecurity("ZZBBB", { fund_category: "US Sector Equity" });
    seedHolding(unclassified, 10);
    seedHolding(classified, 10);
    seedPrice(unclassified, 100);
    seedPrice(classified, 100);

    const unclassifiedRows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "fund_category",
      bucket: "Unclassified",
    });
    expect(unclassifiedRows.map((r) => r.symbol)).toEqual(["ZZAAA"]);

    const classifiedRows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "fund_category",
      bucket: "US Sector Equity",
    });
    expect(classifiedRows.map((r) => r.symbol)).toEqual(["ZZBBB"]);
  });

  it("geography: both a literal 'null' string and a real NULL drill under 'Unknown'; a real geography does not", () => {
    const literalNull = seedSecurity("ZZCCC", { geography: "null" });
    const trueNull = seedSecurity("ZZDDD", { geography: null });
    const real = seedSecurity("ZZEEE", { geography: "North America" });
    seedHolding(literalNull, 10);
    seedHolding(trueNull, 10);
    seedHolding(real, 10);
    seedPrice(literalNull, 100);
    seedPrice(trueNull, 100);
    seedPrice(real, 100);

    const unknownRows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "geography",
      bucket: "Unknown",
    });
    expect(unknownRows.map((r) => r.symbol).sort()).toEqual(["ZZCCC", "ZZDDD"]);

    const realRows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "geography",
      bucket: "North America",
    });
    expect(realRows.map((r) => r.symbol)).toEqual(["ZZEEE"]);
  });

  it("market_cap_category: a NULL value drills under 'Unknown'", () => {
    const unclassified = seedSecurity("ZZFFF", { market_cap_category: null });
    seedHolding(unclassified, 10);
    seedPrice(unclassified, 100);

    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "market_cap_category",
      bucket: "Unknown",
    });
    expect(rows.map((r) => r.symbol)).toEqual(["ZZFFF"]);
  });

  it("style: a NULL value drills under 'Unknown'", () => {
    const unclassified = seedSecurity("ZZGGG", { style: null });
    seedHolding(unclassified, 10);
    seedPrice(unclassified, 100);

    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "style",
      bucket: "Unknown",
    });
    expect(rows.map((r) => r.symbol)).toEqual(["ZZGGG"]);
  });

  it("the drill-down row count for 'Unclassified' equals the breakdown's position_count for the same bucket", () => {
    const unclassifiedOne = seedSecurity("ZZHHH", { fund_category: null });
    const unclassifiedTwo = seedSecurity("ZZIII", { fund_category: null });
    const classified = seedSecurity("ZZJJJ", { fund_category: "US Sector Equity" });
    seedHolding(unclassifiedOne, 10);
    seedHolding(unclassifiedTwo, 10);
    seedHolding(classified, 10);
    seedPrice(unclassifiedOne, 100);
    seedPrice(unclassifiedTwo, 100);
    seedPrice(classified, 100);

    const breakdown = getAllocationByDimension(db, "fund_category");
    const bucket = breakdown.find((b) => b.group_name === "Unclassified");
    expect(bucket).toBeDefined();
    expect(bucket!.position_count).toBe(2);

    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "fund_category",
      bucket: "Unclassified",
    });
    expect(rows.length).toBe(bucket!.position_count);
  });
});

describe("getHoldingsInBucket inherits an option's bucket from its underlying", () => {
  // getAllocationByDimension routes fund_category | geography |
  // market_cap_category | style for OPTIONS through the underlying's value
  // (classificationGroupSql's CASE + the s_u join). The drill-down composed
  // only the bucket half and had no s_u join, so an option the breakdown
  // counted under geography 'United States' came back neither there (missing
  // from the drilled list, count mismatch) nor correctly — it showed up under
  // 'Unknown' instead.
  const OPTION_SYMBOL = "INTC  270115C00030000";

  it("geography: the option drills under the UNDERLYING's bucket, not under 'Unknown'", () => {
    const intc = seedSecurity("INTC", { geography: "United States" });
    const leap = seedSecurity(OPTION_SYMBOL, {
      security_type: "Option",
      geography: null,
      underlying_symbol: "INTC",
      multiplier: 100,
    });
    const trulyUnknown = seedSecurity("ZZKKK", { geography: null });
    for (const id of [intc, leap, trulyUnknown]) {
      seedHolding(id, 10);
      seedPrice(id, 100);
    }

    const breakdown = getAllocationByDimension(db, "geography");
    const us = breakdown.find((b) => b.group_name === "United States");
    expect(us).toBeDefined();
    // Stock + option: the breakdown attributes the option to INTC's geography.
    expect(us!.position_count).toBe(2);

    const usRows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "geography",
      bucket: "United States",
    });
    expect(usRows.map((r) => r.symbol).sort()).toEqual([OPTION_SYMBOL, "INTC"].sort());
    expect(usRows.length).toBe(us!.position_count);

    const unknownRows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "geography",
      bucket: "Unknown",
    });
    expect(unknownRows.map((r) => r.symbol)).toEqual(["ZZKKK"]);
    const unknownBucket = breakdown.find((b) => b.group_name === "Unknown");
    expect(unknownRows.length).toBe(unknownBucket!.position_count);
  });

  it("fund_category: an option whose underlying is unclassified falls back to 'Unclassified' on BOTH surfaces", () => {
    const intc = seedSecurity("INTC", { fund_category: null });
    const leap = seedSecurity(OPTION_SYMBOL, {
      security_type: "Option",
      fund_category: null,
      underlying_symbol: "INTC",
      multiplier: 100,
    });
    seedHolding(intc, 10);
    seedHolding(leap, 1);
    seedPrice(intc, 100);
    seedPrice(leap, 5);

    const breakdown = getAllocationByDimension(db, "fund_category");
    const bucket = breakdown.find((b) => b.group_name === "Unclassified");
    expect(bucket!.position_count).toBe(2);

    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "fund_category",
      bucket: "Unclassified",
    });
    expect(rows.map((r) => r.symbol).sort()).toEqual([OPTION_SYMBOL, "INTC"].sort());
    expect(rows.length).toBe(bucket!.position_count);
  });

  it("market_cap_category: the option inherits a literal-'null' underlying's fallback bucket", () => {
    // The underlying carries the AI classifier's literal string "null" — the
    // breakdown NULLIFs it and falls back to the option's own (NULL → 'Unknown').
    const intc = seedSecurity("INTC", { market_cap_category: "null" });
    const leap = seedSecurity(OPTION_SYMBOL, {
      security_type: "Option",
      market_cap_category: null,
      underlying_symbol: "INTC",
      multiplier: 100,
    });
    seedHolding(intc, 10);
    seedHolding(leap, 1);
    seedPrice(intc, 100);
    seedPrice(leap, 5);

    const breakdown = getAllocationByDimension(db, "market_cap_category");
    const bucket = breakdown.find((b) => b.group_name === "Unknown");
    expect(bucket!.position_count).toBe(2);

    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "market_cap_category",
      bucket: "Unknown",
    });
    expect(rows.length).toBe(bucket!.position_count);
  });
});
