/**
 * Foreign-listing echo guard (2026-07-16).
 *
 * Finnhub resolves ADR queries to the LOCAL listing and returns
 * local-currency figures: querying "TSM" returns symbol "2330.TW" with
 * epsEstimate 24.57 (TWD per local share) and revenueEstimate
 * 1,279,497,062,904 (TWD) — verified live against the API 2026-07-16.
 * Storing those as-is rendered "Cons: $24.10 · $1275.55B" across every
 * calendar surface and leaked into the TSM preview email scoreboard
 * (reconcileEarningsDates COALESCEd the junk onto the canonical manual row).
 *
 * Rule: when entry.symbol !== the queried symbol, the SCHEDULE (date/hour)
 * stays trusted but the FIGURES are local-currency and must be dropped.
 * The Worker mirror already enforces this via its strict symbol match —
 * see workers/cron/test/enrich-actuals.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fetchFinnhubEarningsForSymbols } from "@/lib/calendar/finnhub";

describe("fetchFinnhubEarningsForSymbols — foreign-listing echo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
    delete process.env.FINNHUB_API_KEY;
  });

  const mockResponses = (calendar: unknown, history: unknown = []) => {
    (global.fetch as ReturnType<typeof vi.fn>)
      // Phase A: calendar sweep
      .mockResolvedValueOnce({
        ok: true,
        json: async () => calendar,
      })
      // Phase B: surprise history
      .mockResolvedValueOnce({
        ok: true,
        json: async () => history,
      });
  };

  it("drops local-currency consensus figures when Finnhub echoes a foreign listing (TSM → 2330.TW)", async () => {
    mockResponses({
      earningsCalendar: [
        {
          symbol: "2330.TW",
          date: "2026-07-16",
          hour: "bmo",
          quarter: 2,
          year: 2026,
          epsEstimate: 24.5662, // TWD per local share — NOT USD ADR EPS
          epsActual: null,
          revenueEstimate: 1279497062904, // TWD
          revenueActual: null,
        },
      ],
    });

    const events = await fetchFinnhubEarningsForSymbols(
      db,
      ["TSM"],
      "2026-07-13",
      "2026-07-19",
      "2026-07-13",
    );

    expect(events).toHaveLength(1);
    // Schedule info is trusted: event exists under the queried symbol.
    expect(events[0].symbol).toBe("TSM");
    expect(events[0].event_date).toBe("2026-07-16");
    expect(events[0].title).toContain("Before Market Open");
    // Figures are NOT: local-currency estimates must never be stored.
    expect(events[0].consensus_estimate).toBeNull();
    // Raw echo preserved for debugging.
    expect(events[0].raw_json).toContain("2330.TW");
  });

  it("keeps consensus figures when Finnhub echoes the queried symbol exactly", async () => {
    mockResponses({
      earningsCalendar: [
        {
          symbol: "NVDA",
          date: "2026-07-15",
          hour: "amc",
          quarter: 2,
          year: 2026,
          epsEstimate: 0.65,
          epsActual: null,
          revenueEstimate: 46000000000,
          revenueActual: null,
        },
      ],
    });

    const events = await fetchFinnhubEarningsForSymbols(
      db,
      ["NVDA"],
      "2026-07-13",
      "2026-07-19",
      "2026-07-13",
    );

    expect(events).toHaveLength(1);
    expect(events[0].consensus_estimate).toBe("EPS 0.65 · Rev 46,000,000,000");
  });
});
