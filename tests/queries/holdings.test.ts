import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
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
