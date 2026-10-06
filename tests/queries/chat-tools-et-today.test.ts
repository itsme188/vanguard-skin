// "Today" in chat tools is the ET calendar date, never the UTC date.
// Clock pinned to 2026-01-01T03:00Z == 2025-12-31 22:00 ET.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getPriceHistory,
  getTaxLotsForChat,
  getIncomeSummaryForChat,
} from "@/lib/queries/chat-tools";

let db: Database.Database;
let acct: number;
let sec: number;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T03:00:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run();
  acct = (db.prepare("SELECT id FROM accounts WHERE name='Test'").get() as { id: number }).id;
  sec = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ABC', 'ABC', 'Stock')")
    .run().lastInsertRowid as number;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chat tools use the ET calendar date", () => {
  it("getPriceHistory default window starts 90 days before the ET date", () => {
    // ET today 2025-12-31 -> start 2025-10-02 (UTC date would give 2025-10-03)
    for (const d of ["2025-10-01", "2025-10-02", "2025-12-30"]) {
      db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 10, 't')").run(sec, d);
    }
    const dates = getPriceHistory(db, "ABC").map((r) => r.date);
    expect(dates).toContain("2025-10-02");
    expect(dates).not.toContain("2025-10-01");
  });

  it("getTaxLotsForChat days_held counts to the ET date", () => {
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, '2025-12-30', 10, 5, 5, 50)`
    ).run(acct, sec);
    const lots = getTaxLotsForChat(db, { status: "open" });
    expect(lots[0].days_held).toBe(1);
  });

  it("getIncomeSummaryForChat trailing_12m starts at the ET date minus a year", () => {
    db.prepare(
      "INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key) VALUES (?, ?, '2024-12-31', 'DIVIDEND', 7, 'k1')"
    ).run(acct, sec);
    const rows = getIncomeSummaryForChat(db, { period: "trailing_12m" });
    expect(rows.reduce((s, r) => s + r.total_dividends, 0)).toBeCloseTo(7, 6);
  });
});
