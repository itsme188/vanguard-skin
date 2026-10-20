import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePositionRisk } from "@/lib/compute/risk";
import { getAnalysisTrustState } from "@/lib/queries/analysis-trust-state";

/**
 * An option past its expiration is not a held long (qa:
 * dashboard-analysis-view-diagnostics-scope-ibkr-position-level-risk-top-10-by-risk-drawer-trust-strip-factor-co).
 * Position-Level Risk and the trust strip's factor coverage must apply the
 * same live-option cut as Greeks, Concentration and Classification, so one
 * page never counts 9 names in one card and 8 in the next. The purge keeps a
 * grace day before deleting the holdings row, so an expired contract can
 * still be in the book at read time. All figures are invented.
 */
const IBKR = 3; // seeded by migration 002
const AS_OF = "2026-06-10";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedStock(symbol: string, close: number, qty: number): number {
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, 'Stock', 1)")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(id, AS_OF, close);
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(IBKR, id, qty, AS_OF, `tws:${IBKR}:${id}:${AS_OF}`);
  db.prepare("INSERT INTO security_factors (security_id) VALUES (?)").run(id);
  return id;
}

function seedOption(symbol: string, expiration: string, close: number, qty: number): number {
  const id = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date, underlying_symbol) VALUES (?, ?, 'Option', 100, ?, 'AAA')",
    )
    .run(symbol, `${symbol} option`, expiration).lastInsertRowid as number;
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(id, AS_OF, close);
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(IBKR, id, qty, AS_OF, `tws:${IBKR}:${id}:${AS_OF}`);
  return id;
}

describe("an expired option is not a held long on the Analysis page", () => {
  beforeEach(() => {
    seedStock("AAA", 100, 100); // 10,000
    seedStock("BBB", 50, 100); //  5,000
    // Expired the day before the as-of date; still in the book (grace day).
    seedOption("AAA   260609C00100000", "2026-06-09", 5, 10); // would be 5,000
    // A live contract stays.
    seedOption("AAA   990115C00100000", "2099-01-15", 2, 10); // 2,000
  });

  it("Position-Level Risk drops the expired contract from the rows and the weight denominator", () => {
    const risk = computePositionRisk(db, { accountIds: [IBKR], asOfDate: AS_OF });
    const symbols = risk.positions.map((p) => p.symbol);
    expect(symbols).not.toContain("AAA   260609C00100000");
    expect(symbols).toContain("AAA   990115C00100000");
    const aaa = risk.positions.find((p) => p.symbol === "AAA")!;
    // 10,000 of a 17,000 long book (10,000 + 5,000 + 2,000), not of 22,000.
    expect(aaa.weight).toBeCloseTo(10000 / 17000, 6);
  });

  it("the trust strip's factor coverage counts the same names as the Factor Coverage card", () => {
    const state = getAnalysisTrustState(db, [IBKR], AS_OF);
    expect(state.factorCoverage.totalNames).toBe(3);
    expect(state.factorCoverage.classified).toBe(3);
  });
});
