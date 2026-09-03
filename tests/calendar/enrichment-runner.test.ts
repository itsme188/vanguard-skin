/**
 * Unit tests for lib/calendar/enrichment-runner.ts
 *
 * The runner orchestrates: findCandidates → fetchActualForEvent → capture
 * reaction → persist. We mock the underlying fetch and verify the SQL
 * side effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { runEnrichment, REACTION_READY_MS } from "@/lib/calendar/enrichment-runner";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { setMutedEarningsSymbols, setEarningsEmailsEnabled } from "@/lib/queries/earnings-settings";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";

vi.mock("@/lib/alerts/print-push", () => ({
  sendEarningsPrintPush: vi.fn(),
}));
import { sendEarningsPrintPush } from "@/lib/alerts/print-push";

const mockSendEarningsPrintPush = vi.mocked(sendEarningsPrintPush);

// Wrap (not replace) the two reaction-capture entry points so the T+115m
// gate tests can assert call/no-call while every other test in this file
// still exercises the real capture logic (bars → matchBarsToReaction →
// reaction_snapshot JSON) unchanged.
vi.mock("@/lib/calendar/reaction-snapshot", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/calendar/reaction-snapshot")>();
  return {
    ...actual,
    captureReactionFromTws: vi.fn(actual.captureReactionFromTws),
  };
});
import { captureReactionFromTws } from "@/lib/calendar/reaction-snapshot";
const mockCaptureReactionFromTws = vi.mocked(captureReactionFromTws);

vi.mock("../../workers/cron/src/yahoo", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../workers/cron/src/yahoo")>();
  return {
    ...actual,
    captureReactionFromYahoo: vi.fn(actual.captureReactionFromYahoo),
  };
});
import { captureReactionFromYahoo } from "../../workers/cron/src/yahoo";
const mockCaptureReactionFromYahoo = vi.mocked(captureReactionFromYahoo);

function seedSecurity(
  db: Database.Database,
  id: number,
  symbol: string,
  sector: string | null,
) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, asset_class, multiplier, sector)
     VALUES (?, ?, ?, 'stock', 'equity', 1, ?)`,
  ).run(id, symbol, `${symbol} Corp`, sector);
}

function insertEvent(
  db: Database.Database,
  opts: {
    id?: number;
    source?: string;
    source_key: string;
    event_type: string;
    event_date: string;
    release_time: string | null;
    symbol?: string | null;
    security_id?: number | null;
    consensus_estimate?: string | null;
    raw_json?: string | null;
    /** 'BMO' | 'AMC' | 'TAS' | 'HH:MM'. Defaults to release_time (the
     *  historical shape of this helper). */
    event_time?: string | null;
  },
) {
  return db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, release_time, title,
        symbol, security_id, consensus_estimate, raw_json, source_key, week_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.source ?? "claude_macro",
    opts.event_type,
    opts.event_date,
    opts.event_time === undefined ? opts.release_time : opts.event_time,
    opts.release_time,
    "Test event",
    opts.symbol ?? null,
    opts.security_id ?? null,
    opts.consensus_estimate ?? null,
    opts.raw_json ?? null,
    opts.source_key,
    opts.event_date,
  );
}

