/**
 * QA finding: tax-lots--headline-tiles-include-reconcile-close-engine-rows
 *
 * The /dashboard/tax-lots headline tiles ("<year> REALIZED / LONG-TERM /
 * SHORT-TERM") sum EVERY tax_lot_sales row for the year, including sales
 * whose sale transaction is the engine-owned `RECONCILE_CLOSE` row (never
 * real broker activity — computeTaxLots mints it to close a position the
 * ledger lost). The TAX REPORT card and the CSV/TXF exports on the same
 * page correctly exclude those rows (`filingOnly`), so the two figures on
 * one screen disagreed by exactly the engine-estimated closes with nothing
 * saying so.
 *
 * USER RULING — "disclose, never exclude": the tiles KEEP their economic
 * totals (the economic view is deliberately whole) and each tile appends a
 * disclosure naming the engine-estimated count and dollars inside it.
 * This file pins the data half of that: getTaxLotSummary /
 * getTaxLotSummaryByAccount now report the per-bucket engine-estimated
 * count and USD gain alongside the unchanged totals.
 *
 * All fixtures are synthetic (fake tickers, small round dollars).
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getClosedTaxLotSales,
  getTaxLotSummary,
  getTaxLotSummaryByAccount,
} from "@/lib/queries/tax-lots";

const ACCOUNT_ID = 1; // "Vanguard Taxable", seeded by migration 002
const CONTROL_ACCOUNT_ID = 2; // "Vanguard Roth IRA" — the QA finding's control
const YEAR = 2026;

function seedStock(db: Database.Database, symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'stock', 'USD')"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedBuy(
  db: Database.Database,
  securityId: number,
  date: string,
  qty: number,
  price: number,
  accountId = ACCOUNT_ID
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, 'BUY', ?, ?, ?, 0, ?)`
  ).run(
    accountId,
    securityId,
    date,
    qty,
    price,
    -(qty * price),
    `buy-${accountId}-${securityId}-${date}`
  );
}

function seedSell(
  db: Database.Database,
  securityId: number,
  date: string,
  qty: number,
  price: number,
  accountId = ACCOUNT_ID
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, 'SELL', ?, ?, ?, 0, ?)`
  ).run(
    accountId,
    securityId,
    date,
    qty,
    price,
    qty * price,
    `sell-${accountId}-${securityId}-${date}`
  );
}

/**
 * RECONCILE_CLOSE is engine-owned in production (computeTaxLots synthesizes
 * it for a broker-zeroed position with an orphan open lot). Same simulation
 * the existing getClosedTaxLotSales tests use: compute against a normal
 * SELL, then relabel the sale transaction. Never parse or emit the type as
 * user activity.
 */
function relabelAsReconcileClose(db: Database.Database, saleDate: string): void {
  const changed = db
    .prepare(
      `UPDATE transactions SET type = 'RECONCILE_CLOSE'
       WHERE id IN (SELECT sale_transaction_id FROM tax_lot_sales WHERE sale_date = ?)`
    )
    .run(saleDate);
  expect(changed.changes).toBe(1);
}

/**
 * The shared fixture, all in ACCOUNT_ID, all USD, calendar year 2026:
 *
 *   ZZA  real SELL      ST  +$200   filing-eligible
 *   ZZB  RECONCILE_CLOSE ST  +$300  engine-estimated
 *   ZZC  real SELL      LT  +$100   filing-eligible
 *   ZZD  RECONCILE_CLOSE LT  +$400  engine-estimated
 *   ZZU  option exercise ST   $0    premium rollover (filing-excluded, zero gain)
 *
 * Account-scoped economic: total +$1,000 · LT +$500 · ST +$500 · 5 sales
 * Account-scoped filing:   total   +$300 · LT +$100 · ST +$200 · 2 sales
 *
 * Plus CONTROL_ACCOUNT_ID, one real SELL (+$100 ST) and no engine closes —
 * the QA finding's control account, where tiles and TAX REPORT card already
 * agreed. Seeded BEFORE computeTaxLots: a re-run after the relabel would
 * drop the RECONCILE_CLOSE sales entirely (the engine's sell-like list does
 * not include that type — it is engine-owned, never user activity).
 */
