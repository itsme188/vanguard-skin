import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  fetchAvEarningsHistory, computePostPrintMoves, summarizeHistory, refreshReportHistory,
  type AvReport,
} from "@/lib/earnings/report-history";
import { getReportHistoryForFamily } from "@/lib/queries/earnings-intel";

const AV_JSON = {
  symbol: "TER",
  quarterlyEarnings: [
    { fiscalDateEnding: "2026-03-31", reportedDate: "2026-04-22", reportedEPS: "1.42",
      estimatedEPS: "1.35", surprise: "0.07", surprisePercentage: "5.1852", reportTime: "post-market" },
    { fiscalDateEnding: "2025-12-31", reportedDate: "2026-01-28", reportedEPS: "1.10",
      estimatedEPS: "None", surprise: "None", surprisePercentage: "None", reportTime: "pre-market" },
  ],
};

function mockFetch(json: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(json), { status: 200 })) as typeof fetch;
}

describe("fetchAvEarningsHistory", () => {
  it("parses numeric strings, maps 'None' → null", async () => {
    const reports = await fetchAvEarningsHistory("TER", { apiKey: "k", fetchImpl: mockFetch(AV_JSON) });
    expect(reports).toHaveLength(2);
    expect(reports[0].reportedEPS).toBeCloseTo(1.42);
    expect(reports[0].surprisePercentage).toBeCloseTo(5.1852, 3);
    expect(reports[1].estimatedEPS).toBeNull();
    expect(reports[1].reportTime).toBe("pre-market");
  });
  it("returns [] on AV error / rate-limit note payload", async () => {
    expect(await fetchAvEarningsHistory("TER", { apiKey: "k", fetchImpl: mockFetch({ Note: "rate limited" }) })).toEqual([]);
  });
  it("sorts defensively newest-first when AV returns out-of-order quarters", async () => {
    // Create 13 quarters in oldest-first order to verify the sort + slice keeps the right 12
    const oldest = "2024-01-31";
    const quarters = Array.from({ length: 13 }, (_, i) => ({
      fiscalDateEnding: `${2025 - Math.floor(i / 4)}-${String((i % 4) * 3 + 1).padStart(2, "0")}-01`,
      reportedDate: new Date(2025, 0, 31 - i).toISOString().slice(0, 10), // YYYY-MM-DD, descending
      reportedEPS: "1.5",
      estimatedEPS: "1.4",
      surprise: "0.1",
      surprisePercentage: "7.1",
      reportTime: "post-market",
    }));
    // Reverse to oldest-first (the bad ordering)
    quarters.reverse();
    const json = { symbol: "TER", quarterlyEarnings: quarters };
    const reports = await fetchAvEarningsHistory("TER", { apiKey: "k", fetchImpl: mockFetch(json) });
    // Should return exactly 12 (the oldest is dropped)
    expect(reports).toHaveLength(12);
    // Should be newest-first: index 0 is the most recent, index 11 is 12 quarters ago
    const newest = reports[0].reportedDate;
    const oldest_kept = reports[11].reportedDate;
    expect(newest > oldest_kept).toBe(true); // String comparison works for YYYY-MM-DD
    // The absolute oldest quarter should NOT be in the result
    expect(reports.find((r) => r.reportedDate === oldest)).toBeUndefined();
  });
});