describe("runEnrichment", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FRED_API_KEY = "test_fred_key";
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRED_API_KEY;
    delete process.env.FINNHUB_API_KEY;
  });

  it("does nothing when no events fall in the enrichment window", async () => {
    // Event is 4 hours old — outside the macro [now-2h, now-5min] window
    insertEvent(db, {
      source_key: "fred:10:2026-04-11",
      event_type: "cpi",
      event_date: "2026-04-11",
      release_time: "08:30",
    });

    // 08:30 EDT = 12:30 UTC. 4 hours post-release → 16:30 UTC, outside macro window.
    const now = new Date("2026-04-11T16:30:00Z");
    const results = await runEnrichment(db, { now });
    expect(results).toEqual([]);

    const row = db
      .prepare("SELECT enriched_at FROM calendar_events")
      .get() as { enriched_at: string | null };
    expect(row.enriched_at).toBeNull();
  });

  it("BMO earnings released 4 hours ago is still in the (12h) earnings window", async () => {
    // Mock Finnhub `/calendar/earnings` for the actual fetch.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "NSC", date: "2026-04-24", epsActual: 3.45, epsEstimate: 3.32 },
        ],
      }),
    });

    seedSecurity(db, 100, "NSC", "Industrials");
    insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:NSC:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "NSC",
      security_id: 100,
    });

    // 08:00 EDT = 12:00 UTC. 4.5 hours post-release → 16:30 UTC. Outside the
    // macro 2h window but inside the earnings 12h window. This is the exact
    // NSC scenario from 2026-04-24 — the runner cron didn't see NSC at 08:13
    // because Finnhub sync hadn't inserted it yet, then by mid-day it was
    // outside the old 2h window forever.
    const now = new Date("2026-04-24T16:30:00Z");
    const results = await runEnrichment(db, { now });
    expect(results).toHaveLength(1);
    expect(results[0].enriched).toBe(true);

    const row = db
      .prepare("SELECT enriched_at, actual_value FROM calendar_events")
      .get() as { enriched_at: string | null; actual_value: string | null };
    expect(row.enriched_at).toBeTruthy();
    expect(row.actual_value).toBeTruthy();
  });

  it("enriches an in-window macro event and writes actual + enriched_at", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        observations: [
          { date: "2026-04-01", value: "310.326" },
          { date: "2026-03-01", value: "309.685" },
          { date: "2025-04-01", value: "300.84" },
        ],
      }),
    });

    insertEvent(db, {
      source_key: "fred:10:2026-04-11",
      event_type: "cpi",
      event_date: "2026-04-11",
      release_time: "08:30",
      consensus_estimate: "3.2%",
    });

    // 08:30 EDT = 12:30 UTC. 1 hour post-release → 13:30 UTC.
    const now = new Date("2026-04-11T13:30:00Z");
    const results = await runEnrichment(db, { now });
    expect(results).toHaveLength(1);
    expect(results[0].enriched).toBe(true);
    expect(results[0].actual).toMatch(/%/);

    const row = db
      .prepare(
        `SELECT actual_value, consensus_value, enriched_at, reaction_snapshot
         FROM calendar_events`,
      )
      .get() as {
      actual_value: string | null;
      consensus_value: string | null;
      enriched_at: string | null;
      reaction_snapshot: string | null;
    };

    expect(row.actual_value).toMatch(/%/);
    expect(row.consensus_value).toBe("3.2%");
    expect(row.enriched_at).toBeTruthy();
    expect(row.reaction_snapshot).toBeNull(); // no TWS passed
  });

  it("skips already-enriched events", async () => {
    insertEvent(db, {
      source_key: "fred:10:2026-04-11",
      event_type: "cpi",
      event_date: "2026-04-11",
      release_time: "08:30",
      consensus_estimate: "3.2%",
    });
    // Pre-mark the row as already enriched
    db.prepare(
      `UPDATE calendar_events SET enriched_at = datetime('now')`,
    ).run();

    const now = new Date("2026-04-11T10:00:00Z");
    const results = await runEnrichment(db, { now });
    expect(results).toEqual([]);
  });

  it("eventId override bypasses the time-window filter", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        observations: [
          { date: "2026-04-01", value: "310.326" },
          { date: "2025-04-01", value: "300.84" },
        ],
      }),
    });

    const { lastInsertRowid } = insertEvent(db, {
      source_key: "fred:10:2026-04-11",
      event_type: "cpi",
      event_date: "2026-04-11",
      release_time: "08:30",
    });

    // "now" is a month after release — way out of window, but we still
    // enrich because eventId was passed.
    const now = new Date("2026-05-11T13:30:00Z");
    const results = await runEnrichment(db, {
      now,
      eventId: Number(lastInsertRowid),
    });
    expect(results).toHaveLength(1);
    expect(results[0].enriched).toBe(true);
  });

  it("never clears an existing actual_value/reaction when a re-enrichment pass fetches nothing", async () => {
    // The EarningsHub "gen" button runs enrichment before composing the
    // recap. For a manual event, fetchActualForEvent has no dispatcher
    // match and returns { actual: null } gracefully (not a throw) — the
    // unconditional `SET actual_value = ?` then DESTROYED the user's
    // manually-saved actuals and 409'd. Deep-QA finding 2026-06-10:
    // earningshub-gen-button--gen-compose-recap-wipes-manually-saved-actuals.
    seedSecurity(db, 1, "NVDA", "Technology");
    const { lastInsertRowid } = insertEvent(db, {
      source: "manual",
      source_key: "manual:NVDA:2026-04-11:earnings",
      event_type: "earnings",
      event_date: "2026-04-11",
      release_time: "16:15",
      symbol: "NVDA",
      security_id: 1,
    });
    const eventId = Number(lastInsertRowid);
    const savedReaction = JSON.stringify({ source: "yahoo", spy: -0.4 });
    db.prepare(
      "UPDATE calendar_events SET actual_value = ?, reaction_snapshot = ? WHERE id = ?",
    ).run("EPS 0.92 · Rev 30.1B", savedReaction, eventId);

    // Every upstream fetch returns nothing useful (graceful nulls).
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });

    await runEnrichment(db, {
      eventId,
      now: new Date("2026-04-11T22:00:00Z"),
    });

    const row = db
      .prepare(
        "SELECT actual_value, reaction_snapshot FROM calendar_events WHERE id = ?",
      )
      .get(eventId) as { actual_value: string | null; reaction_snapshot: string | null };
    expect(row.actual_value).toBe("EPS 0.92 · Rev 30.1B");
    expect(row.reaction_snapshot).toBe(savedReaction);
  });

  it("logs an unmapped-sector earnings gap", async () => {
    // Finnhub actual fetch
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            symbol: "ACME",
            date: "2026-05-15",
            epsActual: 1.0,
            epsEstimate: 0.9,
            revenueActual: null,
            revenueEstimate: null,
          },
        ],
      }),
    });

    seedSecurity(db, 1, "ACME", "Made-Up Sector");
    insertEvent(db, {
      source_key: "finnhub:ACME:2026-05-15",
      event_type: "earnings",
      event_date: "2026-05-15",
      release_time: "08:00",
      symbol: "ACME",
      security_id: 1,
    });

    const now = new Date("2026-05-15T13:00:00Z"); // 1h after 08:00 ET (12:00Z)
    const mockTws = { getHistoricalData: async () => [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await runEnrichment(db, { now, tws: mockTws as any, pacingMs: 0 });
    expect(results).toHaveLength(1);

    const gap = db
      .prepare("SELECT * FROM sector_etf_gaps WHERE symbol = 'ACME'")
      .get() as { symbol: string; sector: string; count: number };
    expect(gap.symbol).toBe("ACME");
    expect(gap.sector).toBe("Made-Up Sector");
    expect(gap.count).toBe(1);
  });

  it("records fetch failures without marking the row enriched", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("network down");
    });

    insertEvent(db, {
      source_key: "fred:10:2026-04-11",
      event_type: "cpi",
      event_date: "2026-04-11",
      release_time: "08:30",
    });

    const now = new Date("2026-04-11T13:30:00Z");
    const results = await runEnrichment(db, { now });
    expect(results).toHaveLength(1);
    expect(results[0].enriched).toBe(false);
    expect(results[0].reason).toMatch(/network down/);

    const row = db
      .prepare("SELECT enriched_at FROM calendar_events")
      .get() as { enriched_at: string | null };
    expect(row.enriched_at).toBeNull();
  });

  // Task 1 (wire-time follow-ups, 2026-08-05): the Finnhub actuals road
  // (fetchFinnhubActual, reached via the finnhub:/manual:/nasdaq: source_key
  // roads) used to swallow a network/HTTP/missing-key failure into a
  // legitimate-looking `{ actual: null }` — indistinguishable in this
  // runner's results from "Finnhub genuinely has nothing yet". Sibling of
  // the FRED case above: a thrown Finnhub fetch failure must surface the
  // same way (results[].reason populated, enriched_at NOT stamped) instead
  // of silently looking like an ordinary empty retry.
  it("records Finnhub fetch failures without marking the row enriched", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("finnhub network down");
    });

    insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:ACME:2026-05-15",
      event_type: "earnings",
      event_date: "2026-05-15",
      release_time: "08:00",
      symbol: "ACME",
    });

    const now = new Date("2026-05-15T13:00:00Z"); // 1h after 08:00 ET release
    const results = await runEnrichment(db, { now });
    expect(results).toHaveLength(1);
    expect(results[0].enriched).toBe(false);
    expect(results[0].reason).toMatch(/finnhub network down/);

    const row = db
      .prepare("SELECT enriched_at, actual_value FROM calendar_events")
      .get() as { enriched_at: string | null; actual_value: string | null };
    expect(row.enriched_at).toBeNull();
    expect(row.actual_value).toBeNull();
  });
});

