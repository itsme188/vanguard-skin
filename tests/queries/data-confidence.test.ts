import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getDataConfidence } from "@/lib/queries/data-confidence";

/**
 * Covers the WS3 universe-correctness bullets for data-confidence.ts: the
 * dimension scorers previously hand-rolled per-account MAX(as_of_date)
 * holdings semantics instead of using the shared latestHoldingsPredicate
 * (lib/queries/latest-holdings.ts), which produced several defective
 * universes — see individual test comments for the specific defect each
 * one targets. Uses the full migrated schema (runMigrations seeds Vanguard
 * Taxable=1, Vanguard Roth IRA=2, IBKR=3).
 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertSecurity(
  db: Database.Database,
  symbol: string,
  opts: { securityType?: string | null; ibConId?: number | null } = {}
): number {
  db.prepare(
    `INSERT INTO securities (symbol, security_type, ib_con_id) VALUES (?, ?, ?)`
  ).run(symbol, opts.securityType ?? null, opts.ibConId ?? null);
  return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
}

function insertBuys(db: Database.Database, accountId: number, securityId: number, count: number): void {
  const stmt = db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
     VALUES (?, ?, '2026-01-05', 'BUY', 10, -100)`
  );
  for (let i = 0; i < count; i++) stmt.run(accountId, securityId);
}

function insertHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  sourceKey: string
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, sourceKey);
}

function insertPrice(db: Database.Database, securityId: number, date: string, closePrice: number): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)`
  ).run(securityId, date, closePrice);
}

function insertDailyValuation(
  db: Database.Database,
  accountId: number,
  date: string,
  holdingsCount: number,
  pricedCount: number
): void {
  db.prepare(
    `INSERT INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
     VALUES (?, ?, 0, 0, 0, ?, ?)`
  ).run(accountId, date, holdingsCount, pricedCount);
}

/** Like insertDailyValuation, but with configurable cash_balance/total_value
 *  so a two-row sequence can produce an unexplained cash-residual jump for
 *  the integrity-gate cap tests (runIntegrityChecks' check 2). */
