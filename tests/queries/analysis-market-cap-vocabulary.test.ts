// tests/queries/analysis-market-cap-vocabulary.test.ts
//
// Pins the READ-side fix for market_cap_category vocabulary fragmentation
// [qa:analysis-market-cap--duplicate-size-buckets-and-tilts]: the Claude
// classification fallback writes bare cap-size labels ("Large"/"Mid"/"Small")
// while every other classification source (static lookup, auto_option,
// manual) writes the canonical "X Cap" scheme. normalizeMarketCapCategory
// (lib/securities/normalize-market-cap.ts) collapses the vocabulary at every
// WRITE site, but legacy rows written before that normalizer existed keep
// their bare label forever — re-running Auto-Classify does not touch
// already-classified rows. Left unnormalized on READ, the Analysis
// Diagnostics "Market Cap" breakdown rendered "Large Cap" beside "Large"
// (same exposure, split in two), its drill-down panel disagreed with the
// breakdown on an option inheriting a bare label from its underlying, and
// the Factor Exposure "Portfolio Tilts → Size" panel repeated the split.
//
// The fix composes the SQL twin marketCapCategoryBucketSql
// (lib/securities/normalize-market-cap.ts, generated from the SAME ALIASES
// table as the JS normalizer) into classificationBucketSql /
// classificationGroupSql (lib/queries/analysis.ts) — which getHoldingsInBucket
// (lib/queries/drill-down.ts) shares — and applies normalizeMarketCapCategory
// to the Size tilt getter (lib/compute/factors.ts).
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";
import { computeFactorAnalysis } from "@/lib/compute/factors";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSecurity(
  symbol: string,
  opts: {
    market_cap_category?: string | null;
    security_type?: string;
    underlying_symbol?: string | null;
    multiplier?: number;
  } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities
         (symbol, name, security_type, market_cap_category, underlying_symbol, multiplier)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Inc`,
      opts.security_type ?? "Stock",
      opts.market_cap_category ?? null,
      opts.underlying_symbol ?? null,
      opts.multiplier ?? 1
    ).lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, quantity: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-06-01', 'test:' || ?)"
  ).run(accountId, securityId, quantity, securityId);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-06-01', 'test')"
  ).run(securityId, price);
}

/**
 * Seven securities spanning the full market_cap_category vocabulary seen in
 * the live database: the canonical "X Cap" scheme, the bare AI-fallback
 * synonyms (including a trailing-space, lowercase variant), the literal
 * string "null", and a true NULL. Quantities are chosen so every bucket's
 * expected total is a clean round number ($100/share throughout).
 */
function seedVocabularyFixture(): { account: number; ids: Record<string, number> } {
  const account = seedAccount("Test");
  const ids: Record<string, number> = {
    largeCap: seedSecurity("LGA", { market_cap_category: "Large Cap" }), // qty 10 -> $1000
    large: seedSecurity("LGB", { market_cap_category: "Large" }), // qty 5 -> $500
    mid: seedSecurity("MID", { market_cap_category: "Mid" }), // qty 10 -> $1000
    smallCap: seedSecurity("SMA", { market_cap_category: "Small Cap" }), // qty 10 -> $1000
    small: seedSecurity("SMB", { market_cap_category: "small " }), // qty 5 -> $500 (trailing space)
    literalNull: seedSecurity("NUL", { market_cap_category: "null" }), // qty 10 -> $1000
    trueNull: seedSecurity("UNK", { market_cap_category: null }), // qty 10 -> $1000
  };
  seedHolding(account, ids.largeCap, 10);
  seedHolding(account, ids.large, 5);
  seedHolding(account, ids.mid, 10);
  seedHolding(account, ids.smallCap, 10);
  seedHolding(account, ids.small, 5);
  seedHolding(account, ids.literalNull, 10);
  seedHolding(account, ids.trueNull, 10);
  for (const id of Object.values(ids)) seedPrice(id, 100);
  return { account, ids };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("market_cap_category read-side vocabulary normalization", () => {
  it("getAllocationByDimension merges a legacy bare label into its canonical 'X Cap' bucket instead of fragmenting it", () => {
    seedVocabularyFixture();

    const result = getAllocationByDimension(db, "market_cap_category");
    const byName = new Map(result.map((r) => [r.group_name, r]));

    // No bare-label survivor rows sitting alongside the "X Cap" spelling.
    expect(byName.has("Large")).toBe(false);
    expect(byName.has("Mid")).toBe(false);
    expect(byName.has("Small")).toBe(false);
    expect(byName.has("small")).toBe(false);
    expect(byName.has("small ")).toBe(false);

    expect(byName.get("Large Cap")?.total_market_value).toBeCloseTo(1500, 0); // LGA(1000) + LGB(500)
    expect(byName.get("Large Cap")?.position_count).toBe(2);
    expect(byName.get("Mid Cap")?.total_market_value).toBeCloseTo(1000, 0);
    expect(byName.get("Mid Cap")?.position_count).toBe(1);
    expect(byName.get("Small Cap")?.total_market_value).toBeCloseTo(1500, 0); // SMA(1000) + SMB(500)
    expect(byName.get("Small Cap")?.position_count).toBe(2);

    // The literal-'null' row and the true-NULL row still fold into Unknown —
    // untouched by the vocabulary fix, still guarded by the pre-existing
    // NULLIF/COALESCE (see analysis-null-string-category.test.ts).
    expect(byName.get("Unknown")?.total_market_value).toBeCloseTo(2000, 0); // NUL(1000) + UNK(1000)
    expect(byName.get("Unknown")?.position_count).toBe(2);

    // Exactly 4 buckets total: Large Cap, Mid Cap, Small Cap, Unknown.
    expect(result.length).toBe(4);
  });

  it("getHoldingsInBucket('Large Cap') returns BOTH the canonical row and the legacy bare-label row", () => {
    seedVocabularyFixture();

    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "market_cap_category",
      bucket: "Large Cap",
    });
    expect(rows.map((r) => r.symbol).sort()).toEqual(["LGA", "LGB"]);
  });

  it("getHoldingsInBucket('Small Cap') returns both the canonical and the trailing-space bare-label row", () => {
    seedVocabularyFixture();

    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "market_cap_category",
      bucket: "Small Cap",
    });
    expect(rows.map((r) => r.symbol).sort()).toEqual(["SMA", "SMB"]);
  });

  it("an OPTION inheriting a bare label from its underlying also lands in the canonical bucket on BOTH surfaces", () => {
    const account = seedAccount("Test");
    const OPTION_SYMBOL = "ZZTP  270115C00030000";
    const underlying = seedSecurity("ZZTP", { market_cap_category: "Large" });
    const option = seedSecurity(OPTION_SYMBOL, {
      security_type: "Option",
      market_cap_category: null,
      underlying_symbol: "ZZTP",
      multiplier: 100,
    });
    seedHolding(account, underlying, 10);
    seedHolding(account, option, 1);
    seedPrice(underlying, 100);
    seedPrice(option, 5);

    const result = getAllocationByDimension(db, "market_cap_category");
    expect(result.find((r) => r.group_name === "Large")).toBeUndefined();
    const largeCap = result.find((r) => r.group_name === "Large Cap");
    expect(largeCap).toBeDefined();
    // Both the underlying AND the option (inheriting ZZTP's bare "Large",
    // normalized to "Large Cap") land in the same bucket.
    expect(largeCap!.position_count).toBe(2);

    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "market_cap_category",
      bucket: "Large Cap",
    });
    expect(rows.map((r) => r.symbol).sort()).toEqual([OPTION_SYMBOL, "ZZTP"].sort());
    expect(rows.length).toBe(largeCap!.position_count);
  });

  it("the Factor Exposure Size tilt has no bare 'Large'/'Mid'/'Small' labels", () => {
    seedVocabularyFixture();

    const result = computeFactorAnalysis(db);
    expect(result.sizeTilt).not.toBeNull();
    const labels = result.sizeTilt!.buckets.map((b) => b.label);

    expect(labels).not.toContain("Large");
    expect(labels).not.toContain("Mid");
    expect(labels).not.toContain("Small");
    expect(labels).not.toContain("small");
    expect(labels).not.toContain("small ");

    const largeCap = result.sizeTilt!.buckets.find((b) => b.label === "Large Cap");
    const midCap = result.sizeTilt!.buckets.find((b) => b.label === "Mid Cap");
    const smallCap = result.sizeTilt!.buckets.find((b) => b.label === "Small Cap");
    expect(largeCap).toBeDefined();
    expect(midCap).toBeDefined();
    expect(smallCap).toBeDefined();
    // Total portfolio value across all 7 seeded securities = $6000.
    expect(largeCap!.weight).toBeCloseTo(1500 / 6000, 2); // LGA + LGB
    expect(midCap!.weight).toBeCloseTo(1000 / 6000, 2);
    expect(smallCap!.weight).toBeCloseTo(1500 / 6000, 2); // SMA + SMB
  });

  it("the Factor Exposure Size tilt folds the literal string 'null' into 'Unclassified', not its own 'null' bucket", () => {
    seedVocabularyFixture();

    const result = computeFactorAnalysis(db);
    const labels = result.sizeTilt!.buckets.map((b) => b.label);

    // Pre-fix, normalizeMarketCapCategory("null") passes the literal string
    // through unchanged (it's not a recognized bare-synonym alias), and the
    // Size tilt getter had no 'null'-literal guard — so the NUL security
    // rendered a bucket literally labeled "null" instead of folding into
    // "Unclassified" alongside the true-NULL row.
    expect(labels).not.toContain("null");

    const unclassified = result.sizeTilt!.buckets.find((b) => b.label === "Unclassified");
    expect(unclassified).toBeDefined();
    // literalNull (NUL, $1000) + trueNull (UNK, $1000) fold together.
    expect(unclassified!.weight).toBeCloseTo(2000 / 6000, 2);
  });
});
