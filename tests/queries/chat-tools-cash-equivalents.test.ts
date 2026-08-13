import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getCashEstimates } from "@/lib/queries/chat-tools";

// ─── Seed helpers (mirrors tests/queries/chat-tools-fx.test.ts) ───────────

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts?: {
    name?: string;
    security_type?: string;
    fund_category?: string;
    asset_class?: string;
    currency?: string;
    multiplier?: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, asset_class, currency, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      opts?.name ?? `${symbol} Corp`,
      opts?.security_type ?? "stock",
      opts?.fund_category ?? null,
      opts?.asset_class ?? "equity",
      opts?.currency ?? "USD",
      opts?.multiplier ?? 1
    );
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis?: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis ?? null, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

function seedSnapshot(db: Database.Database, accountId: number, monthEnd: string, totalValue: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value)
     VALUES (?, ?, ?)`
  ).run(accountId, monthEnd, totalValue);
}

const TODAY = "2025-01-31";

describe("getCashEstimates — cash-equivalent exclusion", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("excludes a fund_category='Cash Equivalent' sweep fund from holdings_total (production shape)", () => {
    // Production shape: live VMFXX-style sweep rows carry security_type
    // 'Mutual Fund' with fund_category 'Cash Equivalent' — signal 1
    // (security_type = 'money_market') matches nothing here; only signal 2
    // (fund_category) does the work. See lib/compute/cash-equivalents.ts.
    const equity = seedSecurity(db, "AAPL", { security_type: "Stock", currency: "USD" });
    seedHolding(db, 1, equity, 100, TODAY);
    seedPrice(db, equity, TODAY, 250); // $25,000

    const sweep = seedSecurity(db, "VMFXX", {
      security_type: "Mutual Fund",
      fund_category: "Cash Equivalent",
      currency: "USD",
    });
    seedHolding(db, 1, sweep, 5000, TODAY);
    seedPrice(db, sweep, TODAY, 1); // $5,000

    seedSnapshot(db, 1, TODAY, 40_000);

    const estimates = getCashEstimates(db);
    const row = estimates.find((e) => e.account_name === "Vanguard Taxable");

    expect(row).toBeDefined();
    // holdings_total must be the equity position ONLY — the sweep fund is
    // cash, not a holding.
    expect(row!.holdings_total).toBeCloseTo(25_000, 2);
    // estimated_cash = snapshot_total - holdings_total, so the sweep's
    // $5,000 stays folded into cash (40,000 - 25,000 = 15,000), not
    // subtracted out on top of the equity position.
    expect(row!.estimated_cash).toBeCloseTo(15_000, 2);
  });

  it("also excludes via the security_type='money_market' signal", () => {
    const equity = seedSecurity(db, "MSFT", { security_type: "Stock", currency: "USD" });
    seedHolding(db, 2, equity, 50, TODAY);
    seedPrice(db, equity, TODAY, 400); // $20,000

    const sweep = seedSecurity(db, "VFFXX", {
      security_type: "money_market",
      currency: "USD",
    });
    seedHolding(db, 2, sweep, 3000, TODAY);
    seedPrice(db, sweep, TODAY, 1); // $3,000

    seedSnapshot(db, 2, TODAY, 30_000);

    const estimates = getCashEstimates(db);
    const row = estimates.find((e) => e.account_name === "Vanguard Roth IRA");

    expect(row).toBeDefined();
    expect(row!.holdings_total).toBeCloseTo(20_000, 2);
    expect(row!.estimated_cash).toBeCloseTo(10_000, 2);
  });
});
