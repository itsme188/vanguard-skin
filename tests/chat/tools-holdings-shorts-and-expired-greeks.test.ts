// Review fixes for what lib/chat/tools.ts hands the chat model:
//  - query_holdings returned the long book only (it never opted into shorts);
//  - holdings rows leaked an internal sort column;
//  - query_options_greeks reported four zero totals with no note for a book
//    holding nothing but expired contracts.
// Synthetic tickers and round invented figures only.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { getHoldingsForChat } from "@/lib/queries/chat-tools";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedStock(symbol: string): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier)
       VALUES (?, ?, 'stock', 'equity', 'USD', 1)`,
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, quantity: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(accountId, securityId, quantity, todayET(), `h-${accountId}-${securityId}`);
}

function seedPrice(securityId: number, close: number): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`,
  ).run(securityId, todayET(), close);
}

function accountId(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

type HoldingRow = {
  symbol: string;
  account_name: string;
  quantity: number;
  market_value: number | null;
  position_weight_pct: number | null;
  position_side: "long" | "short";
};

describe("query_holdings tool includes shorts, signed", () => {
  it("returns a short position with negative quantity and market value, and names its side", async () => {
    const acct = accountId("Acct One");
    const long = seedStock("AAA");
    const short = seedStock("ZZZ");
    seedHolding(acct, long, 10);
    seedHolding(acct, short, -5);
    seedPrice(long, 100);
    seedPrice(short, 100);

    const result = (await executeTool(db, "query_holdings", {})) as {
      error?: string;
      data: HoldingRow[];
    };
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.data)).toBe(true);

    const shortRow = result.data.find((h) => h.symbol === "ZZZ");
    expect(shortRow).toBeDefined();
    expect(shortRow!.quantity).toBe(-5);
    expect(shortRow!.market_value).toBe(-500);
    expect(shortRow!.position_side).toBe("short");
    expect(shortRow!.position_weight_pct!).toBeGreaterThan(0);

    const longRow = result.data.find((h) => h.symbol === "AAA")!;
    expect(longRow.position_side).toBe("long");
    expect(longRow.market_value).toBe(1000);
  });

  it("the tool description says the figures are signed", () => {
    const tool = CHAT_TOOLS.find((t) => t.name === "query_holdings")!;
    expect(tool.description).toContain("negative = short");
  });
});

describe("getHoldingsForChat row shape and ordering", () => {
  it("never returns the internal sort column, with or without shorts", () => {
    const acct = accountId("Acct One");
    const long = seedStock("AAA");
    seedHolding(acct, long, 10);
    seedPrice(long, 100);

    for (const includeShorts of [true, false]) {
      const rows = getHoldingsForChat(db, { includeShorts });
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0])).not.toContain("sort_market_exposure");
    }
  });

  it("two accounts holding one symbol at equal exposure come back in account-name order", () => {
    // Inserted in reverse name order so insertion order cannot pass the test.
    const second = accountId("Acct Two");
    const first = accountId("Acct One");
    const sec = seedStock("AAA");
    seedHolding(second, sec, -10);
    seedHolding(first, sec, 10);
    seedPrice(sec, 100);

    const rows = getHoldingsForChat(db, { includeShorts: true });
    expect(rows.map((h) => h.account_name)).toEqual(["Acct One", "Acct Two"]);
  });
});

describe("query_options_greeks on an expired-only option book", () => {
  type Portfolio = {
    totalDelta: number | null;
    totalGamma: number | null;
    totalTheta: number | null;
    totalVega: number | null;
    totalPositions: number;
    expiredPositions: number;
    fallbackVolPositions: number;
    note: string | null;
    volatilityNote: string | null;
  };

  function seedOption(underlying: string, expiry: string, qty: number): void {
    const id = db
      .prepare(
        `INSERT INTO securities
           (symbol, security_type, option_type, strike_price, expiration_date,
            underlying_symbol, multiplier, currency)
         VALUES (?, 'option', 'CALL', 100, ?, ?, 100, 'USD')`,
      )
      .run(`${underlying} CALL ${expiry}`, expiry, underlying).lastInsertRowid as number;
    seedHolding(1, id, qty);
  }

  async function run(): Promise<Portfolio> {
    const result = (await executeTool(db, "query_options_greeks", {})) as {
      error?: string;
      data: { portfolio: Portfolio };
    };
    expect(result.error).toBeUndefined();
    return result.data.portfolio;
  }

  it("nulls the four totals and says the contracts are expired", async () => {
    const und = seedStock("AAA");
    seedPrice(und, 100);
    seedOption("AAA", addDays(todayET(), -2), 1);

    const p = await run();
    // Only meaningful if the engine still loads the expired row; if it stops
    // loading them, the empty-book case below covers the payload.
    expect(p.expiredPositions).toBe(1);
    expect(p.totalPositions).toBe(0);
    expect(p.totalDelta).toBeNull();
    expect(p.totalGamma).toBeNull();
    expect(p.totalTheta).toBeNull();
    expect(p.totalVega).toBeNull();
    expect(p.note).toContain("no live option positions");
    expect(p.note).toContain("1 expired contract excluded");
    expect(p.volatilityNote).toBeNull();
  });

  it("says when a priced position used a fallback volatility", async () => {
    const und = seedStock("AAA");
    seedPrice(und, 100);
    // No option price row: the engine cannot solve a volatility from the
    // contract's own price and falls back.
    seedOption("AAA", addDays(todayET(), 180), 1);

    const p = await run();
    expect(p.totalPositions).toBe(1);
    expect(p.fallbackVolPositions).toBe(1);
    expect(typeof p.totalDelta).toBe("number");
    // Coverage is complete, so `note` stays null; the volatility caveat has
    // its own field.
    expect(p.note).toBeNull();
    expect(p.volatilityNote).toContain("1 of the 1 priced position used a fallback volatility");
  });
});
