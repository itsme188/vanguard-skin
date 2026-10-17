/**
 * The chat holdings tool's security_type filter (query_holdings).
 *
 * The tool offers the model lowercase tokens ('stock', 'etf', 'option',
 * 'mutual_fund', 'money_market', 'bond'); the securities table stores
 * 'Stock', 'ETF', 'Option', 'Mutual Fund', 'Bond'. A case-sensitive equality
 * matched nothing, so every typed filter returned zero rows. Synthetic
 * symbols and invented figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getHoldingsForChat } from "@/lib/queries/chat-tools";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedHold, seedPx } from "../setup/pending-statement-fixtures";

const IBKR = 3; // seeded by migration 002

let db: Database.Database;

function sec(
  symbol: string,
  type: string,
  extra: { fund_category?: string | null; expiration_date?: string | null; multiplier?: number } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, currency, fund_category, expiration_date, multiplier)
         VALUES (?, ?, ?, 'USD', ?, ?, ?)`
      )
      .run(symbol, `${symbol} name`, type, extra.fund_category ?? null, extra.expiration_date ?? null, extra.multiplier ?? 1)
      .lastInsertRowid
  );
}

function symbols(type: string): string[] {
  return getHoldingsForChat(db, { security_type: type })
    .map((r) => r.symbol)
    .sort();
}

describe("getHoldingsForChat security_type filter", () => {
  beforeEach(() => {
    db = createPendingTestDb();
    const today = todayET();
    const nextYear = `${Number(today.slice(0, 4)) + 1}-06-19`;
    const rows: Array<[string, string, Parameters<typeof sec>[2]]> = [
      ["AAA", "Stock", {}],
      ["BBB", "ETF", {}],
      ["CCC", "Bond", {}],
      ["DDD", "Mutual Fund", {}],
      ["SWEEP", "Mutual Fund", { fund_category: "Cash Equivalent" }],
      ["AAA 270619C00100000", "Option", { expiration_date: nextYear, multiplier: 100 }],
    ];
    for (const [symbol, type, extra] of rows) {
      const id = sec(symbol, type, extra);
      seedHold(db, IBKR, id, today, "stmt", 10);
      seedPx(db, id, today, 20);
    }
  });

  it("matches the stored capitalised type for each lowercase token", () => {
    expect(symbols("stock")).toEqual(["AAA"]);
    expect(symbols("etf")).toEqual(["BBB"]);
    expect(symbols("bond")).toEqual(["CCC"]);
    expect(symbols("option")).toEqual(["AAA 270619C00100000"]);
  });

  it("mutual_fund returns the mutual funds, the sweep fund included; money_market returns only the cash equivalent", () => {
    expect(symbols("mutual_fund")).toEqual(["DDD", "SWEEP"]);
    expect(symbols("money_market")).toEqual(["SWEEP"]);
  });

  it("the stored spelling is accepted too, case-insensitively", () => {
    expect(symbols("Option")).toEqual(["AAA 270619C00100000"]);
    expect(symbols("MUTUAL FUND")).toEqual(["DDD", "SWEEP"]);
  });

  it("an unknown token matches nothing rather than everything", () => {
    expect(symbols("crypto")).toEqual([]);
  });
});