function seedFixture(db: Database.Database): void {
  const zza = seedStock(db, "ZZA");
  seedBuy(db, zza, "2026-01-05", 10, 100);
  seedSell(db, zza, "2026-03-01", 10, 120); // +$200 short-term, real

  const zzb = seedStock(db, "ZZB");
  seedBuy(db, zzb, "2026-01-05", 10, 100);
  seedSell(db, zzb, "2026-04-01", 10, 130); // +$300 short-term, becomes engine close

  const zzc = seedStock(db, "ZZC");
  seedBuy(db, zzc, "2024-01-05", 10, 50);
  seedSell(db, zzc, "2026-05-01", 10, 60); // +$100 long-term, real

  const zzd = seedStock(db, "ZZD");
  seedBuy(db, zzd, "2024-01-05", 10, 50);
  seedSell(db, zzd, "2026-06-01", 10, 90); // +$400 long-term, becomes engine close

  // Premium-rollover leg, produced by the REAL engine path (not a hand-set
  // flag) so the fixture proves the zero-gain-by-construction claim the
  // identity below leans on: a long call exercised into its underlying.
  const zzu = seedStock(db, "ZZU");
  const opt = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, currency, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, 'ZZU 50 Call', 'option', 'USD', 'ZZU', 'CALL', 50, '2026-09-18', 100)`
    )
    .run("ZZU   260918C00050000").lastInsertRowid as number;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, '2026-02-02', 'BUY_TO_OPEN', 1, 5, 500, 0, 'opt-open')`
  ).run(ACCOUNT_ID, opt);
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, '2026-07-01', 'EXERCISED', 1, 5, 500, 0, 'opt-exercise')`
  ).run(ACCOUNT_ID, opt);
  seedBuy(db, zzu, "2026-07-01", 100, 50); // shares received at the strike

  // Control account: one ordinary SELL, no engine-estimated closes.
  const zzf = seedStock(db, "ZZF");
  seedBuy(db, zzf, "2026-01-05", 10, 100, CONTROL_ACCOUNT_ID);
  seedSell(db, zzf, "2026-03-02", 10, 110, CONTROL_ACCOUNT_ID); // +$100 short-term

  computeTaxLots(db);

  relabelAsReconcileClose(db, "2026-04-01");
  relabelAsReconcileClose(db, "2026-06-01");
}

describe("tax-lot summary — engine-estimated (RECONCILE_CLOSE) disclosure", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedFixture(db);
  });

  it("the fixture's premium-rollover row is engine-produced and zero-gain by construction", () => {
    const rollover = db
      .prepare(
        `SELECT premium_rollover, realized_gain_loss, is_long_term
           FROM tax_lot_sales WHERE sale_date = '2026-07-01'`
      )
      .all() as Array<{
      premium_rollover: number;
      realized_gain_loss: number;
      is_long_term: number;
    }>;
    expect(rollover).toHaveLength(1);
    expect(rollover[0].premium_rollover).toBe(1);
    // lib/compute/tax-lots.ts sets proceeds === cost_basis_allocated for a
    // rollover, so the gain is 0 BY CONSTRUCTION. That is what lets the
    // identity below be stated without a premium-rollover correction term.
    expect(rollover[0].realized_gain_loss).toBe(0);
    expect(rollover[0].is_long_term).toBe(0);
  });

  describe("getTaxLotSummary", () => {
    it("leaves the economic totals unchanged (RECONCILE_CLOSE stays included)", () => {
      // Portfolio-wide: the 5 fixture sales plus the control account's one.
      const summary = getTaxLotSummary(db, YEAR);
      expect(summary.totalClosedSales).toBe(6);
      expect(summary.totalRealizedGain).toBe(1_100);
      expect(summary.longTermGain).toBe(500);
      expect(summary.shortTermGain).toBe(600);
      expect(summary.excludedNonUsdSales).toBe(0);
    });

    it("reports the engine-estimated count and gain per bucket", () => {
      const summary = getTaxLotSummary(db, YEAR);
      expect(summary.engineEstimatedSales).toBe(2);
      expect(summary.engineEstimatedGain).toBe(700);
      expect(summary.engineEstimatedLongTermSales).toBe(1);
      expect(summary.engineEstimatedLongTermGain).toBe(400);
      expect(summary.engineEstimatedShortTermSales).toBe(1);
      expect(summary.engineEstimatedShortTermGain).toBe(300);
    });

    it("never counts a premium-rollover row as engine-estimated", () => {
      // filingOnly excludes premium rollovers too, but they are NOT
      // engine-estimated closes — a disclosure that lumped them together
      // would name a count the user cannot reconcile to the Estimated chips
      // in the Closed Sales table below.
      const summary = getTaxLotSummary(db, YEAR);
      const syntheticRows = getClosedTaxLotSales(db, YEAR).filter(
        (s) => s.is_synthetic_close
      );
      expect(syntheticRows).toHaveLength(2);
      expect(summary.engineEstimatedSales).toBe(syntheticRows.length);
    });

    it("reports zeros for a year with no engine-estimated closes", () => {
      const clean = new Database(":memory:");
      clean.pragma("foreign_keys = ON");
      runMigrations(clean);
      const sec = seedStock(clean, "ZZE");
      seedBuy(clean, sec, "2026-01-05", 10, 100);
      seedSell(clean, sec, "2026-03-01", 10, 120);
      computeTaxLots(clean);

      const summary = getTaxLotSummary(clean, YEAR);
      expect(summary.totalRealizedGain).toBe(200);
      expect(summary.engineEstimatedSales).toBe(0);
      expect(summary.engineEstimatedGain).toBe(0);
      expect(summary.engineEstimatedLongTermSales).toBe(0);
      expect(summary.engineEstimatedLongTermGain).toBe(0);
      expect(summary.engineEstimatedShortTermSales).toBe(0);
      expect(summary.engineEstimatedShortTermGain).toBe(0);
      clean.close();
    });
  });

  describe("getTaxLotSummaryByAccount", () => {
    it("mirrors the per-bucket engine-estimated figures per account", () => {
      const rows = getTaxLotSummaryByAccount(db, YEAR);
      const acct = rows.find((r) => r.account_id === ACCOUNT_ID);
      expect(acct).toBeTruthy();
      expect(acct!.totalClosedSales).toBe(5);
      expect(acct!.totalRealizedGain).toBe(1_000);
      expect(acct!.longTermGain).toBe(500);
      expect(acct!.shortTermGain).toBe(500);
      expect(acct!.engineEstimatedSales).toBe(2);
      expect(acct!.engineEstimatedGain).toBe(700);
      expect(acct!.engineEstimatedLongTermSales).toBe(1);
      expect(acct!.engineEstimatedLongTermGain).toBe(400);
      expect(acct!.engineEstimatedShortTermSales).toBe(1);
      expect(acct!.engineEstimatedShortTermGain).toBe(300);
    });

    it("keeps an account with no engine-estimated closes at zero (control)", () => {
      const rows = getTaxLotSummaryByAccount(db, YEAR);
      const control = rows.find((r) => r.account_id === CONTROL_ACCOUNT_ID);
      expect(control).toBeTruthy();
      expect(control!.totalClosedSales).toBe(1);
      expect(control!.totalRealizedGain).toBe(100);
      expect(control!.shortTermGain).toBe(100);
      expect(control!.engineEstimatedSales).toBe(0);
      expect(control!.engineEstimatedGain).toBe(0);
      expect(control!.engineEstimatedLongTermSales).toBe(0);
      expect(control!.engineEstimatedLongTermGain).toBe(0);
      expect(control!.engineEstimatedShortTermSales).toBe(0);
      expect(control!.engineEstimatedShortTermGain).toBe(0);
    });
  });

  describe("IDENTITY: tile − engine-estimated === the filing figure", () => {
    /**
     * The pinned identity, per term bucket:
     *
     *   tile figure − engine-estimated figure
     *     === Σ realized_gain_loss over getClosedTaxLotSales(db, year,
     *         { filingOnly: true }) rows in that bucket
     *
     * `filingOnly` also drops premium-rollover rows, but those are ZERO-GAIN
     * BY CONSTRUCTION in lib/compute/tax-lots.ts (proceeds is forced equal to
     * cost_basis_allocated when isPremiumRollover), so they contribute
     * nothing to either side and the identity needs no rollover term. The
     * first test in this file pins that construction against the real engine.
     *
     * The tile gains are USD-only (`USD_ONLY` in lib/queries/tax-lots.ts) and
     * getClosedTaxLotSales returns native-currency rows, so the right-hand
     * side is restricted to USD rows — the same restriction the tiles apply.
     */
    function filingSum(
      db: Database.Database,
      predicate: (isLongTerm: boolean) => boolean
    ): number {
      return getClosedTaxLotSales(db, YEAR, { filingOnly: true })
        .filter((s) => s.currency === "USD" && predicate(Boolean(s.is_long_term)))
        .reduce((sum, s) => sum + s.realized_gain_loss, 0);
    }

    it("holds for the total, long-term and short-term buckets", () => {
      const summary = getTaxLotSummary(db, YEAR);

      expect(summary.totalRealizedGain - summary.engineEstimatedGain).toBeCloseTo(
        filingSum(db, () => true),
        6
      );
      expect(summary.longTermGain - summary.engineEstimatedLongTermGain).toBeCloseTo(
        filingSum(db, (lt) => lt),
        6
      );
      expect(summary.shortTermGain - summary.engineEstimatedShortTermGain).toBeCloseTo(
        filingSum(db, (lt) => !lt),
        6
      );

      // Not a vacuous identity: the engine-estimated part is the whole gap.
      expect(filingSum(db, () => true)).toBe(400);
      expect(summary.totalRealizedGain).toBe(1_100);
      expect(summary.engineEstimatedGain).toBe(700);
    });
  });

  describe("USD_ONLY handling is identical for the new sums", () => {
    it("excludes a non-USD engine-estimated close from the gain but still counts it", () => {
      const krw = db
        .prepare(
          "INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZZK', 'ZZK Co', 'stock', 'KRW')"
        )
        .run().lastInsertRowid as number;
      const lot = db
        .prepare(
          `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
           VALUES (?, ?, '2026-01-02', 1000, 10, 0, 10000)`
        )
        .run(ACCOUNT_ID, krw).lastInsertRowid as number;
      const txn = db
        .prepare(
          `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
           VALUES (?, ?, '2026-08-01', 'RECONCILE_CLOSE', 10, 90000, 'krw-reconcile')`
        )
        .run(ACCOUNT_ID, krw).lastInsertRowid as number;
      db.prepare(
        `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
         VALUES (?, ?, 10, 9000, 90000, 10000, 80000, 0, 211, '2026-08-01')`
      ).run(lot, txn);

      const summary = getTaxLotSummary(db, YEAR);
      // Native-KRW 80,000 never sums into a USD dollar figure...
      expect(summary.engineEstimatedGain).toBe(700);
      expect(summary.engineEstimatedShortTermGain).toBe(300);
      expect(summary.totalRealizedGain).toBe(1_100);
      // ...but the row is still counted, exactly like totalClosedSales does.
      expect(summary.totalClosedSales).toBe(7);
      expect(summary.engineEstimatedSales).toBe(3);
      expect(summary.engineEstimatedShortTermSales).toBe(2);
      expect(summary.excludedNonUsdSales).toBe(1);
    });
  });
});
