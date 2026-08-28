import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  recordWireObservation,
  isBoundedObservation,
  stampEmptyProbe,
  getObservationsForFamily,
  resolveSymbolReleaseTime,
  resolveEarningsReleaseTime,
  upsertSymbolReleaseTime,
  clearUserReleaseTime,
  hasBoundedObservations,
  applyResolvedReleaseTimeToUpcomingEvents,
  isSuspectAmcCallTime,
} from "@/lib/earnings/wire-times";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";

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

// helper: a bounded observation whose first_seen is 07:15 ET on a summer date
// (EDT = UTC-4 → 11:15Z).
function seedBoundedObs(symbol: string, date: string, seenIsoUtc: string) {
  recordWireObservation(db, {
    symbol,
    eventDate: date,
    eventId: null,
    firstSeenAt: seenIsoUtc,
    lastEmptyProbeAt: new Date(Date.parse(seenIsoUtc) - 15 * 60_000).toISOString(),
  });
}

describe("resolveSymbolReleaseTime cascade", () => {
  it("layer 1: user override wins over everything", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:30", source: "web_verified" }); // replaced by user row (PK)
    seedBoundedObs("XMTR", "2026-05-05", "2026-05-05T11:15:00.000Z");
    expect(resolveSymbolReleaseTime(db, "XMTR", "bmo")).toEqual({ time: "07:00", source: "user" });
  });

  it("layer 2: web_verified honored only while ZERO bounded observations exist", () => {
    upsertSymbolReleaseTime(db, { symbol: "WIX", releaseTime: "07:10", source: "web_verified" });
    expect(resolveSymbolReleaseTime(db, "WIX", "bmo")).toEqual({ time: "07:10", source: "web_verified" });
    seedBoundedObs("WIX", "2026-05-05", "2026-05-05T11:15:00.000Z"); // 07:15 ET bounded
    // bounded obs now exist → web row skipped, observed-derived: 07:15 − 10m → 07:05 → floor :05
    expect(resolveSymbolReleaseTime(db, "WIX", "bmo")).toEqual({ time: "07:05", source: "observed" });
  });

  it("layer 3: earliest bounded first_seen minus 10 min, rounded down to :05", () => {
    seedBoundedObs("XMTR", "2026-05-05", "2026-05-05T11:22:00.000Z"); // 07:22 ET
    seedBoundedObs("XMTR", "2026-02-03", "2026-02-03T12:33:00.000Z"); // 07:33 ET (EST=UTC-5)
    // earliest = 07:22 → minus 10 = 07:12 → round down :05 = 07:10
    expect(resolveSymbolReleaseTime(db, "XMTR", "bmo")).toEqual({ time: "07:10", source: "observed" });
  });

  it("unbounded observations alone produce NO derived time", () => {
    recordWireObservation(db, {
      symbol: "DOCN", eventDate: "2026-05-05", eventId: null,
      firstSeenAt: "2026-05-05T11:40:00.000Z", lastEmptyProbeAt: null,
    });
    expect(resolveSymbolReleaseTime(db, "DOCN", "bmo")).toBeNull();
  });

  it("slot-mismatch guard: a morning stored time is ignored for an AMC event", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
    expect(resolveSymbolReleaseTime(db, "XMTR", "amc")).toBeNull();
    expect(resolveSymbolReleaseTime(db, "XMTR", null)).toEqual({ time: "07:00", source: "user" }); // null slot → no guard
  });

  it("04:00 sanity floor on derived times", () => {
    seedBoundedObs("EARL", "2026-05-05", "2026-05-05T08:02:00.000Z"); // 04:02 ET
    expect(resolveSymbolReleaseTime(db, "EARL", "bmo")).toEqual({ time: "04:00", source: "observed" });
  });
});

