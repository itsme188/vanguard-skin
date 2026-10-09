/**
 * The capture gate in lib/calendar/enrichment-runner.ts: a reaction is never
 * stored before its own window (release + window_min) has elapsed, for ANY
 * row, and a row that was marked done before then gets a later reaction-only
 * attempt (owner ruling 2026-10-08).
 *
 * The two capture entry points are mocked to return a ready-made snapshot —
 * the dangerous case is exactly a capture that hands something back early.
 * All prices are invented round figures.
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

import { runEnrichment, REACTION_READY_MS } from "@/lib/calendar/enrichment-runner";
import { captureReactionFromTws, composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { captureReactionFromYahoo } from "../../workers/cron/src/yahoo";
import { assessReactionSnapshot } from "@/lib/calendar/reaction-validity";

const mockTwsCapture = vi.mocked(captureReactionFromTws);
const mockYahooCapture = vi.mocked(captureReactionFromYahoo);

const MIN = 60 * 1000;
const EVENT_DATE = "2026-04-24";

function snapshotFor(releaseInstant: Date, source: "tws" | "yahoo"): ReactionSnapshot {
  return {
    t0_utc: releaseInstant.toISOString(),
    window_min: 120,
    source,
    spy: { t_pre: 500, t_post: 505, delta_pct: 1 },
    qqq: { t_pre: 400, t_post: 398, delta_pct: -0.5 },
    tlt: { t_pre: 90, t_post: 90.45, delta_pct: 0.5 },
  };
}

function insertEvent(
  db: Database.Database,
  opts: {
    source: string;
    source_key: string;
    event_type: string;
    release_time: string;
    symbol?: string | null;
    security_id?: number | null;
  },
): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title,
          symbol, security_id, consensus_estimate, source_key, week_of)
       VALUES (?, ?, ?, ?, ?, 'Test event', ?, ?, NULL, ?, ?)`,
    )
    .run(
      opts.source,
      opts.event_type,
      EVENT_DATE,
      opts.release_time,
      opts.release_time,
      opts.symbol ?? null,
      opts.security_id ?? null,
      opts.source_key,
      EVENT_DATE,
    );
  return Number(lastInsertRowid);
}

function insertMacro(db: Database.Database): number {
  return insertEvent(db, {
    source: "claude_macro",
    source_key: `fred:10:${EVENT_DATE}`,
    event_type: "cpi",
    release_time: "08:30",
  });
}

function insertEarnings(db: Database.Database): number {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, asset_class, multiplier, sector)
     VALUES (700, 'ZZA', 'ZZA Corp', 'stock', 'equity', 1, 'Technology')`,
  ).run();
  return insertEvent(db, {
    source: "finnhub",
    source_key: `finnhub:ZZA:${EVENT_DATE}`,
    event_type: "earnings",
    release_time: "08:00",
    symbol: "ZZA",
    security_id: 700,
  });
}

function fredResponse() {
  return {
    ok: true,
    json: async () => ({
      observations: [
        { date: "2026-04-01", value: "310" },
        { date: "2025-04-01", value: "300" },
      ],
    }),
  };
}

function finnhubResponse() {
  return {
    ok: true,
    json: async () => ({
      earningsCalendar: [{ symbol: "ZZA", date: EVENT_DATE, epsActual: 1.0, epsEstimate: 0.9 }],
    }),
  };
}

interface Row {
  enriched_at: string | null;
  actual_value: string | null;
  reaction_snapshot: string | null;
}
function readRow(db: Database.Database, id: number): Row {
  return db
    .prepare("SELECT enriched_at, actual_value, reaction_snapshot FROM calendar_events WHERE id = ?")
    .get(id) as Row;
}

/** Move the retry-pacing stamp into the past so a second pass is not paced out. */
function clearPacing(db: Database.Database, id: number) {
  db.prepare("UPDATE calendar_events SET enrichment_attempted_at = '2000-01-01 00:00:00' WHERE id = ?").run(id);
}

const stubTws = { getHistoricalData: async () => [] } as never;

