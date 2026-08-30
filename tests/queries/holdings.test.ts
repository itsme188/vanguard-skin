import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAllHoldings,
  getHoldingsByAccount,
  getLatestHoldingsDate,
} from "@/lib/queries/holdings";

function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, symbol + " Corp");
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    quantity,
    asOfDate,
    `hold-${accountId}-${securityId}-${asOfDate}`
  );
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  date: string,
  price: number
): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

describe("holdings queries", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("getHoldingsByAccount", () => {
    it("returns holdings for an account at latest date by default", () => {
      const vti = seedSecurity(db, "VTI");
      const bnd = seedSecurity(db, "BND");
      seedHolding(db, ACCOUNT_ID, vti, 100, "2025-01-31");
      seedHolding(db, ACCOUNT_ID, bnd, 50, "2025-01-31");
      seedHolding(db, ACCOUNT_ID, vti, 110, "2025-02-28");
      seedHolding(db, ACCOUNT_ID, bnd, 55, "2025-02-28");

      const holdings = getHoldingsByAccount(db, ACCOUNT_ID);
      expect(holdings).toHaveLength(2);
      // Ordered by symbol
      expect(holdings[0].symbol).toBe("BND");
      expect(holdings[0].quantity).toBe(55);
      expect(holdings[1].symbol).toBe("VTI");
      expect(holdings[1].quantity).toBe(110);
    });

    it("excludes quantity=0 tombstone rows but keeps shorts", () => {
      // The closed-equity reconciler writes quantity=0 rows at the latest
      // snapshot date for statement-disappeared positions — those are closure
      // markers, not positions (QA 2026-07-11: ACWV/EEMV as "0 shares · $0.00").
      const vti = seedSecurity(db, "VTI");
      const acwv = seedSecurity(db, "ACWV");
      const shortSec = seedSecurity(db, "XYZ");
      seedHolding(db, ACCOUNT_ID, vti, 100, "2025-02-28");
      seedHolding(db, ACCOUNT_ID, acwv, 0, "2025-02-28");
      seedHolding(db, ACCOUNT_ID, shortSec, -25, "2025-02-28");

      const holdings = getHoldingsByAccount(db, ACCOUNT_ID);
      expect(holdings.map((h) => h.symbol).sort()).toEqual(["VTI", "XYZ"]);
    });

    it("hides a matured bond by default but keeps it in a point-in-time snapshot", () => {
      // Parity with getAllHoldings (2026-08-30 landing-review nit): a
      // matured bond/bill that escaped purgeMaturedBondHoldings must not
      // surface as a live position under per-pair "latest" keying. The
      // explicit-asOfDate branch deliberately keeps it — on that date the
      // bond had not yet matured.
      const vti = seedSecurity(db, "VTI");
      const bill = seedSecurity(db, "MATURED-BILL");
      db.prepare("UPDATE securities SET maturity_date = '2025-02-15' WHERE id = ?").run(bill);
      seedHolding(db, ACCOUNT_ID, vti, 100, "2025-01-31");
      seedHolding(db, ACCOUNT_ID, bill, 10, "2025-01-31");

      const latest = getHoldingsByAccount(db, ACCOUNT_ID);
      expect(latest.map((h) => h.symbol)).toEqual(["VTI"]);

      const snapshot = getHoldingsByAccount(db, ACCOUNT_ID, "2025-01-31");
      expect(snapshot.map((h) => h.symbol).sort()).toEqual(["MATURED-BILL", "VTI"]);
    });

    it("returns a security whose newest row predates the account's newest snapshot date", () => {
      // QA finding accounts-holdings--global-max-as-of-date-drops-19-live-positions-72k-treasuries:
      // "latest" is per-(account, security), never a per-account global
      // MAX(as_of_date). A bond that only restates on the monthly statement
      // must survive a daily broker/Plaid sync that rewrites the equity rows.
      const vti = seedSecurity(db, "VTI");
      const bond = seedSecurity(db, "BOND");
      seedHolding(db, ACCOUNT_ID, bond, 40, "2025-01-31"); // only row, older date
      seedHolding(db, ACCOUNT_ID, vti, 110, "2025-02-28"); // newer sync row

      const holdings = getHoldingsByAccount(db, ACCOUNT_ID);
      expect(holdings.map((h) => h.symbol)).toEqual(["BOND", "VTI"]);

      const bondRow = holdings.find((h) => h.symbol === "BOND")!;
      expect(bondRow.quantity).toBe(40);
      expect(bondRow.as_of_date).toBe("2025-01-31");

      const vtiRow = holdings.find((h) => h.symbol === "VTI")!;
      expect(vtiRow.quantity).toBe(110);
      expect(vtiRow.as_of_date).toBe("2025-02-28");
    });

    it("hides a security whose newest row is a quantity=0 tombstone above a non-zero older row", () => {
      // Reconciler contract: the tombstone IS the latest row for the
      // (account, security) pair, so per-pair latest + quantity != 0 still
      // hides the closed position (it must not resurrect the older row).
      const vti = seedSecurity(db, "VTI");
      const acwv = seedSecurity(db, "ACWV");
      seedHolding(db, ACCOUNT_ID, acwv, 75, "2025-01-31"); // was held
      seedHolding(db, ACCOUNT_ID, acwv, 0, "2025-02-28"); // closure marker
      seedHolding(db, ACCOUNT_ID, vti, 110, "2025-02-28");

      const holdings = getHoldingsByAccount(db, ACCOUNT_ID);
      expect(holdings.map((h) => h.symbol)).toEqual(["VTI"]);
    });

    it("renders a short whose newest row predates the account's newest snapshot date", () => {
      const vti = seedSecurity(db, "VTI");
      const shortSec = seedSecurity(db, "XYZ");
      seedHolding(db, ACCOUNT_ID, shortSec, -25, "2025-01-31");
      seedHolding(db, ACCOUNT_ID, vti, 110, "2025-02-28");

      const holdings = getHoldingsByAccount(db, ACCOUNT_ID);
      expect(holdings.map((h) => h.symbol)).toEqual(["VTI", "XYZ"]);
      const shortRow = holdings.find((h) => h.symbol === "XYZ")!;
      expect(shortRow.quantity).toBe(-25);
      expect(shortRow.as_of_date).toBe("2025-01-31");
    });

    it("returns holdings for a specific date", () => {
      const vti = seedSecurity(db, "VTI");
      seedHolding(db, ACCOUNT_ID, vti, 100, "2025-01-31");
      seedHolding(db, ACCOUNT_ID, vti, 110, "2025-02-28");

      const holdings = getHoldingsByAccount(db, ACCOUNT_ID, "2025-01-31");
      expect(holdings).toHaveLength(1);
      expect(holdings[0].quantity).toBe(100);
    });

    it("returns empty array for account with no holdings", () => {
      const holdings = getHoldingsByAccount(db, ACCOUNT_ID);
      expect(holdings).toHaveLength(0);
    });

    it("includes security details", () => {
      const vti = seedSecurity(db, "VTI");
      seedHolding(db, ACCOUNT_ID, vti, 100, "2025-01-31");

      const holdings = getHoldingsByAccount(db, ACCOUNT_ID);
      expect(holdings[0].symbol).toBe("VTI");
      expect(holdings[0].security_name).toBe("VTI Corp");
      expect(holdings[0].account_name).toBe("Vanguard Taxable");
    });
  });

  describe("getAllHoldings", () => {
    // Account IDs from the 002_seed_accounts.sql seed: 1 = Vanguard Taxable,
    // 2 = Vanguard Roth IRA, 3 = IBKR.
    const TAXABLE_ID = 1;
    const IBKR_ID = 3;
    const TODAY = "2025-02-28";

    it("includes shorts (negative quantity, negative current_value) alongside longs, excludes qty=0 tombstones", () => {
      // Long position in the taxable account.
      const vti = seedSecurity(db, "VTI");
      seedHolding(db, TAXABLE_ID, vti, 100, TODAY);
      seedPrice(db, vti, TODAY, 250);

      // Long position in a second account (IBKR).
      const tlt = seedSecurity(db, "TLT");
      seedHolding(db, IBKR_ID, tlt, 20, TODAY);
      seedPrice(db, tlt, TODAY, 90);

      // Short position in IBKR — real position, must render (mirrors
      // getHoldingsByAccount's quantity != 0 filter).
      const banc = seedSecurity(db, "BANC");
      seedHolding(db, IBKR_ID, banc, -500, TODAY);
      seedPrice(db, banc, TODAY, 15);

      // Closed-equity reconciler tombstone (quantity=0) — closure marker,
      // not a position; must be excluded (QA 2026-07-11 precedent).
      const acwv = seedSecurity(db, "ACWV");
      seedHolding(db, IBKR_ID, acwv, 0, TODAY);
      seedPrice(db, acwv, TODAY, 100);

      const rows = getAllHoldings(db);
      const symbols = rows.map((r) => r.symbol).sort();
      expect(symbols).toEqual(["BANC", "TLT", "VTI"]);

      const bancRow = rows.find((r) => r.symbol === "BANC")!;
      expect(bancRow.quantity).toBe(-500);
      expect(bancRow.current_value).toBe(-500 * 15);
      expect(bancRow.current_value).toBeLessThan(0);

      const vtiRow = rows.find((r) => r.symbol === "VTI")!;
      expect(vtiRow.quantity).toBe(100);
      expect(vtiRow.current_value).toBe(100 * 250);

      const tltRow = rows.find((r) => r.symbol === "TLT")!;
      expect(tltRow.quantity).toBe(20);
      expect(tltRow.current_value).toBe(20 * 90);
    });
    it("includes a security whose newest row predates its account's newest snapshot date, and counts it in the totals", () => {
      // QA finding accounts-holdings--global-max-as-of-date-drops-19-live-positions-72k-treasuries:
      // pre-fix the per-account global MAX(as_of_date) dropped every position
      // that only restates on the monthly statement, and the table's totals /
      // allocation percentages were computed on the short list.
      const vti = seedSecurity(db, "VTI");
      seedHolding(db, TAXABLE_ID, vti, 100, TODAY);
      seedPrice(db, vti, TODAY, 250);

      // Statement-only position in the SAME account, older as_of_date.
      const bond = seedSecurity(db, "BOND");
      seedHolding(db, TAXABLE_ID, bond, 40, "2025-01-31");
      seedPrice(db, bond, TODAY, 200);

      // Second account, newest date — proves the fix is not account-scoped.
      const tlt = seedSecurity(db, "TLT");
      seedHolding(db, IBKR_ID, tlt, 20, TODAY);
      seedPrice(db, tlt, TODAY, 90);

      const rows = getAllHoldings(db);
      expect(rows.map((r) => r.symbol).sort()).toEqual(["BOND", "TLT", "VTI"]);

      const bondRow = rows.find((r) => r.symbol === "BOND")!;
      expect(bondRow.quantity).toBe(40);
      expect(bondRow.as_of_date).toBe("2025-01-31");
      expect(bondRow.current_value).toBe(40 * 200);

      const total = rows.reduce((sum, r) => sum + (r.current_value ?? 0), 0);
      expect(total).toBe(100 * 250 + 40 * 200 + 20 * 90);
    });

    it("hides a security whose newest row is a quantity=0 tombstone above a non-zero older row", () => {
      const vti = seedSecurity(db, "VTI");
      seedHolding(db, TAXABLE_ID, vti, 100, TODAY);
      seedPrice(db, vti, TODAY, 250);

      const acwv = seedSecurity(db, "ACWV");
      seedHolding(db, IBKR_ID, acwv, 75, "2025-01-31"); // was held
      seedHolding(db, IBKR_ID, acwv, 0, TODAY); // closure marker
      seedPrice(db, acwv, TODAY, 100);

      const rows = getAllHoldings(db);
      expect(rows.map((r) => r.symbol)).toEqual(["VTI"]);
    });

    it("renders a short whose newest row predates its account's newest snapshot date", () => {
      const tlt = seedSecurity(db, "TLT");
      seedHolding(db, IBKR_ID, tlt, 20, TODAY);
      seedPrice(db, tlt, TODAY, 90);

      const banc = seedSecurity(db, "BANC");
      seedHolding(db, IBKR_ID, banc, -500, "2025-01-31");
      seedPrice(db, banc, TODAY, 15);

      const rows = getAllHoldings(db);
      expect(rows.map((r) => r.symbol).sort()).toEqual(["BANC", "TLT"]);

      const bancRow = rows.find((r) => r.symbol === "BANC")!;
      expect(bancRow.quantity).toBe(-500);
      expect(bancRow.as_of_date).toBe("2025-01-31");
      expect(bancRow.current_value).toBe(-500 * 15);
    });
  });

  describe("getLatestHoldingsDate", () => {
    it("returns the latest date for an account", () => {
      const vti = seedSecurity(db, "VTI");
      seedHolding(db, ACCOUNT_ID, vti, 100, "2025-01-31");
      seedHolding(db, ACCOUNT_ID, vti, 110, "2025-02-28");

      const date = getLatestHoldingsDate(db, ACCOUNT_ID);
      expect(date).toBe("2025-02-28");
    });

    it("returns null when account has no holdings", () => {
      const date = getLatestHoldingsDate(db, ACCOUNT_ID);
      expect(date).toBeNull();
    });
  });
});
