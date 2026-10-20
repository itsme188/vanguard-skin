/**
 * The chat portfolio context describes an option holding in plain words
 * (side, call/put, underlying, strike, expiry as YYYY-MM-DD) so the model
 * never has to decode an OCC symbol or guess the side. A long put in the
 * verified-holdings list was once answered as a "short put" with the wrong
 * expiry year. Synthetic symbols and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";

let db: Database.Database;

function seedOption(
  symbol: string,
  cols: { optionType?: string | null; strike?: number | null; expiration?: string | null; underlying?: string | null } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
         VALUES (?, ?, 'Option', ?, ?, ?, ?, 100)`
      )
      .run(symbol, `${symbol} contract`, cols.optionType ?? null, cols.strike ?? null, cols.expiration ?? null, cols.underlying ?? null)
      .lastInsertRowid
  );
}

function seedHolding(securityId: number, quantity: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (1, ?, ?, 500, '2026-10-16', ?)`
  ).run(securityId, quantity, `hold-1-${securityId}`);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2026-10-16', 6)").run(securityId);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("option holdings in the chat portfolio context", () => {
  it("an un-enriched OCC put reads as a long put with strike and ISO expiry parsed from the symbol", () => {
    const id = seedOption("AAA   270618P00050000");
    seedHolding(id, 1);
    const ctx = getPortfolioSummaryForChat(db);
    const line = ctx.split("\n").find((l) => l.includes("AAA   270618P00050000"));
    expect(line).toBeDefined();
    expect(line).toContain("1 contracts");
    expect(line).toContain("long put on AAA, $50 strike, expires 2027-06-18");
  });

  it("an enriched call reads from the stored columns and its stored underlying", () => {
    const id = seedOption("ZZZ   270319C00050000", {
      optionType: "CALL",
      strike: 50,
      expiration: "2027-03-19",
      underlying: "ZZZ",
    });
    seedHolding(id, 2);
    const ctx = getPortfolioSummaryForChat(db);
    const line = ctx.split("\n").find((l) => l.includes("ZZZ   270319C00050000"));
    expect(line).toContain("long call on ZZZ, $50 strike, expires 2027-03-19");
  });

  it("a legacy compact expiry prints as ISO", () => {
    const id = seedOption("CCC   270618C00050000", { optionType: "CALL", strike: 50, expiration: "20270618", underlying: "CCC" });
    seedHolding(id, 1);
    const line = getPortfolioSummaryForChat(db).split("\n").find((l) => l.includes("CCC   270618C00050000"));
    expect(line).toContain("expires 2027-06-18");
    expect(line).not.toContain("20270618");
  });

  it("a short option is described in words in the short section", () => {
    const id = seedOption("DDD   270618C00050000");
    seedHolding(id, -2);
    const ctx = getPortfolioSummaryForChat(db);
    const line = ctx.split("\n").find((l) => l.startsWith("- DDD") && l.includes("short 2 contracts"));
    expect(line).toBeDefined();
    expect(line).toContain("short call on DDD, $50 strike, expires 2027-06-18");
  });

  it("expired long and short options are left out of both lists", () => {
    const longId = seedOption("EEE   260116P00050000", { optionType: "PUT", strike: 50, expiration: "2026-01-16", underlying: "EEE" });
    const shortId = seedOption("FFF   260116C00050000", { optionType: "CALL", strike: 50, expiration: "20260116", underlying: "FFF" });
    seedHolding(longId, 1);
    seedHolding(shortId, -1);
    const ctx = getPortfolioSummaryForChat(db);
    expect(ctx).not.toContain("EEE   260116P00050000");
    expect(ctx).not.toContain("FFF   260116C00050000");
  });

  it("a stock line carries no option leg", () => {
    const id = Number(
      db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('BBB', 'BBB Corp', 'Stock')").run().lastInsertRowid
    );
    seedHolding(id, 10);
    const ctx = getPortfolioSummaryForChat(db);
    const line = ctx.split("\n").find((l) => l.startsWith("- BBB ("));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/long (call|put)/);
  });
});
