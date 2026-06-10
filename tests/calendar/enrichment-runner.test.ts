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
import { runEnrichment } from "@/lib/calendar/enrichment-runner";

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
    opts.release_time,
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
});
