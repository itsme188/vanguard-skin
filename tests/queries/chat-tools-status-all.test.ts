/**
 * The chat tax-lot tool's status "all" returns open lots AND closed sales,
 * with or without a year. Synthetic ticker and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getTaxLotsForChat } from "@/lib/queries/chat-tools";
import { createPendingTestDb, seedSec } from "../setup/pending-statement-fixtures";

const IBKR = 3; // seeded by migration 002
const BUY_DATE = "2025-01-10";
const SELL_DATE = "2025-03-10";

let db: Database.Database;

function fill(securityId: number, type: string, date: string, qty: number, price: number, key: string): void {
  const sign = type === "BUY" ? -1 : 1;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(IBKR, securityId, date, type, qty, price, sign * qty * price, key);
}

beforeEach(() => {
  db = createPendingTestDb();
  const aaa = seedSec(db, "AAA");
  fill(aaa, "BUY", BUY_DATE, 100, 10, "status-all-1");
  fill(aaa, "SELL", SELL_DATE, 40, 12, "status-all-2");
  computeTaxLots(db);
});

describe("getTaxLotsForChat status all", () => {
  it("returns the open lot and the closed sale with no year", () => {
    const rows = getTaxLotsForChat(db, { status: "all", symbol: "AAA" });
    expect(rows).toHaveLength(2);
    const open = rows.filter((r) => !r.sale_date);
    const closed = rows.filter((r) => r.sale_date);
    expect(open).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0].realized_gain_loss).toBe(80);
    expect(rows[0].sale_date).toBeFalsy(); // open rows first
  });

  it("still returns the closed sale (and the open lot) with the sale year", () => {
    const rows = getTaxLotsForChat(db, { status: "all", symbol: "AAA", year: 2025 });
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.realized_gain_loss === 80)).toBe(true);
  });

  it("keeps open and closed to one row each", () => {
    expect(getTaxLotsForChat(db, { status: "open", symbol: "AAA" })).toHaveLength(1);
    const closed = getTaxLotsForChat(db, { status: "closed", symbol: "AAA" });
    expect(closed).toHaveLength(1);
    expect(closed[0].realized_gain_loss).toBe(80);
  });
});
