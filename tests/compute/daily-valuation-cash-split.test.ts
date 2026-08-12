import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";

/**
 * Cash/holdings split normalization in the daily valuation engine.
 *
 * Two sources describe the same account with different conventions:
 *  - the statement/canonical path writes the sweep money-market fund AND
 *    Treasuries as ordinary `holdings` rows;
 *  - the Plaid daily path folds the sweep fund into cash (never a position)
 *    and does not report Treasuries at all.
 *
 * Because `cash_balance` is a residual (snapshot_total − holdings_value),
 * whichever source owns the latest snapshot for a date used to decide
 * whether the sweep balance counted as cash or as holdings — a month-end
 * "split flip" with no economic event behind it, plus a phantom holdings
 * cliff on the days the bonds vanished.
 *
 * Normalization: sweep = cash everywhere, bonds = holdings everywhere.
 * All figures below are synthetic.
 */

function seedSecurity(
  db: Database.Database,
  symbol: string,
  securityType?: string,
  fundCategory?: string
): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type, fund_category) VALUES (?, ?, ?, ?)")
    .run(symbol, symbol + " Fund", securityType ?? null, fundCategory ?? null);
  return result.lastInsertRowid as number;
}

/** source_key prefix is load-bearing here: 'canonical:' / 'plaid:' / 'tws-'
 *  are what the engine reads to decide whether to carry bonds forward. */
