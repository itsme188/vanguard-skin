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
  } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities
         (symbol, name, security_type, fund_category, geography, market_cap_category, style, multiplier)
       VALUES (?, ?, 'Stock', ?, ?, ?, ?, 1)`
    )
    .run(
      symbol,
      `${symbol} Inc`,
      opts.fund_category ?? null,
      opts.geography ?? null,
      opts.market_cap_category ?? null,
      opts.style ?? null
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