describe("earnings retry-until-complete (migration 062)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FRED_API_KEY = "test_fred_key";
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRED_API_KEY;
    delete process.env.FINNHUB_API_KEY;
  });

  /**
   * Convert a UTC instant into its ET wall-clock date/time parts, for
   * constructing event_date/release_time fixtures. Using Intl (rather than
   * hand-rolled DST math) means these tests don't need to know whether a
   * given date falls in EDT or EST.
   */
  function etDateTimeParts(d: Date): { date: string; time: string } {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    let hour = get("hour");
    if (hour === "24") hour = "00"; // Intl quirk: midnight can format as "24"
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      time: `${hour}:${get("minute")}`,
    };
  }

  function getRow(id: number) {
    return db
      .prepare(
        `SELECT enriched_at, enrichment_attempted_at, actual_value, reaction_snapshot
         FROM calendar_events WHERE id = ?`,
      )
      .get(id) as {
      enriched_at: string | null;
      enrichment_attempted_at: string | null;
      actual_value: string | null;
      reaction_snapshot: string | null;
    };
  }

  // Entries must echo the queried symbol: the foreign-listing guard
  // (2026-07-16) drops figures from any entry whose symbol mismatches
  // (Finnhub resolves ADR queries to the local listing, e.g. TSM → 2330.TW
  // with TWD-scale figures).
  function mockFinnhubActual(entry: {
    symbol: string;
    date: string;
    epsActual?: number | null;
    epsEstimate?: number | null;
  } | null) {
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ earningsCalendar: entry ? [entry] : [] }),
    });
  }

  const emptyTws = { getHistoricalData: async () => [] };
  // Bars straddling an 08:00 ET release: pre-target (07:55 ET) and
  // post-target (10:00 ET = release+120min). Same bars serve every symbol
  // call (SPY/QQQ/TLT/sector/event-symbol) since matchBarsToReaction only
  // needs SOME bar within tolerance of each target.
  function realTwsFor(eventDate: string) {
    const [y, m, d] = eventDate.split("-");
    return {
      getHistoricalData: async () => [
        { time: `${y}${m}${d}  07:55:00`, close: 500.0 },
        { time: `${y}${m}${d}  10:00:00`, close: 505.0 },
      ],
    };
  }

  // Earnings-retry scenarios (2, 3, and the first-attempt-null test 1) use a
  // release instant far in the future relative to real wall-clock "now" —
  // enrichment_attempted_at is always stamped with REAL datetime('now'), so
  // parking the fictional release ~30 days out guarantees
  // (fictional now) - (real attempted_at) comfortably clears the 10-min
  // retry-pacing threshold on every subsequent call, regardless of when
  // this test suite actually runs.
  const { date: FUTURE_DATE, time: FUTURE_TIME } = etDateTimeParts(
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  );
  // Reconstruct via composeReleaseInstant (the same function the runner
  // uses internally) rather than the raw pre-rounding Date — etDateTimeParts
  // truncates to the minute, so anchoring on the raw instant would leave a
  // sub-minute drift against the runner's own ageMs computation, which is
  // too close for comfort against the 150-min settle-deadline boundary.
  const RELEASE_INSTANT = composeReleaseInstant(FUTURE_DATE, FUTURE_TIME)!;

  function releasePlus(minutes: number): Date {
    return new Date(RELEASE_INSTANT.getTime() + minutes * 60 * 1000);
  }

  it("does NOT stamp enriched_at when the actual fetch returns null", async () => {
    seedSecurity(db, 200, "ZETA", "Technology");
    const { lastInsertRowid } = insertEvent(db, {
      source: "finnhub",
      source_key: `finnhub:ZETA:${FUTURE_DATE}`,
      event_type: "earnings",
      event_date: FUTURE_DATE,
      release_time: FUTURE_TIME,
      symbol: "ZETA",
      security_id: 200,
    });
    const eventId = Number(lastInsertRowid);

    mockFinnhubActual(null); // no matching entry → actual null
    await runEnrichment(db, {
      now: releasePlus(20),
      tws: emptyTws as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      pacingMs: 0,
    });

    const row = getRow(eventId);
    expect(row.enriched_at).toBeNull();
    expect(row.enrichment_attempted_at).not.toBeNull();
  });

  it("retries on a later tick and completes once actual + reaction exist", async () => {
    seedSecurity(db, 201, "YOTA", "Technology");
    const { lastInsertRowid } = insertEvent(db, {
      source: "finnhub",
      source_key: `finnhub:YOTA:${FUTURE_DATE}`,
      event_type: "earnings",
      event_date: FUTURE_DATE,
      release_time: FUTURE_TIME,
      symbol: "YOTA",
      security_id: 201,
    });
    const eventId = Number(lastInsertRowid);

    // Attempt 1 at T+20: nulls → incomplete.
    mockFinnhubActual(null);
    await runEnrichment(db, {
      now: releasePlus(20),
      tws: emptyTws as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      pacingMs: 0,
    });
    expect(getRow(eventId).enriched_at).toBeNull();

    // Attempt 2 at T+155: actual + reaction available → complete.
    mockFinnhubActual({ symbol: "YOTA", date: FUTURE_DATE, epsActual: 2.5, epsEstimate: 2.3 });
    await runEnrichment(db, {
      now: releasePlus(155),
      tws: realTwsFor(FUTURE_DATE) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      pacingMs: 0,
    });

    const row = getRow(eventId);
    expect(row.actual_value).toContain("EPS");
    expect(row.enriched_at).not.toBeNull();
  });

  it("actual present but no reaction: incomplete before 150 min, complete after", async () => {
    seedSecurity(db, 202, "XILA", "Technology");
    const { lastInsertRowid } = insertEvent(db, {
      source: "finnhub",
      source_key: `finnhub:XILA:${FUTURE_DATE}`,
      event_type: "earnings",
      event_date: FUTURE_DATE,
      release_time: FUTURE_TIME,
      symbol: "XILA",
      security_id: 202,
    });
    const eventId = Number(lastInsertRowid);

    mockFinnhubActual({ symbol: "XILA", date: FUTURE_DATE, epsActual: 1.1, epsEstimate: 1.0 });
    await runEnrichment(db, {
      now: releasePlus(20),
      tws: emptyTws as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      pacingMs: 0,
    });
    expect(getRow(eventId).enriched_at).toBeNull(); // has actual, waiting on reaction window
    expect(getRow(eventId).actual_value).toContain("EPS"); // but the actual was stored (COALESCE)

    await runEnrichment(db, {
      now: releasePlus(151),
      tws: emptyTws as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      pacingMs: 0,
    });
    expect(getRow(eventId).enriched_at).not.toBeNull(); // settle deadline passed
  });

  it("paces retries: a row attempted <10 min ago is not re-selected", async () => {
    // Both `now` values here are real-clock-relative (not the far-future
    // fixture) so they land on the SAME clock as enrichment_attempted_at,
    // which is always stamped with real SQL datetime('now').
    const realNow = new Date();
    const releaseInstant = new Date(realNow.getTime() - 20 * 60 * 1000);
    const { date, time } = etDateTimeParts(releaseInstant);

    seedSecurity(db, 203, "WUXI", "Technology");
    const { lastInsertRowid } = insertEvent(db, {
      source: "finnhub",
      source_key: `finnhub:WUXI:${date}`,
      event_type: "earnings",
      event_date: date,
      release_time: time,
      symbol: "WUXI",
      security_id: 203,
    });
    const eventId = Number(lastInsertRowid);

    mockFinnhubActual(null);
    await runEnrichment(db, {
      now: realNow,
      tws: emptyTws as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      pacingMs: 0,
    });
    const firstAttempt = getRow(eventId).enrichment_attempted_at;
    expect(firstAttempt).not.toBeNull();

    const results = await runEnrichment(db, {
      now: new Date(realNow.getTime() + 5 * 60 * 1000), // 5 min later
      tws: emptyTws as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      pacingMs: 0,
    });
    expect(results).toEqual([]); // paced out — not re-selected
    expect(getRow(eventId).enrichment_attempted_at).toBe(firstAttempt); // unchanged
  });

  it("macro rows keep single-shot semantics (enriched_at stamped even on null actual)", async () => {
    insertEvent(db, {
      source: "claude_macro",
      source_key: `fred:10:${FUTURE_DATE}`,
      event_type: "cpi",
      event_date: FUTURE_DATE,
      release_time: FUTURE_TIME,
      consensus_estimate: "3.0%",
    });

    // FRED fetch fails → actual null.
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });

    await runEnrichment(db, { now: releasePlus(20) });

    const row = db
      .prepare("SELECT enriched_at FROM calendar_events")
      .get() as { enriched_at: string | null };
    expect(row.enriched_at).not.toBeNull();
  });
});

