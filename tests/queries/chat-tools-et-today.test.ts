// "Today" in chat tools is the ET calendar date, never the UTC date.
// Clock pinned to 2026-01-01T03:00Z == 2025-12-31 22:00 ET.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getPriceHistory,
  getTaxLotsForChat,
  getIncomeSummaryForChat,
  getDataFreshness,
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

describe("getDataFreshness: Eastern day and the scope's own dates (B25 / QA-9)", () => {
  function hold(account: number, security: number, date: string) {
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 5, 50, ?, ?)"
    ).run(account, security, date, `fresh-${account}-${security}-${date}`);
  }

  it("a price dated today is 0 days old at 21:00 Eastern", () => {
    // 2026-11-11 02:00Z is 2026-11-10 21:00 Eastern: the UTC clock already
    // reads the 11th, and the old code aged a price dated the 10th 1 day.
    vi.setSystemTime(new Date("2026-11-11T02:00:00Z"));
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-10', 10, 't')").run(sec);
    hold(acct, sec, "2026-11-10");
    const f = getDataFreshness(db);
    expect(f.latest_price_date).toBe("2026-11-10");
    expect(f.price_age_days).toBe(0);
    expect(f.holdings_age_days).toBe(0);
  });

  it("an old scoped account beside a fresh unrelated account reads old", () => {
    vi.setSystemTime(new Date("2026-11-11T17:00:00Z")); // 12:00 Eastern on the 11th
    const fresh = db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('NEW', 'NEW', 'Stock')")
      .run().lastInsertRowid as number;
    // The scoped account (acct) last saw holdings and a price on 2026-10-30;
    // account 1 has both from 2026-11-10.
    hold(acct, sec, "2026-10-30");
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-10-30', 10, 't')").run(sec);
    hold(1, fresh, "2026-11-10");
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-10', 10, 't')").run(fresh);

    const scoped = getDataFreshness(db, { accountIds: [acct] });
    expect(scoped.latest_holdings_date).toBe("2026-10-30");
    expect(scoped.holdings_age_days).toBe(12);
    expect(scoped.latest_price_date).toBe("2026-10-30");
    expect(scoped.price_age_days).toBe(12);

    const whole = getDataFreshness(db);
    expect(whole.latest_holdings_date).toBe("2026-11-10");
    expect(whole.price_age_days).toBe(1);

    const none = getDataFreshness(db, { accountIds: [] });
    expect(none.latest_holdings_date).toBeNull();
    expect(none.latest_price_date).toBeNull();
    expect(none.price_age_days).toBeNull();
  });
});
