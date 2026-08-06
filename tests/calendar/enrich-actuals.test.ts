/**
 * Unit tests for lib/calendar/enrich-actuals.ts
 *
 * Focus: source_key parsing + dispatcher correctness. The actual
 * FRED/Finnhub/Claude fetches are mocked at the global fetch layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  parseSourceKey,
  fetchActualForEvent,
  fetchFredSeriesLatest,
  formatFredValue,
  RELEASE_ID_TO_SERIES,
  probeFinnhubActualExists,
  probeFinnhubActualExistsStrict,
} from "@/lib/calendar/enrich-actuals";

// ── formatFredValue — units + level/delta semantics ──────────────────
//
// Values below are REAL FRED observations (verified live 2026-06-11).
// The 2026-06-11 deep-QA sweep caught the old `level_k` formatter
// (a) appending "K" to raw-count series (ICSA is "Number", not thousands
// → "+4,000K" = 4M jobless claims) and (b) rendering deltas for series
// the press quotes as levels (claims, home sales, JOLTS, starts).

const obs = (value: number, priorValue: number | null = null) => ({
  value,
  date: "2026-06-06",
  priorValue,
  priorYearValue: null as number | null,
});

describe("formatFredValue — count/level semantics", () => {
  it("renders Initial Claims as the LEVEL in K (raw-count series)", () => {
    // ICSA week ending 2026-06-06: 229,000 (prior 225,000). Old code
    // emitted the WoW delta "+4,000K" — 4 million claims.
    expect(formatFredValue(obs(229000, 225000), { formatAs: "level_count", unitScale: 1 }))
      .toBe("229K");
  });

  it("renders Existing Home Sales as the level in M (raw-count series)", () => {
    // May 2026: 4,170,000 SAAR (prior 4,040,000). Old: "+130,000K".
    expect(formatFredValue(obs(4170000, 4040000), { formatAs: "level_count", unitScale: 1 }))
      .toBe("4.17M");
  });

  it("scales thousands-denominated levels to M (Housing Starts)", () => {
    // April 2026: 1,465 thousand SAAR. Old: "-42K" (the MoM delta).
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
    // PAYEMS May 2026: 159,001K (prior 158,829K) → +172K jobs.
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
    // BOPGSTB April 2026: -55,881 ($M). Old: "-55,881" with no unit.
    expect(formatFredValue(obs(-55881, -56585), { formatAs: "usd_millions" }))
      .toBe("-$55.9B");
  });
});

describe("RELEASE_ID_TO_SERIES — units-verified config", () => {
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
    // The press / consensus quote PPI *Final Demand* (PPIFIS, release 46
    // membership verified via FRED /series/release 2026-06-12). PPIACO is
    // the legacy all-commodities basket — May 2026 prints +13.1% YoY where
    // the final-demand headline is +6.4%; a stored PPIACO YoY matches no
    // number the user will ever read.
    expect(RELEASE_ID_TO_SERIES[46]).toEqual({ seriesId: "PPIFIS", formatAs: "pct_yoy" });
  });
});

describe("fetchFredSeriesLatest — priorYear selection", () => {
  // Real PPIACO observations, ALFRED vintage 2026-06-11 (probed live
  // 2026-06-12). FRED returns EVERY month in desc order, so an
  // 11-months-back row (2025-06) sits ahead of the true year-ago row
  // (2025-05). The sparse mocks in the dispatcher tests above hid this:
  // a "first match in 11–13 months" scan computed the 6/11 PPI YoY
  // against June 2025 (12.3%) instead of May 2025 (13.1%).
  const PPIACO_DESC: Array<[string, string]> = [
    ["2026-05-01", "292.504"], ["2026-04-01", "282.700"], ["2026-03-01", "275.979"],
    ["2026-02-01", "269.553"], ["2026-01-01", "263.608"], ["2025-12-01", "261.333"],
    ["2025-11-01", "261.914"], ["2025-10-01", "260.591"], ["2025-09-01", "262.054"],
    ["2025-08-01", "262.110"], ["2025-07-01", "262.358"], ["2025-06-01", "260.491"],
    ["2025-05-01", "258.678"], ["2025-04-01", "258.392"],
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    process.env.FRED_API_KEY = "test_fred_key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRED_API_KEY;
  });

  it("computes YoY against the exact 12-months-back observation, not 11", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        observations: PPIACO_DESC.map(([date, value]) => ({ date, value })),
      }),
    });

    const result = await fetchFredSeriesLatest("PPIACO", "2026-06-11", "2026-06-11");
    expect(result?.value).toBe(292.504);
    // 2025-05 (12 months back), NOT 2025-06 (11 months back).
    expect(result?.priorYearValue).toBe(258.678);
  });

  it("falls back to a near-12-month observation when the exact month is missing", async () => {
    // Vintage holes happen (a month can be absent from an old ALFRED
    // vintage). Better an 11-month YoY than none — but only when 12 is
    // genuinely unavailable.
    const withHole = PPIACO_DESC.filter(([date]) => date !== "2025-05-01");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        observations: withHole.map(([date, value]) => ({ date, value })),
      }),
    });

    const result = await fetchFredSeriesLatest("PPIACO", "2026-06-11", "2026-06-11");
    expect(result?.priorYearValue).toBe(260.491); // 2025-06, the nearest in-window row
  });
});

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

  // Manual earnings rows — the "+ Add ticker" flow AND every date/slot
  // correction (minted manual precisely so sync can't clobber it) — used to
  // fall through to "unknown", so they never fetched actuals: no recap, no
  // push-at-print, for exactly the events the user curated by hand. They ride
  // the same Finnhub symbol+date road as a vendor earnings row.
  it("routes manual EARNINGS keys down the finnhub road", () => {
    expect(parseSourceKey("manual:RKT:2026-08-06:earnings")).toEqual({
      kind: "finnhub",
      symbol: "RKT",
      date: "2026-08-06",
    });
  });

  it("leaves non-earnings manual keys unknown", () => {
    expect(parseSourceKey("manual:UMICH:2026-08-06:other_macro")).toEqual({ kind: "unknown" });
    expect(parseSourceKey("manual:arbitrary-event")).toEqual({ kind: "unknown" });
  });

  // Nasdaq-only earnings rows (Finnhub's calendar missed the name, Nasdaq's
  // caught it — the RKT 7/30 / XMTR+WIX 8/04 population) used to fall through
  // to "unknown": the runner retried every tick but never fetched an actual,
  // so the recap gate never opened and the blocked-recap Pushover fired 2h
  // after every such print. Same disease, same cure as the manual: keys.
  it("routes nasdaq keys down the finnhub road", () => {
    expect(parseSourceKey("nasdaq:XMTR:2026-08-04")).toEqual({
      kind: "finnhub",
      symbol: "XMTR",
      date: "2026-08-04",
    });
  });

  it("leaves malformed nasdaq keys unknown", () => {
    expect(parseSourceKey("nasdaq:XMTR")).toEqual({ kind: "unknown" });
    expect(parseSourceKey("nasdaq:XMTR:not-a-date")).toEqual({ kind: "unknown" });
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

    // Vintage must be pinned to the event date (ALFRED realtime params) so
    // a late re-run can never pick up later-published observations or
    // revisions — the stored actual is the release-day first print.
    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("realtime_start=2026-04-11");
    expect(calledUrl).toContain("realtime_end=2026-04-11");
  });

  it("falls back to prior-month-end capping when a series has no ALFRED vintages", async () => {
    // First call (vintage-pinned) 400s — EXHOSLUSM495S-style licensed
    // series. Second call must drop realtime params and cap observation_end
    // at the end of the month BEFORE the event, so a later-published month
    // can never leak in.
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          observations: [
            { date: "2026-05-01", value: "4170000" },
            { date: "2026-04-01", value: "4040000" },
          ],
        }),
      });

    const result = await fetchActualForEvent(db, {
      id: 1,
      source: "claude_macro",
      source_key: "fred:291:2026-06-09",
      event_type: "housing",
      event_date: "2026-06-09",
      release_time: "10:00",
      symbol: null,
      title: "May Existing Home Sales",
      consensus_estimate: null,
      raw_json: null,
    });

    expect(result.actual).toBe("4.17M");
    const fallbackUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(fallbackUrl).toContain("observation_end=2026-05-31");
    expect(fallbackUrl).not.toContain("realtime_start");
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

  it("fetches Finnhub actual for a MANUAL earnings row (corrected / hand-added)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            symbol: "RKT",
            date: "2026-08-06",
            epsActual: 0.09,
            epsEstimate: 0.07,
            revenueActual: 1300000000,
            revenueEstimate: 1250000000,
          },
        ],
      }),
    });

    const result = await fetchActualForEvent(db, {
      id: 1,
      source: "manual",
      source_key: "manual:RKT:2026-08-06:earnings",
      event_type: "earnings",
      event_date: "2026-08-06",
      release_time: "16:15",
      symbol: "RKT",
      title: "RKT earnings (Manual entry)",
      consensus_estimate: "EPS 0.07",
      raw_json: null,
    });

    expect(result.source).toBe("finnhub");
    expect(result.actual).toContain("EPS 0.09");
    // The symbol+date came from the source_key, so the request targeted the
    // corrected date — not the wrong vendor one the correction replaced.
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("symbol=RKT");
    expect(url).toContain("from=2026-08-06");
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

  it("drops figures when Finnhub echoes a foreign listing (TSM → 2330.TW): local currency is untrusted", async () => {
    // Finnhub resolves ADR queries to the LOCAL listing: querying "TSM"
    // returns symbol "2330.TW" with TWD-scale figures (verified live
    // 2026-07-16 — epsActual 138.87, revenueEstimate 1.28 trillion). The
    // schedule is trustworthy; the FIGURES are local-currency and must
    // never be stored as USD. Supersedes the earlier date-only match
    // (GFL → GFL.TO), which let TWD estimates reach the email scoreboard
    // as "$1275.55B". Foreign-listed names now rely on the Nasdaq scan /
    // bogeys for consensus and the blocked-recap → manual-actuals flow
    // for actuals ("better no email than a wrong one").
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

    const result = await fetchActualForEvent(db, {
      id: 1,
      source: "finnhub",
      source_key: "finnhub:TSM:2026-07-16",
      event_type: "earnings",
      event_date: "2026-07-16",
      release_time: "08:00",
      symbol: "TSM",
      title: "TSM earnings",
      consensus_estimate: "EPS 3.80",
      raw_json: null,
    });

    expect(result.source).toBe("finnhub");
    // No TWD figures — actual stays null so the recap gate holds.
    expect(result.actual).toBeNull();
    // The row's existing consensus (Nasdaq-sourced USD) survives.
    expect(result.consensus).toBe("EPS 3.80");
  });

  it("prefers the exact-symbol entry when Finnhub returns both listings on one date", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            symbol: "GFL.TO",
            date: "2026-07-29",
            epsActual: 0.42, // CAD
            epsEstimate: 0.38,
            revenueActual: null,
            revenueEstimate: null,
          },
          {
            symbol: "GFL",
            date: "2026-07-29",
            epsActual: 0.31, // USD
            epsEstimate: 0.28,
            revenueActual: 2100000000,
            revenueEstimate: 2050000000,
          },
        ],
      }),
    });

    const result = await fetchActualForEvent(db, {
      id: 1,
      source: "finnhub",
      source_key: "finnhub:GFL:2026-07-29",
      event_type: "earnings",
      event_date: "2026-07-29",
      release_time: "16:15",
      symbol: "GFL",
      title: "GFL earnings",
      consensus_estimate: "EPS 0.28",
      raw_json: null,
    });

    expect(result.source).toBe("finnhub");
    expect(result.actual).toContain("EPS 0.31");
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
    // Persistent mock (not Once): the vintage-pinned call AND the
    // prior-month-end fallback call both fail when FRED is down.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
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

// Task 1 (wire-time follow-ups, 2026-08-05): fetchFinnhubActual — the
// ACTUALS road reached via fetchActualForEvent/parsed.kind === "finnhub" —
// wrapped the shared fetchFinnhubEntry helper (which THROWS on a missing
// API key / non-ok HTTP response / network failure, precisely so a caller
// can distinguish "Finnhub answered, nothing published yet" from "the fetch
// never really happened") in its own try/catch and collapsed every one of
// those failures into { actual: null, consensus: null } — identical to a
// genuine empty result. Earnings retry-until-complete (migration 062)
// absorbs the behavioral consequence (the row is just retried next tick),
// but the loud error reason is lost, contradicting the bubble-upstream-
// failures convention: a Finnhub outage during the actuals road silently
// looks like "nothing new yet" in every log. Restore propagation so
// runEnrichment's per-event try/catch (lib/calendar/enrichment-runner.ts)
// can log the real reason and skip stamping enrichment_attempted_at, the
// same as it already does for a thrown FRED fetch failure (see "records
// fetch failures without marking the row enriched" in
// tests/calendar/enrichment-runner.test.ts).
describe("fetchActualForEvent — Finnhub actuals road surfaces errors (Task 1)", () => {
  let db: Database.Database;

  const finnhubEvent = {
    id: 1,
    source: "finnhub",
    source_key: "finnhub:XMTR:2026-08-04",
    event_type: "earnings",
    event_date: "2026-08-04",
    release_time: "08:00",
    symbol: "XMTR",
    title: "XMTR earnings",
    consensus_estimate: "EPS 0.05",
    raw_json: null,
  };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.stubGlobal("fetch", vi.fn());
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FINNHUB_API_KEY;
  });

  it("propagates a network failure instead of reporting a legitimate empty", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network down"),
    );
    await expect(fetchActualForEvent(db, finnhubEvent)).rejects.toThrow("network down");
  });

  it("propagates a non-ok HTTP response instead of reporting a legitimate empty", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(fetchActualForEvent(db, finnhubEvent)).rejects.toThrow(/429/);
  });

  it("propagates a missing FINNHUB_API_KEY instead of reporting a legitimate empty", async () => {
    delete process.env.FINNHUB_API_KEY;
    await expect(fetchActualForEvent(db, finnhubEvent)).rejects.toThrow(/FINNHUB_API_KEY/);
  });

  it("still returns a legitimate empty when Finnhub genuinely has no calendar entry", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ earningsCalendar: [] }),
    });
    const result = await fetchActualForEvent(db, finnhubEvent);
    expect(result.actual).toBeNull();
    expect(result.source).toBe("finnhub");
  });

  it("still returns a legitimate empty when the entry exists but has no actual figures yet", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "XMTR", date: "2026-08-04", epsActual: null, epsEstimate: 0.05, revenueActual: null, revenueEstimate: 900 },
        ],
      }),
    });
    const result = await fetchActualForEvent(db, finnhubEvent);
    expect(result.actual).toBeNull();
    expect(result.source).toBe("finnhub");
  });
});

// I2 (final review, 2026-08-04): probeFinnhubActualExists swallows EVERY
// error (network, non-ok HTTP, missing API key) into `false` — the correct
// fail-open behavior for its preview-guard consumer (better a redundant
// preview than a blocked one). But the wire-probe pre-release pass
// interprets a `false` as verified-empty evidence and stamps
// wire_probe_empty_at, feeding the release-time calibration cascade — a
// swallowed 429/outage would fabricate bounded-observation evidence out of
// a probe that never actually ran. probeFinnhubActualExistsStrict is the
// error-propagating sibling built for that consumer.
describe("probeFinnhubActualExistsStrict — error-propagating probe (I2)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FINNHUB_API_KEY;
  });

  it("returns true when Finnhub has published actual figures", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "XMTR", date: "2026-08-04", epsActual: 0.1, epsEstimate: 0.05, revenueActual: 1000, revenueEstimate: 900 },
        ],
      }),
    });
    await expect(probeFinnhubActualExistsStrict("XMTR", "2026-08-04")).resolves.toBe(true);
  });

  it("returns false (not a thrown error) when the calendar entry has no actual yet — legitimate empty", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "XMTR", date: "2026-08-04", epsActual: null, epsEstimate: 0.05, revenueActual: null, revenueEstimate: 900 },
        ],
      }),
    });
    await expect(probeFinnhubActualExistsStrict("XMTR", "2026-08-04")).resolves.toBe(false);
  });

  it("returns false (not a thrown error) when Finnhub's calendar has nothing for the date", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ earningsCalendar: [] }),
    });
    await expect(probeFinnhubActualExistsStrict("XMTR", "2026-08-04")).resolves.toBe(false);
  });

  it("THROWS on a non-ok HTTP response instead of swallowing it (429/outage)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(probeFinnhubActualExistsStrict("XMTR", "2026-08-04")).rejects.toThrow();
  });

  it("THROWS on a network failure instead of swallowing it", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network down"));
    await expect(probeFinnhubActualExistsStrict("XMTR", "2026-08-04")).rejects.toThrow("network down");
  });

  it("THROWS when FINNHUB_API_KEY is missing instead of reporting empty", async () => {
    delete process.env.FINNHUB_API_KEY;
    await expect(probeFinnhubActualExistsStrict("XMTR", "2026-08-04")).rejects.toThrow();
  });
});

// Regression guard: probeFinnhubActualExists (the email-sweep already-
// reported preview guard's consumer) must keep its existing fail-open
// behavior unchanged by the I2 fix above.
describe("probeFinnhubActualExists — unchanged fail-open behavior (regression guard)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    process.env.FINNHUB_API_KEY = "test_finnhub_key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FINNHUB_API_KEY;
  });

  it("still returns false (never throws) on a non-ok HTTP response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(probeFinnhubActualExists("XMTR", "2026-08-04")).resolves.toBe(false);
  });

  it("still returns false (never throws) on a network failure", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network down"));
    await expect(probeFinnhubActualExists("XMTR", "2026-08-04")).resolves.toBe(false);
  });

  it("still returns false (never throws) when FINNHUB_API_KEY is missing", async () => {
    delete process.env.FINNHUB_API_KEY;
    await expect(probeFinnhubActualExists("XMTR", "2026-08-04")).resolves.toBe(false);
  });

  it("still returns true when Finnhub has published actual figures", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "XMTR", date: "2026-08-04", epsActual: 0.1, epsEstimate: 0.05, revenueActual: 1000, revenueEstimate: 900 },
        ],
      }),
    });
    await expect(probeFinnhubActualExists("XMTR", "2026-08-04")).resolves.toBe(true);
  });
});
