/**
 * A week-ago concentration snapshot (`asOfDate`) must value its positions at
 * the closes ON OR BEFORE that date. Pre-fix the latest-price step was
 * unbounded, so the "as of last week" weights were last week's holdings at
 * TODAY's prices — look-ahead (CLAUDE.md: as-of computations bound every read
 * by the as-of date). FX stays current: no as-of FX reader exists.
 * Synthetic symbols and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getConcentrationUniverse } from "@/lib/queries/concentration-universe";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Acct')").run();
  const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'ZZ Acct'").get() as { id: number }).id;
  const insSec = db.prepare(
    "INSERT INTO securities (symbol, name, security_type, multiplier, currency) VALUES (?, ?, 'Stock', 1, 'USD')"
  );
  const insHold = db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)"
  );
  const insPrice = db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)");
  for (const sym of ["ZZA", "ZZB"]) {
    const id = insSec.run(sym, sym).lastInsertRowid as number;
    insHold.run(acct, id, 10, "2030-01-01", `t:${sym}`);
    insPrice.run(id, "2030-01-01", 100);
  }
  // A close AFTER the as-of date: ZZA doubles.
  const zza = (db.prepare("SELECT id FROM securities WHERE symbol = 'ZZA'").get() as { id: number }).id;
  insPrice.run(zza, "2030-01-10", 200);
});

describe("getConcentrationUniverse asOfDate bounds the price read", () => {
  it("values an as-of snapshot at the closes on or before that date", () => {
    const asOf = getConcentrationUniverse(db, undefined, { asOfDate: "2030-01-05" });
    expect(asOf.find((p) => p.symbol === "ZZA")!.marketValue).toBe(1000);
    expect(asOf.find((p) => p.symbol === "ZZB")!.marketValue).toBe(1000);
  });

  it("an as-of date after the newer close still reads it", () => {
    const later = getConcentrationUniverse(db, undefined, { asOfDate: "2030-01-10" });
    expect(later.find((p) => p.symbol === "ZZA")!.marketValue).toBe(2000);
  });

  it("without an as-of date reads the latest close", () => {
    const now = getConcentrationUniverse(db);
    expect(now.find((p) => p.symbol === "ZZA")!.marketValue).toBe(2000);
  });
});

// Review 2026-11-15 (W5): a position first held ON the as-of date, with no
// cost basis and no close on or before that date (its first close comes a
// day later), valued to 0 and was dropped, so the week-over-week change read
// it as a new position. It stays in the snapshot, valued at its first close
// after the date and marked so.
describe("getConcentrationUniverse asOfDate keeps a position with no close yet", () => {
  it("a new position with no close on or before the date stays, valued at its first later close and marked", () => {
    const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'ZZ Acct'").get() as { id: number }).id;
    const id = db
      .prepare("INSERT INTO securities (symbol, name, security_type, multiplier, currency) VALUES ('ZZN', 'ZZN', 'Stock', 1, 'USD')")
      .run().lastInsertRowid as number;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 5, '2030-01-05', 't:ZZN')",
    ).run(acct, id);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2030-01-06', 40)").run(id);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2030-01-09', 90)").run(id);

    const asOf = getConcentrationUniverse(db, undefined, { asOfDate: "2030-01-05" });
    const zzn = asOf.find((p) => p.symbol === "ZZN");
    expect(zzn).toBeDefined();
    expect(zzn!.marketValue).toBe(200); // 5 x the FIRST close after the date
    expect(zzn!.priced).toBe(false);
    expect(zzn!.valuedAfterAsOf).toBe(true);
    // The other positions are untouched and unmarked.
    expect(asOf.find((p) => p.symbol === "ZZA")!.valuedAfterAsOf).toBe(false);
    expect(asOf).toHaveLength(3);
  });

  it("a cost basis still comes before a later close", () => {
    const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'ZZ Acct'").get() as { id: number }).id;
    const id = db
      .prepare("INSERT INTO securities (symbol, name, security_type, multiplier, currency) VALUES ('ZZC', 'ZZC', 'Stock', 1, 'USD')")
      .run().lastInsertRowid as number;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 5, 150, '2030-01-05', 't:ZZC')",
    ).run(acct, id);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2030-01-06', 40)").run(id);
    const zzc = getConcentrationUniverse(db, undefined, { asOfDate: "2030-01-05" }).find((p) => p.symbol === "ZZC")!;
    expect(zzc.marketValue).toBe(150);
    expect(zzc.valuedAfterAsOf).toBe(false);
  });

  it("without an as-of date nothing is marked", () => {
    expect(getConcentrationUniverse(db).every((p) => p.valuedAfterAsOf === false)).toBe(true);
  });
});
