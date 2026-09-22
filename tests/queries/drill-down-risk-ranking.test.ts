/**
 * The "Top N by risk" drawer (DrillDownPanel with `filter.kind === "risk"`,
 * backed by GET /api/analysis/drill-down -> getHoldingsInBucket) must:
 *
 *   1. draw the SAME universe the Concentration Metrics "Top 10 Positions"
 *      chart draws (top N positions by market value, one row per security),
 *      and
 *   2. rank those rows by per-position risk contribution computed through
 *      computePositionRisk — the same code path the Position-Level Risk card
 *      uses — never a hand-rolled proxy, and
 *   3. leave out positions with no measurable volatility (the money-market
 *      sweep), which would otherwise sit at the top of a list titled "by
 *      risk" purely because it is the biggest balance.
 *
 * Pre-fix the risk branch ordered by `market_value * COALESCE(beta, 1)` — a
 * beta-weighted proxy that is neither ranking. On live data it pulled two
 * small high-beta names into the top 10 and pushed the 7th and 8th largest
 * positions out of it, so the drawer and the chart on the SAME page listed
 * different names.
 *
 * [qa:analysis-diagnostics--four-different-spy-weights-one-page-regression-4]
 * [qa:analysis-risk-drawer--top10-by-risk-ranked-by-value-vmfxx-first]
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";
import { getConcentrationMetrics } from "@/lib/queries/analysis";
import { computePositionRisk } from "@/lib/compute/risk";
import { getConcentrationUniverse } from "@/lib/queries/concentration-universe";

// Migration 002 seeds: 1=Vanguard Taxable, 2=Vanguard Roth IRA, 3=IBKR.
const ACCOUNT = 1;
const SERIES_DAYS = 80;

// Deterministic zero-drift return shape. Every security shares it and only
// scales it, so correlations are ~1 and each position's risk contribution is
// proportional to weight x volatility — which makes the expected ranking
// exact rather than approximate. sd(PATTERN) ~ 1.549.
const PATTERN = [1, -1, 2, -2, 1, -1];
const PATTERN_SD = 1.5492;
const TRADING_DAYS_PER_YEAR = 252;

/** Daily amplitude that produces roughly `annualVol` annualized volatility. */
function amplitudeFor(annualVol: number): number {
  return annualVol / (PATTERN_SD * Math.sqrt(TRADING_DAYS_PER_YEAR));
}

