/**
 * Unit tests for lib/calendar/enrich-actuals.ts
 *
 * Focus: source_key parsing + dispatcher correctness. The actual
 * FRED/Finnhub/Claude fetches are mocked at the global fetch layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseSourceKey, fetchActualForEvent } from "@/lib/calendar/enrich-actuals";

describe("parseSourceKey", () => {
  it("parses fred:<releaseId>:<date>", () => {
    const p = parseSourceKey("fred:10:2026-04-11");
    expect(p).toEqual({ kind: "fred", releaseId: 10, date: "2026-04-11" });
  });

  it("parses fomc:<date>", () => {
    expect(parseSourceKey("fomc:2026-04-29")).toEqual({
      kind: "fomc",
      date: "2026-04-29",
    });
  });

  it("parses finnhub:<symbol>:<date>", () => {
    expect(parseSourceKey("finnhub:NVDA:2026-05-21")).toEqual({
      kind: "finnhub",
      symbol: "NVDA",
      date: "2026-05-21",
    });
  });

  it("parses nonfred:<shortName>:<date> and unescapes underscores", () => {
    expect(parseSourceKey("nonfred:ISM_Manufacturing:2026-05-01")).toEqual({
      kind: "nonfred",
      shortName: "ISM Manufacturing",
      date: "2026-05-01",
    });
  });

  it("returns unknown for malformed keys", () => {
    expect(parseSourceKey("bogus:99")).toEqual({ kind: "unknown" });
    expect(parseSourceKey("")).toEqual({ kind: "unknown" });
  });
});

describe("fetchActualForEvent — dispatcher", () => {
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

  it("passes consensus_estimate through from the row when source is fred", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        observations: [
          { date: "2026-04-01", value: "310.326" },
          { date: "2026-03-01", value: "309.685" },
          // 12 months prior for YoY
          { date: "2025-04-01", value: "300.84" },
          { date: "2025-03-01", value: "299.50" },
        ],
      }),
    });

    const result = await fetchActualForEvent(db, {
      id: 1,
      source: "claude_macro",
      source_key: "fred:10:2026-04-11",
      event_type: "cpi",
      event_date: "2026-04-11",
      release_time: "08:30",
      symbol: null,
      title: "March CPI",
      consensus_estimate: "3.2%",
      raw_json: null,
    });

    expect(result.source).toBe("fred");
    expect(result.consensus).toBe("3.2%");
    // (310.326 - 300.84) / 300.84 * 100 = 3.15%, rounded to 3.2%.
    expect(result.actual).toMatch(/^\d\.\d%$/);
  });

  it("returns null actual but keeps consensus for unknown source_keys", async () => {
    const result = await fetchActualForEvent(db, {
      id: 1,
      source: "manual",
      source_key: "manual:arbitrary-event",
      event_type: "other",
      event_date: "2026-04-11",
      release_time: null,
      symbol: null,
      title: "Arbitrary",
      consensus_estimate: "keep me",
      raw_json: null,
    });

    expect(result.actual).toBeNull();
    expect(result.consensus).toBe("keep me");
    expect(result.source).toBe("unknown");
  });

  it("fetches Finnhub actual for earnings events", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            symbol: "NVDA",
            date: "2026-05-21",
            epsActual: 0.65,
            epsEstimate: 0.60,
            revenueActual: 46000000000,
            revenueEstimate: 43000000000,
          },
        ],
      }),
    });

    const result = await fetchActualForEvent(db, {
      id: 1,
      source: "finnhub",
      source_key: "finnhub:NVDA:2026-05-21",
      event_type: "earnings",
      event_date: "2026-05-21",
      release_time: "16:15",
      symbol: "NVDA",
      title: "NVDA earnings",
      consensus_estimate: "EPS 0.60",
      raw_json: null,
    });

    expect(result.source).toBe("finnhub");
    expect(result.actual).toContain("EPS 0.65");
    expect(result.actual).toContain("Rev 46,000,000,000");
    // Finnhub's fresh consensus wins over the row's stale consensus.
    expect(result.consensus).toContain("EPS 0.60");
  });

  it("returns null when FRED release_id is not mapped", async () => {
    const result = await fetchActualForEvent(db, {
      id: 1,
      source: "claude_macro",
      source_key: "fred:99999:2026-04-11",
      event_type: "other_macro",
      event_date: "2026-04-11",
      release_time: "10:00",
      symbol: null,
      title: "Unmapped release",
      consensus_estimate: null,
      raw_json: null,
    });

    expect(result.actual).toBeNull();
    expect(result.source).toBe("unknown");
  });

  it("returns null actual when FRED API is unreachable", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await fetchActualForEvent(db, {
      id: 1,
      source: "claude_macro",
      source_key: "fred:10:2026-04-11",
      event_type: "cpi",
      event_date: "2026-04-11",
      release_time: "08:30",
      symbol: null,
      title: "March CPI",
      consensus_estimate: "3.2%",
      raw_json: null,
    });

    expect(result.actual).toBeNull();
    expect(result.consensus).toBe("3.2%");
    expect(result.source).toBe("fred");
  });
});
