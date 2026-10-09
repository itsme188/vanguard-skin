/**
 * The evening "significant moves" universe is the same set of security types
 * on the Mac and in the cloud.
 *
 * The Worker's fallback email reads `vanguardHoldings` from the nightly
 * snapshot, and `getVanguardHoldingsForSnapshot` keeps stock / common stock /
 * ETF / mutual fund. The Mac's `computeAnomalies` had no type filter: any held
 * row with a beta on file and two closes could be named a mover, whatever its
 * type (an option or a bond retyped after its beta was cached, an untyped
 * row). The Mac now applies the same list, so the two emails name the same
 * securities, and an option or a bond is never a mover.
 *
 * The parity half runs the REAL snapshot reader against the same database:
 * if either side's list changes alone, this file fails.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeAnomalies, formatVanguardAnomaliesBlock, isMoverSecurityType } from "@/lib/digest/anomalies";
import { upsertBeta } from "@/lib/mutations/security-betas";
import { getVanguardHoldingsForSnapshot } from "@/scripts/snapshot-state-to-r2";

let db: Database.Database;
let vanguard: number;

const PRIOR = "2026-05-07";
const LATEST = "2026-05-08";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')").run();
  vanguard = (db.prepare("SELECT id FROM accounts WHERE name = 'Vanguard Taxable'").get() as { id: number }).id;
  const spy = security("SPY", "ETF");
  price(spy, PRIOR, 500);
  price(spy, LATEST, 500.5); // flat day
});

function security(symbol: string, type: string | null): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, ?, 1)")
    .run(symbol, `${symbol} name`, type).lastInsertRowid as number;
}
function price(id: number, date: string, close: number): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'vanguard')").run(id, date, close);
}
/** A held row that clears every numeric gate: +10% on a flat day, beta on file. */
function heldMover(symbol: string, type: string | null): number {
  const id = security(symbol, type);
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 100, ?, ?)",
  ).run(vanguard, id, LATEST, `test:${vanguard}:${id}`);
  price(id, PRIOR, 100);
  price(id, LATEST, 110);
  upsertBeta(db, { securityId: id, lookbackDays: 60, beta: 1.0, residualStd: 1.0 });
  return id;
}

const flagged = () => computeAnomalies(db).map((f) => f.symbol).sort();
const cloudUniverse = () =>
  [...new Set(getVanguardHoldingsForSnapshot(db).map((h) => h.symbol))].filter((s) => s !== "SPY").sort();

describe("the mover universe keeps equity-like types only", () => {
  it.each([
    ["Stock"],
    ["stock"],
    ["STOCK"],
    ["Common Stock"],
    ["ETF"],
    ["etf"],
    ["Mutual Fund"],
    ["mutual fund"],
  ])("%s is evaluated", (type) => {
    heldMover("ZZA", type);
    expect(flagged()).toEqual(["ZZA"]);
  });

  it.each([
    ["Option"],
    ["option"],
    ["Equity and Index Options"],
    ["Bond"],
    ["bond"],
    ["ADR"],
    ["money_market"],
    ["Unknown"],
    [""],
    [null],
  ])("%s is not a mover, even with a beta on file and a 10%% move", (type) => {
    heldMover("ZZB", type);
    expect(flagged()).toEqual([]);
    expect(formatVanguardAnomaliesBlock(db)).toBe("");
  });

  it("isMoverSecurityType is case-insensitive and fails closed on an unknown type", () => {
    for (const t of ["Stock", "COMMON STOCK", "Etf", "Mutual Fund"]) expect(isMoverSecurityType(t)).toBe(true);
    for (const t of ["Option", "Bond", "ADR", "", null, undefined]) expect(isMoverSecurityType(t)).toBe(false);
  });

  it("a scoped call (the Significant Moves card) applies the same list", () => {
    heldMover("ZZA", "Stock");
    heldMover("ZZB", "Option");
    heldMover("ZZC", "Bond");
    expect(computeAnomalies(db, { accountIds: [vanguard] }).map((f) => f.symbol)).toEqual(["ZZA"]);
  });
});

describe("Mac and cloud name the same securities", () => {
  it("every type at once: the Mac's flagged set equals the snapshot's universe", () => {
    const types: [string, string | null][] = [
      ["ZZA", "Stock"],
      ["ZZB", "ETF"],
      ["ZZC", "Mutual Fund"],
      ["ZZD", "Common Stock"],
      ["ZZE", "stock"],
      ["ZZF", "ADR"],
      ["ZZG", "Option"],
      ["ZZH", "Bond"],
      ["ZZI", null],
      ["ZZJ", "mutual_fund"],
      ["ZZK", "money_market"],
      ["ZZL", "Equity and Index Options"],
    ];
    for (const [symbol, type] of types) heldMover(symbol, type);

    // Every seeded name clears the numeric gates, so the flagged set IS the
    // Mac's universe.
    expect(flagged()).toEqual(cloudUniverse());
    expect(flagged()).toEqual(["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"]);
  });

  it("a row with no symbol is in neither universe", () => {
    heldMover("", "Stock");
    heldMover("ZZA", "Stock");
    expect(flagged()).toEqual(cloudUniverse());
    expect(flagged()).toEqual(["ZZA"]);
  });
});
