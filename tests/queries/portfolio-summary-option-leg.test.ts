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
    const id = seedOption("AAA   271217P00215000");
    seedHolding(id, 1);
    const ctx = getPortfolioSummaryForChat(db);
    const line = ctx.split("\n").find((l) => l.includes("AAA   271217P00215000"));
    expect(line).toBeDefined();
    expect(line).toContain("1 contracts");
    expect(line).toContain("long put on AAA, $215 strike, expires 2027-12-17");
  });

  it("an enriched call reads from the stored columns and its stored underlying", () => {
    const id = seedOption("ZZZ   260320C00050000", {
      optionType: "CALL",
      strike: 50,
      expiration: "2026-03-20",
      underlying: "ZZZ",
    });
    seedHolding(id, 2);
    const ctx = getPortfolioSummaryForChat(db);
    const line = ctx.split("\n").find((l) => l.includes("ZZZ   260320C00050000"));
    expect(line).toContain("long call on ZZZ, $50 strike, expires 2026-03-20");
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
