/**
 * GET /api/transcripts — read-boundary entity decoding.
 *
 * Regression pin for the deep-QA finding
 * research-notes-transcript-modal--earnings-transcript-renders-raw-html-entities:
 * earnings_transcripts rows cached BEFORE the fetch-time decoder existed
 * (decodeFilingEntities in lib/apis/edgar.ts) still carry raw numeric
 * references (&#160; / &#744;) in their stored transcript text. The route
 * must decode at read time so legacy rows self-heal without a migration —
 * both the Security Detail transcript viewer and the Research → Notes
 * "View Full Transcript" modal render this payload verbatim.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { GET, POST } from "@/app/api/transcripts/route";
import { getEarningsTranscript as getAlphaVantageTranscript } from "@/lib/transcripts/alpha-vantage";
import { getEarnings8KFilings } from "@/lib/apis/edgar";
import { todayET, addDays } from "@/lib/calendar/date-utils";

vi.mock("@/lib/transcripts/alpha-vantage", () => ({
  isAlphaVantageConfigured: vi.fn(() => true),
  getEarningsTranscript: vi.fn(async () => null),
}));

vi.mock("@/lib/apis/api-ninjas", () => ({
  isApiNinjasConfigured: vi.fn(() => false),
  getEarningsTranscript: vi.fn(async () => null),
}));

vi.mock("@/lib/apis/edgar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apis/edgar")>()),
  getEarnings8KFilings: vi.fn(async () => []),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost:3099${url}`);
}

describe("GET /api/transcripts (cached transcript entity decoding)", () => {
  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    runMigrations(hoisted.db);

    hoisted.db
      .prepare(
        `INSERT INTO earnings_transcripts
           (ticker, year, quarter, source, transcript, summary, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "RBRK",
        2026,
        1,
        "edgar_8k",
        // Legacy row: stored pre-decoder, raw numeric entities intact
        "Date of Report (date of earliest event reported): March&#160;12, 2026\n" +
          "&#9744; Written communications pursuant to Rule 425 &amp; more",
        "Q1 summary",
        "edgar:RBRK:2026:1"
      );
  });

  it("decodes legacy raw HTML entities in the stored transcript at read time", async () => {
    const res = await GET(
      makeRequest("/api/transcripts?ticker=RBRK&year=2026&quarter=1")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.transcript).toContain("March 12, 2026");
    expect(body.data.transcript).toContain("☐ Written communications");
    expect(body.data.transcript).toContain("Rule 425 & more");
    expect(body.data.transcript).not.toMatch(/&#\d+;/);
  });

  it("passes through already-clean transcripts unchanged (decoder is a no-op)", async () => {
    hoisted.db
      .prepare(
        `INSERT INTO earnings_transcripts
           (ticker, year, quarter, source, transcript, source_key)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "AAPL",
        2026,
        2,
        "api_ninjas",
        "Operator: Good afternoon. Tim Cook: Thanks, everyone.",
        "ninjas:AAPL:2026:2"
      );

    const res = await GET(
      makeRequest("/api/transcripts?ticker=AAPL&year=2026&quarter=2")
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.transcript).toBe(
      "Operator: Good afternoon. Tim Cook: Thanks, everyone."
    );
  });

  it("returns 404 for an uncached quarter", async () => {
    const res = await GET(
      makeRequest("/api/transcripts?ticker=RBRK&year=2020&quarter=1")
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/transcripts (the fetch / refresh buttons)", () => {
  const printDate = addDays(todayET(), -1);

  function post(body: unknown): NextRequest {
    return new NextRequest("http://localhost:3099/api/transcripts", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  function seedPrint(rawJson: string | null, source = "finnhub") {
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, release_time, title, symbol, actual_value, source_key, week_of, superseded, raw_json)
         VALUES (?, 'earnings', ?, '16:05', 'ZZR earnings', 'ZZR', 'EPS 1.00', ?, ?, 0, ?)`,
      )
      .run(source, printDate, `${source}:ZZR:${printDate}`, printDate, rawJson);
  }

  function call(opening: string) {
    return {
      transcript: `Operator (Operator): ${opening}\n\nJane Doe (CEO): Revenue rose on steady demand.`,
      participants: [],
      overall_sentiment: null,
    };
  }

  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    runMigrations(hoisted.db);
    vi.mocked(getAlphaVantageTranscript).mockReset().mockResolvedValue(null);
    vi.mocked(getEarnings8KFilings).mockReset().mockResolvedValue([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("with no quarter, requests the latest print's FISCAL quarter, not the calendar quarter", async () => {
    seedPrint(JSON.stringify({ entry: { quarter: 4, year: 2026 } }));
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      call("Welcome to the ZZR fiscal fourth quarter 2026 earnings conference call."),
    );

    const res = await POST(post({ ticker: "ZZR" }));
    const body = await res.json();

    expect(getAlphaVantageTranscript).toHaveBeenCalledWith("ZZR", 2026, 4);
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ year: 2026, quarter: 4, source: "alpha_vantage" });
  });

  it("does not cache an older fiscal quarter's call as the refresh; the print's 8-K is returned instead", async () => {
    seedPrint(JSON.stringify({ entry: { quarter: 4, year: 2026 } }));
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      call("Welcome to the ZZR fiscal second quarter 2026 earnings conference call."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      {
        accessionNumber: "zzr-q4",
        filingDate: printDate,
        filingUrl: "https://example.test/zzr-q4",
        pressReleaseText: "ZZR reports fiscal fourth quarter 2026 results.",
      },
    ]);

    const res = await POST(post({ ticker: "ZZR" }));
    const body = await res.json();

    expect(body.data).toMatchObject({ year: 2026, quarter: 4, source: "edgar_8k" });
    expect(
      hoisted.db.prepare("SELECT source FROM earnings_transcripts").all(),
    ).toEqual([{ source: "edgar_8k" }]);
  });

  it("returns 404 and caches nothing when the print's call is wrong and no 8-K is filed yet", async () => {
    seedPrint(JSON.stringify({ entry: { quarter: 4, year: 2026 } }));
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      call("Welcome to the ZZR fiscal second quarter 2026 earnings conference call."),
    );

    const res = await POST(post({ ticker: "ZZR" }));

    expect(res.status).toBe(404);
    expect(
      (hoisted.db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts").get() as { c: number }).c,
    ).toBe(0);
  });

  it("an explicit quarter is requested as given, and a contradicting call is rejected", async () => {
    seedPrint(JSON.stringify({ entry: { quarter: 4, year: 2026 } }));
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      call("Welcome to the ZZR fiscal second quarter 2026 earnings conference call."),
    );

    const res = await POST(post({ ticker: "ZZR", year: 2026, quarter: 3 }));

    expect(getAlphaVantageTranscript).toHaveBeenCalledWith("ZZR", 2026, 3);
    expect(res.status).toBe(404);
    expect(
      (hoisted.db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts").get() as { c: number }).c,
    ).toBe(0);
  });

  // Changed 2026-10-08 (sprint unit 26): this used to pin a calendar-quarter
  // vendor request for a print with no Finnhub entry. That request can return
  // an older fiscal quarter's call as "the latest", so it is no longer made.
  it("a latest print with no Finnhub entry makes no calendar-quarter vendor request", async () => {
    seedPrint(null, "nasdaq");

    await POST(post({ ticker: "ZZR" }));

    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
  });

  it("falls back to the calendar default only when no earnings print is on file", async () => {
    await POST(post({ ticker: "ZZR" }));

    const [, year, quarter] = vi.mocked(getAlphaVantageTranscript).mock.calls[0];
    const { getMostRecentQuarter } = await import("@/lib/transcripts/fetch");
    expect({ year, quarter }).toEqual(getMostRecentQuarter());
  });
});
