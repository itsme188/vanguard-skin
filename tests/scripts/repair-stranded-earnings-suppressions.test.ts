/**
 * scripts/repair-stranded-earnings-suppressions.ts
 * (qa:today-earningshub-fix-date--suppression-row-delete-loses-coverage-permanently).
 * Symbols are synthetic except the GOOG / GOOGL pair from the repo's own
 * share-class table.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  planSuppressionRepair,
  runSuppressionRepair,
  formatPlan,
  parseArgs,
} from "@/scripts/repair-stranded-earnings-suppressions";

const TODAY = "2026-09-10";
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function suppress(symbol: string, date: string): number {
  return db
    .prepare(
      "INSERT INTO calendar_event_suppressions (symbol, event_date, event_type, reason) VALUES (?, ?, 'earnings', ?)",
    )
    .run(symbol, date, `user-deleted finnhub row #1`).lastInsertRowid as number;
}

function event(symbol: string, date: string, superseded = 0): void {
  db.prepare(
    `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of, raw_json, superseded)
     VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(date, `${symbol} earnings`, symbol, `manual:${symbol}:${date}:earnings`, date, superseded);
}

function ids(): number[] {
  return (db.prepare("SELECT id FROM calendar_event_suppressions ORDER BY id").all() as { id: number }[]).map(
    (r) => r.id,
  );
}

describe("planSuppressionRepair", () => {
  it("a suppression is stranded only when the company has no earnings row near the date", () => {
    const stranded = suppress("ZZA", "2026-09-15");
    suppress("ZZB", "2026-09-15");
    event("ZZB", "2026-09-16"); // the corrected row still exists
    suppress("ZZC", "2026-09-15");
    event("ZZC", "2026-09-20", 1); // a superseded row still counts as coverage
    suppress("GOOG", "2026-09-15");
    event("GOOGL", "2026-09-17"); // share-class sibling
    const old = suppress("ZZD", "2026-06-01");
    event("ZZD", "2026-09-15"); // next quarter's print is not the same print

    const plan = planSuppressionRepair(db, { today: TODAY });
    expect(plan.examined).toBe(5);
    expect(plan.covered).toBe(3);
    expect(plan.stranded.map((s) => [s.id, s.symbol, s.upcoming, s.selected])).toEqual([
      [stranded, "ZZA", true, false],
      [old, "ZZD", false, false],
    ]);
  });

  it("ignores non-earnings suppressions", () => {
    db.prepare(
      "INSERT INTO calendar_event_suppressions (symbol, event_date, event_type) VALUES ('ZZA', '2026-09-15', 'dividend')",
    ).run();
    expect(planSuppressionRepair(db, { today: TODAY }).examined).toBe(0);
  });
});

describe("runSuppressionRepair", () => {
  it("the dry run writes nothing", () => {
    suppress("ZZA", "2026-09-15");
    const before = ids();
    const { applied, lifted } = runSuppressionRepair(db, { today: TODAY, symbols: ["ZZA"] });
    expect(applied).toBe(false);
    expect(lifted).toBe(0);
    expect(ids()).toEqual(before);
  });

  it("apply refuses to run without named symbols", () => {
    suppress("ZZA", "2026-09-15");
    expect(() => runSuppressionRepair(db, { apply: true, today: TODAY })).toThrow(/--symbols/);
    expect(ids()).toHaveLength(1);
  });

  it("apply lifts only the named symbols' stranded suppressions, and a second run is a no-op", () => {
    suppress("ZZA", "2026-09-15");
    const keptUnnamed = suppress("ZZE", "2026-09-15");
    const keptCovered = suppress("ZZB", "2026-09-15");
    event("ZZB", "2026-09-16");

    const first = runSuppressionRepair(db, { apply: true, today: TODAY, symbols: ["zza", "ZZB", "ZZQ"] });
    expect(first.lifted).toBe(1);
    expect(first.plan.unmatchedSymbols).toEqual(["ZZB", "ZZQ"]);
    expect(ids()).toEqual([keptUnnamed, keptCovered]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get()).toEqual({ n: 1 });

    const second = runSuppressionRepair(db, { apply: true, today: TODAY, symbols: ["ZZA"] });
    expect(second.lifted).toBe(0);
    expect(ids()).toEqual([keptUnnamed, keptCovered]);
  });
});

describe("output and arguments", () => {
  it("formatPlan lists each stranded row with what would happen to it", () => {
    suppress("ZZA", "2026-09-15");
    suppress("ZZE", "2026-06-01");
    const lines = formatPlan(planSuppressionRepair(db, { today: TODAY, symbols: ["ZZA"] })).join("\n");
    expect(lines).toMatch(/\[ZZA\] 2026-09-15 \(upcoming\): would lift/);
    expect(lines).toMatch(/\[ZZE\] 2026-06-01 \(past;.*\): kept \(not named\)/);
  });

  it("parseArgs reads --apply and --symbols, and rejects anything else", () => {
    expect(parseArgs([])).toEqual({ apply: false, symbols: [] });
    expect(parseArgs(["--apply", "--symbols", "aaa, bbb"])).toEqual({ apply: true, symbols: ["AAA", "BBB"] });
    expect(() => parseArgs(["--symbols"])).toThrow(/comma-separated/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
  });
});
