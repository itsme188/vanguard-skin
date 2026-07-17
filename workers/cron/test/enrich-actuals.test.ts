/**
 * Tests for workers/cron/src/enrich-actuals.ts::formatFredValue — the
 * Worker mirror of lib/calendar/enrich-actuals.ts. Cases are identical to
 * tests/calendar/enrich-actuals.test.ts (Mac side) so the two formatters
 * can never drift: same observation in, same rendered string out.
 *
 * Values are REAL FRED observations (verified live 2026-06-11). The
 * 2026-06-11 deep-QA sweep caught the old `level_k` formatter appending
 * "K" to raw-count series and rendering deltas for level-quoted series.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchActualForEventCloud, fetchFredSeriesLatest, formatFredValue, RELEASE_ID_TO_SERIES } from "../src/enrich-actuals";

const obs = (value: number, priorValue: number | null = null) => ({
  value,
  date: "2026-06-06",
  priorValue,
  priorYearValue: null as number | null,
});

describe("formatFredValue — count/level semantics (Worker mirror)", () => {
  it("renders Initial Claims as the LEVEL in K (raw-count series)", () => {
    expect(formatFredValue(obs(229000, 225000), { formatAs: "level_count", unitScale: 1 }))
      .toBe("229K");
  });

  it("renders Existing Home Sales as the level in M (raw-count series)", () => {
    expect(formatFredValue(obs(4170000, 4040000), { formatAs: "level_count", unitScale: 1 }))
      .toBe("4.17M");
  });

  it("scales thousands-denominated levels to M (Housing Starts)", () => {
    expect(formatFredValue(obs(1465, 1507), { formatAs: "level_count", unitScale: 1000 }))
      .toBe("1.47M");
  });

  it("keeps sub-million thousands-denominated levels in K (New Home Sales)", () => {
    expect(formatFredValue(obs(622, 663), { formatAs: "level_count", unitScale: 1000 }))
      .toBe("622K");
  });

  it("renders JOLTS openings as the level in M", () => {
    expect(formatFredValue(obs(7618, 6887), { formatAs: "level_count", unitScale: 1000 }))
      .toBe("7.62M");
  });

  it("renders payrolls as a signed monthly delta in K (delta convention)", () => {
    expect(formatFredValue(obs(159001, 158829), { formatAs: "delta_k", unitScale: 1000 }))
      .toBe("+172K");
  });

  it("renders negative payroll deltas with a minus sign", () => {
    expect(formatFredValue(obs(158650, 158829), { formatAs: "delta_k", unitScale: 1000 }))
      .toBe("-179K");
  });

  it("renders raw-persons delta series in K (monthly ADP)", () => {
    expect(formatFredValue(obs(134500000, 134458000), { formatAs: "delta_k", unitScale: 1 }))
      .toBe("+42K");
  });

  it("returns null for delta_k with no prior observation (never a bare level)", () => {
    expect(formatFredValue(obs(159001, null), { formatAs: "delta_k", unitScale: 1000 }))
      .toBeNull();
  });

  it("renders trade balance in signed $B (millions-of-dollars series)", () => {
    expect(formatFredValue(obs(-55881, -56585), { formatAs: "usd_millions" }))
      .toBe("-$55.9B");
  });
});

describe("RELEASE_ID_TO_SERIES — units-verified config (Worker mirror)", () => {
  it("pins ICSA as a level-quoted raw-count series", () => {
    expect(RELEASE_ID_TO_SERIES[180]).toEqual({
      seriesId: "ICSA", formatAs: "level_count", unitScale: 1,
    });
  });

  it("uses the MONTHLY ADP series (weekly raw series can't produce the headline)", () => {
    expect(RELEASE_ID_TO_SERIES[194].seriesId).toBe("ADPMNUSNERSA");
    expect(RELEASE_ID_TO_SERIES[194].formatAs).toBe("delta_k");
  });

  it("pins trade balance as millions-of-USD", () => {
    expect(RELEASE_ID_TO_SERIES[51].formatAs).toBe("usd_millions");
  });

  it("pins PPI to the headline Final Demand series, not All Commodities", () => {
    // Parity with the Mac case: press/consensus quote PPI Final Demand
    // (PPIFIS, release 46 membership verified via FRED /series/release
    // 2026-06-12); PPIACO all-commodities YoY matches no published headline.
    expect(RELEASE_ID_TO_SERIES[46]).toEqual({ seriesId: "PPIFIS", formatAs: "pct_yoy" });
  });
});

describe("fetchFredSeriesLatest — priorYear selection (Worker mirror)", () => {
  // Identical fixture to the Mac case: real PPIACO observations, ALFRED
  // vintage 2026-06-11. Desc order puts the 11-months-back row (2025-06)
  // ahead of the true year-ago row (2025-05); a first-match 11–13-month
  // window scan picks the wrong YoY base.
  const PPIACO_DESC: Array<[string, string]> = [
    ["2026-05-01", "292.504"], ["2026-04-01", "282.700"], ["2026-03-01", "275.979"],
    ["2026-02-01", "269.553"], ["2026-01-01", "263.608"], ["2025-12-01", "261.333"],
    ["2025-11-01", "261.914"], ["2025-10-01", "260.591"], ["2025-09-01", "262.054"],
    ["2025-08-01", "262.110"], ["2025-07-01", "262.358"], ["2025-06-01", "260.491"],
    ["2025-05-01", "258.678"], ["2025-04-01", "258.392"],
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes YoY against the exact 12-months-back observation, not 11", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        observations: PPIACO_DESC.map(([date, value]) => ({ date, value })),
      }),
    });

    const result = await fetchFredSeriesLatest("test_key", "PPIACO", "2026-06-11", "2026-06-11");
    expect(result?.value).toBe(292.504);
    // 2025-05 (12 months back), NOT 2025-06 (11 months back).
    expect(result?.priorYearValue).toBe(258.678);
  });

  it("falls back to a near-12-month observation when the exact month is missing", async () => {
    const withHole = PPIACO_DESC.filter(([date]) => date !== "2025-05-01");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        observations: withHole.map(([date, value]) => ({ date, value })),
      }),
    });

    const result = await fetchFredSeriesLatest("test_key", "PPIACO", "2026-06-11", "2026-06-11");
    expect(result?.priorYearValue).toBe(260.491); // 2025-06, nearest in-window row
  });
});

describe("fetchActualForEventCloud — Finnhub foreign-listing echo guard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops figures when Finnhub echoes a foreign listing (TSM → 2330.TW)", async () => {
    // Finnhub resolves ADR queries to the LOCAL listing with local-currency
    // figures (verified live 2026-07-16: querying "TSM" returns "2330.TW"
    // with TWD-scale epsEstimate 24.57 / revenue 1.28 trillion). The
    // Worker's strict symbol match is the INTENTIONAL guard — figures from
    // a mismatched echo are local-currency and must never be stored as USD.
    // Mirrors the Mac-side rule in lib/calendar/enrich-actuals.ts (pinned
    // in tests/calendar/enrich-actuals.test.ts).
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            symbol: "2330.TW",
            date: "2026-07-16",
            epsActual: 138.87,
            epsEstimate: 24.5662,
            revenueActual: 1295316420999,
            revenueEstimate: 1279497062904,
          },
        ],
      }),
    });

    const result = await fetchActualForEventCloud(
      {
        source_key: "finnhub:TSM:2026-07-16",
        event_date: "2026-07-16",
        consensus_estimate: "EPS 3.80",
      },
      { FINNHUB_API_KEY: "test_key" },
    );

    expect(result.source).toBe("finnhub");
    expect(result.actual).toBeNull();
    // The row's existing (USD) consensus survives the null fresh-consensus.
    expect(result.consensus).toBe("EPS 3.80");
  });

  it("uses figures when Finnhub echoes the queried symbol exactly", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            symbol: "NVDA",
            date: "2026-05-21",
            epsActual: 0.65,
            epsEstimate: 0.6,
            revenueActual: 46000000000,
            revenueEstimate: 43000000000,
          },
        ],
      }),
    });

    const result = await fetchActualForEventCloud(
      {
        source_key: "finnhub:NVDA:2026-05-21",
        event_date: "2026-05-21",
        consensus_estimate: "EPS 0.60",
      },
      { FINNHUB_API_KEY: "test_key" },
    );

    expect(result.actual).toContain("EPS 0.65");
    expect(result.consensus).toContain("EPS 0.60");
  });
});