/** `SERIES_DAYS` consecutive calendar dates ending yesterday. */
function seriesDates(): string[] {
  const out: string[] = [];
  const end = Date.now() - 24 * 3600 * 1000;
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    out.push(new Date(end - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  return out;
}

const DATES = seriesDates();
const AS_OF = DATES[DATES.length - 1];

/**
 * Write a price series whose LAST close is exactly `endPrice`, so a
 * position's market value is quantity x endPrice regardless of the path.
 */
function seedPriceSeries(
  db: Database.Database,
  securityId: number,
  annualVol: number,
  endPrice: number
) {
  const amp = amplitudeFor(annualVol);
  const rel: number[] = [1];
  for (let t = 0; t < DATES.length - 1; t++) {
    rel.push(rel[rel.length - 1] * Math.exp(amp * PATTERN[t % PATTERN.length]));
  }
  const last = rel[rel.length - 1];
  const stmt = db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`
  );
  DATES.forEach((d, i) => stmt.run(securityId, d, (endPrice * rel[i]) / last));
}

/**
 * The book:
 *   SWEEP1  $200,000  money market, 80 pinned closes -> measured vol exactly 0
 *   SWEEP2  $150,000  money market, 3 closes         -> vol not publishable
 *   E01..E08 $100k..$30k  the 8 equities that belong in a top-10 universe
 *   E09 $20,000, E10 $10,000  too small for the top 10 -- but carry beta 3.0,
 *                             which the pre-fix `market_value * beta` proxy
 *                             hoisted INTO it, at E07/E08's expense.
 */
const EQUITIES = [
  { id: 11, symbol: "EQ01", qty: 1000, annualVol: 0.10, beta: null },
  { id: 12, symbol: "EQ02", qty: 900, annualVol: 0.50, beta: null },
  { id: 13, symbol: "EQ03", qty: 800, annualVol: 0.15, beta: null },
  { id: 14, symbol: "EQ04", qty: 700, annualVol: 0.60, beta: null },
  { id: 15, symbol: "EQ05", qty: 600, annualVol: 0.25, beta: null },
  { id: 16, symbol: "EQ06", qty: 500, annualVol: 0.70, beta: null },
  { id: 17, symbol: "EQ07", qty: 400, annualVol: 0.45, beta: 0.3 },
  { id: 18, symbol: "EQ08", qty: 300, annualVol: 0.80, beta: 0.3 },
  { id: 19, symbol: "EQ09", qty: 200, annualVol: 0.90, beta: 3.0 },
  { id: 20, symbol: "EQ10", qty: 100, annualVol: 0.90, beta: 3.0 },
];

const SWEEPS = [
  { id: 1, symbol: "SWEEP1", qty: 200000, closes: DATES },
  { id: 2, symbol: "SWEEP2", qty: 150000, closes: DATES.slice(-3) },
];

function seedBook(db: Database.Database) {
  const insSec = db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insHold = db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)`
  );
  const insBeta = db.prepare(
    `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 60, ?, ?)`
  );
  const insPrice = db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 1.0, 'test')`
  );

  for (const s of SWEEPS) {
    insSec.run(s.id, s.symbol, `${s.symbol} Sweep Fund`, "Mutual Fund", null, "Cash Equivalent");
    for (const d of s.closes) insPrice.run(s.id, d);
    insHold.run(ACCOUNT, s.id, AS_OF, s.qty, `h-${s.symbol}`);
  }

  for (const e of EQUITIES) {
    insSec.run(e.id, e.symbol, `${e.symbol} Inc.`, "Stock", "Technology", "US Sector Equity (Technology)");
    seedPriceSeries(db, e.id, e.annualVol, 100);
    insHold.run(ACCOUNT, e.id, AS_OF, e.qty, `h-${e.symbol}`);
    if (e.beta != null) insBeta.run(e.id, e.beta, AS_OF);
  }
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  seedBook(db);
  return db;
}

describe("risk drill-down universe == Concentration 'Top 10 Positions' universe", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("with no cash equivalents in the book, the drawer lists exactly the concentration top 10", () => {
    // Drop the sweeps so the two lists have no ruled-out rows between them.
    db.prepare(`DELETE FROM holdings WHERE security_id IN (1, 2)`).run();

    const drawer = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    const concentration = getConcentrationMetrics(db).top_positions;

    expect(concentration).toHaveLength(10);
    expect(new Set(drawer.map((r) => r.symbol))).toEqual(
      new Set(concentration.map((p) => p.symbol))
    );
  });

  it("with sweeps in the book, the drawer is the concentration top 10 minus the sweeps", () => {
    const drawer = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    const concentration = getConcentrationMetrics(db).top_positions.map((p) => p.symbol);

    // The chart's own top 10 is value-ranked, so both sweeps sit in it.
    expect(concentration.slice(0, 2)).toEqual(["SWEEP1", "SWEEP2"]);
    expect(drawer.map((r) => r.symbol).sort()).toEqual(
      concentration.filter((s) => !s.startsWith("SWEEP")).sort()
    );
  });

  it("keeps the 7th and 8th largest positions and rejects smaller high-beta names", () => {
    // Pre-fix regression: ORDER BY market_value * COALESCE(beta, 1) put
    // EQ09/EQ10 (beta 3.0) ahead of EQ07/EQ08 (beta 0.3) even though EQ07 is
    // twice EQ09's size -- the exact live symptom.
    const symbols = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 }).map((r) => r.symbol);
    expect(symbols).toContain("EQ07");
    expect(symbols).toContain("EQ08");
    expect(symbols).not.toContain("EQ09");
    expect(symbols).not.toContain("EQ10");
  });
});

describe("risk drill-down ranks by risk contribution, not market value", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("rows come back in non-increasing risk-contribution order", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    expect(rows.length).toBeGreaterThan(1);
    const contributions = rows.map((r) => r.riskContribution);
    expect(contributions.every((c) => typeof c === "number")).toBe(true);
    for (let i = 1; i < contributions.length; i++) {
      expect(contributions[i - 1]!).toBeGreaterThanOrEqual(contributions[i]!);
    }
  });

  it("the order is weight x volatility, which is NOT the market-value order", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    // weight x vol: EQ02 .45, EQ04 .42, EQ06 .35, EQ08 .24, EQ07 .18,
    //               EQ05 .15, EQ03 .12, EQ01 .10
    expect(rows.map((r) => r.symbol)).toEqual([
      "EQ02", "EQ04", "EQ06", "EQ08", "EQ07", "EQ05", "EQ03", "EQ01",
    ]);
    // Market-value order would have been EQ01..EQ08 -- the old drawer order.
    expect(rows.map((r) => r.symbol)).not.toEqual([
      "EQ01", "EQ02", "EQ03", "EQ04", "EQ05", "EQ06", "EQ07", "EQ08",
    ]);
  });

  it("every row's risk contribution and weight come from computePositionRisk itself", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    const card = computePositionRisk(db, { topN: 10 });
    for (const row of rows) {
      const position = card.positions.find((p) => p.securityId === row.securityId);
      expect(position, `${row.symbol} missing from the Position-Level Risk card`).toBeDefined();
      expect(row.riskContribution).toBe(position!.riskContribution);
      // Same weight as the card, to the bit -- one page must not render two
      // different weights for the same ticker.
      expect(row.weight).toBe(position!.weight);
    }
  });
});

describe("risk drill-down excludes positions with no measurable volatility", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("the money-market sweep is not the first row -- it is not a row at all", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    expect(rows.map((r) => r.symbol)).not.toContain("SWEEP1"); // vol measured at 0
    expect(rows.map((r) => r.symbol)).not.toContain("SWEEP2"); // vol not publishable
    expect(rows[0].symbol).not.toMatch(/^SWEEP/);
  });

  it("dropping the sweeps shortens the list rather than back-filling smaller names", () => {
    // The universe is the concentration top 10; excluded rows are removed
    // from it, never replaced by rank 11/12.
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.symbol)).not.toContain("EQ09");
  });

  it("still carries the drill-down display columns (sector, factors, beta)", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    const eq07 = rows.find((r) => r.symbol === "EQ07")!;
    expect(eq07.sector).toBe("Technology");
    expect(eq07.beta).toBe(0.3);
    expect(eq07.marketValue).toBeCloseTo(40000, 4);
  });
});

describe("risk drill-down respects account scope", () => {
  it("an account holding none of the book returns no rows", () => {
    const db = freshDb();
    const rows = getHoldingsInBucket(db, "roth", { kind: "risk", topN: 10 }, [2]);
    expect(rows).toEqual([]);
  });

  it("scoping to the holding account returns the same ranking", () => {
    const db = freshDb();
    const scoped = getHoldingsInBucket(db, "vanguard", { kind: "risk", topN: 10 }, [ACCOUNT]);
    const all = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    expect(scoped.map((r) => r.symbol)).toEqual(all.map((r) => r.symbol));
  });
});

/**
 * Review findings on the ranking change (PR #86):
 *
 *   1. The drawer ALSO dropped every position whose published annualized
 *      volatility sat under a 0.5% floor. A Treasury bill priced near par
 *      prints well under that and is explicitly NOT a cash equivalent
 *      (lib/compute/cash-equivalents.ts says so in as many words), so it
 *      vanished from a list whose caption only disclosed sweeps. Silent
 *      omission of a real position — the exact bug class the "unpublishable
 *      volatility is KEPT" rule already guards. The floor is gone; identity
 *      (isCashEquivalentSecurity) is the only exclusion.
 *   2. The caption claimed the drawer drew "the same positions as the
 *      Concentration chart's top holdings". It does not, and cannot: the
 *      drawer projects `computePositionRisk`, whose universe differs from
 *      `getConcentrationUniverse` on three axes. The tests below pin those
 *      three divergences so the two universes can never be quietly assumed
 *      equal again (the caption pin itself lives in
 *      tests/repo/drill-down-risk-metric-column.test.ts).
 */

/**
 * A second, small book built for the universe edge cases. Kept separate from
 * `seedBook` so the exact-ordering assertions above stay readable.
 *
 *   ANCH  $100,000  ordinary equity, 30% vol — the anchor position
 *   BILL   $20,000  Treasury bill at par, 0.1% vol, NOT a cash equivalent
 *   SWEP  $150,000  money-market sweep, pinned closes (fund_category set)
 *   MATB   $30,000  bond whose maturity_date is years past
 *   SHRT  -$50,000  a short
 *   NOPX        --  held, but no price row at all (cost basis $50,000)
 */
function seedEdgeBook(db: Database.Database) {
  const insSec = db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, maturity_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insHold = db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, cost_basis, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  insSec.run(31, "ANCH", "ANCH Inc.", "Stock", "Technology", null, null);
  seedPriceSeries(db, 31, 0.30, 100);
  insHold.run(ACCOUNT, 31, AS_OF, 1000, 90000, "h-ANCH");

  // A bill trading at par. Its measured volatility is a tenth of a percent —
  // real, publishable, and far under the removed 0.5% floor.
  insSec.run(32, "BILL", "BILL Treasury Bill", "Bond", null, "Government Bond", null);
  seedPriceSeries(db, 32, 0.001, 100);
  insHold.run(ACCOUNT, 32, AS_OF, 20000, 19800, "h-BILL");

  insSec.run(33, "SWEP", "SWEP Sweep Fund", "Mutual Fund", null, "Cash Equivalent", null);
  const insPinned = db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 1.0, 'test')`
  );
  for (const d of DATES) insPinned.run(33, d);
  insHold.run(ACCOUNT, 33, AS_OF, 150000, 150000, "h-SWEP");

  insSec.run(34, "MATB", "MATB Matured Bond", "Bond", null, "Government Bond", "2020-06-30");
  seedPriceSeries(db, 34, 0.05, 100);
  insHold.run(ACCOUNT, 34, AS_OF, 30000, 29500, "h-MATB");

  insSec.run(35, "SHRT", "SHRT Inc.", "Stock", "Technology", null, null);
  seedPriceSeries(db, 35, 0.40, 100);
  insHold.run(ACCOUNT, 35, AS_OF, -500, -45000, "h-SHRT");

  insSec.run(36, "NOPX", "NOPX Inc.", "Stock", "Technology", null, null);
  insHold.run(ACCOUNT, 36, AS_OF, 1000, 50000, "h-NOPX");
}

function edgeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  seedEdgeBook(db);
  return db;
}

describe("risk drill-down excludes sweeps by identity, not by a volatility floor", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = edgeDb();
  });

  it("keeps a near-par bill whose volatility is a tenth of a percent", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    const bill = rows.find((r) => r.symbol === "BILL");

    expect(bill, "a real, priced, non-cash-equivalent position must not vanish").toBeDefined();
    // It renders at its own (tiny) contribution rather than being hidden.
    expect(typeof bill!.riskContribution).toBe("number");
    expect(bill!.riskContribution!).toBeGreaterThan(0);
    // And it sorts where its risk puts it: last, behind the 30% and 5% names.
    expect(rows[rows.length - 1].symbol).toBe("BILL");
  });

  it("still excludes the money-market sweep through the shared cash-equivalent identity", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    expect(rows.map((r) => r.symbol)).not.toContain("SWEP");
  });
});

describe("risk drill-down universe is computePositionRisk's, NOT the concentration universe's", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = edgeDb();
  });

  it("drops a SHORT that the concentration universe carries (includeShorts: false)", () => {
    const drawer = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    const universe = getConcentrationUniverse(db);

    expect(drawer.map((r) => r.symbol)).not.toContain("SHRT");
    expect(universe.map((p) => p.symbol)).toContain("SHRT");
  });

  it("drops an UNPRICED position that the concentration universe carries at cost basis", () => {
    const drawer = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    const universe = getConcentrationUniverse(db);

    expect(drawer.map((r) => r.symbol)).not.toContain("NOPX");
    const nopx = universe.find((p) => p.symbol === "NOPX");
    expect(nopx?.marketValue).toBe(50000);
  });

  it("KEEPS a matured bond that the concentration universe drops (no maturity filter)", () => {
    // Documenting today's behaviour, not endorsing it: computePositionRisk
    // applies no maturity cutoff, so the drawer still ranks a bond that has
    // already redeemed. Changing that belongs in lib/compute/risk.ts.
    const drawer = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 });
    const universe = getConcentrationUniverse(db);

    expect(drawer.map((r) => r.symbol)).toContain("MATB");
    expect(universe.map((p) => p.symbol)).not.toContain("MATB");
  });

  it("so the two lists differ — the drawer must never claim to be the chart's top holdings", () => {
    const drawer = getHoldingsInBucket(db, "all", { kind: "risk", topN: 10 }).map((r) => r.symbol);
    const chartTop = getConcentrationUniverse(db)
      .slice(0, 10)
      .map((p) => p.symbol);
    expect(new Set(drawer)).not.toEqual(new Set(chartTop));
  });
});
