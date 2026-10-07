/**
 * Same-day transcript sweep, END TO END: the real `fetchSameDayTranscripts`
 * drives the real `fetchTranscript`, the real Alpha Vantage client, the real
 * EDGAR client and the real insert. Only the network (`fetch`) and the AI
 * call are stubbed.
 *
 * tests/transcripts/same-day.test.ts mocks `fetchTranscript` whole, which is
 * why three defects were invisible to the suite: the 8-K fallback could not
 * succeed for a company whose fiscal year is not the calendar year, a call
 * that states no quarter was cached, and one name spent 59 vendor requests in
 * 36 hours. Each has a test here that runs the code path a real sweep runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fetchSameDayTranscripts } from "@/lib/transcripts/same-day";
import { generateTextForFeature } from "@/lib/ai/generate";

vi.mock("@/lib/ai/generate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/generate")>()),
  generateTextForFeature: vi.fn(),
}));

// Print: 2026-10-20 16:05 ET = 20:05 UTC (EDT). First sweep 55 minutes later.
const PRINT_DATE = "2026-10-20";
const RELEASE_UTC = Date.parse("2026-10-20T20:05:00Z");
const FIRST_SWEEP = new Date(RELEASE_UTC + 55 * 60 * 1000);
const HALF_HOUR = 30 * 60 * 1000;
const FRESH_WINDOW_MS = 36 * 60 * 60 * 1000;

interface Network {
  /** Opening line of the vendor's call, or null when the vendor has nothing. */
  vendorOpening: string | null;
  /** The 8-K exhibit text, or null when EDGAR lists no earnings 8-K. */
  pressRelease: string | null;
  filingDate: string;
  vendorRequests: string[];
  edgarLookups: number;
  other: string[];
}

let net: Network;
let db: Database.Database;

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => body,
  };
}

function stubNetwork(): void {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (url.includes("alphavantage")) {
      net.vendorRequests.push(/quarter=([^&]+)/.exec(url)![1]);
      return response(
        net.vendorOpening
          ? {
              transcript: [
                { speaker: "Operator", title: "Operator", content: net.vendorOpening },
                {
                  speaker: "Jane Doe",
                  title: "CEO",
                  content: "Revenue rose on steady demand across the regions.",
                },
              ],
            }
          : { Information: "no transcript" },
      );
    }
    if (url.includes("company_tickers")) {
      return response({ 0: { cik_str: 1, ticker: "ZZ", title: "ZZ Test Co" } });
    }
    if (url.includes("submissions")) {
      net.edgarLookups += 1;
      const has = net.pressRelease !== null;
      return response({
        filings: {
          recent: {
            form: has ? ["8-K"] : [],
            filingDate: has ? [net.filingDate] : [],
            accessionNumber: has ? ["0000000001-26-000001"] : [],
            primaryDocument: has ? ["d.htm"] : [],
            primaryDocDescription: has ? ["8-K"] : [],
          },
        },
      });
    }
    if (url.endsWith("d.htm")) return response("Item 2.02 Results of Operations");
    if (url.endsWith("ex99.htm")) return response(net.pressRelease ?? "");
    if (url.endsWith("/")) return response('<a href="ex99.htm">exhibit</a>');
    net.other.push(url);
    return { ok: false, status: 404, statusText: "not found", json: async () => ({}), text: async () => "" };
  });
}

