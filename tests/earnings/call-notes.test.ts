import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getCallNoteForEvent,
  getCallNotePresenceForEvents,
  getLatestCallNoteForFamily,
} from "@/lib/queries/earnings-call-notes";
import { upsertCallNote } from "@/lib/mutations/earnings-call-notes";

let db: Database.Database;

function seedEvent(symbol: string, eventDate: string): number {
  return db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
       VALUES ('finnhub', 'earnings', ?, ?, ?, ?)`
    )
    .run(eventDate, `${symbol} earnings`, symbol, `finnhub:${symbol}:${eventDate}`)
    .lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("earnings call notes", () => {
  it("upsert creates then updates in place (one note per event)", () => {
    const eventId = seedEvent("NVDA", "2026-07-08");
    const created = upsertCallNote(db, {
      eventId,
      symbol: "NVDA",
      guidance: "raised",
      tone: "confident",
    });
    expect(created.guidance).toBe("raised");

    const updated = upsertCallNote(db, {
      eventId,
      symbol: "NVDA",
      guidance: "lowered",
      surprises: "China guide pulled",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.guidance).toBe("lowered");
    expect(updated.surprises).toBe("China guide pulled");
    // tone not passed on the second save → cleared (full-replace semantics)
    expect(updated.tone).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS c FROM earnings_call_notes").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("rejects an invalid guidance value", () => {
    const eventId = seedEvent("NVDA", "2026-07-08");
    expect(() =>
      upsertCallNote(db, { eventId, symbol: "NVDA", guidance: "mooned" as never })
    ).toThrow(/guidance/i);
  });

  it("getCallNoteForEvent returns null when absent", () => {
    const eventId = seedEvent("NVDA", "2026-07-08");
    expect(getCallNoteForEvent(db, eventId)).toBeNull();
  });

  it("presence set covers only events with notes", () => {
    const a = seedEvent("NVDA", "2026-07-08");
    const b = seedEvent("JPM", "2026-07-08");
    upsertCallNote(db, { eventId: a, symbol: "NVDA" });
    const set = getCallNotePresenceForEvents(db, [a, b]);
    expect(set.has(a)).toBe(true);
    expect(set.has(b)).toBe(false);
  });

  it("family latest-lookup walks issuer siblings and respects beforeDate", () => {
    const q1 = seedEvent("GOOGL", "2026-04-20");
    const q2 = seedEvent("GOOGL", "2026-07-20");
    upsertCallNote(db, { eventId: q1, symbol: "GOOGL", guidance: "inline", tone: "steady" });
    upsertCallNote(db, { eventId: q2, symbol: "GOOGL", guidance: "raised" });

    // Query by the sibling class — GOOG should find GOOGL notes.
    const latest = getLatestCallNoteForFamily(db, "GOOG");
    expect(latest?.guidance).toBe("raised");

    // beforeDate excludes the same-quarter event → prior quarter's note.
    const prior = getLatestCallNoteForFamily(db, "GOOG", "2026-07-20");
    expect(prior?.guidance).toBe("inline");
  });
});