describe("computePostPrintMoves", () => {
  // Trading days around a Wed 2026-04-22 AMC print and a Wed 2026-01-28 BMO print.
  const closes = [
    { date: "2026-01-27", close: 100 }, { date: "2026-01-28", close: 103 },
    { date: "2026-04-21", close: 120 }, { date: "2026-04-22", close: 121 },
    { date: "2026-04-23", close: 126 },
  ];
  const reports: AvReport[] = [
    { fiscalDateEnding: "2026-03-31", reportedDate: "2026-04-22", reportedEPS: 1.42,
      estimatedEPS: 1.35, surprisePercentage: 5.19, reportTime: "post-market" },
    { fiscalDateEnding: "2025-12-31", reportedDate: "2026-01-28", reportedEPS: 1.1,
      estimatedEPS: 1.0, surprisePercentage: 10, reportTime: "pre-market" },
  ];
  it("AMC: next close vs print-day close; BMO: print-day close vs prior close", () => {
    const rows = computePostPrintMoves(reports, closes);
    expect(rows[0].postPrintMovePct).toBeCloseTo(((126 - 121) / 121) * 100, 3);
    expect(rows[1].postPrintMovePct).toBeCloseTo(3, 3);
  });
  it("unknown reportTime defaults to the AMC convention", () => {
    const rows = computePostPrintMoves(
      [{ ...reports[0], reportTime: null }], closes);
    expect(rows[0].postPrintMovePct).toBeCloseTo(((126 - 121) / 121) * 100, 3);
  });
  it("missing closes → null move, surprise preserved", () => {
    const rows = computePostPrintMoves(reports, []);
    expect(rows[0].postPrintMovePct).toBeNull();
    expect(rows[0].surprisePct).toBeCloseTo(5.19);
  });
  it("AMC print on a non-trading day uses the prior trading day as D", () => {
    // Print date Sat 2026-04-25 → D = 4/23 (last close ≤ date), D+1 missing → null
    const rows = computePostPrintMoves(
      [{ ...reports[0], reportedDate: "2026-04-25" }], closes);
    expect(rows[0].postPrintMovePct).toBeNull();
  });
});

describe("summarizeHistory", () => {
  it("averages |move| and counts beats over rows with both EPS values", () => {
    const rows = [
      { reportedDate: "2026-04-22", fiscalDateEnding: null, epsActual: 1.42, epsEstimate: 1.35, surprisePct: 5, reportTime: null, postPrintMovePct: 4.1 },
      { reportedDate: "2026-01-28", fiscalDateEnding: null, epsActual: 0.9, epsEstimate: 1.0, surprisePct: -10, reportTime: null, postPrintMovePct: -2.3 },
      { reportedDate: "2025-10-28", fiscalDateEnding: null, epsActual: 1.0, epsEstimate: null, surprisePct: null, reportTime: null, postPrintMovePct: null },
    ];
    const s = summarizeHistory(rows);
    expect(s.avgAbsMovePct).toBeCloseTo((4.1 + 2.3) / 2, 3);
    expect(s.beatCount).toBe(1);
    expect(s.missCount).toBe(1);
    expect(s.quarterCount).toBe(3);
  });
  it("empty → null average, zero counts", () => {
    expect(summarizeHistory([])).toEqual({ avgAbsMovePct: null, beatCount: 0, missCount: 0, quarterCount: 0 });
  });
});

describe("refreshReportHistory", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); runMigrations(db); });

  it("fetches AV + Yahoo (DI), writes rows, returns true", async () => {
    // 2026-04-21/22/23 07:00Z → ET calendar dates 2026-04-21/22/23 (straddles the AMC
    // print's reportedDate 2026-04-22, same close pattern as the computePostPrintMoves
    // unit test above). Brief's literal 2025-epoch timestamps decoded a year off from
    // the AV_JSON fixture's 2026 reportedDates, which would silently null out the move
    // instead of exercising it — adjusted the fixture, not the implementation.
    const yahooJson = {
      chart: { result: [{ timestamp: [1776754800, 1776841200, 1776927600],
        indicators: { quote: [{ close: [120, 121, 126] }] } }] },
    };
    let call = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      call++;
      const u = String(url);
      if (u.includes("alphavantage")) return new Response(JSON.stringify(AV_JSON), { status: 200 });
      return new Response(JSON.stringify(yahooJson), { status: 200 });
    }) as typeof fetch;
    const ok = await refreshReportHistory(db, "TER", { apiKey: "k", fetchImpl });
    expect(ok).toBe(true);
    expect(getReportHistoryForFamily(db, "TER").length).toBeGreaterThan(0);
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("no API key → false, no writes, no fetches", async () => {
    const fetchImpl = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    expect(await refreshReportHistory(db, "TER", { apiKey: null, fetchImpl })).toBe(false);
    expect(getReportHistoryForFamily(db, "TER")).toHaveLength(0);
  });
});
