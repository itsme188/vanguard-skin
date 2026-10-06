import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  deleteUnenrichedEventsForWeek,
  upsertCalendarEvents,
  type CalendarEventInput,
} from "@/lib/mutations/calendar";

const WEEK = "2026-10-05";

function macroInput(
  sourceKey: string,
  overrides: Partial<CalendarEventInput> = {},
): CalendarEventInput {
  return {
    source: "claude_macro",
    event_type: "other_macro",
    event_date: "2026-10-06",
    event_time: "08:30",
    title: `Synthetic release ${sourceKey}`,
    source_key: sourceKey,
    week_of: WEEK,
    ...overrides,
  };
}

function row(db: Database.Database, sourceKey: string) {
  return db
    .prepare(
      `SELECT id, consensus_estimate, previous_value FROM calendar_events WHERE source_key = ?`,
    )
    .get(sourceKey) as
    | { id: number; consensus_estimate: string | null; previous_value: string | null }
    | undefined;
}

describe("macro re-sync keeps sync-owned consensus estimates", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("a re-listed row survives the orphan delete and keeps its estimate when the fresh input omits it", () => {
    upsertCalendarEvents(db, [
      macroInput("fred:1:2026-10-06", { consensus_estimate: "-$1.0B", previous_value: "-$2.0B" }),
    ]);
    const before = row(db, "fred:1:2026-10-06")!;

    const fresh = [macroInput("fred:1:2026-10-06")];
    deleteUnenrichedEventsForWeek(db, WEEK, "claude_macro", fresh.map((e) => e.source_key));
    upsertCalendarEvents(db, fresh);

    const after = row(db, "fred:1:2026-10-06")!;
    expect(after.id).toBe(before.id);
    expect(after.consensus_estimate).toBe("-$1.0B");
    expect(after.previous_value).toBe("-$2.0B");
  });

  it("an unenriched row absent from the keep list is still deleted as a true orphan", () => {
    upsertCalendarEvents(db, [
      macroInput("fred:1:2026-10-06"),
      macroInput("fred:2:2026-10-07", { consensus_estimate: "100K" }),
    ]);

    const deleted = deleteUnenrichedEventsForWeek(db, WEEK, "claude_macro", ["fred:1:2026-10-06"]);

    expect(deleted).toBe(1);
    expect(row(db, "fred:1:2026-10-06")).toBeDefined();
    expect(row(db, "fred:2:2026-10-07")).toBeUndefined();
  });

  it("without a keep list the delete behaves exactly as before", () => {
    upsertCalendarEvents(db, [macroInput("fred:1:2026-10-06")]);
    expect(deleteUnenrichedEventsForWeek(db, WEEK, "claude_macro")).toBe(1);
  });

  it("an incoming non-null estimate still overwrites the stored one", () => {
    upsertCalendarEvents(db, [
      macroInput("fred:1:2026-10-06", { consensus_estimate: "100K", previous_value: "90K" }),
    ]);
    upsertCalendarEvents(db, [
      macroInput("fred:1:2026-10-06", { consensus_estimate: "120K", previous_value: "95K" }),
    ]);

    const after = row(db, "fred:1:2026-10-06")!;
    expect(after.consensus_estimate).toBe("120K");
    expect(after.previous_value).toBe("95K");
  });
});
