import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { CalendarEventInput } from "@/lib/mutations/calendar";
import { upsertCalendarEvents } from "@/lib/mutations/calendar";

/**
 * [qa:dashboard-today-refresh-from-finnhub-macro-step-week-ahead-nov-9-15-and-nov-2-8-refresh-deletes-the-november-u]
 *
 * A non-FRED release the publisher moved from 11-13 (week of 11-09) to 11-06
 * (week of 11-02). The original week's sync now writes the moved row into the
 * other week. That row must:
 *   - survive the destination week's own macro cleanup (its schedule entry is
 *     not in that week's fetch, so its key would not be on the keep list);
 *   - be reported, on the original week, as "rescheduled", not as a release
 *     the source stopped publishing;
 *   - not get the old date re-created beside it by the hardcoded fallback.
 * All rows are synthetic public-calendar data.
 */

vi.mock("@/lib/tws/wsh", () => ({ fetchWshEvents: vi.fn() }));
vi.mock("@/lib/tws/client", () => ({ getIbApi: vi.fn(() => null), disconnectTws: vi.fn() }));
vi.mock("@/lib/calendar/macro-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/macro-events")>();
  return { ...actual, fetchMacroEvents: vi.fn() };
});

import { syncCalendarForWeek, rescheduledInKeepKeys } from "@/lib/calendar/sync";
import { fetchMacroEvents } from "@/lib/calendar/macro-events";

const ORIG_WEEK = "2026-11-09";
const DEST_WEEK = "2026-11-02";
const PREFIX = "nonfred:U._of_Michigan_Consumer_Sentiment_(Preliminary):";
const OPTS = { includeWsh: false, includeFinnhub: false, includeNasdaq: false } as const;

function umich(date: string, weekOf: string, raw: Record<string, unknown> | null): CalendarEventInput {
  return {
    source: "claude_macro",
    event_type: "other_macro",
    event_date: date,
    event_time: "10:00",
    title: "U. of Michigan Consumer Sentiment (Preliminary)",
    description: null,
    expected_impact: "medium",
    consensus_estimate: null,
    previous_value: null,
    raw_json: raw ? JSON.stringify(raw) : null,
    source_key: `${PREFIX}${date}`,
    week_of: weekOf,
  };
}

const MOVED = umich("2026-11-06", DEST_WEEK, {
  verify_status: "rescheduled",
  original_date: "2026-11-13",
  source_url: "https://example.test/schedule",
  note: null,
});

function fred(date: string, weekOf: string, id: number): CalendarEventInput {
  return {
    source: "claude_macro",
    event_type: "other_macro",
    event_date: date,
    event_time: "08:30",
    title: `Synthetic Release ${id}`,
    description: null,
    expected_impact: "medium",
    consensus_estimate: null,
    previous_value: null,
    source_key: `fred:${id}:${date}`,
    week_of: weekOf,
  };
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
});

const keys = () =>
  (db.prepare("SELECT source_key, week_of FROM calendar_events ORDER BY source_key").all() as {
    source_key: string;
    week_of: string;
  }[]);

describe("rescheduledInKeepKeys", () => {
  it("lists only claude_macro rows of the week carried in from another week's schedule", () => {
    upsertCalendarEvents(db, [
      MOVED,
      // Rescheduled inside its own week: its own week's fetch lists it.
      umich("2026-11-05", DEST_WEEK, { verify_status: "rescheduled", original_date: "2026-11-04" }),
      // Verified unchanged.
      umich("2026-11-03", DEST_WEEK, { verify_status: "unchanged", original_date: "2026-11-03" }),
      // No raw_json at all.
      umich("2026-11-07", DEST_WEEK, null),
      // Carried in, but filed under another week.
      umich("2026-11-20", "2026-11-16", { verify_status: "rescheduled", original_date: "2026-11-27" }),
    ]);
    db.prepare("UPDATE calendar_events SET raw_json = 'not json' WHERE source_key = ?").run(
      `${PREFIX}2026-11-07`,
    );
    expect(rescheduledInKeepKeys(db, DEST_WEEK, "2026-11-02", "2026-11-08")).toEqual([
      `${PREFIX}2026-11-06`,
    ]);
  });
});

describe("syncCalendarForWeek — a release rescheduled out of its week", () => {
  it("the original week's refresh writes the moved row and names the old row as rescheduled", async () => {
    // The old-date row from an earlier sync.
    upsertCalendarEvents(db, [umich("2026-11-13", ORIG_WEEK, null)]);
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([fred("2026-11-12", ORIG_WEEK, 901), MOVED]);

    const res = await syncCalendarForWeek(db, ORIG_WEEK, OPTS);

    expect(res.removed).toEqual([
      {
        title: "U. of Michigan Consumer Sentiment (Preliminary)",
        eventDate: "2026-11-13",
        source: "claude_macro",
        reason: "rescheduled to 2026-11-06 by the publisher",
      },
    ]);
    expect(keys()).toEqual([
      { source_key: "fred:901:2026-11-12", week_of: ORIG_WEEK },
      { source_key: `${PREFIX}2026-11-06`, week_of: DEST_WEEK },
    ]);
  });

  it("an ordinary orphan keeps the plain reason", async () => {
    upsertCalendarEvents(db, [fred("2026-11-10", ORIG_WEEK, 902)]);
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([MOVED]);
    const res = await syncCalendarForWeek(db, ORIG_WEEK, OPTS);
    expect(res.removed.map((r) => r.reason)).toEqual([
      "no longer on the release schedule the source publishes",
    ]);
  });

  it("the destination week's refresh keeps the carried-in row", async () => {
    upsertCalendarEvents(db, [MOVED, fred("2026-11-03", DEST_WEEK, 903)]);
    // The destination week's own fetch never lists the moved release.
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([fred("2026-11-04", DEST_WEEK, 904)]);

    const res = await syncCalendarForWeek(db, DEST_WEEK, OPTS);

    expect(keys().map((k) => k.source_key)).toEqual([
      "fred:904:2026-11-04",
      `${PREFIX}2026-11-06`,
    ]);
    expect(res.removed.map((r) => r.eventDate)).toEqual(["2026-11-03"]);
  });

  it("the hardcoded fallback does not re-create the old date beside the moved row", async () => {
    upsertCalendarEvents(db, [MOVED]);
    vi.mocked(fetchMacroEvents).mockRejectedValueOnce(new Error("FRED 503"));

    await syncCalendarForWeek(db, ORIG_WEEK, OPTS);

    const umichKeys = keys()
      .map((k) => k.source_key)
      .filter((k) => k.startsWith(PREFIX));
    expect(umichKeys).toEqual([`${PREFIX}2026-11-06`]);
  });
});