function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  sourceKey: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, sourceKey);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  date: string,
  totalValue: number,
  source: string
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, ?)`
  ).run(accountId, date, totalValue, source);
}

function valuationsByDate(db: Database.Database, accountId: number): Record<string, any> {
  return Object.fromEntries(
    (
      db
        .prepare(
          `SELECT valuation_date, cash_balance, holdings_value, total_value,
                  holdings_count, priced_count, data_quality
             FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date`
        )
        .all(accountId) as any[]
    ).map((v) => [v.valuation_date, v])
  );
}

describe("daily valuation — cash/holdings split normalization", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  // ─── Part B: sweep money-market funds are cash, not holdings ─────

  it("keeps the cash/holdings split continuous across a canonical→Plaid source handoff", () => {
    // The 07-31 regression shape: a statement month-end that reports the
    // sweep fund as a holding, immediately followed by a Plaid day that
    // reports the same money as cash. Totals matched at both anchors even
    // pre-fix — it was the SPLIT that flipped, so assert cash continuity.
    const aapl = seedSecurity(db, "AAPL", "stock", "US Large Cap Equity");
    const sweep = seedSecurity(db, "VMFXX", "money_market", "Cash Equivalent");

    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-07-31", "canonical:hold:TAX:AAPL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, sweep, 40_000, "2026-07-31", "canonical:hold:TAX:VMFXX:2026-07-31");
    // Plaid day: only AAPL is a position; the sweep balance arrives as cash.
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-03", "plaid:1:1:2026-08-03");

    seedPrice(db, aapl, "2026-07-31", 150);
    seedPrice(db, aapl, "2026-08-03", 150);
    seedPrice(db, sweep, "2026-07-31", 1);
    seedPrice(db, sweep, "2026-08-03", 1);

    // Both days carry an anchor (statement NetLiq, then Plaid NetLiq).
    seedSnapshot(db, ACCOUNT_ID, "2026-07-31", 56_000, "statement");
    seedSnapshot(db, ACCOUNT_ID, "2026-08-03", 56_000, "plaid");

    computeDailyValuations(db);
    const vals = valuationsByDate(db, ACCOUNT_ID);

    // Statement day: sweep is excluded from holdings and re-enters via the
    // Phase 2 residual. 100 * 150 = 15,000 of real positions.
    expect(vals["2026-07-31"].holdings_value).toBe(15_000);
    expect(vals["2026-07-31"].holdings_count).toBe(1); // sweep not counted
    expect(vals["2026-07-31"].cash_balance).toBe(41_000); // 40,000 sweep + 1,000 true cash
    expect(vals["2026-07-31"].total_value).toBe(56_000); // anchor invariant

    // Plaid day: identical split — no flip, no phantom move.
    expect(vals["2026-08-03"].holdings_value).toBe(15_000);
    expect(vals["2026-08-03"].cash_balance).toBe(41_000);
    expect(vals["2026-08-03"].total_value).toBe(56_000);

    expect(vals["2026-08-03"].cash_balance).toBe(vals["2026-07-31"].cash_balance);
  });

  it("still writes a valuation row when every holding is a cash equivalent", () => {
    // An all-sweep account has nothing to value, but Phase 2 needs a row on
    // the date to attach the anchor's cash to — otherwise the whole account
    // silently disappears from the series.
    const sweep = seedSecurity(db, "VMFXX", "money_market", "Cash Equivalent");
    seedHolding(db, ACCOUNT_ID, sweep, 40_000, "2026-07-31", "canonical:hold:TAX:VMFXX:2026-07-31");
    seedPrice(db, sweep, "2026-07-31", 1);
    seedSnapshot(db, ACCOUNT_ID, "2026-07-31", 40_000, "statement");

    computeDailyValuations(db);
    const vals = valuationsByDate(db, ACCOUNT_ID);

    expect(vals["2026-07-31"]).toBeDefined();
    expect(vals["2026-07-31"].holdings_value).toBe(0);
    expect(vals["2026-07-31"].holdings_count).toBe(0);
    expect(vals["2026-07-31"].priced_count).toBe(0);
    expect(vals["2026-07-31"].data_quality).toBe("estimated");
    expect(vals["2026-07-31"].cash_balance).toBe(40_000);
    expect(vals["2026-07-31"].total_value).toBe(40_000);
  });

  it("excludes a sweep fund flagged only by fund_category (security_type never repaired)", () => {
    const aapl = seedSecurity(db, "AAPL", "stock", "US Large Cap Equity");
    // Broker labeled it a plain stock; only the classification layer knows.
    const sweep = seedSecurity(db, "VFFXX", "stock", "Cash Equivalent");

    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-07-31", "canonical:hold:TAX:AAPL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, sweep, 10_000, "2026-07-31", "canonical:hold:TAX:VFFXX:2026-07-31");
    seedPrice(db, aapl, "2026-07-31", 150);
    seedPrice(db, sweep, "2026-07-31", 1);
    seedSnapshot(db, ACCOUNT_ID, "2026-07-31", 25_000, "statement");

    computeDailyValuations(db);
    const vals = valuationsByDate(db, ACCOUNT_ID);

    expect(vals["2026-07-31"].holdings_value).toBe(15_000);
    expect(vals["2026-07-31"].cash_balance).toBe(10_000);
    expect(vals["2026-07-31"].total_value).toBe(25_000);
  });

  // ─── Part C: statement bonds carried into Plaid-sourced days ─────

  it("carries statement-sourced bonds into Plaid snapshot days and marks them daily", () => {
    const aapl = seedSecurity(db, "AAPL", "stock", "US Large Cap Equity");
    const bill = seedSecurity(db, "TBILL", "bond", "US Treasury");

    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-07-31", "canonical:hold:TAX:AAPL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, bill, 100_000, "2026-07-31", "canonical:hold:TAX:TBILL:2026-07-31");
    // Plaid never reports the Treasury.
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-03", "plaid:1:1:2026-08-03");
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-04", "plaid:1:1:2026-08-04");

    for (const d of ["2026-07-31", "2026-08-03", "2026-08-04"]) seedPrice(db, aapl, d, 150);
    seedPrice(db, bill, "2026-07-31", 99);
    seedPrice(db, bill, "2026-08-03", 99.5);
    seedPrice(db, bill, "2026-08-04", 100);

    // Only a 07-31 anchor: 15,000 equity + 99,000 bond + 1,000 cash.
    seedSnapshot(db, ACCOUNT_ID, "2026-07-31", 115_000, "statement");

    computeDailyValuations(db);
    const vals = valuationsByDate(db, ACCOUNT_ID);

    expect(vals["2026-07-31"].holdings_value).toBe(114_000);
    expect(vals["2026-07-31"].cash_balance).toBe(1_000);

    // Plaid days: bond still held, marked at that day's price.
    expect(vals["2026-08-03"].holdings_value).toBe(114_500); // 15,000 + 99,500
    expect(vals["2026-08-03"].holdings_count).toBe(2);
    expect(vals["2026-08-03"].priced_count).toBe(2);
    expect(vals["2026-08-04"].holdings_value).toBe(115_000); // 15,000 + 100,000

    // Cash stays smooth — no bond value leaking into the residual.
    expect(vals["2026-08-03"].cash_balance).toBe(1_000);
    expect(vals["2026-08-04"].cash_balance).toBe(1_000);
  });

  it("keeps cash positive when a Plaid ANCHOR day also carries a bond (the daily production shape)", () => {
    // The shape that actually ships: Plaid writes a monthly_snapshots anchor
    // on every sync (lib/plaid/refresh.ts), so on a carry day the residual is
    // computed against a PLAID total rather than inherited from the previous
    // statement — cash = plaid_total − (equity + carried_bond).
    //
    // That makes this the one test that exercises the engine's load-bearing
    // assumption: Plaid's account `balances.current` includes the
    // institution-held Treasury even though Plaid never reports it as a
    // position. Verified against real data — Plaid-anchored carry days come
    // out positive and smooth, with zero negative-cash rows on the account
    // that holds bonds. If a future Plaid change dropped bond value from the
    // account total, the carried bond would be subtracted from a total that
    // never contained it and cash would crater by the bond's full market
    // value; the positivity assertions below are the canary for that.
    const aapl = seedSecurity(db, "AAPL", "stock", "US Large Cap Equity");
    const bill = seedSecurity(db, "TBILL", "bond", "US Treasury");
    const TRUE_CASH = 1_000;

    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-07-31", "canonical:hold:TAX:AAPL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, bill, 100_000, "2026-07-31", "canonical:hold:TAX:TBILL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-03", "plaid:1:1:2026-08-03");
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-04", "plaid:1:1:2026-08-04");

    for (const d of ["2026-07-31", "2026-08-03", "2026-08-04"]) seedPrice(db, aapl, d, 150);
    seedPrice(db, bill, "2026-07-31", 99);   // 99,000
    seedPrice(db, bill, "2026-08-03", 99.5); // 99,500
    seedPrice(db, bill, "2026-08-04", 100);  // 100,000

    // Statement anchor, then a Plaid anchor on EACH sync day. Every total
    // includes the bond's market value — that is the verified reality this
    // test pins down.
    seedSnapshot(db, ACCOUNT_ID, "2026-07-31", 15_000 + 99_000 + TRUE_CASH, "statement");
    seedSnapshot(db, ACCOUNT_ID, "2026-08-03", 15_000 + 99_500 + TRUE_CASH, "plaid");
    seedSnapshot(db, ACCOUNT_ID, "2026-08-04", 15_000 + 100_000 + TRUE_CASH, "plaid");

    computeDailyValuations(db);
    const vals = valuationsByDate(db, ACCOUNT_ID);

    // (c) The carried bond is inside holdings_value on the Plaid anchor days.
    expect(vals["2026-08-03"].holdings_value).toBe(114_500); // 15,000 + 99,500
    expect(vals["2026-08-03"].holdings_count).toBe(2);
    expect(vals["2026-08-04"].holdings_value).toBe(115_000); // 15,000 + 100,000

    // (a) The residual against the PLAID total lands exactly on true cash —
    // it does not absorb the bond (that would be ~100,500, a phantom spike)
    // and it does not go negative (that would be ~-98,500, the failure mode
    // if Plaid's total ever excluded the bond).
    expect(vals["2026-08-03"].cash_balance).toBe(TRUE_CASH);
    expect(vals["2026-08-04"].cash_balance).toBe(TRUE_CASH);

    // (b) Positive and continuous across the statement→Plaid handoff and
    // across consecutive Plaid anchors — no step, no sign flip.
    for (const d of ["2026-07-31", "2026-08-03", "2026-08-04"]) {
      expect(vals[d].cash_balance).toBeGreaterThan(0);
      expect(vals[d].cash_balance).toBe(TRUE_CASH);
      // Totals still equal the anchors' own snapshot totals.
      expect(vals[d].total_value).toBe(vals[d].holdings_value + TRUE_CASH);
    }
  });

  it("never carries bonds into a TWS-sourced snapshot day", () => {
    // TWS reports bonds itself; carrying would double-count around a
    // mid-month sale. The gate is the presence of a plaid: row, not the
    // absence of bonds alone.
    const aapl = seedSecurity(db, "AAPL", "stock", "US Large Cap Equity");
    const bill = seedSecurity(db, "TBILL", "bond", "US Treasury");

    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-07-31", "canonical:hold:IBKR:AAPL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, bill, 100_000, "2026-07-31", "canonical:hold:IBKR:TBILL:2026-07-31");
    // TWS day after the bond was sold: no bond row, and none should appear.
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-03", "tws-1-1-2026-08-03");

    for (const d of ["2026-07-31", "2026-08-03"]) seedPrice(db, aapl, d, 150);
    seedPrice(db, bill, "2026-07-31", 99);
    seedPrice(db, bill, "2026-08-03", 99.5);

    seedSnapshot(db, ACCOUNT_ID, "2026-07-31", 115_000, "statement");

    computeDailyValuations(db);
    const vals = valuationsByDate(db, ACCOUNT_ID);

    expect(vals["2026-08-03"].holdings_value).toBe(15_000);
    expect(vals["2026-08-03"].holdings_count).toBe(1);
  });

  it("stops carrying a bond once a newer canonical snapshot no longer holds it", () => {
    const aapl = seedSecurity(db, "AAPL", "stock", "US Large Cap Equity");
    const bill = seedSecurity(db, "TBILL", "bond", "US Treasury");

    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-07-31", "canonical:hold:TAX:AAPL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, bill, 100_000, "2026-07-31", "canonical:hold:TAX:TBILL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-05", "plaid:1:1:2026-08-05");
    // New statement: the Treasury is gone (sold/matured).
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-15", "canonical:hold:TAX:AAPL:2026-08-15");
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-20", "plaid:1:1:2026-08-20");

    for (const d of ["2026-07-31", "2026-08-05", "2026-08-15", "2026-08-20"]) {
      seedPrice(db, aapl, d, 150);
      seedPrice(db, bill, d, 100);
    }

    seedSnapshot(db, ACCOUNT_ID, "2026-07-31", 116_000, "statement");

    computeDailyValuations(db);
    const vals = valuationsByDate(db, ACCOUNT_ID);

    // Before the new statement: bond carried.
    expect(vals["2026-08-05"].holdings_count).toBe(2);
    expect(vals["2026-08-05"].holdings_value).toBe(115_000); // 15,000 + 100,000
    // After it: nothing to carry — the latest canonical snapshot has no bonds.
    expect(vals["2026-08-20"].holdings_count).toBe(1);
    expect(vals["2026-08-20"].holdings_value).toBe(15_000);
  });

  it("does not double-count a bond the Plaid day already reports itself", () => {
    // Defensive: if Plaid ever starts reporting Treasuries, the day's own
    // row wins and the carry must not fire at all.
    const aapl = seedSecurity(db, "AAPL", "stock", "US Large Cap Equity");
    const bill = seedSecurity(db, "TBILL", "bond", "US Treasury");

    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-07-31", "canonical:hold:TAX:AAPL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, bill, 100_000, "2026-07-31", "canonical:hold:TAX:TBILL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-03", "plaid:1:1:2026-08-03");
    seedHolding(db, ACCOUNT_ID, bill, 50_000, "2026-08-03", "plaid:1:2:2026-08-03"); // half sold

    for (const d of ["2026-07-31", "2026-08-03"]) {
      seedPrice(db, aapl, d, 150);
      seedPrice(db, bill, d, 100);
    }

    seedSnapshot(db, ACCOUNT_ID, "2026-07-31", 116_000, "statement");

    computeDailyValuations(db);
    const vals = valuationsByDate(db, ACCOUNT_ID);

    // 15,000 + 50,000 — the day's own quantity, not 100,000 and not 150,000.
    expect(vals["2026-08-03"].holdings_value).toBe(65_000);
    expect(vals["2026-08-03"].holdings_count).toBe(2);
  });

  it("is idempotent across repeated recomputes with carried bonds and sweep exclusion", () => {
    const aapl = seedSecurity(db, "AAPL", "stock", "US Large Cap Equity");
    const bill = seedSecurity(db, "TBILL", "bond", "US Treasury");
    const sweep = seedSecurity(db, "VMFXX", "money_market", "Cash Equivalent");

    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-07-31", "canonical:hold:TAX:AAPL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, bill, 100_000, "2026-07-31", "canonical:hold:TAX:TBILL:2026-07-31");
    seedHolding(db, ACCOUNT_ID, sweep, 40_000, "2026-07-31", "canonical:hold:TAX:VMFXX:2026-07-31");
    seedHolding(db, ACCOUNT_ID, aapl, 100, "2026-08-03", "plaid:1:1:2026-08-03");

    for (const d of ["2026-07-31", "2026-08-03"]) {
      seedPrice(db, aapl, d, 150);
      seedPrice(db, bill, d, 100);
      seedPrice(db, sweep, d, 1);
    }
    seedSnapshot(db, ACCOUNT_ID, "2026-07-31", 156_000, "statement");

    computeDailyValuations(db);
    const first = valuationsByDate(db, ACCOUNT_ID);
    computeDailyValuations(db);
    const second = valuationsByDate(db, ACCOUNT_ID);

    expect(second).toEqual(first);
  });
});
