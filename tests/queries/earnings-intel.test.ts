import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertEarningsIntel, replaceReportHistory } from "@/lib/mutations/earnings-intel";
import {
  getIntelForEvents,
  getReportHistoryForFamily,
  isHistoryStale,
  decorateCockpitIntel,
  cockpitRowsToIntelEvents,
} from "@/lib/queries/earnings-intel";
import type { CockpitPayload, CockpitRow } from "@/lib/queries/earnings-cockpit";
import type { EventStages } from "@/lib/earnings/cockpit-stages";

let db: Database.Database;

function seedEvent(): number {
  return db.prepare(
    `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title)
     VALUES ('finnhub', 'finnhub:TER:2026-07-14', 'earnings', '2026-07-14', '2026-07-13', 'TER earnings')`
  ).run().lastInsertRowid as number;
}

const HIST = (over: Partial<Parameters<typeof replaceReportHistory>[2][number]> = {}) => ({
  reportedDate: "2026-04-22", fiscalDateEnding: "2026-03-31",
  epsActual: 1.42, epsEstimate: 1.35, surprisePct: 5.2,
  reportTime: "post-market" as const, postPrintMovePct: 4.1, ...over,
});

beforeEach(() => { db = new Database(":memory:"); runMigrations(db); });

describe("earnings_intel cache", () => {
  it("upserts and reads intel per event", () => {
    const id = seedEvent();
    upsertEarningsIntel(db, { eventId: id, impliedMovePct: 4.8, impliedMethod: "straddle",
      expiryUsed: "2026-07-18", straddleMid: 6.2, spot: 129.1, computedAt: "2026-07-14 14:05:00" });
    upsertEarningsIntel(db, { eventId: id, impliedMovePct: 5.1, impliedMethod: "straddle",
      expiryUsed: "2026-07-18", straddleMid: 6.6, spot: 129.4, computedAt: "2026-07-14 14:35:00" });
    const map = getIntelForEvents(db, [id]);
    expect(map.get(id)?.impliedMovePct).toBe(5.1); // second upsert wins
  });

  it("cascades away when the calendar event is deleted", () => {
    const id = seedEvent();
    upsertEarningsIntel(db, { eventId: id, impliedMovePct: 4.8, impliedMethod: "straddle",
      expiryUsed: "2026-07-18", straddleMid: 6.2, spot: 129.1, computedAt: "2026-07-14 14:05:00" });
    db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
    expect(getIntelForEvents(db, [id]).size).toBe(0);
  });
});

describe("earnings_report_history", () => {
  it("replace upserts, prunes to newest 12, reads newest-first", () => {
    const rows = Array.from({ length: 14 }, (_, i) => {
      const y = 2023 + Math.floor(i / 12);
      return HIST({ reportedDate: `${y}-${String((i % 12) + 1).padStart(2, "0")}-15`, fiscalDateEnding: null });
    });
    replaceReportHistory(db, "TER", rows);
    const kept = db.prepare("SELECT COUNT(*) AS n FROM earnings_report_history WHERE symbol='TER'").get() as { n: number };
    expect(kept.n).toBe(12);
    const read = getReportHistoryForFamily(db, "TER", 8);
    expect(read).toHaveLength(8);
    expect(read[0].reportedDate > read[1].reportedDate).toBe(true); // newest first
  });

  it("getReportHistoryForFamily walks issuer siblings (GOOG ↔ GOOGL)", () => {
    replaceReportHistory(db, "GOOGL", [HIST()]);
    expect(getReportHistoryForFamily(db, "GOOG")).toHaveLength(1);
  });

  it("isHistoryStale: no rows → stale; fresh rows → not stale; old fetched_at → stale", () => {
    expect(isHistoryStale(db, "TER")).toBe(true);
    replaceReportHistory(db, "TER", [HIST()]);
    expect(isHistoryStale(db, "TER")).toBe(false);
    db.prepare("UPDATE earnings_report_history SET fetched_at = '2026-01-01 00:00:00' WHERE symbol='TER'").run();
    expect(isHistoryStale(db, "TER")).toBe(true);
  });
});

describe("migration 069 enum CHECK constraints", () => {
  it("rejects an invalid implied_method; NULL and valid enums pass", () => {
    const id = seedEvent();
    expect(() =>
      db.prepare(
        "INSERT INTO earnings_intel (event_id, implied_method, computed_at) VALUES (?, 'vibes', '2026-07-21 14:00:00')"
      ).run(id)
    ).toThrow(/CHECK/);
    // NULL method (no-data row) and both valid enums are unaffected.
    upsertEarningsIntel(db, { eventId: id, impliedMovePct: null, impliedMethod: null,
      expiryUsed: null, straddleMid: null, spot: null, computedAt: "2026-07-21 14:00:00" });
    upsertEarningsIntel(db, { eventId: id, impliedMovePct: 4.8, impliedMethod: "iv_approx",
      expiryUsed: null, straddleMid: null, spot: null, computedAt: "2026-07-21 14:05:00" });
    expect(getIntelForEvents(db, [id]).get(id)?.impliedMethod).toBe("iv_approx");
  });

  it("rejects an invalid report_time; NULL and pre/post-market pass", () => {
    expect(() =>
      db.prepare(
        "INSERT INTO earnings_report_history (symbol, reported_date, report_time) VALUES ('TER', '2026-04-22', 'midday')"
      ).run()
    ).toThrow(/CHECK/);
    replaceReportHistory(db, "TER", [HIST(), HIST({ reportedDate: "2026-01-20", reportTime: null })]);
    expect(getReportHistoryForFamily(db, "TER")).toHaveLength(2);
  });
});

