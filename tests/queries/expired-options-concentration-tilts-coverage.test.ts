import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { getConcentrationUniverse } from "@/lib/queries/concentration-universe";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { getClassificationCoverage } from "@/lib/queries/analysis";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run();
});

function acct(): number {
  return (db.prepare("SELECT id FROM accounts WHERE name='Test'").get() as { id: number }).id;
}

function seedHolding(sid: number, price: number): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 1, '2026-06-01', 'test:' || ?)"
  ).run(acct(), sid, sid);
  db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-06-01', 'test')").run(sid, price);
}

function seedOption(symbol: string, expiration: string): number {
  const sid = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, sector, classification_source)
       VALUES (?, ?, 'Option', 'ZZZ', 'CALL', 100, ?, 100, 'Technology', 'test')`
    )
    .run(symbol, symbol, expiration).lastInsertRowid as number;
  seedHolding(sid, 5);
  return sid;
}

function seedStock(symbol: string): number {
  const sid = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, multiplier, sector, geography, classification_source)
       VALUES (?, ?, 'Stock', 1, 'Technology', 'US', 'test')`
    )
    .run(symbol, symbol).lastInsertRowid as number;
  seedHolding(sid, 1000);
  return sid;
}

const compact = (d: string) => d.replace(/-/g, "");

describe("expired options leave concentration, tilts and coverage", () => {
  it("concentration universe: expired (dashed and compact) dropped; live, today and stock kept", () => {
    seedStock("ZZA");
    seedOption("LIVEOPT", addDays(todayET(), 5));
    seedOption("TODAYOPT", todayET());
    seedOption("DEADOPT", addDays(todayET(), -1));
    seedOption("DEADCMP", compact(addDays(todayET(), -3)));
    seedOption("LIVECMP", compact(addDays(todayET(), 4)));
    const syms = getConcentrationUniverse(db).map((p) => p.symbol).sort();
    expect(syms).toEqual(["LIVECMP", "LIVEOPT", "TODAYOPT", "ZZA"]);
  });

  it("tilts: an expired option adds no weight", () => {
    seedStock("ZZA"); // 1000, Technology
    seedOption("DEADOPT", addDays(todayET(), -1)); // would be 500
    db.prepare("UPDATE securities SET sector='Energy' WHERE symbol='DEADOPT'").run();
    const res = computeFactorAnalysis(db);
    const labels = res.sectorTilt?.buckets.map((b) => b.label) ?? [];
    expect(labels).toEqual(["Technology"]);
    expect(res.sectorTilt?.buckets[0].weight).toBeCloseTo(1, 6);
  });

  it("tilts: a live option and a stock keep their weights", () => {
    seedStock("ZZA"); // 1000
    seedOption("LIVEOPT", addDays(todayET(), 5)); // 500
    db.prepare("UPDATE securities SET sector='Energy' WHERE symbol='LIVEOPT'").run();
    const w = Object.fromEntries(
      (computeFactorAnalysis(db).sectorTilt?.buckets ?? []).map((b) => [b.label, b.weight])
    );
    expect(w["Technology"]).toBeCloseTo(1000 / 1500, 6);
    expect(w["Energy"]).toBeCloseTo(500 / 1500, 6);
  });

  it("coverage: expired option is not counted; live option and stock are", () => {
    seedStock("ZZA");
    seedOption("LIVEOPT", addDays(todayET(), 5));
    seedOption("DEADOPT", addDays(todayET(), -1));
    seedOption("DEADCMP", compact(addDays(todayET(), -2)));
    const cov = getClassificationCoverage(db);
    expect(cov.total).toBe(2);
    expect(cov.classified).toBe(2);
  });
});
