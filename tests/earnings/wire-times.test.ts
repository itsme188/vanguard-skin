import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  recordWireObservation,
  isBoundedObservation,
  stampEmptyProbe,
  getObservationsForFamily,
} from "@/lib/earnings/wire-times";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedEvent(symbol: string, date: string): number {
  return db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, symbol, title, source_key, week_of)
       VALUES ('finnhub','earnings',?,?,?,?,?)`,
    )
    .run(date, symbol, `${symbol} earnings`, `finnhub:${symbol}:${date}`, date)
    .lastInsertRowid as number;
}

describe("recordWireObservation", () => {
  it("inserts a first sighting and is idempotent per (symbol, date, source)", () => {
    const id = seedEvent("XMTR", "2026-08-04");
    const first = recordWireObservation(db, {
      symbol: "xmtr",
      eventDate: "2026-08-04",
      eventId: id,
      firstSeenAt: "2026-08-04T11:15:00.000Z",
      lastEmptyProbeAt: "2026-08-04T11:00:00.000Z",
    });
    const second = recordWireObservation(db, {
      symbol: "XMTR",
      eventDate: "2026-08-04",
      eventId: id,
      firstSeenAt: "2026-08-04T12:00:00.000Z",
      lastEmptyProbeAt: null,
    });
    expect(first).toBe(true);
    expect(second).toBe(false); // first sighting wins
    const rows = getObservationsForFamily(db, "XMTR", "2026-01-01");
    expect(rows).toHaveLength(1);
    expect(rows[0].first_seen_at).toBe("2026-08-04T11:15:00.000Z");
    expect(rows[0].symbol).toBe("XMTR"); // stored UPPER
  });

  it("survives a DB without the observations table (minimal test DBs)", () => {
    const bare = new Database(":memory:");
    expect(
      recordWireObservation(bare, {
        symbol: "XMTR",
        eventDate: "2026-08-04",
        eventId: null,
        firstSeenAt: "2026-08-04T11:15:00.000Z",
        lastEmptyProbeAt: null,
      }),
    ).toBe(false);
    expect(getObservationsForFamily(bare, "XMTR", "2026-01-01")).toEqual([]);
  });
});

describe("isBoundedObservation", () => {
  it("bounded when the empty probe is within 30 min before first-seen", () => {
    expect(
      isBoundedObservation("2026-08-04T11:15:00.000Z", "2026-08-04T11:00:00.000Z"),
    ).toBe(true);
  });
  it("unbounded when there was no empty probe", () => {
    expect(isBoundedObservation("2026-08-04T11:15:00.000Z", null)).toBe(false);
  });
  it("unbounded when the empty probe is older than 30 min", () => {
    expect(
      isBoundedObservation("2026-08-04T11:15:00.000Z", "2026-08-04T10:30:00.000Z"),
    ).toBe(false);
  });
});

describe("stampEmptyProbe", () => {
  it("stamps wire_probe_empty_at on the event row", () => {
    const id = seedEvent("WIX", "2026-08-04");
    stampEmptyProbe(db, id, new Date("2026-08-04T11:00:00.000Z"));
    const row = db
      .prepare("SELECT wire_probe_empty_at FROM calendar_events WHERE id = ?")
      .get(id) as { wire_probe_empty_at: string | null };
    expect(row.wire_probe_empty_at).toBe("2026-08-04T11:00:00.000Z");
  });
});

describe("getObservationsForFamily", () => {
  it("walks issuer siblings (GOOG observation found via GOOGL)", () => {
    recordWireObservation(db, {
      symbol: "GOOG",
      eventDate: "2026-07-29",
      eventId: null,
      firstSeenAt: "2026-07-29T20:05:00.000Z",
      lastEmptyProbeAt: "2026-07-29T19:50:00.000Z",
    });
    expect(getObservationsForFamily(db, "GOOGL", "2026-01-01")).toHaveLength(1);
  });
});