describe("decorateCockpitIntel", () => {
  it("attaches cached intel + history summary per row; null when absent", () => {
    const id = seedEvent();
    upsertEarningsIntel(db, {
      eventId: id, impliedMovePct: 4.8, impliedMethod: "straddle",
      expiryUsed: "2026-07-18", straddleMid: 6.2, spot: 129.1, computedAt: "2026-07-14 14:05:00",
    });
    replaceReportHistory(db, "TER", [HIST()]);

    const amcRow = { eventId: id, symbol: "TER" } as unknown as CockpitRow;
    const carryoverRow = { eventId: 999999, symbol: "ZZZ" } as unknown as CockpitRow;
    const payload = {
      lanes: { bmo: [], unknown: [], amc: [amcRow] },
      carryover: [carryoverRow],
    } as unknown as CockpitPayload;

    decorateCockpitIntel(db, payload);

    expect(payload.lanes.amc[0].intel).toMatchObject({
      impliedMovePct: 4.8, impliedMethod: "straddle", histBeatCount: 1,
    });
    expect(payload.carryover[0].intel).toBeNull();
  });

  it("family-dedupes history reads: GOOG + GOOGL rows hit earnings_report_history once", () => {
    replaceReportHistory(db, "GOOGL", [HIST()]);
    const rowA = makeCockpitRow(21, "GOOG", "upcoming");
    const rowB = makeCockpitRow(22, "GOOGL", "upcoming");
    const payload = {
      lanes: { bmo: [], unknown: [], amc: [rowA, rowB] },
      carryover: [],
    } as unknown as CockpitPayload;

    let histPrepares = 0;
    const origPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes("FROM earnings_report_history")) histPrepares++;
      return origPrepare(sql);
    };
    decorateCockpitIntel(db, payload);

    expect(histPrepares).toBe(1);
    // Both rows still get the shared family history.
    expect(rowA.intel?.histQuarterCount).toBe(1);
    expect(rowB.intel?.histQuarterCount).toBe(1);
  });
});

function stagesWithReleased(state: EventStages["released"]["state"]): EventStages {
  return {
    preview: "pending",
    released: { state, releaseInstant: null },
    actual: "pending",
    reaction: { state: "pending", source: null, readyAt: null },
    recap: "waiting",
  };
}

function makeCockpitRow(
  eventId: number,
  symbol: string,
  releasedState: EventStages["released"]["state"],
  carryover = false,
): CockpitRow {
  return {
    eventId,
    symbol,
    securityId: null,
    title: `${symbol} earnings`,
    eventDate: carryover ? "2026-07-13" : "2026-07-14",
    eventTime: "AMC",
    releaseTime: "16:20",
    symbolStatus: "held",
    consensus: "—",
    actual: null,
    stages: stagesWithReleased(releasedState),
    netExposure: 0,
    isTopExposure: false,
    hasCallNote: false,
    carryover,
    intel: null,
  };
}

describe("cockpitRowsToIntelEvents", () => {
  it("excludes released rows (including carryover) from the ensure list", () => {
    const upcoming = makeCockpitRow(1, "TER", "upcoming");
    const released = makeCockpitRow(2, "NVDA", "released");
    const unknown = makeCockpitRow(3, "ABC", "unknown");
    const carryover = makeCockpitRow(4, "JPM", "released", true);

    const payload: CockpitPayload = {
      generatedAt: "2026-07-14T14:00:00.000Z",
      nextRelease: null,
      lanes: { bmo: [], amc: [upcoming, released, unknown], unknown: [] },
      carryover: [carryover],
      skippedRows: 0,
      rowsByEvent: {},
    };

    const events = cockpitRowsToIntelEvents(payload);
    expect(events.map((e) => e.id).sort((a, b) => a - b)).toEqual([1, 3]);
    expect(events.some((e) => e.id === 2)).toBe(false);
    expect(events.some((e) => e.id === 4)).toBe(false);
  });

  it("keeps mapping shape (id/symbol/event_date/event_time) for surviving rows", () => {
    const upcoming = makeCockpitRow(10, "TER", "upcoming");
    const payload: CockpitPayload = {
      generatedAt: "2026-07-14T14:00:00.000Z",
      nextRelease: null,
      lanes: { bmo: [], amc: [upcoming], unknown: [] },
      carryover: [],
      skippedRows: 0,
      rowsByEvent: {},
    };
    expect(cockpitRowsToIntelEvents(payload)).toEqual([
      { id: 10, symbol: "TER", event_date: "2026-07-14", event_time: "AMC" },
    ]);
  });

  it("excludes a row whose released state is upcoming but whose actual stage is captured (IMAX 7/23 wrong-slot case)", () => {
    const wrongSlot = makeCockpitRow(5, "IMAX", "upcoming");
    wrongSlot.stages.actual = "captured";
    const normalUpcoming = makeCockpitRow(6, "TER", "upcoming");

    const payload: CockpitPayload = {
      generatedAt: "2026-07-23T14:00:00.000Z",
      nextRelease: null,
      lanes: { bmo: [], amc: [wrongSlot, normalUpcoming], unknown: [] },
      carryover: [],
      skippedRows: 0,
      rowsByEvent: {},
    };

    const events = cockpitRowsToIntelEvents(payload);
    expect(events.some((e) => e.id === 5)).toBe(false);
    expect(events.some((e) => e.id === 6)).toBe(true);
  });
});
