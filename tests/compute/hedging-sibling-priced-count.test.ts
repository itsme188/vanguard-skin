// The Defense analysis consumes option Greeks that the engine may have priced
// off a SIBLING share class's close (a GOOGL contract off GOOG). The count of
// such positions is carried on the result so the view can state it.
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { runMigrations } from "@/lib/db/migrate";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { anchorIndex } from "../helpers/source-anchor";

let db: Database.Database;
let acct: number;

function stock(symbol: string, price: number | null): number {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, multiplier, currency)
       VALUES (?, ?, 'Stock', 1, 'USD')`,
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  if (price !== null) {
    db.prepare(
      "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')",
    ).run(id, price, todayET());
  }
  return id;
}

function put(underlying: string, strike: number, optionPrice: number): number {
  const expiry = addDays(todayET(), 180);
  const id = db
    .prepare(
      `INSERT INTO securities
         (symbol, name, security_type, underlying_symbol, option_type, strike_price,
          expiration_date, multiplier, currency)
       VALUES (?, ?, 'Option', ?, 'PUT', ?, ?, 100, 'USD')`,
    )
    .run(`${underlying} PUT ${strike}`, `${underlying} put`, underlying, strike, expiry)
    .lastInsertRowid as number;
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')",
  ).run(id, optionPrice, todayET());
  return id;
}

function hold(securityId: number, qty: number): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, ?)",
  ).run(acct, securityId, qty, 1000, todayET());
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES ('Acct One')").run();
  acct = (db.prepare("SELECT id FROM accounts WHERE name = 'Acct One'").get() as { id: number }).id;
});

describe("computeDefenseAnalysis — sibling-priced option count", () => {
  it("counts an option whose Greeks were priced off the sibling class's close", () => {
    hold(stock("GOOG", 300), 100); // the priced class
    stock("GOOGL", null); // the contract's own underlying: no close
    hold(put("GOOGL", 280, 12), 1);

    const result = computeDefenseAnalysis(db, [acct]);
    expect(result.siblingPricedPositions).toBe(1);
  });

  it("is zero when the contract's own underlying has a close", () => {
    hold(stock("GOOG", 300), 100);
    stock("GOOGL", 301);
    hold(put("GOOGL", 280, 12), 1);

    const result = computeDefenseAnalysis(db, [acct]);
    expect(result.siblingPricedPositions).toBe(0);
  });

  it("is zero with no options at all", () => {
    hold(stock("GOOG", 300), 100);
    expect(computeDefenseAnalysis(db, [acct]).siblingPricedPositions).toBe(0);
  });
});

describe("DefenseView states the sibling-priced count", () => {
  const src = readFileSync("app/dashboard/components/DefenseView.tsx", "utf8");

  it("renders one masked-count line, outside the collapsed diagnostics", () => {
    const gate = anchorIndex(src, "analysis.siblingPricedPositions > 0 &&");
    const line = anchorIndex(src, "<Count value={analysis.siblingPricedPositions} />", gate);
    const details = anchorIndex(src, "<details");
    expect(line).toBeLessThan(details);
    expect(src.slice(gate, details)).toContain("sibling share class");
  });
});
