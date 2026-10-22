/**
 * A measured reaction is never replaced by a later capture (2026-10-22).
 *
 * Pressing "gen recap" runs a single-event enrichment pass. Before this fix
 * the pass re-captured the reaction whenever the window had elapsed, and the
 * UPDATE's COALESCE only protected against a NULL new value, so a Yahoo
 * capture replaced a stored TWS measurement. The stored snapshot is now read
 * through readReactionLegs (lib/calendar/reaction-validity.ts): a snapshot
 * with a measured leg is kept as stored and no capture runs; a snapshot whose
 * legs are all pending (captured before its window ended) is re-captured as
 * before. Only the explicit "upgrade to TWS" road overwrites a measurement.
 *
 * Synthetic symbol and invented round prices only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";

vi.mock("@/lib/alerts/print-push", () => ({ sendEarningsPrintPush: vi.fn() }));

vi.mock("@/lib/calendar/reaction-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/reaction-snapshot")>();
  return { ...actual, captureReactionFromTws: vi.fn() };
});
vi.mock("../../workers/cron/src/yahoo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workers/cron/src/yahoo")>();
  return { ...actual, captureReactionFromYahoo: vi.fn() };
});

import { runEnrichment } from "@/lib/calendar/enrichment-runner";
import { captureReactionFromTws, composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { captureReactionFromYahoo } from "../../workers/cron/src/yahoo";
import { assessReactionSnapshot, readReactionLegs } from "@/lib/calendar/reaction-validity";

const mockTwsCapture = vi.mocked(captureReactionFromTws);
const mockYahooCapture = vi.mocked(captureReactionFromYahoo);

const MIN = 60 * 1000;
const EVENT_DATE = "2026-04-24";
const RELEASE_TIME = "08:00";

function release(): Date {
  return composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
}

function storedTwsSnapshot(capturedAt: Date): ReactionSnapshot {
  return {
    t0_utc: release().toISOString(),
    window_min: 120,
    source: "tws",
    captured_at: capturedAt.toISOString(),
    symbol: { symbol: "ZZZ", t_pre: 100, t_post: 104, delta_pct: 4.0 },
    spy: { t_pre: 500, t_post: 505, delta_pct: 1 },
    qqq: { t_pre: 400, t_post: 404, delta_pct: 1 },
    tlt: { t_pre: 90, t_post: 90.9, delta_pct: 1 },
    sector: { symbol: "XLK", t_pre: 200, t_post: 202, delta_pct: 1 },
  } as ReactionSnapshot;
}

function yahooSnapshot(): ReactionSnapshot {
  return {
    t0_utc: release().toISOString(),
    window_min: 120,
    source: "yahoo",
    symbol: { symbol: "ZZZ", t_pre: 100, t_post: 103.5, delta_pct: 3.5 },
    spy: { t_pre: 500, t_post: 510, delta_pct: 2 },
    qqq: { t_pre: 400, t_post: 408, delta_pct: 2 },
    tlt: { t_pre: 90, t_post: 91.8, delta_pct: 2 },
  } as ReactionSnapshot;
}

function insertEarnings(db: Database.Database, reactionJson: string): number {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, asset_class, multiplier, sector)
     VALUES (710, 'ZZZ', 'ZZZ Corp', 'stock', 'equity', 1, 'Technology')`,
  ).run();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title,
          symbol, security_id, consensus_estimate, actual_value, reaction_snapshot,
          source_key, week_of)
       VALUES ('finnhub', 'earnings', ?, ?, ?, 'ZZZ earnings', 'ZZZ', 710, NULL, 'EPS 1.00',
               ?, ?, ?)`,
    )
    .run(EVENT_DATE, RELEASE_TIME, RELEASE_TIME, reactionJson, `finnhub:ZZZ:${EVENT_DATE}`, EVENT_DATE);
  return Number(lastInsertRowid);
}

function readSnapshot(db: Database.Database, id: number): string | null {
  return (
    db.prepare("SELECT reaction_snapshot FROM calendar_events WHERE id = ?").get(id) as {
      reaction_snapshot: string | null;
    }
  ).reaction_snapshot;
}

const stubTws = { getHistoricalData: async () => [] } as never;

describe("single-event enrichment keeps a measured reaction", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
    mockTwsCapture.mockReset();
    mockYahooCapture.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FINNHUB_API_KEY;
  });

  it("a stored TWS measurement is left byte-identical and no capture runs (gen recap, TWS down)", async () => {
    const seeded = JSON.stringify(storedTwsSnapshot(new Date(release().getTime() + 125 * MIN)));
    expect(assessReactionSnapshot(JSON.parse(seeded)).valid).toBe(true);
    const id = insertEarnings(db, seeded);
    mockYahooCapture.mockResolvedValue(yahooSnapshot());

    const results = await runEnrichment(db, {
      eventId: id,
      now: new Date(release().getTime() + 19 * 60 * MIN),
      pacingMs: 0,
    });

    expect(mockYahooCapture).not.toHaveBeenCalled();
    expect(mockTwsCapture).not.toHaveBeenCalled();
    expect(readSnapshot(db, id)).toBe(seeded);
    // A stored measurement counts as having a reaction: the row is complete.
    expect(results[0].enriched).toBe(true);
  });

  it("with TWS connected, a stored measurement is still not re-captured", async () => {
    const seeded = JSON.stringify(storedTwsSnapshot(new Date(release().getTime() + 125 * MIN)));
    const id = insertEarnings(db, seeded);
    mockTwsCapture.mockResolvedValue({ ...yahooSnapshot(), source: "tws" });

    await runEnrichment(db, {
      eventId: id,
      now: new Date(release().getTime() + 300 * MIN),
      tws: stubTws,
      pacingMs: 0,
    });

    expect(mockTwsCapture).not.toHaveBeenCalled();
    expect(readSnapshot(db, id)).toBe(seeded);
  });

  it("a stored snapshot whose legs are all pending (captured before the window ended) is re-captured", async () => {
    const premature = storedTwsSnapshot(new Date(release().getTime() + 30 * MIN));
    const read = readReactionLegs(premature);
    expect(Object.keys(read!.measured)).toEqual([]);
    expect(assessReactionSnapshot(premature).premature).toBe(true);
    const id = insertEarnings(db, JSON.stringify(premature));
    mockYahooCapture.mockResolvedValue(yahooSnapshot());

    const now = new Date(release().getTime() + 130 * MIN);
    await runEnrichment(db, { eventId: id, now, pacingMs: 0 });

    expect(mockYahooCapture).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(readSnapshot(db, id)!) as ReactionSnapshot;
    expect(stored.source).toBe("yahoo");
    expect(stored.captured_at).toBe(now.toISOString());
    expect(assessReactionSnapshot(stored).valid).toBe(true);
  });

  it("the explicit upgrade-to-TWS road still overwrites a stored measurement", async () => {
    const seeded = storedTwsSnapshot(new Date(release().getTime() + 125 * MIN));
    const id = insertEarnings(db, JSON.stringify({ ...seeded, source: "yahoo" }));
    mockTwsCapture.mockResolvedValue({ ...yahooSnapshot(), source: "tws" });

    const now = new Date(release().getTime() + 300 * MIN);
    await runEnrichment(db, {
      eventId: id,
      now,
      tws: stubTws,
      upgradeReactionToTws: true,
      pacingMs: 0,
    });

    expect(mockTwsCapture).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(readSnapshot(db, id)!) as ReactionSnapshot;
    expect(stored.source).toBe("tws");
    expect(stored.captured_at).toBe(now.toISOString());
  });
});
