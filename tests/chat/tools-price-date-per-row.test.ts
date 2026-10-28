// Every holdings and open tax-lot row carries the date of the price row behind
// its mark, so the chat model can label a stale quote by its own date.
// Synthetic tickers and round invented figures only.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsForChat, getTaxLotsForChat } from "@/lib/queries/chat-tools";
import { todayET } from "@/lib/calendar/date-utils";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";

let db: Database.Database;
let acct: number;

function seed(symbol: string, priceDates: string[]): number {
  const sec = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier)
       VALUES (?, ?, 'stock', 'equity', 'USD', 1)`,
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, 100, 1000, ?, ?)`,
  ).run(acct, sec, todayET(), `h-${symbol}`);
  db.prepare(
    `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
     VALUES (?, ?, '2025-01-02', 10, 100, 100, 1000, 0)`,
  ).run(acct, sec);
  for (const d of priceDates) {
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 12, 'test')`).run(sec, d);
  }
  return sec;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acct = db.prepare("INSERT INTO accounts (name) VALUES ('Acct One')").run().lastInsertRowid as number;
  seed("AAA", ["2026-10-20", "2026-10-26"]);
  seed("BBB", ["2026-10-19", "2026-10-21"]);
});

describe("price_date per row", () => {
  it("holdings rows carry their own latest price date", () => {
    const rows = getHoldingsForChat(db, {});
    expect(rows.find((r) => r.symbol === "AAA")!.price_date).toBe("2026-10-26");
    expect(rows.find((r) => r.symbol === "BBB")!.price_date).toBe("2026-10-21");
  });

  it("open tax lot rows carry their own latest price date", () => {
    const rows = getTaxLotsForChat(db, { status: "open" });
    expect(rows.find((r) => r.symbol === "AAA")!.price_date).toBe("2026-10-26");
    expect(rows.find((r) => r.symbol === "BBB")!.price_date).toBe("2026-10-21");
  });
});

describe("chat prompt: dating a mark", () => {
  it("tells the model a mark is dated by its row's price_date", () => {
    const p = buildSystemPrompt("## Portfolio Summary\n- Test data", "2026-03-17", "all");
    expect(p).toContain("price_date");
    expect(p).toMatch(/dated by that row's `price_date`/);
    expect(p).toMatch(/stale as of its own date/);
  });
});