describe("reaction-capture gate: T+115m for earnings only (Task 7)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FRED_API_KEY = "test_fred_key";
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
    mockCaptureReactionFromTws.mockClear();
    mockCaptureReactionFromYahoo.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRED_API_KEY;
    delete process.env.FINNHUB_API_KEY;
  });

  // A stub `tws` object is enough — the assertions are on whether
  // captureReactionFromTws/captureReactionFromYahoo get invoked at all, not
  // on what bars they'd find.
  const mockTws = { getHistoricalData: async () => [] };

  it("skips reaction capture for an earnings row before T+115m (retry tick covers it)", async () => {
    seedSecurity(db, 400, "GATE", "Technology");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "GATE", date: "2026-04-24", epsActual: 1.0, epsEstimate: 0.9 },
        ],
      }),
    });

    const { lastInsertRowid } = insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:GATE:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00", // 08:00 EDT = 12:00 UTC
      symbol: "GATE",
      security_id: 400,
    });
    const eventId = Number(lastInsertRowid);
    const releaseInstant = composeReleaseInstant("2026-04-24", "08:00")!;

    // 30 minutes post-release — well short of the 115-min gate.
    const now = new Date(releaseInstant.getTime() + 30 * 60 * 1000);
    await runEnrichment(db, { now, tws: mockTws as any, pacingMs: 0 }); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(mockCaptureReactionFromTws).not.toHaveBeenCalled();
    expect(mockCaptureReactionFromYahoo).not.toHaveBeenCalled();

    const row = db
      .prepare(
        "SELECT enriched_at, actual_value FROM calendar_events WHERE id = ?",
      )
      .get(eventId) as { enriched_at: string | null; actual_value: string | null };
    // The actual landed (COALESCE-written) but completion still requires the
    // reaction OR the 150-min settle deadline — neither holds at T+30m, so
    // the row stays open for the next retry tick.
    expect(row.actual_value).toBeTruthy();
    expect(row.enriched_at).toBeNull();
  });

  it("still captures reaction immediately for a macro row (single-shot semantics)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        observations: [
          { date: "2026-04-01", value: "310.326" },
          { date: "2025-04-01", value: "300.84" },
        ],
      }),
    });

    insertEvent(db, {
      source: "claude_macro",
      source_key: "fred:10:2026-04-11",
      event_type: "cpi",
      event_date: "2026-04-11",
      release_time: "08:30", // 08:30 EDT = 12:30 UTC
      consensus_estimate: "3.2%",
    });
    const releaseInstant = composeReleaseInstant("2026-04-11", "08:30")!;

    // Same 30-minute age as the skipped earnings case above — macro rows
    // are never gated, so capture must still be attempted immediately.
    const now = new Date(releaseInstant.getTime() + 30 * 60 * 1000);
    await runEnrichment(db, { now, tws: mockTws as any, pacingMs: 0 }); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(mockCaptureReactionFromTws).toHaveBeenCalled();
  });

  it("attempts earnings reaction capture once past T+115m", async () => {
    seedSecurity(db, 401, "LATEGATE", "Technology");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "LATEGATE", date: "2026-04-24", epsActual: 1.2, epsEstimate: 1.0 },
        ],
      }),
    });

    insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:LATEGATE:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00", // 08:00 EDT = 12:00 UTC
      symbol: "LATEGATE",
      security_id: 401,
    });
    const releaseInstant = composeReleaseInstant("2026-04-24", "08:00")!;

    // Just past REACTION_READY_MS — the gate should now allow the attempt.
    const now = new Date(releaseInstant.getTime() + REACTION_READY_MS + 60_000);
    await runEnrichment(db, { now, tws: mockTws as any, pacingMs: 0 }); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(mockCaptureReactionFromTws).toHaveBeenCalled();
  });
});