function seedPrint(opts: { fiscal?: { quarter: number; year: number } } = {}): number {
  const sec = Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('ZZ', 'ZZ Test Co', 'Stock')`)
      .run().lastInsertRowid,
  );
  const acct = Number(db.prepare(`INSERT INTO accounts (name) VALUES ('a')`).run().lastInsertRowid);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, '2026-10-19', 'h:ZZ')`,
  ).run(acct, sec);
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, release_time, title, symbol, actual_value,
           source_key, week_of, superseded, raw_json)
         VALUES (?, 'earnings', ?, '16:05', 'ZZ earnings', 'ZZ', 'EPS 1.00', 'k:ZZ', '2026-10-19', 0, ?)`,
      )
      .run(
        opts.fiscal ? "finnhub" : "nasdaq",
        PRINT_DATE,
        opts.fiscal ? JSON.stringify({ entry: opts.fiscal }) : null,
      ).lastInsertRowid,
  );
}

function cachedRows() {
  return db
    .prepare("SELECT year, quarter, source, call_date FROM earnings_transcripts ORDER BY id")
    .all() as Array<{ year: number; quarter: number; source: string; call_date: string | null }>;
}

/** Sweep every 30 minutes for the whole 36-hour fresh window. */
async function sweepFor36Hours(opts: { resetStampLikeTheReviewHarness?: boolean } = {}): Promise<number> {
  let ticks = 0;
  for (let t = FIRST_SWEEP.getTime(); t - RELEASE_UTC <= FRESH_WINDOW_MS; t += HALF_HOUR) {
    const now = new Date(t);
    if (opts.resetStampLikeTheReviewHarness) {
      // The review's scratch harness aged the stamp to "31 minutes ago"
      // before every tick. The request bound must hold under that too.
      db.prepare(
        `UPDATE calendar_events SET transcript_attempted_at = ? WHERE transcript_attempted_at IS NOT NULL`,
      ).run(new Date(t - 31 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19));
    }
    await fetchSameDayTranscripts(db, { now });
    ticks += 1;
  }
  return ticks;
}

const OLDER_CALL = "Welcome to the ZZ fiscal second quarter 2026 earnings conference call.";
const RIGHT_CALL = "Welcome to the ZZ fiscal fourth quarter 2026 earnings conference call.";
const FISCAL_Q4_RELEASE = "ZZ reports fiscal fourth quarter 2026 results. Revenue rose.";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  net = {
    vendorOpening: null,
    pressRelease: null,
    filingDate: PRINT_DATE,
    vendorRequests: [],
    edgarLookups: 0,
    other: [],
  };
  vi.stubEnv("ALPHA_VANTAGE_API_KEY", "test-key");
  vi.stubEnv("API_NINJAS_KEY", "");
  vi.stubEnv("API_NINJAS_API_KEY", "");
  stubNetwork();
  vi.mocked(generateTextForFeature).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  expect(net.other).toEqual([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("same-day sweep with the real fetch chain", () => {
  it("a calendar-year print: the call that names the quarter is cached", async () => {
    seedPrint({ fiscal: { quarter: 3, year: 2026 } });
    net.vendorOpening = "Good day and welcome to the ZZ third quarter 2026 earnings conference call.";
    net.pressRelease = "ZZ reports third quarter 2026 results.";

    const result = await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(net.vendorRequests).toEqual(["2026Q3"]);
    expect(net.edgarLookups).toBe(0);
    expect(cachedRows()).toEqual([
      { year: 2026, quarter: 3, source: "alpha_vantage", call_date: null },
    ]);
  });

  it("an offset-fiscal print with the wrong vendor call: rejected, and the print's 8-K is cached under the fiscal key", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.vendorOpening = OLDER_CALL;
    net.pressRelease = FISCAL_Q4_RELEASE;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    // Asked for the FISCAL quarter, not the calendar quarter of the print date.
    expect(net.vendorRequests).toEqual(["2026Q4"]);
    expect(cachedRows()).toEqual([
      { year: 2026, quarter: 4, source: "edgar_8k", call_date: PRINT_DATE },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/rejected alpha_vantage ZZ 2026Q4: stated Q2 2026 but key is Q4 2026/),
    );

    // The next tick, 31 minutes on: the filing is cached, so the print is on
    // the 24-hour upgrade clock and nothing is requested.
    const next = await fetchSameDayTranscripts(db, {
      now: new Date(FIRST_SWEEP.getTime() + 31 * 60 * 1000),
    });
    expect(next).toEqual({ attempted: 0, fetched: 0 });
    expect(net.vendorRequests).toHaveLength(1);
    expect(net.edgarLookups).toBe(1);
  });

  it("an offset-fiscal print whose vendor has not posted yet: the 8-K filed on the print date is cached", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.pressRelease = FISCAL_Q4_RELEASE;

    const result = await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(cachedRows()).toEqual([
      { year: 2026, quarter: 4, source: "edgar_8k", call_date: PRINT_DATE },
    ]);
  });

  it("an offset-fiscal print with the right call: cached, EDGAR never asked", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.vendorOpening = RIGHT_CALL;
    net.pressRelease = FISCAL_Q4_RELEASE;

    const result = await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(net.vendorRequests).toEqual(["2026Q4"]);
    expect(net.edgarLookups).toBe(0);
    expect(cachedRows()).toEqual([
      { year: 2026, quarter: 4, source: "alpha_vantage", call_date: null },
    ]);
  });

  it("a call that states no quarter is never cached for a print", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.vendorOpening = "Good afternoon everyone and thank you for standing by.";
    net.pressRelease = FISCAL_Q4_RELEASE;

    await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(cachedRows().map((r) => r.source)).toEqual(["edgar_8k"]);
  });

  it("a call whose stated quarter sits behind 600 words of operator text is still read, and rejected", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.vendorOpening = `${Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ")} welcome to the fiscal second quarter 2026 call`;
    net.pressRelease = FISCAL_Q4_RELEASE;

    await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(cachedRows().map((r) => r.source)).toEqual(["edgar_8k"]);
  });

  it("a print with no Finnhub entry: no vendor request at all, the 8-K is cached under the quarter it states", async () => {
    seedPrint();
    net.vendorOpening = RIGHT_CALL;
    net.pressRelease = FISCAL_Q4_RELEASE;

    const result = await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(net.vendorRequests).toEqual([]);
    expect(cachedRows()).toEqual([
      { year: 2026, quarter: 4, source: "edgar_8k", call_date: PRINT_DATE },
    ]);

    // Done: no further attempt, though the row is not under the calendar key.
    const next = await fetchSameDayTranscripts(db, {
      now: new Date(FIRST_SWEEP.getTime() + 31 * 60 * 1000),
    });
    expect(next).toEqual({ attempted: 0, fetched: 0 });
    expect(net.edgarLookups).toBe(1);
  });

  it("a print with no Finnhub entry and a release that states no quarter: cached under the calendar key", async () => {
    seedPrint();
    net.pressRelease = "ZZ reports results. Revenue rose and margins held.";

    await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(net.vendorRequests).toEqual([]);
    expect(cachedRows()).toEqual([
      { year: 2026, quarter: 3, source: "edgar_8k", call_date: PRINT_DATE },
    ]);
  });

  it("the AI desk note lands on a filing that was stored by date under the print's key although its own label differs", async () => {
    // The desk note is written by echoing the row back through the insert.
    // That re-write must not be re-judged as a new keying decision.
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.pressRelease = `ZZ reports third quarter 2026 results. ${"Revenue rose on steady demand. ".repeat(250)}`;
    vi.mocked(generateTextForFeature).mockResolvedValue({
      text: "**Guidance**\n- Raised the full-year outlook",
    } as never);

    const result = await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(generateTextForFeature).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT year, quarter, source, summary FROM earnings_transcripts").all(),
    ).toEqual([
      {
        year: 2026,
        quarter: 4,
        source: "edgar_8k",
        summary: "**Guidance**\n- Raised the full-year outlook",
      },
    ]);
  });

  it("an 8-K filed the next business day is still the print's filing", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.pressRelease = FISCAL_Q4_RELEASE;
    net.filingDate = "2026-10-21";

    await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });

    expect(cachedRows()).toEqual([
      { year: 2026, quarter: 4, source: "edgar_8k", call_date: "2026-10-21" },
    ]);
  });
});

