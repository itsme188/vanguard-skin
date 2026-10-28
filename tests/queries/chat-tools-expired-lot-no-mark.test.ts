/**
 * The chat tax-lot tool withholds the last MARK, not only the value and the
 * gain, for a lot that carries no value (ruling R1): an expired option
 * awaiting its closing entry, and a pending lot. Before this test the tool
 * nulled current_value / unrealized_gain but still shipped current_price, and
 * the model multiplied it back out into a "value at last mark" for a put that
 * finished out of the money (QA dashboard-today-chat-rail-tax-lot-tool-...).
 * Synthetic symbols and small round figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getTaxLotsForChat } from "@/lib/queries/chat-tools";
import { createPendingTestDb, seedHold, seedPx } from "../setup/pending-statement-fixtures";

const ACCT = 3; // IBKR, seeded by the migrations

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createPendingTestDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  // Monday 2026-10-26 noon Eastern.
  vi.setSystemTime(new Date("2026-10-26T16:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function seedOpt(symbol: string, expiration: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date, currency)
         VALUES (?, ?, 'option', 100, ?, 'USD')`
      )
      .run(symbol, `${symbol} contract`, expiration).lastInsertRowid
  );
}

function txn(sec: number, date: string, type: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)`
  ).run(ACCT, sec, date, type, qty, price, `ctnm-${seq++}`);
}

describe("getTaxLotsForChat — no mark for a lot that carries no value", () => {
  it("an expired put: current_price, current_value and unrealized_gain are all null; the note says it expired", () => {
    // Expired Friday 2026-10-23; last mark Wednesday 2026-10-21.
    const sec = seedOpt("ZEXP  261023P00250000", "2026-10-23");
    txn(sec, "2026-10-01", "BUY_TO_OPEN", 2, 12);
    seedPx(db, sec, "2026-10-21", 7.5);
    computeTaxLots(db);

    const rows = getTaxLotsForChat(db, { symbol: "ZEXP  261023P00250000" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      quantity_remaining: 2,
      cost_basis: 2400,
      current_price: null,
      current_value: null,
      unrealized_gain: null,
      pending_statement: false,
    });
    expect(rows[0].status_note ?? "").toMatch(/expired/i);
  });

  it("a pending lot (live zero, statement awaited) ships no mark either", () => {
    const sec = seedOpt("ZPND  270115C00010000", "2027-01-15");
    txn(sec, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    seedHold(db, ACCT, sec, "2026-10-20", "live-zero");
    seedPx(db, sec, "2026-10-23", 4);
    computeTaxLots(db);

    const rows = getTaxLotsForChat(db, { symbol: "ZPND  270115C00010000" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      current_price: null,
      current_value: null,
      unrealized_gain: null,
      pending_statement: true,
      pending_statement_reason: "awaiting_statement",
    });
  });

  it("an ordinary live option keeps its mark, value and gain", () => {
    const sec = seedOpt("ZLIV  270115C00010000", "2027-01-15");
    txn(sec, "2026-06-01", "BUY_TO_OPEN", 1, 3);
    seedHold(db, ACCT, sec, "2026-10-23", "tws", 1);
    seedPx(db, sec, "2026-10-23", 4);
    computeTaxLots(db);

    const rows = getTaxLotsForChat(db, { symbol: "ZLIV  270115C00010000" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ current_price: 4, current_value: 400, unrealized_gain: 100, pending_statement: false });
  });
});
