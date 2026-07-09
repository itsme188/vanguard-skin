import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertEarningsIntel, replaceReportHistory } from "@/lib/mutations/earnings-intel";
import {
  getIntelForEvents,
  getReportHistoryForFamily,
  isHistoryStale,
  decorateCockpitIntel,
} from "@/lib/queries/earnings-intel";
import type { CockpitPayload, CockpitRow } from "@/lib/queries/earnings-cockpit";

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
});
