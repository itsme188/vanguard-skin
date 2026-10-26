/**
 * DECISIONS 2026-10-26 (reviewer item 2): the broker syncs write no holdings
 * row on a closed market day, so holdings age is measured without the closed
 * days in between. A row dated the last trading day before today is fresh;
 * otherwise every weekend and holiday would show a "sync IBKR positions"
 * warning no sync can clear. Synthetic figures only.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getDataConfidence, holdingAgeDays } from "@/lib/queries/data-confidence";

const FIX = "Import latest statement or sync IBKR positions";

function dbWithIbkrRowsOn(date: string): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
  const sec = db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZA', 'Stock')").run()
    .lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 10, 100, ?, ?)",
  ).run(acct, sec, date, `tws-${acct}-${sec}-${date}`);
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 12, 'tws')").run(sec, date);
  return db;
}

function staleHoldingsAction(db: Database.Database, now: Date) {
  return getDataConfidence(db, now).actions.find((a) => a.fix === FIX);
}

describe("holdings age counts trading days", () => {
  it("Sunday evening with Friday rows: no stale-holdings warning", () => {
    const db = dbWithIbkrRowsOn("2026-03-13");
    const now = new Date("2026-03-16T02:00:00Z"); // Sunday 22:00 Eastern
    expect(staleHoldingsAction(db, now)).toBeUndefined();
    const { holdingsRecency } = getDataConfidence(db, now);
    expect(holdingsRecency.guidanceActionable).toBe(false);
    expect(holdingsRecency.perAccount.find((a) => a.name === "IBKR")!.daysOld).toBe(2); // wording keeps calendar days
  });

  it("Tuesday with Friday rows: the warning shows (Monday traded with no newer row)", () => {
    const db = dbWithIbkrRowsOn("2026-03-13");
    expect(staleHoldingsAction(db, new Date("2026-03-17T16:00:00Z"))).toBeDefined();
  });

  it("Monday holiday after a Friday: no warning, and none on the Tuesday after either", () => {
    const db = dbWithIbkrRowsOn("2026-09-04"); // Labor Day is Monday 2026-09-07
    expect(staleHoldingsAction(db, new Date("2026-09-07T16:00:00Z"))).toBeUndefined();
    expect(staleHoldingsAction(db, new Date("2026-09-08T16:00:00Z"))).toBeUndefined();
    expect(staleHoldingsAction(db, new Date("2026-09-09T16:00:00Z"))).toBeDefined();
  });

  it("holdingAgeDays leaves out closed days only", () => {
    expect(holdingAgeDays("2026-03-13", "2026-03-13")).toBe(0);
    expect(holdingAgeDays("2026-03-12", "2026-03-13")).toBe(1);
    expect(holdingAgeDays("2026-03-11", "2026-03-13")).toBe(2);
    expect(holdingAgeDays("2026-03-13", "2026-03-16")).toBe(1); // Fri -> Mon
    expect(holdingAgeDays("2026-03-13", "2026-03-17")).toBe(2); // Fri -> Tue
  });
});