describe("resolveEarningsReleaseTime full cascade", () => {
  const bmoRow = { event_type: "earnings", event_time: "BMO", raw_json: null, symbol: "XMTR" };

  it("falls through to the 08:00 BMO default with no data", () => {
    expect(resolveEarningsReleaseTime(db, bmoRow)).toBe("08:00");
  });

  it("explicit HH:MM event_time still wins over a user override", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
    expect(
      resolveEarningsReleaseTime(db, { ...bmoRow, event_time: "06:45" }),
    ).toBe("06:45");
  });

  it("pull-down rule: an unbounded sighting earlier than the default pulls it down (layer >= 3 only)", () => {
    recordWireObservation(db, {
      symbol: "XMTR", eventDate: "2026-05-05", eventId: null,
      firstSeenAt: "2026-05-05T11:05:00.000Z", lastEmptyProbeAt: null, // 07:05 ET, unbounded
    });
    // default would be 08:00; unbounded 07:05 pulls down → 07:05 − 10m = 06:55
    expect(resolveEarningsReleaseTime(db, bmoRow)).toBe("06:55");
  });

  it("pull-down does NOT override a user standing override", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:30", source: "user" });
    recordWireObservation(db, {
      symbol: "XMTR", eventDate: "2026-05-05", eventId: null,
      firstSeenAt: "2026-05-05T11:05:00.000Z", lastEmptyProbeAt: null,
    });
    expect(resolveEarningsReleaseTime(db, bmoRow)).toBe("07:30");
  });

  it("legacy SYMBOL_RELEASE_TIMES_ET constant still applies (layer 4)", () => {
    expect(
      resolveEarningsReleaseTime(db, { event_type: "earnings", event_time: "AMC", raw_json: null, symbol: "AAPL" }),
    ).toBe("16:30");
  });

  it("TAS rows never consult the symbol cascade, even with a standing user override", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
    // TAS ("during trading") has no BMO/AMC slot, so slot=null would
    // otherwise bypass the sameSideOfNoon guard and let the user's morning
    // override leak into a print that isn't BMO/AMC at all. resolveReleaseTime
    // itself returns null for a bare TAS earnings row with no raw_json.
    expect(
      resolveEarningsReleaseTime(db, { event_type: "earnings", event_time: "TAS", raw_json: null, symbol: "XMTR" }),
    ).toBeNull();
  });

  // I1 (final review, 2026-08-04): Finnhub and Nasdaq both write
  // event_time: null with the slot living in raw_json.entry.hour — the
  // dominant vendor-row shape. Before this fix, the slot IIFE only read
  // event_time, so slot was ALWAYS null on these rows and the
  // sameSideOfNoon guard was permanently inert: a morning user
  // override/observation history could apply to an AMC vendor row.
  describe("slot guard reads raw_json.entry.hour when event_time is null (vendor rows)", () => {
    it("AMC slot from raw_json.entry.hour blocks a morning user override", () => {
      upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
      const vendorRow = {
        event_type: "earnings",
        event_time: null,
        raw_json: JSON.stringify({ entry: { hour: "amc" } }),
        symbol: "XMTR",
      };
      // Override does NOT apply (07:00 is not same-side-of-noon as amc) —
      // falls through to resolveReleaseTime's raw_json-derived AMC default.
      expect(resolveEarningsReleaseTime(db, vendorRow)).toBe("16:15");
    });

    it("BMO slot from raw_json.entry.hour applies a matching morning user override", () => {
      upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
      const vendorRow = {
        event_type: "earnings",
        event_time: null,
        raw_json: JSON.stringify({ entry: { hour: "bmo" } }),
        symbol: "XMTR",
      };
      expect(resolveEarningsReleaseTime(db, vendorRow)).toBe("07:00");
    });
  });
});

describe("applyResolvedReleaseTimeToUpcomingEvents", () => {
  it("updates future un-enriched family earnings rows, skips past/enriched/actualed rows", () => {
    const future = seedEvent("XMTR", "2027-01-15");
    db.prepare("UPDATE calendar_events SET event_time = 'BMO', release_time = '08:00' WHERE id = ?").run(future);
    const done = seedEvent("XMTR", "2027-01-16");
    db.prepare(
      "UPDATE calendar_events SET event_time = 'BMO', release_time = '08:00', actual_value = 'EPS 1.00' WHERE id = ?",
    ).run(done);
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });

    const n = applyResolvedReleaseTimeToUpcomingEvents(db, "XMTR", { today: "2026-12-01" });

    expect(n).toBe(1);
    expect(
      (db.prepare("SELECT release_time FROM calendar_events WHERE id = ?").get(future) as { release_time: string }).release_time,
    ).toBe("07:00");
    expect(
      (db.prepare("SELECT release_time FROM calendar_events WHERE id = ?").get(done) as { release_time: string }).release_time,
    ).toBe("08:00");
  });
});

/**
 * The shared BMO/AMC slot resolver (lib/earnings/earnings-slot.ts) — one
 * function now behind wire-times' cascade guard, verify-earnings-dates'
 * candidate slot, and the pre-print slot floor.
 */