function insertDailyValuationCash(
  db: Database.Database,
  accountId: number,
  date: string,
  cashBalance: number,
  totalValue: number,
  holdingsCount: number,
  pricedCount: number
): void {
  db.prepare(
    `INSERT INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(accountId, date, cashBalance, totalValue - cashBalance, totalValue, holdingsCount, pricedCount);
}

const NOW = new Date("2026-08-21T16:00:00Z"); // 2026-08-21 in ET, well within the trading day

describe("data-confidence universes (latest-holdings predicate)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("a carried position under a fresher live row stays in the price-freshness universe", () => {
    // Account has a statement AAPL holding as_of 2026-07-31 and a TWS MSFT
    // row as_of 2026-08-20 — the old per-account MAX(as_of_date) join would
    // only see MSFT (the account's max date) and silently drop AAPL from
    // totalHeld, even though AAPL is still a currently-held position.
    const aapl = insertSecurity(db, "AAPL");
    const msft = insertSecurity(db, "MSFT");
    insertHolding(db, 1, aapl, 10, "2026-07-31", "canonical:hold:TAX:AAPL:2026-07-31");
    insertHolding(db, 1, msft, 5, "2026-08-20", "tws-1-msft-2026-08-20");

    const { priceFreshness } = getDataConfidence(db, NOW);
    expect(priceFreshness.totalHeld).toBe(2);
  });

  it("shorts are in the universe (quantity != 0)", () => {
    const spy = insertSecurity(db, "SPY");
    insertHolding(db, 3, spy, -50, "2026-08-20", "tws-3-spy-2026-08-20");

    const { priceFreshness } = getDataConfidence(db, NOW);
    expect(priceFreshness.totalHeld).toBe(1);
  });

  it("a sold-out position can never be the stalest symbol", () => {
    // XYZ was held (qty>0) back on 2026-06-01 with an ancient price, then
    // fully sold — the latest row for (account, XYZ) is qty=0 as_of
    // 2026-08-01. The old stalest query joined ANY holdings row with
    // quantity > 0 (no "latest" filter at all), so the long-sold, long-stale
    // XYZ row would still win "stalest" forever.
    const xyz = insertSecurity(db, "XYZ");
    insertPrice(db, xyz, "2026-06-01", 10);
    insertHolding(db, 1, xyz, 100, "2026-06-01", "canonical:hold:TAX:XYZ:2026-06-01");
    insertHolding(db, 1, xyz, 0, "2026-08-01", "canonical:hold:TAX:XYZ:2026-08-01");

    // A currently-held, recently-priced security so the universe isn't empty.
    const aapl = insertSecurity(db, "AAPL");
    insertPrice(db, aapl, "2026-08-20", 200);
    insertHolding(db, 1, aapl, 10, "2026-08-20", "canonical:hold:TAX:AAPL:2026-08-20");

    const { priceFreshness } = getDataConfidence(db, NOW);
    expect(priceFreshness.stalestSymbol).not.toContain("XYZ");
  });

  it("a held security with NO price rows IS the stalest (LEFT JOIN, missing-first)", () => {
    const noPrice = insertSecurity(db, "NOPRICE");
    insertHolding(db, 1, noPrice, 10, "2026-08-15", "canonical:hold:TAX:NOPRICE:2026-08-15");

    const hasPrice = insertSecurity(db, "HASPRICE");
    insertPrice(db, hasPrice, "2026-08-16", 50); // 5 days stale as of NOW, but it HAS a price
    insertHolding(db, 1, hasPrice, 10, "2026-08-20", "canonical:hold:TAX:HASPRICE:2026-08-20");

    const { priceFreshness } = getDataConfidence(db, NOW);
    expect(priceFreshness.stalestSymbol).toContain("NOPRICE");
    expect(priceFreshness.stalestSymbol).toContain("no price rows");
    // "no price rows" falls back to the holding's own age: 2026-08-21 - 2026-08-15 = 6 days.
    expect(priceFreshness.stalestDays).toBe(6);
  });

  it("holdings recency is per (account, security): one fresh TWS row does not make the account read today", () => {
    const aapl = insertSecurity(db, "AAPL");
    const msft = insertSecurity(db, "MSFT");
    insertHolding(db, 1, aapl, 10, "2026-06-22", "canonical:hold:TAX:AAPL:2026-06-22"); // 60 days old
    insertHolding(db, 1, msft, 5, "2026-08-21", "tws-1-msft-2026-08-21"); // today

    const { holdingsRecency } = getDataConfidence(db, NOW);
    const taxable = holdingsRecency.perAccount.find((a) => a.name === "Vanguard Taxable");
    expect(taxable).toBeDefined();
    expect(taxable!.daysOld).toBe(60);
    expect(taxable!.source).toBe("statement");
  });

  // Regression pin (qa:header-dataconfidence--holdings-date-is-oldest-
  // position-not-latest): the drawer rendered ONLY the stalest position's
  // date under the account name ("Vanguard Taxable: 2026-04-30"), which
  // contradicted Data Health's own "Last holdings 2026-08-27" for the same
  // account — the scoring dimension is deliberately stalest-first (weakest
  // link), but the drawer must show BOTH figures, clearly labeled, so they
  // can never read as disagreeing.
  it("per-account detail carries the account's LATEST holdings date alongside the stalest position's symbol+date; scoring stays stalest-based", () => {
    const fresh = insertSecurity(db, "FRESH");
    const stale = insertSecurity(db, "STALE");
    insertHolding(db, 1, fresh, 10, "2026-08-27", "canonical:hold:TAX:FRESH:2026-08-27");
    insertHolding(db, 1, stale, 5, "2026-04-30", "canonical:hold:TAX:STALE:2026-04-30");

    const now = new Date("2026-08-28T16:00:00Z");
    const { holdingsRecency } = getDataConfidence(db, now);
    const taxable = holdingsRecency.perAccount.find((a) => a.name === "Vanguard Taxable");
    expect(taxable).toBeDefined();

    // Scoring is UNCHANGED: still based on the stalest position (weakest link).
    expect(taxable!.date).toBe("2026-04-30");
    expect(taxable!.daysOld).toBe(120); // 2026-04-30 -> 2026-08-28
    expect(taxable!.stalestSymbol).toBe("STALE");
    expect(holdingsRecency.score).toBe(0); // 90+ days stale bucket, same as before this fix

    // NEW: the account's latest (freshest) holdings date is carried too.
    expect(taxable!.latestDate).toBe("2026-08-27");

    // The composed detail string names both dates + the stalest symbol, so
    // it can never disagree with Data Health's "Last holdings 2026-08-27".
    expect(holdingsRecency.detail).toContain(
      "Vanguard Taxable: latest: 2026-08-27 · stalest position: STALE 2026-04-30"
    );

    // The prescribed action names the position to refresh, not just "import
    // a statement".
    expect(holdingsRecency.guidance).toContain("STALE");
    expect(holdingsRecency.guidance).toContain("Vanguard Taxable");
  });

  it("valuation coverage sums per-account latest rows; an account with holdings but no valuation row counts as unpriced", () => {
    const aapl = insertSecurity(db, "AAPL");
    const msft = insertSecurity(db, "MSFT");
    insertHolding(db, 1, aapl, 10, "2026-08-20", "canonical:hold:TAX:AAPL:2026-08-20");
    insertHolding(db, 1, msft, 5, "2026-08-20", "canonical:hold:TAX:MSFT:2026-08-20");
    insertDailyValuation(db, 1, "2026-08-20", 2, 2); // fully priced

    const spy = insertSecurity(db, "SPY");
    insertHolding(db, 2, spy, 3, "2026-08-19", "canonical:hold:ROTH:SPY:2026-08-19");
    // No daily_valuations row at all for account 2.

    const { valuationCoverage } = getDataConfidence(db, NOW);
    expect(valuationCoverage.totalCount).toBe(3);
    expect(valuationCoverage.pricedCount).toBe(2);
    expect(valuationCoverage.perAccountAsOf).toEqual(
      expect.arrayContaining([
        { accountName: "Vanguard Taxable", asOfDate: "2026-08-20" },
        { accountName: "Vanguard Roth IRA", asOfDate: null },
      ])
    );
  });

  it("evening ET boundary: at 2026-08-23T23:30-04:00 the staleness baseline is 2026-08-23, not -24", () => {
    const aapl = insertSecurity(db, "AAPL");
    insertHolding(db, 1, aapl, 10, "2026-08-23", "canonical:hold:TAX:AAPL:2026-08-23");

    const { holdingsRecency } = getDataConfidence(db, new Date("2026-08-24T03:30:00Z"));
    const taxable = holdingsRecency.perAccount.find((a) => a.name === "Vanguard Taxable");
    expect(taxable).toBeDefined();
    expect(taxable!.daysOld).toBe(0);
  });
});

/**
 * Integrity gate cap (spec: number-trust durable fixes, task 18). Cap
 * applies AFTER the existing weighted mean: any critical hit caps
 * overallScore to <=45 and monotonically lowers overallLevel (high|medium →
 * low; stale never promotes). Warnings never cap. capReason names the FIRST
 * critical hit by module order (deterministic — see runIntegrityChecks'
 * push order in lib/queries/integrity-checks.ts).
 */
describe("data-confidence — integrity gate cap", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("a critical hit caps level high→low and score to <=45, names capReason", () => {
    // A clean, well-covered portfolio (all 3 seeded accounts hold the same
    // priced/enriched/valued security as-of today) drives the pre-cap
    // weighted mean to "high" (>=80) on its own — see the per-dimension
    // breakdown below. A single unexplained cash-residual jump in account 1
    // (critical hit, check 2 of runIntegrityChecks) is the only integrity
    // problem: it also caps scoreCashAccuracy internally to <=40, but even
    // so priceFreshness(100)*.4 + holdingsRecency(100)*.25 + cashAccuracy(~40)*.15
    // + enrichment(100)*.1 + valuationCoverage(100)*.1 ≈ 91 pre-cap — "high".
    const aapl = insertSecurity(db, "AAPL", { ibConId: 12345 });
    insertPrice(db, aapl, "2026-08-21", 200);
    for (const accountId of [1, 2, 3]) {
      insertHolding(db, accountId, aapl, 10, "2026-08-21", `canonical:hold:${accountId}:AAPL:2026-08-21`);
    }
    // Account 1: an older, clean valuation followed by an unexplained
    // -50,000 cash jump with no matching transaction — the critical hit.
    insertDailyValuationCash(db, 1, "2026-08-19", 200_000, 500_000, 1, 1);
    insertDailyValuationCash(db, 1, "2026-08-21", 150_000, 500_000, 1, 1);
    // Accounts 2 and 3: single clean valuation rows (no jump possible).
    insertDailyValuationCash(db, 2, "2026-08-21", 100_000, 400_000, 1, 1);
    insertDailyValuationCash(db, 3, "2026-08-21", 100_000, 400_000, 1, 1);

    const result = getDataConfidence(db, NOW);

    expect(result.integrity.critical.length).toBeGreaterThan(0);
    expect(result.capReason).toBe(
      "Vanguard Taxable: unexplained cash residual of -50000.00 on 2026-08-21"
    );
    expect(result.overallScore).toBeLessThanOrEqual(45);
    expect(result.overallLevel).toBe("low");
  });

  it("cap never promotes: a stale result stays stale and its score is unchanged, with capReason set", () => {
    // Every dimension is deliberately starved (no prices, ancient holding,
    // no statement anchor, unenriched, unpriced valuation) so the pre-cap
    // weighted mean is already 0 — well under the 45 cap. Math.min(0, 45)
    // must leave it at 0, and overallLevel ("stale", <20) must NOT be
    // promoted to "low" by the cap. (Illustrative score is 0 here rather
    // than a specific nonzero "stale" value — the fixture is deterministic
    // by construction; any score below 45 exercises the same "never
    // promotes" code path.)
    const aapl = insertSecurity(db, "AAPL"); // no ibConId → unenriched
    insertHolding(db, 1, aapl, 10, "2026-01-01", "canonical:hold:TAX:AAPL:2026-01-01"); // ancient
    // No price row for AAPL at all → priceFreshness = 0.
    // No monthly_snapshots row at all → cashAccuracy = 0.
    // Two daily_valuations rows for account 1 with an unexplained cash jump
    // (the critical hit) and priced_count=0 → valuationCoverage = 0.
    insertDailyValuationCash(db, 1, "2026-08-19", 200_000, 500_000, 1, 0);
    insertDailyValuationCash(db, 1, "2026-08-21", 150_000, 500_000, 1, 0);

    const result = getDataConfidence(db, NOW);

    expect(result.overallScore).toBe(0);
    expect(result.overallLevel).toBe("stale");
    expect(result.capReason).toBe(
      "Vanguard Taxable: unexplained cash residual of -50000.00 on 2026-08-21"
    );
  });

  it("warnings do not cap: overallScore/Level pass through unchanged and capReason stays null", () => {
    // A corporate-action reconcile-delta hit is ALWAYS a warning (check 4 of
    // runIntegrityChecks) — never critical. No holdings/prices/snapshots at
    // all, so the weighted mean is a fixed, known value: priceFreshness=100
    // (nothing to price) * .4 + holdingsRecency=0 (3 seeded accounts, none
    // ever synced) * .25 + cashAccuracy=0 (no anchor) * .15 +
    // enrichment=100 (nothing to enrich) * .1 + valuationCoverage=0 (no
    // valuations at all) * .1 = 50.
    db.prepare(
      `INSERT INTO securities (id, symbol) VALUES (200, 'SPLIT')`
    ).run();
    db.prepare(
      `INSERT INTO corporate_actions
         (id, security_id, action_type, effective_date, ratio_numerator, ratio_denominator, reconcile_delta)
       VALUES (5, 200, 'SPLIT', '2026-06-15', 2, 1, 3.5)`
    ).run();

    const result = getDataConfidence(db, NOW);

    expect(result.integrity.critical).toEqual([]);
    expect(result.integrity.warnings.length).toBeGreaterThan(0);
    expect(result.overallScore).toBe(50);
    expect(result.overallLevel).toBe("medium");
    expect(result.capReason).toBeNull();
  });

  it("two criticals: capReason names the FIRST by module order (type-identity before cash-residual)", () => {
    // runIntegrityChecks pushes check-1 (type-identity) hits into `critical`
    // before check-2 (cash-residual) hits, regardless of each check's own
    // internal "worst" ordering — this pins that module-order determinism.
    const bond = insertSecurity(db, "ZZZ", { securityType: "Bond" });
    insertBuys(db, 1, bond, 12); // >10 equity fills on a Bond-typed security
    insertHolding(db, 1, bond, 100, "2026-08-21", "canonical:hold:TAX:ZZZ:2026-08-21"); // held → critical

    insertDailyValuationCash(db, 1, "2026-08-19", 200_000, 500_000, 1, 1);
    insertDailyValuationCash(db, 1, "2026-08-21", 150_000, 500_000, 1, 1); // unexplained jump → critical

    const result = getDataConfidence(db, NOW);

    expect(result.integrity.critical.length).toBeGreaterThanOrEqual(2);
    expect(result.capReason).toBe("ZZZ: Bond type contradicts 12 equity fills");
  });
});
