/**
 * A foreign-listing echo contributes the DATE only (2026-10-24).
 *
 * Finnhub resolves an ADR query to the local listing (TSM -> 2330.TW) and its
 * `hour` is read against the HOME exchange's session: 2330.TW reports after
 * the Taiwan close, which is before the US open. Storing that hour moved TSM
 * to "4:15 PM after the close" on a refresh and let the chip read "confirmed
 * by Finnhub + Nasdaq" on a slot only Nasdaq gave. So an echoed row carries
 * no hour label and no vendor hour in raw_json: the slot comes from Nasdaq
 * (pickSameDateWinner prefers a row with a real slot) or stays unknown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fetchFinnhubEarningsForSymbols } from "@/lib/calendar/finnhub";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";

describe("fetchFinnhubEarningsForSymbols — a foreign echo gives the date only", () => {
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

  const mock = (entry: Record<string, unknown>) => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ earningsCalendar: [entry] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
  };

  it("drops the home-exchange hour: no hour label, no slot from raw_json, the date kept", async () => {
    mock({ symbol: "2330.TW", date: "2026-07-16", hour: "amc", quarter: 2, year: 2026, epsEstimate: 24.5, revenueEstimate: 1e12 });
    const [ev] = await fetchFinnhubEarningsForSymbols(db, ["TSM"], "2026-07-13", "2026-07-19", "2026-07-13");
    expect(ev.symbol).toBe("TSM");
    expect(ev.event_date).toBe("2026-07-16");
    expect(ev.title).toBe("TSM earnings");
    expect(ev.title).not.toMatch(/Market/);
    expect(deriveEarningsSlot({ event_time: ev.event_time ?? null, raw_json: ev.raw_json ?? null })).toBeNull();
    // The echo itself is still recorded for debugging.
    expect(ev.raw_json).toContain("2330.TW");
    expect(JSON.parse(ev.raw_json!)).toMatchObject({ foreign_echo: true, dropped_hour: "amc" });
  });

  it("an exact echo keeps its hour", async () => {
    mock({ symbol: "NVDA", date: "2026-07-15", hour: "amc", quarter: 2, year: 2026, epsEstimate: 0.65, revenueEstimate: 4.6e10 });
    const [ev] = await fetchFinnhubEarningsForSymbols(db, ["NVDA"], "2026-07-13", "2026-07-19", "2026-07-13");
    expect(ev.title).toBe("NVDA earnings (After Market Close)");
    expect(deriveEarningsSlot({ event_time: ev.event_time ?? null, raw_json: ev.raw_json ?? null })).toBe("amc");
  });
});
