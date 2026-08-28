/**
 * Cash-Deploy — equity-sleeve sector gaps.
 *
 * QA finding `analysis-cash-deploy--fixed-income-gap-vs-equity-benchmark`:
 * against VTI (an all-equity index) the gap table led with
 * "Fixed Income · Current 11.7% · Target 0.0% · Gap +11.7pp" styled like an
 * actionable gap. VTI holds no fixed income, so that gap can never be closed
 * by deploying cash — and it distorted every other sector's weight, because
 * the fixed-income dollars sat in the denominator of an equity-only
 * comparison.
 *
 * Decision: when the benchmark is equity-only, measure sector gaps on the
 * EQUITY SLEEVE — drop fixed-income / cash-equivalent buckets from the
 * current weights, renormalize the rest to 100%, and report the excluded
 * sleeve so the UI can caption it. A benchmark that DOES carry a
 * fixed-income weight (a blended 60/40-style target) keeps today's
 * full-universe comparison.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  isNonEquitySectorBucket,
  suggestAllocation,
  type CashDeploySuggestion,
} from "@/lib/compute/cash-deploy";

const TODAY = new Date().toISOString().slice(0, 10);

// Seed arithmetic (Vanguard Taxable = account 1, VTI benchmark from migration 050):
//   AAPL   Technology   350 × $200 = $70,000
//   JNJ    Healthcare   100 × $83  =  $8,300   → equities $78,300
//   VMFXX  Fixed Income  60 × $100 =  $6,000   (sweep fund: sector 'Fixed Income')
//   T-BOND Fixed Income  5,700 @ 100 = $5,700  (sectorless bond → 'Fixed Income')
//   holdings $90,000 + $10,000 cash = $100,000 projected
//   fixed-income sleeve $11,700 = 11.7% of projected; equity sleeve $88,300
const CASH = 10_000;
const PROJECTED_TOTAL = 100_000;
const FIXED_INCOME_DOLLARS = 11_700;
const EQUITY_SLEEVE_TOTAL = PROJECTED_TOTAL - FIXED_INCOME_DOLLARS; // 88,300
const TECH_DOLLARS = 70_000;
const HEALTHCARE_DOLLARS = 8_300;
const VTI_TECH_TARGET = 0.31;
const VTI_HEALTHCARE_TARGET = 0.115;

function seedEquities(db: Database.Database) {
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector) VALUES (1, 'AAPL', 'Stock', 'Technology')`
  ).run();
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector) VALUES (2, 'JNJ', 'Stock', 'Healthcare')`
  ).run();
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector) VALUES (3, 'LLY', 'Stock', 'Healthcare')`
  ).run();

  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 200, 'tws')`).run(TODAY);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 83, 'tws')`).run(TODAY);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (3, ?, 750, 'tws')`).run(TODAY);

  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 1, '2026-04-30', 350, 'h-aapl')`
  ).run();
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 2, '2026-04-30', 100, 'h-jnj')`
  ).run();

  // Healthcare is the underweight sleeve sector, so both watchlist names sit there.
  db.prepare(
    `INSERT INTO watchlist (security_id, group_name, is_active, thesis) VALUES (2, 'vanguard_buy', 1, 'defensive yield')`
  ).run();
  db.prepare(
    `INSERT INTO watchlist (security_id, group_name, is_active, thesis) VALUES (3, 'vanguard_buy', 1, 'GLP-1 leader')`
  ).run();
}

function seedFixedIncome(db: Database.Database) {
  // A money-market sweep fund (live data tags VMFXX sector 'Fixed Income',
  // fund_category 'Cash Equivalent') and a sectorless Treasury bond, which
  // explodeHoldingBySector buckets as 'Fixed Income'.
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, fund_category)
     VALUES (4, 'VMFXX', 'Mutual Fund', 'Fixed Income', 'Cash Equivalent')`
  ).run();
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector) VALUES (5, 'T-BOND', 'Bond', NULL)`
  ).run();

  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (4, ?, 100, 'tws')`).run(TODAY);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (5, ?, 100, 'tws')`).run(TODAY);

  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 4, '2026-04-30', 60, 'h-vmfxx')`
  ).run(); // $6,000
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 5, '2026-04-30', 5700, 'h-tbond')`
  ).run(); // 5,700 face @ 100 → $5,700
}

function gapFor(result: CashDeploySuggestion, sector: string) {
  return result.gaps.find((g) => g.sector === sector);
}

describe("equity-sleeve sector gaps (equity benchmark)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedEquities(db);
    seedFixedIncome(db);
  });

  it("drops the unclosable Fixed Income row from the gap table", () => {
    const result = suggestAllocation(db, "vanguard", [1], CASH);
    expect(result.benchmarkSymbol).toBe("VTI");
    expect(result.mode).toBe("benchmark");
    expect(result.gaps.map((g) => g.sector)).not.toContain("Fixed Income");
  });

  it("renormalizes the remaining sector weights onto the equity sleeve", () => {
    const result = suggestAllocation(db, "vanguard", [1], CASH);
    const tech = gapFor(result, "Technology")!;
    expect(tech).toBeDefined();

    const rawWeight = TECH_DOLLARS / PROJECTED_TOTAL; // 0.70 — the old, FI-diluted weight
    const excludedFraction = FIXED_INCOME_DOLLARS / PROJECTED_TOTAL; // 0.117
    expect(tech.currentWeight).toBeCloseTo(rawWeight / (1 - excludedFraction), 9);
    expect(tech.currentWeight).toBeCloseTo(TECH_DOLLARS / EQUITY_SLEEVE_TOTAL, 9);
  });

  it("reports the excluded sleeve so the UI can caption it", () => {
    const result = suggestAllocation(db, "vanguard", [1], CASH);
    expect(result.excludedSleeve).not.toBeNull();
    expect(result.excludedSleeve!.totalPct).toBeCloseTo(11.7, 6);
    expect(result.excludedSleeve!.buckets).toHaveLength(1);
    expect(result.excludedSleeve!.buckets[0].sector).toBe("Fixed Income");
    expect(result.excludedSleeve!.buckets[0].weightPct).toBeCloseTo(11.7, 6);
  });

  it("computes dollarGap against the equity-sleeve denominator, not the full portfolio", () => {
    const result = suggestAllocation(db, "vanguard", [1], CASH);
    const tech = gapFor(result, "Technology")!;

    // Sleeve basis: 88,300 × 31% − 70,000 = −42,627 (overweight, never allocated).
    const sleeveDollarGap = EQUITY_SLEEVE_TOTAL * VTI_TECH_TARGET - TECH_DOLLARS;
    const fullBasisDollarGap = PROJECTED_TOTAL * VTI_TECH_TARGET - TECH_DOLLARS; // −39,000 (old behaviour)
    expect(tech.dollarGap).toBeCloseTo(sleeveDollarGap, 6);
    expect(tech.dollarGap).not.toBeCloseTo(fullBasisDollarGap, 1);
  });

  it("allocates the equity-sleeve gap instead of reporting 'couldn't match any benchmark gaps'", () => {
    const result = suggestAllocation(db, "vanguard", [1], CASH);
    // 88,300 × 11.5% − 8,300 = $1,854.50 of Healthcare to buy.
    const expected = EQUITY_SLEEVE_TOTAL * VTI_HEALTHCARE_TARGET - HEALTHCARE_DOLLARS;
    expect(result.picks.length).toBeGreaterThan(0);
    expect(result.totalAllocated).toBeCloseTo(expected, 6);
    expect(result.notes.join(" ")).not.toMatch(/couldn't match watchlist names/i);
    // Gap fully closed by the allocation — never left double-filled.
    expect(Math.abs(gapFor(result, "Healthcare")!.dollarGap)).toBeLessThan(0.01);
    expect(Math.abs(gapFor(result, "Healthcare")!.gapPp)).toBeLessThan(0.01);
  });

  it("matches, gap for gap, the same equities held with no fixed income at all", () => {
    const withFixedIncome = suggestAllocation(db, "vanguard", [1], CASH);

    const clean = new Database(":memory:");
    clean.pragma("foreign_keys = ON");
    runMigrations(clean);
    seedEquities(clean);
    // Same equities, same $88,300 projected total (78,300 + 10,000 cash),
    // no fixed income at all.
    const withoutFixedIncome = suggestAllocation(clean, "vanguard", [1], CASH);
    clean.close();

    expect(withoutFixedIncome.excludedSleeve).toBeNull();
    expect(withFixedIncome.gaps.map((g) => g.sector)).toEqual(
      withoutFixedIncome.gaps.map((g) => g.sector)
    );
    for (const gap of withFixedIncome.gaps) {
      const twin = gapFor(withoutFixedIncome, gap.sector)!;
      expect(gap.currentWeight).toBeCloseTo(twin.currentWeight, 9);
      expect(gap.targetWeight).toBeCloseTo(twin.targetWeight, 9);
      expect(gap.gapPp).toBeCloseTo(twin.gapPp, 9);
      expect(gap.dollarGap).toBeCloseTo(twin.dollarGap, 6);
    }
  });
});

describe("benchmarks that are NOT equity-only keep the full-universe comparison", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedEquities(db);
    seedFixedIncome(db);
  });

  it("keeps Fixed Income in the table when the benchmark carries a fixed-income weight", () => {
    // Model a blended (60/40-style) target by giving the seeded benchmark a
    // real fixed-income allocation.
    db.prepare(
      `INSERT OR REPLACE INTO benchmark_compositions (benchmark_symbol, sector, weight, market_cap_bucket, refreshed_at)
       VALUES ('VTI', 'Fixed Income', 0.40, '', '2026-04-30')`
    ).run();

    const result = suggestAllocation(db, "vanguard", [1], CASH);
    expect(result.excludedSleeve).toBeNull();

    const fi = gapFor(result, "Fixed Income")!;
    expect(fi).toBeDefined();
    expect(fi.currentWeight).toBeCloseTo(FIXED_INCOME_DOLLARS / PROJECTED_TOTAL, 9);
    expect(fi.targetWeight).toBeCloseTo(0.4, 9);

    // Full-universe denominator for every other sector too.
    expect(gapFor(result, "Technology")!.currentWeight).toBeCloseTo(
      TECH_DOLLARS / PROJECTED_TOTAL,
      9
    );
  });

  it("leaves heuristic mode (no composition seeded) untouched", () => {
    db.prepare(`DELETE FROM benchmark_compositions`).run();
    const result = suggestAllocation(db, "vanguard", [1], CASH);
    expect(result.mode).toBe("heuristic");
    expect(result.excludedSleeve).toBeNull();
    expect(result.gaps.map((g) => g.sector)).toContain("Fixed Income");
  });

  it("reports no excluded sleeve when the portfolio holds no fixed income or cash", () => {
    const clean = new Database(":memory:");
    clean.pragma("foreign_keys = ON");
    runMigrations(clean);
    seedEquities(clean);
    const result = suggestAllocation(clean, "vanguard", [1], CASH);
    clean.close();
    expect(result.excludedSleeve).toBeNull();
  });

  it("reports no excluded sleeve when there is no cash to deploy", () => {
    const result = suggestAllocation(db, "vanguard", [1], 0);
    expect(result.gaps).toHaveLength(0);
    expect(result.excludedSleeve).toBeNull();
  });
});

describe("isNonEquitySectorBucket", () => {
  it("matches the fixed-income and cash bucket vocabulary, case-insensitively", () => {
    expect(isNonEquitySectorBucket("Fixed Income")).toBe(true);
    expect(isNonEquitySectorBucket("fixed income")).toBe(true);
    expect(isNonEquitySectorBucket("Cash")).toBe(true);
    expect(isNonEquitySectorBucket("Cash Equivalent")).toBe(true);
    expect(isNonEquitySectorBucket("Money Market")).toBe(true);
  });

  it("leaves GICS sectors and unclassified equity buckets in the sleeve", () => {
    expect(isNonEquitySectorBucket("Technology")).toBe(false);
    expect(isNonEquitySectorBucket("Real Estate")).toBe(false);
    expect(isNonEquitySectorBucket("Financials")).toBe(false);
    // "Unknown" holds unclassified EQUITIES — excluding it would silently
    // shrink the sleeve. "Diversified" is a broad equity fund label.
    expect(isNonEquitySectorBucket("Unknown")).toBe(false);
    expect(isNonEquitySectorBucket("Diversified")).toBe(false);
  });
});