describe("vendor requests over a simulated 36 hours (free tier: 25 a day)", () => {
  it("wrong vendor call every time, 8-K present: 2 vendor requests, 1 EDGAR lookup (was 59 and 59)", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.vendorOpening = OLDER_CALL;
    net.pressRelease = FISCAL_Q4_RELEASE;

    const ticks = await sweepFor36Hours();

    expect(ticks).toBe(71);
    // The first sweep, then one upgrade try 24 hours later.
    expect(net.vendorRequests).toEqual(["2026Q4", "2026Q4"]);
    expect(net.edgarLookups).toBe(1);
    expect(cachedRows()).toEqual([
      { year: 2026, quarter: 4, source: "edgar_8k", call_date: PRINT_DATE },
    ]);
  });

  it("vendor never posts, 8-K present: 2 vendor requests", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.pressRelease = FISCAL_Q4_RELEASE;

    await sweepFor36Hours();

    expect(net.vendorRequests).toHaveLength(2);
    expect(net.edgarLookups).toBe(1);
  });

  it("wrong vendor call every time and NO 8-K to fall back on: 3 vendor requests, not one per tick", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.vendorOpening = OLDER_CALL;

    const ticks = await sweepFor36Hours();

    // Nothing can be cached, so the 30-minute retries continue for the
    // filing. The vendor is asked on the first attempt and on the first
    // attempt after the 12-hour and 24-hour marks.
    expect(net.vendorRequests).toHaveLength(3);
    expect(net.edgarLookups).toBe(ticks);
    expect(cachedRows()).toEqual([]);
  });

  it("the same bounds hold under the review harness, which re-ages the attempt stamp before every tick", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.vendorOpening = OLDER_CALL;

    await sweepFor36Hours({ resetStampLikeTheReviewHarness: true });
    expect(net.vendorRequests).toHaveLength(3);

    net.pressRelease = FISCAL_Q4_RELEASE;
    net.vendorRequests = [];
    db.prepare("UPDATE calendar_events SET transcript_attempted_at = NULL").run();
    await sweepFor36Hours({ resetStampLikeTheReviewHarness: true });
    expect(net.vendorRequests).toHaveLength(1);
  });

  it("no Finnhub entry and no 8-K: zero vendor requests", async () => {
    seedPrint();
    net.vendorOpening = RIGHT_CALL;

    await sweepFor36Hours();

    expect(net.vendorRequests).toEqual([]);
    expect(cachedRows()).toEqual([]);
  });

  it("the vendor posts the right call on day two: the cached filing is upgraded", async () => {
    seedPrint({ fiscal: { quarter: 4, year: 2026 } });
    net.pressRelease = FISCAL_Q4_RELEASE;
    await fetchSameDayTranscripts(db, { now: FIRST_SWEEP });
    net.vendorOpening = RIGHT_CALL;

    const result = await fetchSameDayTranscripts(db, {
      now: new Date(FIRST_SWEEP.getTime() + 25 * 60 * 60 * 1000),
    });

    expect(result).toEqual({ attempted: 1, fetched: 1 });
    expect(cachedRows().map((r) => `${r.source}:${r.year}Q${r.quarter}`)).toEqual([
      "edgar_8k:2026Q4",
      "alpha_vantage:2026Q4",
    ]);
  });
});