describe("capture gate: no reaction before release + window", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FRED_API_KEY = "test_fred_key";
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
    mockTwsCapture.mockReset();
    mockYahooCapture.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRED_API_KEY;
    delete process.env.FINNHUB_API_KEY;
  });

  it("the gate constant is the full window, not window minus the bar tolerance", () => {
    expect(REACTION_READY_MS).toBe(120 * MIN);
  });

  it("macro row minutes after release: nothing captured or stored, the row is still marked done", async () => {
    const id = insertMacro(db);
    const release = composeReleaseInstant(EVENT_DATE, "08:30")!;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fredResponse());
    mockTwsCapture.mockResolvedValue(snapshotFor(release, "tws"));
    mockYahooCapture.mockResolvedValue(snapshotFor(release, "yahoo"));

    const results = await runEnrichment(db, {
      now: new Date(release.getTime() + 7 * MIN),
      tws: stubTws,
      pacingMs: 0,
    });

    expect(mockTwsCapture).not.toHaveBeenCalled();
    expect(mockYahooCapture).not.toHaveBeenCalled();
    const row = readRow(db, id);
    expect(row.reaction_snapshot).toBeNull();
    // The actuals path is unchanged: macro rows are single-shot.
    expect(row.actual_value).toBeTruthy();
    expect(row.enriched_at).toBeTruthy();
    expect(results[0].reaction).toBeNull();
  });

  it("earnings row at T+116m (inside the old T+115m gate): still nothing captured", async () => {
    const id = insertEarnings(db);
    const release = composeReleaseInstant(EVENT_DATE, "08:00")!;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(finnhubResponse());
    mockTwsCapture.mockResolvedValue(snapshotFor(release, "tws"));
    mockYahooCapture.mockResolvedValue(snapshotFor(release, "yahoo"));

    await runEnrichment(db, {
      now: new Date(release.getTime() + 116 * MIN),
      tws: stubTws,
      pacingMs: 0,
    });

    expect(mockTwsCapture).not.toHaveBeenCalled();
    expect(mockYahooCapture).not.toHaveBeenCalled();
    const row = readRow(db, id);
    expect(row.reaction_snapshot).toBeNull();
    expect(row.actual_value).toBeTruthy();
    // Still open: the next tick retries.
    expect(row.enriched_at).toBeNull();
  });

  it("earnings row at T+121m: captured, stamped with the capture instant, placeholder leg dropped", async () => {
    const id = insertEarnings(db);
    const release = composeReleaseInstant(EVENT_DATE, "08:00")!;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(finnhubResponse());
    mockTwsCapture.mockResolvedValue({
      ...snapshotFor(release, "tws"),
      qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
    });

    const now = new Date(release.getTime() + 121 * MIN);
    await runEnrichment(db, { now, tws: stubTws, pacingMs: 0 });

    expect(mockTwsCapture).toHaveBeenCalledTimes(1);
    const row = readRow(db, id);
    const stored = JSON.parse(row.reaction_snapshot!) as ReactionSnapshot;
    expect(stored.captured_at).toBe(now.toISOString());
    expect(stored.source).toBe("tws");
    expect(stored.spy).toEqual({ t_pre: 500, t_post: 505, delta_pct: 1 });
    expect("qqq" in stored).toBe(false);
    expect(assessReactionSnapshot(stored).valid).toBe(true);
    expect(row.enriched_at).toBeTruthy();
  });

  it("a capture that returns a snapshot for a window that has not elapsed is not stored (explicit event)", async () => {
    const id = insertMacro(db);
    const release = composeReleaseInstant(EVENT_DATE, "08:30")!;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fredResponse());
    mockYahooCapture.mockResolvedValue(snapshotFor(release, "yahoo"));

    await runEnrichment(db, { now: new Date(release.getTime() + 30 * MIN), eventId: id, pacingMs: 0 });

    expect(mockYahooCapture).not.toHaveBeenCalled();
    expect(readRow(db, id).reaction_snapshot).toBeNull();
  });

  it("the TWS re-capture road refuses before the window has elapsed and keeps what is stored", async () => {
    const id = insertMacro(db);
    const release = composeReleaseInstant(EVENT_DATE, "08:30")!;
    mockTwsCapture.mockResolvedValue(snapshotFor(release, "tws"));

    const results = await runEnrichment(db, {
      now: new Date(release.getTime() + 30 * MIN),
      eventId: id,
      tws: stubTws,
      upgradeReactionToTws: true,
      pacingMs: 0,
    });

    expect(mockTwsCapture).not.toHaveBeenCalled();
    expect(results[0].enriched).toBe(false);
    expect(results[0].reason).toBe("reaction_window_not_elapsed");
    expect(readRow(db, id).reaction_snapshot).toBeNull();
  });

  it("the TWS re-capture road stamps the capture instant once the window has elapsed", async () => {
    const id = insertMacro(db);
    const release = composeReleaseInstant(EVENT_DATE, "08:30")!;
    mockTwsCapture.mockResolvedValue(snapshotFor(release, "tws"));

    const now = new Date(release.getTime() + 300 * MIN);
    const results = await runEnrichment(db, {
      now,
      eventId: id,
      tws: stubTws,
      upgradeReactionToTws: true,
      pacingMs: 0,
    });

    expect(results[0].enriched).toBe(true);
    const stored = JSON.parse(readRow(db, id).reaction_snapshot!) as ReactionSnapshot;
    expect(stored.captured_at).toBe(now.toISOString());
  });
});