describe("push-at-print hook (Wave 1 §2)", () => {
  let db: Database.Database;

  function seedAccount(id: number, name: string) {
    db.prepare(`INSERT INTO accounts (id, name) VALUES (?, ?)`).run(id, name);
  }

  function seedHolding(
    accountId: number,
    securityId: number,
    quantity: number,
    asOfDate: string,
  ) {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      securityId,
      quantity,
      asOfDate,
      `test:${accountId}:${securityId}:${asOfDate}`,
    );
  }

  function mockFinnhubActual(entry: {
    symbol: string;
    date: string;
    epsActual?: number | null;
    epsEstimate?: number | null;
    revenueActual?: number | null;
    revenueEstimate?: number | null;
  } | null) {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ earningsCalendar: entry ? [entry] : [] }),
    });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FRED_API_KEY = "test_fred_key";
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
    mockSendEarningsPrintPush.mockClear();
    mockSendEarningsPrintPush.mockResolvedValue({ pushed: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRED_API_KEY;
    delete process.env.FINNHUB_API_KEY;
  });

  it("fires on the null→non-null actual transition for a held earnings row", async () => {
    seedSecurity(db, 300, "PUSH", "Technology");
    seedAccount(900, "Test Account");
    seedHolding(900, 300, 100, "2026-04-20");

    mockFinnhubActual({
      symbol: "PUSH",
      date: "2026-04-24",
      epsActual: 1.42,
      epsEstimate: 1.35,
      revenueActual: 775200000,
      revenueEstimate: 762000000,
    });

    const { lastInsertRowid } = insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:PUSH:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "PUSH",
      security_id: 300,
    });
    const eventId = Number(lastInsertRowid);

    // 08:00 EDT = 12:00 UTC. 4.5h later — inside the earnings 12h window.
    const now = new Date("2026-04-24T16:30:00Z");
    await runEnrichment(db, { now });

    expect(mockSendEarningsPrintPush).toHaveBeenCalledTimes(1);
    expect(mockSendEarningsPrintPush).toHaveBeenCalledWith({
      eventId,
      symbol: "PUSH",
      actualValue: "EPS 1.42 · Rev 775,200,000",
      consensusValue: "EPS 1.35 · Rev 762,000,000",
      reactionJson: null,
      readThroughs: [],
      readThroughOnly: false,
    });
  });

  it("fires for a NON-held reporter with a live read-through pair (#13), flagged readThroughOnly", async () => {
    // TER is not held/watchlisted — but PRTO (held) is a read-through target.
    seedSecurity(db, 310, "PRTO", "Technology");
    seedAccount(910, "RT Account");
    seedHolding(910, 310, 40, "2026-04-20");
    db.prepare(
      `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, weight, hypothesis)
       VALUES ('TER', 'PRTO', 1.0, 'same input-cost cycle')`,
    ).run();

    mockFinnhubActual({
      symbol: "TER",
      date: "2026-04-24",
      epsActual: 1.42,
      epsEstimate: 1.35,
    });

    insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:TER:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "TER",
    });

    await runEnrichment(db, { now: new Date("2026-04-24T16:30:00Z") });

    expect(mockSendEarningsPrintPush).toHaveBeenCalledTimes(1);
    expect(mockSendEarningsPrintPush).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "TER",
        readThroughOnly: true,
        readThroughs: [
          { target: "PRTO", targetStatus: "held", hypothesis: "same input-cost cycle" },
        ],
      }),
    );
  });

  it("does NOT fire for a read-through reporter whose target was exited (#13 gate stays narrow)", async () => {
    seedSecurity(db, 311, "EXITED", "Technology"); // no holding row
    db.prepare(
      `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, weight, hypothesis)
       VALUES ('TER2', 'EXITED', 1.0, 'stale pair')`,
    ).run();

    mockFinnhubActual({ symbol: "TER2", date: "2026-04-24", epsActual: 1.0 });

    insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:TER2:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "TER2",
    });

    await runEnrichment(db, { now: new Date("2026-04-24T16:30:00Z") });

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  it("a HELD reporter with a live pair keeps the normal title semantics (readThroughOnly false) with lines attached", async () => {
    seedSecurity(db, 312, "BOTH", "Technology");
    seedSecurity(db, 313, "TGT2", "Technology");
    seedAccount(912, "RT Account 2");
    seedHolding(912, 312, 10, "2026-04-20");
    seedHolding(912, 313, 20, "2026-04-20");
    db.prepare(
      `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, weight, hypothesis)
       VALUES ('BOTH', 'TGT2', 1.0, 'shared cycle')`,
    ).run();

    mockFinnhubActual({ symbol: "BOTH", date: "2026-04-24", epsActual: 2.0, epsEstimate: 1.8 });

    insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:BOTH:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "BOTH",
      security_id: 312,
    });

    await runEnrichment(db, { now: new Date("2026-04-24T16:30:00Z") });

    expect(mockSendEarningsPrintPush).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "BOTH",
        readThroughOnly: false,
        readThroughs: [{ target: "TGT2", targetStatus: "held", hypothesis: "shared cycle" }],
      }),
    );
  });

  it("does NOT fire on a retry tick where the actual was already stored", async () => {
    seedSecurity(db, 301, "RETRY", "Technology");
    seedAccount(901, "Test Account 2");
    seedHolding(901, 301, 50, "2026-04-20");

    const { lastInsertRowid } = insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:RETRY:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "RETRY",
      security_id: 301,
    });
    const eventId = Number(lastInsertRowid);
    db.prepare(
      "UPDATE calendar_events SET actual_value = ? WHERE id = ?",
    ).run("EPS 2.00 · Rev 500,000,000", eventId);

    const now = new Date("2026-04-24T16:30:00Z");
    await runEnrichment(db, { now });

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  it("does NOT fire for a muted symbol", async () => {
    seedSecurity(db, 302, "MUTE", "Technology");
    seedAccount(902, "Test Account 3");
    seedHolding(902, 302, 25, "2026-04-20");
    setMutedEarningsSymbols(db, ["MUTE"]);

    mockFinnhubActual({
      symbol: "MUTE",
      date: "2026-04-24",
      epsActual: 0.5,
      epsEstimate: 0.45,
    });

    insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:MUTE:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "MUTE",
      security_id: 302,
    });

    const now = new Date("2026-04-24T16:30:00Z");
    await runEnrichment(db, { now });

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  it("does NOT fire when master toggle is off", async () => {
    seedSecurity(db, 305, "TOGGLE", "Technology");
    seedAccount(904, "Test Account 5");
    seedHolding(904, 305, 30, "2026-04-20");
    setEarningsEmailsEnabled(db, false);

    mockFinnhubActual({
      symbol: "TOGGLE",
      date: "2026-04-24",
      epsActual: 1.1,
      epsEstimate: 1.0,
    });

    insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:TOGGLE:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "TOGGLE",
      security_id: 305,
    });

    const now = new Date("2026-04-24T16:30:00Z");
    await runEnrichment(db, { now });

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  it("does NOT fire for a symbol that is neither held nor watchlisted", async () => {
    seedSecurity(db, 303, "NOPOS", "Technology");
    // No holdings, no watchlist row.

    mockFinnhubActual({
      symbol: "NOPOS",
      date: "2026-04-24",
      epsActual: 0.75,
      epsEstimate: 0.7,
    });

    insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:NOPOS:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "NOPOS",
      security_id: 303,
    });

    const now = new Date("2026-04-24T16:30:00Z");
    await runEnrichment(db, { now });

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  // [C-17 / v2 slice A §4.1] Selection consumers switched to coveredForEvents
  // (armed events get what held names get) — the push gate is explicitly
  // NOT one of them and must keep reading getSymbolStatus's held/watchlist
  // union only. An armed-only, unheld, unwatched reporter's null→non-null
  // transition must not fire the push.
  it("does NOT fire for an armed-only reporter (not held, not watchlisted) — push gate stays held/watchlist/read-through only", async () => {
    seedSecurity(db, 306, "ARMED1", "Technology");
    // No holdings, no watchlist row — armed only.

    mockFinnhubActual({
      symbol: "ARMED1",
      date: "2026-04-24",
      epsActual: 0.62,
      epsEstimate: 0.55,
    });

    const { lastInsertRowid } = insertEvent(db, {
      source: "finnhub",
      source_key: "finnhub:ARMED1:2026-04-24",
      event_type: "earnings",
      event_date: "2026-04-24",
      release_time: "08:00",
      symbol: "ARMED1",
      security_id: 306,
    });
    armWorksheet(db, Number(lastInsertRowid));

    const now = new Date("2026-04-24T16:30:00Z");
    await runEnrichment(db, { now });

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });

  it("does NOT fire for a macro row even when it carries an actual + a symbol", async () => {
    seedSecurity(db, 304, "AAPL", "Technology");
    seedAccount(903, "Test Account 4");
    seedHolding(903, 304, 10, "2026-04-11");

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        observations: [
          { date: "2026-04-01", value: "310.326" },
          { date: "2025-04-01", value: "300.84" },
        ],
      }),
    });

    insertEvent(db, {
      source: "claude_macro",
      source_key: "fred:10:2026-04-11",
      event_type: "cpi",
      event_date: "2026-04-11",
      release_time: "08:30",
      symbol: "AAPL",
      security_id: 304,
      consensus_estimate: "3.2%",
    });

    // 08:30 EDT = 12:30 UTC. 1 hour post-release.
    const now = new Date("2026-04-11T13:30:00Z");
    await runEnrichment(db, { now });

    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
  });
});

