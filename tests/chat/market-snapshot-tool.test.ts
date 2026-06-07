import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

/**
 * Seed the last 11 calendar days (relative to todayET()) for a symbol so the
 * SPY-anchored trading-day pair is always FRESH and consecutive on any run
 * date — keeping the local-first branch (no network) deterministic.
 */
function seedRecentDays(securityId: number, base: number, step: number): void {
  const today = todayET();
  for (let i = 0; i <= 11; i++) {
    const date = addDays(today, -i);
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')"
    ).run(securityId, date, base - i * step);
  }
}

describe("query_market_snapshot tool", () => {
  it("is registered in CHAT_TOOLS", () => {
    expect(CHAT_TOOLS.find((t) => t.name === "query_market_snapshot")).toBeDefined();
  });

  it("dispatches via executeTool and returns a fresh local snapshot (no network)", async () => {
    const spyId = seedSecurity("SPY");
    seedRecentDays(spyId, 600, 2);

    db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')").run();
    const acctId = (
      db.prepare("SELECT id FROM accounts WHERE name = 'Vanguard Taxable'").get() as { id: number }
    ).id;
    const gsId = seedSecurity("GS");
    seedRecentDays(gsId, 1090, 5);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 100, ?, ?)`
    ).run(acctId, gsId, todayET(), `test:gs`);

    const result = (await executeTool(db, "query_market_snapshot", {})) as {
      error?: string;
      data?: { source: string; moves: { symbol: string }[] };
    };

    // Not the default "Unknown tool" branch.
    expect(result.error).toBeUndefined();
    expect(result.data?.source).toBe("local");
    expect(result.data?.moves.some((m) => m.symbol === "SPY")).toBe(true);
    expect(result.data?.moves.some((m) => m.symbol === "GS")).toBe(true);
  });
});