describe("reaction-only follow-up: a row marked done before its window ended is retried", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FRED_API_KEY = "test_fred_key";
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
    mockTwsCapture.mockReset();
    mockYahooCapture.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRED_API_KEY;
    delete process.env.FINNHUB_API_KEY;
  });

  async function enrichMacroEarly(): Promise<{ id: number; release: Date; before: Row }> {
    const id = insertMacro(db);
    const release = composeReleaseInstant(EVENT_DATE, "08:30")!;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fredResponse());
    await runEnrichment(db, { now: new Date(release.getTime() + 10 * MIN), pacingMs: 0 });
    const before = readRow(db, id);
    expect(before.enriched_at).toBeTruthy();
    expect(before.reaction_snapshot).toBeNull();
    clearPacing(db, id);
    return { id, release, before };
  }

  it("captures the reaction once the window has elapsed, leaving the actual and enriched_at alone", async () => {
    const { id, release, before } = await enrichMacroEarly();
    mockYahooCapture.mockResolvedValue(snapshotFor(release, "yahoo"));

    const now = new Date(release.getTime() + 125 * MIN);
    const results = await runEnrichment(db, { now, pacingMs: 0 });

    expect(mockYahooCapture).toHaveBeenCalledTimes(1);
    const after = readRow(db, id);
    const stored = JSON.parse(after.reaction_snapshot!) as ReactionSnapshot;
    expect(stored.captured_at).toBe(now.toISOString());
    expect(stored.source).toBe("yahoo");
    expect(after.enriched_at).toBe(before.enriched_at);
    expect(after.actual_value).toBe(before.actual_value);
    // No vendor actual fetch on this road.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ eventId: id, actual: null, enriched: true, reason: "reaction_follow_up" });
    expect(results[0].reaction?.captured_at).toBe(now.toISOString());
  });

  it("does not run before the window has elapsed", async () => {
    const { id, release } = await enrichMacroEarly();
    mockYahooCapture.mockResolvedValue(snapshotFor(release, "yahoo"));

    const results = await runEnrichment(db, { now: new Date(release.getTime() + 100 * MIN), pacingMs: 0 });

    expect(mockYahooCapture).not.toHaveBeenCalled();
    expect(results).toEqual([]);
    expect(readRow(db, id).reaction_snapshot).toBeNull();
  });

  it("stops once the capture window has settled (T+150m)", async () => {
    const { id, release } = await enrichMacroEarly();
    mockYahooCapture.mockResolvedValue(snapshotFor(release, "yahoo"));

    await runEnrichment(db, { now: new Date(release.getTime() + 151 * MIN), pacingMs: 0 });

    expect(mockYahooCapture).not.toHaveBeenCalled();
    expect(readRow(db, id).reaction_snapshot).toBeNull();
  });

  it("an empty capture leaves the row NULL and paces the next attempt", async () => {
    const { id, release } = await enrichMacroEarly();
    mockYahooCapture.mockResolvedValue(null);

    const first = new Date(release.getTime() + 121 * MIN);
    const r1 = await runEnrichment(db, { now: first, pacingMs: 0 });
    expect(mockYahooCapture).toHaveBeenCalledTimes(1);
    expect(r1).toEqual([]);
    expect(readRow(db, id).reaction_snapshot).toBeNull();

    // The attempt was stamped (wall-clock datetime('now')).
    const stamped = db
      .prepare("SELECT enrichment_attempted_at AS t FROM calendar_events WHERE id = ?")
      .get(id) as { t: string };
    expect(stamped.t).not.toBe("2000-01-01 00:00:00");
    // Re-express that stamp on the test's own clock, then: 5 minutes later is
    // paced out, 14 minutes later is tried again.
    db.prepare("UPDATE calendar_events SET enrichment_attempted_at = ? WHERE id = ?").run(
      first.toISOString().replace("T", " ").slice(0, 19),
      id,
    );
    await runEnrichment(db, { now: new Date(first.getTime() + 5 * MIN), pacingMs: 0 });
    expect(mockYahooCapture).toHaveBeenCalledTimes(1);
    await runEnrichment(db, { now: new Date(first.getTime() + 14 * MIN), pacingMs: 0 });
    expect(mockYahooCapture).toHaveBeenCalledTimes(2);
  });

  it("never touches a row that already holds a snapshot", async () => {
    const { id, release } = await enrichMacroEarly();
    const existing = JSON.stringify({ ...snapshotFor(release, "tws"), captured_at: "2026-04-24T15:00:00.000Z" });
    db.prepare("UPDATE calendar_events SET reaction_snapshot = ? WHERE id = ?").run(existing, id);
    mockYahooCapture.mockResolvedValue(snapshotFor(release, "yahoo"));

    await runEnrichment(db, { now: new Date(release.getTime() + 125 * MIN), pacingMs: 0 });

    expect(mockYahooCapture).not.toHaveBeenCalled();
    expect(readRow(db, id).reaction_snapshot).toBe(existing);
  });

  it("respects the per-pass limit", async () => {
    const { release } = await enrichMacroEarly();
    mockYahooCapture.mockResolvedValue(snapshotFor(release, "yahoo"));

    await runEnrichment(db, { now: new Date(release.getTime() + 125 * MIN), pacingMs: 0, limit: 0 });

    expect(mockYahooCapture).not.toHaveBeenCalled();
  });
});