describe("deriveEarningsSlot", () => {
  it("reads a literal BMO/AMC event_time marker, case-insensitively", () => {
    expect(deriveEarningsSlot({ event_time: "BMO", raw_json: null })).toBe("bmo");
    expect(deriveEarningsSlot({ event_time: "amc", raw_json: null })).toBe("amc");
    expect(deriveEarningsSlot({ event_time: " Amc ", raw_json: null })).toBe("amc");
  });

  it("reads a clock event_time by side of noon", () => {
    expect(deriveEarningsSlot({ event_time: "07:30", raw_json: null })).toBe("bmo");
    expect(deriveEarningsSlot({ event_time: "11:59", raw_json: null })).toBe("bmo");
    expect(deriveEarningsSlot({ event_time: "12:00", raw_json: null })).toBe("amc");
    expect(deriveEarningsSlot({ event_time: "16:05", raw_json: null })).toBe("amc");
  });

  it("falls back to raw_json.entry.hour on the dominant vendor shape (event_time NULL)", () => {
    expect(
      deriveEarningsSlot({ event_time: null, raw_json: JSON.stringify({ entry: { hour: "amc" } }) }),
    ).toBe("amc");
    expect(
      deriveEarningsSlot({ event_time: null, raw_json: JSON.stringify({ entry: { hour: "BMO" } }) }),
    ).toBe("bmo");
  });

  it("returns null for dmh / unknown / missing / malformed raw_json", () => {
    expect(
      deriveEarningsSlot({ event_time: null, raw_json: JSON.stringify({ entry: { hour: "dmh" } }) }),
    ).toBeNull();
    expect(
      deriveEarningsSlot({ event_time: null, raw_json: JSON.stringify({ entry: { hour: "unknown" } }) }),
    ).toBeNull();
    expect(deriveEarningsSlot({ event_time: null, raw_json: "{not json" })).toBeNull();
    expect(deriveEarningsSlot({ event_time: null, raw_json: null })).toBeNull();
  });

  it("treats a literal TAS as 'no slot' and never infers one from raw_json", () => {
    expect(
      deriveEarningsSlot({ event_time: "TAS", raw_json: JSON.stringify({ entry: { hour: "amc" } }) }),
    ).toBeNull();
  });

  it("ignores release_time unless the caller opts into the fallback", () => {
    const row = { event_time: null, raw_json: null, release_time: "16:15" };
    expect(deriveEarningsSlot(row)).toBeNull();
    expect(deriveEarningsSlot(row, { allowReleaseTimeFallback: true })).toBe("amc");
    expect(
      deriveEarningsSlot({ ...row, release_time: "08:00" }, { allowReleaseTimeFallback: true }),
    ).toBe("bmo");
  });
});

/**
 * Suspect AMC call time (owner report, live 2026-08-26/27): a web-sourced
 * "17:00" for an after-close name is the CALL, not the print — CRWD/RBRK both
 * printed ~16:05 while carrying a 17:00 web_verified time. Such a row is
 * ignored by the cascade (layer 2 skipped) so observed/default wins. A USER
 * row is never suspect: an explicit human decision stands.
 */
describe("isSuspectAmcCallTime", () => {
  it("flags 17:00 and later on an AMC slot only", () => {
    expect(isSuspectAmcCallTime("17:00", "amc")).toBe(true);
    expect(isSuspectAmcCallTime("17:30", "amc")).toBe(true);
    expect(isSuspectAmcCallTime("16:59", "amc")).toBe(false);
    expect(isSuspectAmcCallTime("16:05", "amc")).toBe(false);
  });

  it("never flags a BMO or unknown slot, nor a missing/malformed time", () => {
    expect(isSuspectAmcCallTime("17:00", "bmo")).toBe(false);
    expect(isSuspectAmcCallTime("17:00", null)).toBe(false);
    expect(isSuspectAmcCallTime(null, "amc")).toBe(false);
    expect(isSuspectAmcCallTime("not-a-time", "amc")).toBe(false);
  });
});

describe("resolveSymbolReleaseTime — suspect AMC call-time rows", () => {
  it("ignores a web_verified 17:00 AMC row and falls through to the observed layer", () => {
    upsertSymbolReleaseTime(db, { symbol: "CRWD", releaseTime: "17:00", source: "web_verified" });
    seedBoundedObs("CRWD", "2026-05-05", "2026-05-05T20:20:00.000Z"); // 16:20 ET
    // 16:20 − 10m → 16:10 (already on :05)
    expect(resolveSymbolReleaseTime(db, "CRWD", "amc")).toEqual({
      time: "16:10",
      source: "observed",
    });
  });

  it("ignores a web_verified 17:00 AMC row with no observations at all (→ null, caller defaults)", () => {
    upsertSymbolReleaseTime(db, { symbol: "RBRK", releaseTime: "17:00", source: "web_verified" });
    expect(resolveSymbolReleaseTime(db, "RBRK", "amc")).toBeNull();
  });

  it("honours a web_verified 16:05 AMC row (a plausible print time)", () => {
    upsertSymbolReleaseTime(db, { symbol: "RBRK", releaseTime: "16:05", source: "web_verified" });
    expect(resolveSymbolReleaseTime(db, "RBRK", "amc")).toEqual({
      time: "16:05",
      source: "web_verified",
    });
  });

  it("honours a USER 17:00 AMC row — an explicit human decision is never suspect", () => {
    upsertSymbolReleaseTime(db, { symbol: "RBRK", releaseTime: "17:00", source: "user" });
    expect(resolveSymbolReleaseTime(db, "RBRK", "amc")).toEqual({
      time: "17:00",
      source: "user",
    });
  });

  it("full cascade: a suspect web row leaves an AMC vendor row on the 16:15 default", () => {
    upsertSymbolReleaseTime(db, { symbol: "RBRK", releaseTime: "17:00", source: "web_verified" });
    expect(
      resolveEarningsReleaseTime(db, {
        event_type: "earnings",
        event_time: null,
        raw_json: JSON.stringify({ entry: { hour: "amc" } }),
        symbol: "RBRK",
      }),
    ).toBe("16:15");
  });
});
