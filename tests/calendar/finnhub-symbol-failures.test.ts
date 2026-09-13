/**
 * Per-symbol Finnhub calendar-fetch failures must reach the caller
 * (nightly QA ledger finding
 * `today-earningshub-refresh--silent-partial-failure-no-outcome-report-regression-3`,
 * the third re-file of the same symptom).
 *
 * Repro: 17 of 77 per-symbol calendar fetches came back HTTP 429 ("Too many
 * requests"). The server log got 17 `[finnhub] calendar fetch failed …`
 * lines, but the loop swallowed every one into console.warn and still
 * advanced onProgress, so the Earnings Hub showed "Finnhub 77/77 scanned"
 * and then "Refreshed — 5 new". A fifth of the universe was never scanned
 * and nothing said so.
 *
 * Fix: an OPTIONAL 7th parameter — `onSymbolFailure` — reports each
 * swallowed failure, pre-classified (`rateLimited` when the message carries
 * a 429). The return type is unchanged (`CalendarEventInput[]`) and callers
 * that don't pass the callback behave exactly as before.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  fetchFinnhubEarningsForSymbols,
  type FinnhubSymbolFailure,
} from "@/lib/calendar/finnhub";

describe("fetchFinnhubEarningsForSymbols — per-symbol failure reporting", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.FINNHUB_API_KEY;
  });

  const httpError = (status: number, body: string) => ({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  });

  const httpOk = (payload: unknown) => ({
    ok: true,
    status: 200,
    json: async () => payload,
  });

  it("reports a 429 as rate-limited while the healthy symbol's rows still come back", async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      // Phase A, symbol 1 of 2 — rate limited.
      .mockResolvedValueOnce(httpError(429, "Too many requests"))
      // Phase A, symbol 2 of 2 — a real hit.
      .mockResolvedValueOnce(
        httpOk({
          earningsCalendar: [
            {
              symbol: "BBB",
              date: "2026-07-15",
              hour: "amc",
              quarter: 2,
              year: 2026,
              epsEstimate: 1.25,
              epsActual: null,
              revenueEstimate: null,
              revenueActual: null,
            },
          ],
        }),
      )
      // Phase B, surprise history for the hit.
      .mockResolvedValueOnce(httpOk([]));

    const failures: FinnhubSymbolFailure[] = [];
    const events = await fetchFinnhubEarningsForSymbols(
      db,
      ["AAA", "BBB"],
      "2026-07-13",
      "2026-07-19",
      "2026-07-13",
      undefined,
      (failure) => failures.push(failure),
    );

    // The successful symbol is unaffected — one symbol's 429 never aborts
    // the scan (that behaviour is deliberate and preserved).
    expect(events).toHaveLength(1);
    expect(events[0].symbol).toBe("BBB");

    // ...but the failure is no longer invisible.
    expect(failures).toHaveLength(1);
    expect(failures[0].symbol).toBe("AAA");
    expect(failures[0].rateLimited).toBe(true);
    expect(failures[0].message).toContain("429");
  });

  it("classifies a non-429 failure as not rate-limited", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      httpError(503, "Service unavailable"),
    );

    const failures: FinnhubSymbolFailure[] = [];
    await fetchFinnhubEarningsForSymbols(
      db,
      ["AAA"],
      "2026-07-13",
      "2026-07-19",
      "2026-07-13",
      undefined,
      (failure) => failures.push(failure),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0].symbol).toBe("AAA");
    expect(failures[0].rateLimited).toBe(false);
    expect(failures[0].message).toContain("503");
  });

  it("reports the failure BEFORE ticking progress for that symbol — sync.ts subtracts failures from `done`", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      httpError(429, "Too many requests"),
    );

    const log: string[] = [];
    await fetchFinnhubEarningsForSymbols(
      db,
      ["AAA"],
      "2026-07-13",
      "2026-07-19",
      "2026-07-13",
      (done, total) => log.push(`progress ${done}/${total}`),
      (failure) => log.push(`failure ${failure.symbol}`),
    );

    expect(log).toEqual(["failure AAA", "progress 1/1"]);
  });

  it("keeps the console.warn line for the server log", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      httpError(429, "Too many requests"),
    );

    await fetchFinnhubEarningsForSymbols(
      db,
      ["AAA"],
      "2026-07-13",
      "2026-07-19",
      "2026-07-13",
    );

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining("[finnhub] calendar fetch failed for AAA"),
    );
  });

  it("still resolves normally for a caller that passes no failure callback (back-compat)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      httpError(429, "Too many requests"),
    );

    await expect(
      fetchFinnhubEarningsForSymbols(db, ["AAA"], "2026-07-13", "2026-07-19", "2026-07-13"),
    ).resolves.toEqual([]);
  });
});