// ── Pre-print floor on the explicit-event road (Codex blocker, 2026-08-28) ──
//
// `runEnrichment(db, { eventId })` deliberately bypasses the release-window
// filter — that is what makes "re-enrich this row" and the EarningsHub
// "Generate" button possible. It also meant a click BEFORE the print could
// fetch an erroneous early vendor actual, write it, stamp enriched_at (which
// arms the recap send gate) and fire the print push. These pin the floor:
// nothing is fetched, written, or pushed before the print window opens, and
// the WINDOWED sweep is untouched by it.
describe("runEnrichment — pre-print floor on the explicit-event road", () => {
  let db: Database.Database;

  // 2026-08-27 is EDT, so ET = UTC−4 throughout this block.
  const EVENT_DATE = "2026-08-27";
  const ET_1530 = new Date("2026-08-27T19:30:00Z");
  const ET_1612 = new Date("2026-08-27T20:12:00Z");
  const ET_0659 = new Date("2026-08-27T10:59:00Z");
  const ET_0700 = new Date("2026-08-27T11:00:00Z");
  const ET_1705 = new Date("2026-08-27T21:05:00Z");

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
    mockSendEarningsPrintPush.mockClear();
    mockSendEarningsPrintPush.mockResolvedValue({ pushed: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FINNHUB_API_KEY;
  });

  /** Held so the print-push gate is genuinely open — a "no push" assertion
   *  is only meaningful when the same row WOULD push after the floor. */
  function seedHeld(securityId: number, symbol: string) {
    seedSecurity(db, securityId, symbol, "Technology");
    db.prepare(`INSERT INTO accounts (id, name) VALUES (?, ?)`).run(
      securityId,
      `Acct ${symbol}`,
    );
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 100, ?, ?)`,
    ).run(securityId, securityId, EVENT_DATE, `test:${symbol}`);
  }

  function mockFinnhubActual(symbol: string) {
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            symbol,
            date: EVENT_DATE,
            epsActual: 1.42,
            epsEstimate: 1.35,
          },
        ],
      }),
    });
  }

  function seedEarnings(opts: {
    securityId: number;
    symbol: string;
    releaseTime: string | null;
    eventTime?: string | null;
    rawJson?: string | null;
  }): number {
    seedHeld(opts.securityId, opts.symbol);
    mockFinnhubActual(opts.symbol);
    const { lastInsertRowid } = insertEvent(db, {
      source: "finnhub",
      source_key: `finnhub:${opts.symbol}:${EVENT_DATE}`,
      event_type: "earnings",
      event_date: EVENT_DATE,
      release_time: opts.releaseTime,
      event_time: opts.eventTime,
      raw_json: opts.rawJson ?? null,
      symbol: opts.symbol,
      security_id: opts.securityId,
    });
    return Number(lastInsertRowid);
  }

  function getRow(id: number) {
    return db
      .prepare(
        `SELECT actual_value, enriched_at, enrichment_attempted_at
           FROM calendar_events WHERE id = ?`,
      )
      .get(id) as {
      actual_value: string | null;
      enriched_at: string | null;
      enrichment_attempted_at: string | null;
    };
  }

  it("AMC row clicked at 15:30 ET: writes nothing, pushes nothing, reports the 16:00 slot floor", async () => {
    // release_time says 17:00 — for an AMC name that is very often the CALL
    // time, not the print. The floor asks the knowable question instead.
    const eventId = seedEarnings({
      securityId: 400,
      symbol: "CRWX",
      releaseTime: "17:00",
      eventTime: "AMC",
    });

    const results = await runEnrichment(db, { eventId, now: ET_1530 });

    expect(results).toHaveLength(1);
    expect(results[0].reason).toBe("pre_print");
    expect(results[0].enriched).toBe(false);
    expect(results[0].actual).toBeNull();
    expect(results[0].prePrint?.basis).toBe("slot");
    expect(results[0].prePrint?.slot).toBe("amc");
    expect(results[0].prePrint?.floor?.toISOString()).toBe(
      "2026-08-27T20:00:00.000Z", // 16:00 ET
    );
    expect(results[0].prePrint?.eventDate).toBe(EVENT_DATE);

    const row = getRow(eventId);
    expect(row.actual_value).toBeNull();
    expect(row.enriched_at).toBeNull();
    expect(row.enrichment_attempted_at).toBeNull(); // never even attempted
    expect(mockSendEarningsPrintPush).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("same AMC row at 16:12 ET: proceeds exactly as before (actual written, push fired)", async () => {
    const eventId = seedEarnings({
      securityId: 401,
      symbol: "CRWY",
      releaseTime: "17:00",
      eventTime: "AMC",
    });

    const results = await runEnrichment(db, { eventId, now: ET_1612 });

    expect(results[0].reason).toBeUndefined();
    expect(getRow(eventId).actual_value).toContain("EPS 1.42");
    expect(mockSendEarningsPrintPush).toHaveBeenCalledTimes(1);
  });

  it("derives the AMC slot from the vendor raw_json hour when event_time is null", async () => {
    const eventId = seedEarnings({
      securityId: 402,
      symbol: "CRWZ",
      releaseTime: "17:00",
      eventTime: null,
      rawJson: JSON.stringify({ entry: { hour: "amc" } }),
    });

    const results = await runEnrichment(db, { eventId, now: ET_1530 });
    expect(results[0].reason).toBe("pre_print");
    expect(results[0].prePrint?.slot).toBe("amc");
  });

  it("BMO row: refused at 06:59 ET, allowed at 07:00 ET", async () => {
    const eventId = seedEarnings({
      securityId: 403,
      symbol: "BMOX",
      releaseTime: "08:00",
      eventTime: "BMO",
    });

    const early = await runEnrichment(db, { eventId, now: ET_0659 });
    expect(early[0].reason).toBe("pre_print");
    expect(early[0].prePrint?.slot).toBe("bmo");
    expect(early[0].prePrint?.floor?.toISOString()).toBe(
      "2026-08-27T11:00:00.000Z", // 07:00 ET
    );
    expect(getRow(eventId).enrichment_attempted_at).toBeNull();

    const onFloor = await runEnrichment(db, { eventId, now: ET_0700 });
    expect(onFloor[0].reason).toBeUndefined();
    expect(getRow(eventId).actual_value).toContain("EPS 1.42");
  });

  it("TAS row falls back to release_time behaviour (no slot to floor on)", async () => {
    const eventId = seedEarnings({
      securityId: 404,
      symbol: "TASX",
      releaseTime: "17:00",
      eventTime: "TAS",
    });

    const before = await runEnrichment(db, { eventId, now: ET_1612 });
    expect(before[0].reason).toBe("pre_print");
    expect(before[0].prePrint?.basis).toBe("release_time");
    expect(before[0].prePrint?.slot).toBeNull();
    expect(before[0].prePrint?.release?.toISOString()).toBe(
      "2026-08-27T21:00:00.000Z", // 17:00 ET
    );

    const after = await runEnrichment(db, { eventId, now: ET_1705 });
    expect(after[0].reason).toBeUndefined();
    expect(getRow(eventId).actual_value).toContain("EPS 1.42");
  });

  it("a macro row keeps release_time semantics (no BMO/AMC notion to floor on)", async () => {
    const { lastInsertRowid } = insertEvent(db, {
      source: "claude_macro",
      source_key: `fred:10:${EVENT_DATE}`,
      event_type: "cpi",
      event_date: EVENT_DATE,
      release_time: "08:30",
    });
    const eventId = Number(lastInsertRowid);

    // 06:59 ET — before the 08:30 release. A slot read of "08:30" would have
    // called this a BMO row and let it through on the 07:00 floor.
    const results = await runEnrichment(db, { eventId, now: ET_0659 });
    expect(results[0].reason).toBe("pre_print");
    expect(results[0].prePrint?.basis).toBe("release_time");
    expect(getRow(eventId).enrichment_attempted_at).toBeNull();
  });

  it("REGRESSION: the windowed sweep is NOT floored — an early print pulled to 06:30 still enriches", async () => {
    // The wire probe pulls release_time to the observed print instant when a
    // BMO name prints early. That row is past its release and inside the
    // sweep window; the slot floor (07:00) must not reach it.
    const eventId = seedEarnings({
      securityId: 405,
      symbol: "EARL",
      releaseTime: "06:30",
      eventTime: "BMO",
    });

    const results = await runEnrichment(db, {
      now: new Date("2026-08-27T10:40:00Z"), // 06:40 ET, 10 min after the print
    });

    expect(results.map((r) => r.eventId)).toContain(eventId);
    expect(results.find((r) => r.eventId === eventId)?.reason).toBeUndefined();
    expect(getRow(eventId).actual_value).toContain("EPS 1.42");
  });
});
