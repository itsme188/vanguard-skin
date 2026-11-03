/**
 * scripts/repair-fred-revision-second-date-rows.ts (owner ruling 2026-11-01,
 * item 4): removes the later-dated Housing Starts row of a reporting period
 * (the Census revision slot), never the earlier print. Synthetic figures.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  planFredRevisionRepair,
  runFredRevisionRepair,
} from "@/scripts/repair-fred-revision-second-date-rows";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function row(db: Database.Database, date: string, title: string, actual: string | null): number {
  return db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, week_of, actual_value, enriched_at)
       VALUES ('claude_macro', 'housing', ?, ?, ?, ?, ?, ?)`,
    )
    .run(date, title, `fred:27:${date}`, date, actual, actual ? `${date} 15:00:00` : null)
    .lastInsertRowid as number;
}

function ids(db: Database.Database): number[] {
  return (
    db.prepare("SELECT id FROM calendar_events WHERE source_key LIKE 'fred:27:%' ORDER BY id").all() as {
      id: number;
    }[]
  ).map((r) => r.id);
}

describe("repair-fred-revision-second-date-rows", () => {
  it("dry run lists the later twin and writes nothing", () => {
    const db = setup();
    const print = row(db, "2026-10-20", "September Housing Starts", "1.0M");
    const slot = row(db, "2026-10-27", "September Housing Starts", null);
    const lone = row(db, "2026-11-18", "October Housing Starts", null);

    const r = runFredRevisionRepair(db, { apply: false });
    expect(r.applied).toBe(false);
    expect(r.candidates.map((c) => [c.id, c.keptId, c.period])).toEqual([[slot, print, "2026-09"]]);
    expect(ids(db)).toEqual([print, slot, lone]);
  });

  it("apply deletes the later un-enriched twin and keeps the print", () => {
    const db = setup();
    const print = row(db, "2026-10-20", "September Housing Starts", "1.0M");
    row(db, "2026-10-27", "September Housing Starts", null);
    const r = runFredRevisionRepair(db, { apply: true });
    expect(r.applied).toBe(true);
    expect(r.deleted).toBe(1);
    expect(ids(db)).toEqual([print]);
  });

  it("apply deletes a later twin carrying an actual when the print has one too", () => {
    const db = setup();
    const print = row(db, "2026-10-20", "September Housing Starts", "1.0M");
    row(db, "2026-10-27", "September Housing Starts", "1.0M");
    expect(runFredRevisionRepair(db, { apply: true }).deleted).toBe(1);
    expect(ids(db)).toEqual([print]);
  });

  it("apply refuses, writing nothing, when the later row holds the only actual", () => {
    const db = setup();
    const a = row(db, "2026-10-20", "September Housing Starts", null);
    const b = row(db, "2026-10-27", "September Housing Starts", "1.0M");
    // A clean pair elsewhere must not be deleted either: refusal is all-or-nothing.
    const c = row(db, "2026-11-18", "October Housing Starts", "1.1M");
    const d = row(db, "2026-11-25", "October Housing Starts", null);
    const r = runFredRevisionRepair(db, { apply: true });
    expect(r.refused).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.candidates.find((x) => x.id === b)?.refusal).toMatch(/only|has none/);
    expect(ids(db)).toEqual([a, b, c, d]);
  });

  it("apply refuses when another table points at a candidate", () => {
    const db = setup();
    row(db, "2026-10-20", "September Housing Starts", "1.0M");
    const slot = row(db, "2026-10-27", "September Housing Starts", null);
    db.prepare("INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'preview')").run(slot);
    const plan = planFredRevisionRepair(db);
    expect(plan.candidates[0].dependents).toEqual(["earnings_email_skips: 1"]);
    const r = runFredRevisionRepair(db, { apply: true });
    expect(r.refused).toBe(true);
    expect(ids(db)).toHaveLength(2);
  });

  it("December data reported in January does not group with the next December", () => {
    const db = setup();
    row(db, "2026-01-20", "December Housing Starts", "1.0M");
    row(db, "2027-01-20", "December Housing Starts", null);
    expect(planFredRevisionRepair(db).candidates).toEqual([]);
  });

  it("--since skips periods whose kept row is earlier, so a refused early period does not block later ones", () => {
    const db = setup();
    const a = row(db, "2026-05-05", "April Housing Starts", null);
    const b = row(db, "2026-05-21", "April Housing Starts", "1.0M");
    const c = row(db, "2026-10-20", "September Housing Starts", "1.0M");
    row(db, "2026-10-27", "September Housing Starts", "1.0M");
    expect(runFredRevisionRepair(db, { apply: true }).refused).toBe(true);
    const r = runFredRevisionRepair(db, { apply: true, since: "2026-06-01" });
    expect(r.applied).toBe(true);
    expect(r.deleted).toBe(1);
    expect(ids(db)).toEqual([a, b, c]);
  });
});
