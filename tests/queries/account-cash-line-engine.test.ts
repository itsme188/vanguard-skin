import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { getAccountCashLine } from "@/lib/queries/account-cash-line";

/**
 * getAccountCashLine names the snapshot that owns the latest day's cash. It
 * copies the valuation engine's anchor rule (an anchor resolves through a
 * priced day in its five-day lookback, or through broker-reported cash), so
 * these tests run the REAL engine over synthetic books and check the two
 * agree: the cash the engine wrote on the latest day is the residual of the
 * anchor the query names, and when the query names none it shows no cash.
 *
 * One position, 10 shares at 100, so positions are worth 1,000 on every
 * priced day. Each anchor implies a different cash residual, which makes
 * the owning anchor readable straight off the engine's cash figure.
 */
const POSITIONS = 1000;

describe("getAccountCashLine against the real valuation engine", () => {
  let db: Database.Database;
  let accountId: number;
  let securityId: number;

  function price(date: string): void {
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 100)").run(
      securityId,
      date,
    );
  }

  function anchor(date: string, total: number, source: string, cashValue: number | null = null): void {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, cash_value)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(accountId, date, total, source, cashValue);
  }

  function engineLatest(): { valuation_date: string; cash_balance: number; total_value: number } {
    return db
      .prepare(
        `SELECT valuation_date, cash_balance, total_value FROM daily_valuations
         WHERE account_id = ? ORDER BY valuation_date DESC LIMIT 1`,
      )
      .get(accountId) as { valuation_date: string; cash_balance: number; total_value: number };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    accountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Broker One')").run()
      .lastInsertRowid as number;
    securityId = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, fund_category) VALUES ('ZZAAA', 'ZZAAA Corp', 'Stock', 'US Large Cap Equity')",
      )
      .run().lastInsertRowid as number;
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 10, NULL, '2026-01-05', 'canonical:hold:ZZ:2026-01-05')`,
    ).run(accountId, securityId);
  });

  describe("no snapshot owns the cash: the figure is withheld", () => {
    it("a statement anchor the engine could not resolve leaves a placeholder zero, which is not shown", () => {
      // Dated before any priced day, with no broker-reported cash: the
      // engine skips it and every row keeps the placeholder cash of 0.
      anchor("2026-01-02", 1300, "statement");
      price("2026-01-05");
      price("2026-01-06");
      computeDailyValuations(db);

      const engine = engineLatest();
      expect(engine.valuation_date).toBe("2026-01-06");
      expect(engine.cash_balance).toBe(0);
      expect(engine.total_value).toBe(POSITIONS);

      const line = getAccountCashLine(db, accountId)!;
      expect(line.valuationDate).toBe("2026-01-06");
      expect(line.holdingsValue).toBe(POSITIONS);
      expect(line.anchorDate).toBeNull();
      expect(line.cashAnchored).toBe(false);
      expect(line.cashBalance).toBeNull();
      expect(line.totalValue).toBeNull();
      expect(line.liveSourceCaption).toBeNull();
    });

    it("cash back-stepped from a LATER live anchor is not shown as the day's cash", () => {
      price("2026-01-05");
      price("2026-01-06");
      // Live anchor two days after the latest valuation; it resolves through
      // the 01-06 row and the engine back-steps its residual over the rows.
      anchor("2026-01-08", 1700, "tws");
      computeDailyValuations(db);

      const engine = engineLatest();
      expect(engine.valuation_date).toBe("2026-01-06");
      expect(engine.cash_balance).toBe(700);

      const line = getAccountCashLine(db, accountId)!;
      expect(line.anchorDate).toBeNull();
      expect(line.cashAnchored).toBe(false);
      expect(line.cashBalance).toBeNull();
      expect(line.totalValue).toBeNull();
      expect(line.holdingsValue).toBe(POSITIONS);
    });
  });

  describe("anchor ownership agrees with the engine", () => {
    function expectOwner(
      residualByAnchor: Record<string, number>,
      owner: string,
      isLive: boolean,
    ): void {
      computeDailyValuations(db);
      const engine = engineLatest();
      const line = getAccountCashLine(db, accountId)!;

      expect(line.valuationDate).toBe(engine.valuation_date);
      expect(line.anchorDate).toBe(owner);
      expect(line.isLiveSource).toBe(isLive);
      expect(line.cashAnchored).toBe(true);
      // The engine's own cash on the latest day is the residual of the
      // anchor the query names, and of no other anchor in the book.
      expect(engine.cash_balance).toBe(residualByAnchor[owner]);
      expect(line.cashBalance).toBe(engine.cash_balance);
      expect(line.totalValue).toBe(engine.total_value);
      expect(line.holdingsValue + line.cashBalance!).toBe(line.totalValue);
    }

    it("a live anchor after a statement takes over, and a later day carries it", () => {
      for (const d of ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"]) price(d);
      anchor("2026-01-05", 1300, "statement");
      anchor("2026-01-07", 1700, "tws");
      expectOwner({ "2026-01-05": 300, "2026-01-07": 700 }, "2026-01-07", true);
    });

    it("an unresolvable live anchor ends the statement's window: nothing owns the later days", () => {
      for (const d of ["2026-01-05", "2026-01-06", "2026-01-27"]) price(d);
      anchor("2026-01-05", 1300, "statement");
      // No priced day from 01-15 to 01-20 and no broker-reported cash. The
      // engine skips this anchor, yet the statement's cash stops at its
      // date, so 01-27 keeps the placeholder zero.
      anchor("2026-01-20", 1700, "plaid");
      computeDailyValuations(db);

      const engine = engineLatest();
      expect(engine.valuation_date).toBe("2026-01-27");
      expect(engine.cash_balance).toBe(0);

      const line = getAccountCashLine(db, accountId)!;
      expect(line.anchorDate).toBeNull();
      expect(line.cashAnchored).toBe(false);
      expect(line.cashBalance).toBeNull();
      expect(line.totalValue).toBeNull();
      // The day the statement did own still reads as owned.
      const owned = db
        .prepare(
          "SELECT cash_balance FROM daily_valuations WHERE account_id = ? AND valuation_date = '2026-01-06'",
        )
        .get(accountId) as { cash_balance: number };
      expect(owned.cash_balance).toBe(300);
    });

    it("the same live anchor takes over once it carries broker-reported cash", () => {
      for (const d of ["2026-01-05", "2026-01-06", "2026-01-27"]) price(d);
      anchor("2026-01-05", 1300, "statement");
      anchor("2026-01-20", 1700, "tws", 450);
      expectOwner({ "2026-01-05": 300, "2026-01-20": 450 }, "2026-01-20", true);
    });
  });
});
