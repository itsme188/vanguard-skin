import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { statedFiscalQuarterDetail, upsertTranscript } from "@/lib/mutations/transcripts";
import {
  deriveFilingReportingQuarter,
  expectedFiscalQuarterForPrint,
  extractGuidance,
  extractRiskFactors,
  fetchLatestTranscript,
  fetchTranscript,
  getCachedFilingForPrint,
  getMostRecentQuarter,
  getTranscriptForChat,
  latestPrintFiscalQuarter,
  statedFiscalQuarterFromTranscript,
} from "@/lib/transcripts/fetch";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { getEarnings8KFilings } from "@/lib/apis/edgar";
import {
  isApiNinjasConfigured,
  getEarningsTranscript as getApiNinjasTranscript,
} from "@/lib/apis/api-ninjas";
import {
  isAlphaVantageConfigured,
  getEarningsTranscript as getAlphaVantageTranscript,
} from "@/lib/transcripts/alpha-vantage";
import { getLatestTranscript as getMotleyFoolTranscript } from "@/lib/apis/motley-fool";

// Mock external fetchers so tests stay offline. The cache-hit tests don't
// reach these; only the legacy-invalidation test does (test #4), and it
// expects either a successful refresh with non-legacy content or a full
// miss — a real network call would hang the suite at 5s.
vi.mock("@/lib/apis/api-ninjas", () => ({
  isApiNinjasConfigured: vi.fn(() => false),
  getEarningsTranscript: vi.fn(async () => null),
}));

// Alpha Vantage defaults to configured-but-empty so existing tests exercise
// the EDGAR fallback unchanged; chain-order tests override per call.
vi.mock("@/lib/transcripts/alpha-vantage", () => ({
  isAlphaVantageConfigured: vi.fn(() => true),
  getEarningsTranscript: vi.fn(async () => null),
}));

// Retired from the chain (2026-06-09) — mocked only to assert it is never
// called. fetch.ts must not import it.
vi.mock("@/lib/apis/motley-fool", () => ({
  getLatestTranscript: vi.fn(async () => null),
}));

vi.mock("@/lib/apis/edgar", () => ({
  // Default mock: a single Q1 2026 filing (Apr-Jun → Q1 2026 per
  // deriveFilingReportingQuarter). Tests that need a different shape
  // override via vi.mocked(...).mockResolvedValueOnce(...).
  getEarnings8KFilings: vi.fn(async () => [
    {
      accessionNumber: "refresh-accession",
      filingDate: "2026-04-25",
      filingUrl: "https://example.test/filing",
      pressReleaseText: "refreshed ".repeat(2000),
    },
  ]),
}));

function resetExternalMocks() {
  vi.mocked(isApiNinjasConfigured).mockReturnValue(false);
  vi.mocked(getApiNinjasTranscript).mockResolvedValue(null);
  vi.mocked(isAlphaVantageConfigured).mockReturnValue(true);
  vi.mocked(getAlphaVantageTranscript).mockResolvedValue(null);
  vi.mocked(getEarnings8KFilings).mockResolvedValue([
    {
      accessionNumber: "refresh-accession",
      filingDate: "2026-04-25",
      filingUrl: "https://example.test/filing",
      pressReleaseText: "refreshed ".repeat(2000),
    },
  ]);
}

beforeEach(() => {
  resetExternalMocks();
});

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedCached(
  db: Database.Database,
  ticker: string,
  year: number,
  quarter: number,
  source: "motley_fool" | "edgar_8k" | "api_ninjas",
  transcript: string,
) {
  upsertTranscript(db, {
    ticker,
    year,
    quarter,
    call_date: "2026-01-30",
    source,
    transcript,
    summary: "seed summary",
    guidance: null,
    risk_factors: null,
    sentiment_score: null,
    sentiment_label: null,
    participants: null,
    accession_number: source === "edgar_8k" ? "seed-accession" : null,
    filing_url: null,
    source_key: `${source}:${ticker}:${year}:${quarter}`,
  });
}

function wordy(words: number): string {
  return Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
}

describe("getTranscriptForChat — excerpt vs full text", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("returns a 1000-word excerpt by default + truncated=true when source is long", async () => {
    seedCached(db, "AAPL", 2026, 1, "motley_fool", wordy(1500));
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1);
    expect(out).not.toBeNull();
    expect(out!.transcript_length_words).toBe(1500);
    expect(out!.excerpt).toMatch(/\.\.\.$/);
    expect(out!.excerpt!.split(/\s+/).length).toBeLessThanOrEqual(1001);
    expect(out!.truncated).toBe(true);
  });

  it("returns the full body when include_full_text=true", async () => {
    seedCached(db, "AAPL", 2026, 1, "motley_fool", wordy(1500));
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, {
      fullText: true,
    });
    expect(out!.excerpt).toBe(wordy(1500));
    expect(out!.truncated).toBe(false);
  });

  it("returns full text unmodified when body is already short (<1000 words)", async () => {
    const short = wordy(200);
    seedCached(db, "AAPL", 2026, 1, "motley_fool", short);
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1);
    expect(out!.excerpt).toBe(short);
    expect(out!.truncated).toBe(false);
  });

  it("legacy edgar_8k cache (<=5200 chars) is replaced IN PLACE by the re-fetched full text when fullText=true", async () => {
    // Seed a cache row that looks like the pre-E2 EDGAR truncation.
    const legacy = "x".repeat(4800);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", legacy);
    const before = db
      .prepare("SELECT id FROM earnings_transcripts WHERE source_key = ?")
      .get("edgar_8k:AAPL:2026:1") as { id: number };

    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, { fullText: true });

    expect(out).not.toBeNull();
    expect(out!.excerpt).toBe("refreshed ".repeat(2000));
    expect(out!.truncated).toBe(false);
    const rows = db
      .prepare("SELECT id, transcript, accession_number FROM earnings_transcripts")
      .all() as Array<{ id: number; transcript: string; accession_number: string }>;
    // Same row, new body: nothing was deleted and nothing was duplicated.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].transcript).toBe("refreshed ".repeat(2000));
    expect(rows[0].accession_number).toBe("refresh-accession");
  });

  it("keeps the cached legacy row and returns it flagged truncated when the re-fetch finds nothing", async () => {
    const legacy = "x".repeat(4800);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", legacy);
    vi.mocked(getEarnings8KFilings).mockResolvedValue([]);

    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, { fullText: true });

    expect(out).not.toBeNull();
    expect(out!.excerpt).toBe(legacy);
    expect(out!.truncated).toBe(true);
    expect(
      (db.prepare("SELECT transcript FROM earnings_transcripts").all() as { transcript: string }[]).map(
        (r) => r.transcript,
      ),
    ).toEqual([legacy]);
  });

  it("keeps the cached legacy row when the re-fetched text is REJECTED for the row's key", async () => {
    // The reviewer's case: the old code deleted the row first, the re-fetch
    // was then rejected, and the tool returned nothing.
    const legacy = "x".repeat(4800);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", legacy);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getEarnings8KFilings).mockResolvedValue([
      {
        accessionNumber: "seed-accession",
        filingDate: "2026-04-25",
        filingUrl: "https://example.test/filing",
        pressReleaseText: `ZZ reports fiscal third quarter 2026 results. ${"body ".repeat(2000)}`,
      },
    ]);

    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, { fullText: true });

    expect(out).not.toBeNull();
    expect(out!.excerpt).toBe(legacy);
    expect(out!.truncated).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rejected edgar_8k AAPL 2026Q1"));
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts").get() as { c: number }).c,
    ).toBe(1);
    warn.mockRestore();
  });

  it("a refresh whose EDGAR lookup throws keeps the row and logs one line", async () => {
    const legacy = "x".repeat(4800);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", legacy);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getEarnings8KFilings).mockRejectedValue(new Error("edgar down"));

    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, { fullText: true });

    expect(out!.excerpt).toBe(legacy);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("edgar down"));
    warn.mockRestore();
  });

  it("legacy edgar_8k cache is NOT invalidated when fullText=false (excerpt is fine)", async () => {
    const legacy = "x".repeat(4800);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", legacy);
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1);
    // Cache survived and the excerpt contains the legacy body.
    expect(out).not.toBeNull();
    const stillCached = db
      .prepare("SELECT COUNT(*) as c FROM earnings_transcripts")
      .get() as { c: number };
    expect(stillCached.c).toBe(1);
  });

  it("long edgar_8k cache (>5200 chars) is NOT re-fetched even when fullText=true", async () => {
    // An already-upgraded cache row (say 20K chars) should pass through
    // without being evicted — re-fetching would waste an EDGAR round trip.
    const modern = "x".repeat(20_000);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", modern);
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, {
      fullText: true,
    });
    expect(out!.excerpt).toBe(modern);
    const stillCached = db
      .prepare("SELECT COUNT(*) as c FROM earnings_transcripts")
      .get() as { c: number };
    expect(stillCached.c).toBe(1);
  });
});

describe("deriveFilingReportingQuarter", () => {
  it("maps Jan-Mar filings to Q4 of prior year", () => {
    expect(deriveFilingReportingQuarter("2026-01-31")).toEqual({ year: 2025, quarter: 4 });
    expect(deriveFilingReportingQuarter("2026-03-12")).toEqual({ year: 2025, quarter: 4 });
  });

  it("maps Apr-Jun filings to Q1 of same year", () => {
    expect(deriveFilingReportingQuarter("2026-04-15")).toEqual({ year: 2026, quarter: 1 });
    expect(deriveFilingReportingQuarter("2026-06-30")).toEqual({ year: 2026, quarter: 1 });
  });

  it("maps Jul-Sep to Q2 and Oct-Dec to Q3", () => {
    expect(deriveFilingReportingQuarter("2026-08-04")).toEqual({ year: 2026, quarter: 2 });
    expect(deriveFilingReportingQuarter("2026-11-15")).toEqual({ year: 2026, quarter: 3 });
  });
});

describe("fetchTranscript — Alpha Vantage chain position", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    vi.clearAllMocks();
  });

  it("uses Alpha Vantage when it returns a transcript — EDGAR never reached", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce({
      transcript: "Jane Doe (CEO): We had a strong quarter with revenue growth.",
      participants: [{ name: "Jane Doe", title: "CEO" }],
      overall_sentiment: 0.6,
    });

    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.fromCache).toBe(false);
    expect(result!.transcript.source).toBe("alpha_vantage");
    expect(result!.transcript.source_key).toBe("alpha_vantage:TER:2026:1");
    expect(result!.transcript.sentiment_score).toBeCloseTo(0.6, 5);
    expect(result!.transcript.sentiment_label).toBe("bullish");
    expect(JSON.parse(result!.transcript.participants!)).toEqual([
      { name: "Jane Doe", title: "CEO" },
    ]);
    expect(getAlphaVantageTranscript).toHaveBeenCalledWith("TER", 2026, 1);
    expect(getEarnings8KFilings).not.toHaveBeenCalled();
  });

  it("falls through to EDGAR when Alpha Vantage returns null — AV tried first", async () => {
    // Default AV mock returns null; default EDGAR mock returns a Q1 2026 filing.
    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.transcript.source).toBe("edgar_8k");
    expect(getAlphaVantageTranscript).toHaveBeenCalledTimes(1);
    expect(getEarnings8KFilings).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(getAlphaVantageTranscript).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(getEarnings8KFilings).mock.invocationCallOrder[0]);
  });

  it("skips Alpha Vantage entirely when unconfigured", async () => {
    vi.mocked(isAlphaVantageConfigured).mockReturnValueOnce(false);

    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.transcript.source).toBe("edgar_8k");
    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
  });

  it("never calls the retired Motley Fool scraper", async () => {
    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(getMotleyFoolTranscript).not.toHaveBeenCalled();
  });

  it("upgrades a cached edgar_8k row to a full Alpha Vantage transcript", async () => {
    // An EDGAR press-release excerpt cached before AV was configured (or
    // while AV was down) must not block the full transcript forever —
    // cache-first would otherwise short-circuit step 2 for that quarter.
    seedCached(db, "TER", 2026, 1, "edgar_8k", "press release excerpt only");
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce({
      transcript: "Jane Doe (CEO): Full call transcript with Q&A.",
      participants: [{ name: "Jane Doe", title: "CEO" }],
      overall_sentiment: 0.1,
    });

    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.transcript.source).toBe("alpha_vantage");
    expect(result!.transcript.transcript).toContain("Full call transcript");
  });

  it("keeps serving the cached edgar_8k row when the AV upgrade comes back empty", async () => {
    seedCached(db, "TER", 2026, 1, "edgar_8k", "press release excerpt only");
    // Default AV mock returns null → upgrade attempt fails quietly.
    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.transcript.source).toBe("edgar_8k");
    expect(result!.fromCache).toBe(true);
    // EDGAR must not be re-fetched — the cached row is already EDGAR content.
    expect(getEarnings8KFilings).not.toHaveBeenCalled();
  });

  it("does not attempt an AV upgrade over a cached api_ninjas full transcript", async () => {
    seedCached(db, "TER", 2026, 1, "api_ninjas", wordy(2000));
    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.transcript.source).toBe("api_ninjas");
    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
  });
});

// ─── Shared seeding for the print-keyed tests ────────────────────

let eventSeq = 0;
function seedCalendarEvent(
  db: Database.Database,
  opts: {
    symbol: string;
    date: string;
    source?: string;
    superseded?: number;
    /** undefined → a Finnhub entry for Q4 2026; null → no raw_json at all. */
    rawJson?: string | null;
    actual?: string | null;
  },
): number {
  eventSeq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, release_time, title, symbol, actual_value, source_key, week_of, superseded, raw_json)
         VALUES (?, 'earnings', ?, '16:00', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.source ?? "finnhub",
        opts.date,
        `${opts.symbol} earnings`,
        opts.symbol,
        opts.actual === undefined ? "EPS 1.00" : opts.actual,
        `seed:${opts.symbol}:${opts.date}:${eventSeq}`,
        opts.date,
        opts.superseded ?? 0,
        opts.rawJson === undefined
          ? JSON.stringify({ entry: { quarter: 4, year: 2026 } })
          : opts.rawJson,
      ).lastInsertRowid,
  );
}

function finnhub(quarter: unknown, year: unknown): string {
  return JSON.stringify({ entry: { quarter, year } });
}

function rowsFor(db: Database.Database, ticker: string) {
  return db
    .prepare(
      "SELECT year, quarter, source, call_date, accession_number FROM earnings_transcripts WHERE ticker = ? ORDER BY id",
    )
    .all(ticker) as Array<{
    year: number;
    quarter: number;
    source: string;
    call_date: string | null;
    accession_number: string | null;
  }>;
}

function filing(accessionNumber: string, filingDate: string, pressReleaseText: string) {
  return {
    accessionNumber,
    filingDate,
    filingUrl: `https://example.test/${accessionNumber}`,
    pressReleaseText,
  };
}

function vendorCall(opening: string) {
  return {
    transcript: `Operator (Operator): ${opening}\n\nJane Doe (CEO): Revenue rose on steady demand across the regions.`,
    participants: [{ name: "Jane Doe", title: "CEO" }],
    overall_sentiment: 0.1,
  };
}

describe("statedFiscalQuarterFromTranscript — the reviewer's table", () => {
  const filler600 = Array.from({ length: 600 }, (_, i) => `instr${i}`).join(" ");

  it.each<[string, { quarter: number; year: number | null } | null]>([
    ["Operator: Welcome to ZZ's third quarter 2026 earnings conference call.", { quarter: 3, year: 2026 }],
    ["Welcome to the fiscal second quarter 2026 financial conference call.", { quarter: 2, year: 2026 }],
    ["ZZ Second Quarter Fiscal Year 2026", { quarter: 2, year: 2026 }],
    ["ZZ Q2 Fiscal Year 2026 Earnings Conference Call", { quarter: 2, year: 2026 }],
    ["ZZ Q2 FY26", { quarter: 2, year: 2026 }],
    ["ZZ fourth quarter and full year fiscal 2026", { quarter: 4, year: 2026 }],
    ["ZZ first quarter fiscal 2027", { quarter: 1, year: 2027 }],
    ["Welcome to the ZZ second quarter earnings call.", { quarter: 2, year: null }],
    ["Good afternoon and thank you all for joining us today to discuss our business.", null],
    [
      "Compared with the second quarter of 2025, our third quarter 2026 results were strong.",
      { quarter: 3, year: 2026 },
    ],
    ["Welcome to the 2Q26 earnings call.", { quarter: 2, year: 2026 }],
    ["Welcome to the 3Q 2026 earnings call.", { quarter: 3, year: 2026 }],
    ["ZZ third-quarter 2026 results", { quarter: 3, year: 2026 }],
    ["Results for the three months ended June 30, 2026", null],
    [`${filler600} welcome to the fiscal second quarter 2026 earnings call`, { quarter: 2, year: 2026 }],
    ["ZZ third quarter of 2026 earnings call", { quarter: 3, year: 2026 }],
    ["ZZ fiscal 2026 third quarter earnings call", { quarter: 3, year: 2026 }],
    ["ZZ Q3 2026 earnings call", { quarter: 3, year: 2026 }],
    ["ZZ FY26 Q2 earnings call", { quarter: 2, year: 2026 }],
    ["The third quarter 10 a.m. call", { quarter: 3, year: null }],
    // Further shapes the same rules must hold for.
    ["ZZ fiscal year 2026 third quarter", { quarter: 3, year: 2026 }],
    ["ZZ Q3'26 call", { quarter: 3, year: 2026 }],
    ["Welcome to the third quarter fiscal '26 call", { quarter: 3, year: 2026 }],
    ["ZZ third quarter and nine months 2026 results", { quarter: 3, year: 2026 }],
    ["ZZ fourth quarter and fiscal year 2026 earnings", { quarter: 4, year: 2026 }],
    ["ZZ Announces 2026 Third Quarter Results", { quarter: 3, year: 2026 }],
    ["The second quarter 2,400 participants joined", { quarter: 2, year: null }],
    ["Results for the quarter ended June 30, 2026 third quarter revenue rose", { quarter: 3, year: null }],
    [
      "Welcome. As a reminder, in the first quarter we closed the deal. Today: fourth quarter 2026 results",
      { quarter: 4, year: 2026 },
    ],
    ["Good day and welcome to the ZZ Q4 2026 call. Last quarter, Q3, we said so.", { quarter: 4, year: 2026 }],
    ["Welcome to the ZZ call. Versus Q3 we grew. This is our Q4 fiscal 2026 call", { quarter: 4, year: 2026 }],
    ["Revenue rose versus the year-ago second quarter, and third quarter demand held.", { quarter: 3, year: null }],
    ["Our Form 10-Q and the 12Q plan are on file.", null],
  ])("%s", (opening, expected) => {
    expect(statedFiscalQuarterFromTranscript(opening)).toEqual(expected);
  });

  it("does not read an unrelated quarter sentence deep in the call", () => {
    const text = `${"Introductory operating remarks without quarter labels. ".repeat(360)}

Jane Doe (CEO): A customer asked about third quarter 2026 budgets in a separate context.`;
    expect(statedFiscalQuarterFromTranscript(text)).toBeNull();
  });

  it("grades the evidence: self-identifying, dated, passing, comparison", () => {
    expect(statedFiscalQuarterDetail("Welcome to the second quarter earnings call.")?.evidence).toBe("self");
    expect(statedFiscalQuarterDetail("In fiscal 2026 third quarter we shipped more units.")?.evidence).toBe("dated");
    expect(statedFiscalQuarterDetail("In the first quarter we closed the deal.")?.evidence).toBe("plain");
    expect(statedFiscalQuarterDetail("Margins rose versus Q3.")?.evidence).toBe("comparison");
  });
});

describe("expectedFiscalQuarterForPrint", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("reads Finnhub quarter/year from a nearby superseded twin", () => {
    seedCalendarEvent(db, { symbol: "ZZF", date: "2026-09-30", source: "manual", rawJson: null });
    seedCalendarEvent(db, { symbol: "ZZF", date: "2026-09-29", superseded: 1 });

    expect(expectedFiscalQuarterForPrint(db, "ZZF", "2026-09-30")).toEqual({
      quarter: 4,
      year: 2026,
    });
  });

  it("returns null for malformed raw_json instead of throwing", () => {
    seedCalendarEvent(db, { symbol: "ZZB", date: "2026-09-30", rawJson: "{bad json" });
    seedCalendarEvent(db, { symbol: "ZZB", date: "2026-09-30", rawJson: "null" });
    seedCalendarEvent(db, { symbol: "ZZB", date: "2026-09-30", rawJson: "[]" });
    expect(expectedFiscalQuarterForPrint(db, "ZZB", "2026-09-30")).toBeNull();
    expect(expectedFiscalQuarterForPrint(db, "ZZB", "garbage")).toBeNull();
  });

  it.each<[string, unknown, unknown, { quarter: number; year: number } | null]>([
    ["a real number pair", 3, 2026, { quarter: 3, year: 2026 }],
    ["a numeric string quarter", "3", 2026, { quarter: 3, year: 2026 }],
    ["year null (was read as year 0)", 3, null, null],
    ["quarter true (was read as quarter 1)", true, 2026, null],
    ["a two-digit year", 3, 26, null],
    ["year 0", 3, 0, null],
    ["a string year", 3, "2026", null],
    ["quarter 0", 0, 2026, null],
    ["quarter 5", 5, 2026, null],
    ["quarter 2.5", 2.5, 2026, null],
    ["quarter 'Q3'", "Q3", 2026, null],
    ["quarter null", null, 2026, null],
  ])("requires real values: %s", (_label, quarter, year, expected) => {
    seedCalendarEvent(db, { symbol: "ZZP", date: "2026-10-20", rawJson: finnhub(quarter, year) });
    expect(expectedFiscalQuarterForPrint(db, "ZZP", "2026-10-20")).toEqual(expected);
  });

  it("prefers a live row one day away over a superseded twin on the print date", () => {
    seedCalendarEvent(db, { symbol: "ZZT", date: "2026-10-20", superseded: 1, rawJson: finnhub(2, 2026) });
    seedCalendarEvent(db, { symbol: "ZZT", date: "2026-10-21", rawJson: finnhub(3, 2026) });
    expect(expectedFiscalQuarterForPrint(db, "ZZT", "2026-10-20")).toEqual({ quarter: 3, year: 2026 });
  });

  it("then the nearest date, then the lower id", () => {
    seedCalendarEvent(db, { symbol: "ZZN", date: "2026-10-22", superseded: 1, rawJson: finnhub(1, 2026) });
    seedCalendarEvent(db, { symbol: "ZZN", date: "2026-10-21", superseded: 1, rawJson: finnhub(2, 2026) });
    seedCalendarEvent(db, { symbol: "ZZN", date: "2026-10-19", superseded: 1, rawJson: finnhub(3, 2026) });
    expect(expectedFiscalQuarterForPrint(db, "ZZN", "2026-10-20")).toEqual({ quarter: 2, year: 2026 });
  });

  it("ignores an entry outside the tolerance (the previous print)", () => {
    seedCalendarEvent(db, { symbol: "ZZO", date: "2026-07-21", rawJson: finnhub(2, 2026) });
    expect(expectedFiscalQuarterForPrint(db, "ZZO", "2026-10-20")).toBeNull();
  });
});

describe("fetchTranscript — a print with a known fiscal quarter", () => {
  let db: Database.Database;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    db = makeDb();
    vi.clearAllMocks();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  const print = { eventDate: "2026-10-20", expectedFiscalQuarter: { year: 2026, quarter: 4 } };

  it("accepts a calendar-year call through the phrase path without any vendor date", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZC's third quarter 2026 earnings call."),
    );

    const result = await fetchTranscript(db, "ZZC", 2026, 3, {
      eventDate: "2026-10-20",
      expectedFiscalQuarter: { year: 2026, quarter: 3 },
    });

    expect(result!.transcript.source).toBe("alpha_vantage");
    expect(result!.transcript.call_date).toBeNull();
    expect(getAlphaVantageTranscript).toHaveBeenCalledWith("ZZC", 2026, 3);
    expect(rowsFor(db, "ZZC")).toHaveLength(1);
  });

  it("requests the vendor with the fiscal key even when the caller passed a calendar key", async () => {
    await fetchTranscript(db, "ZZQ", 2026, 3, print);
    expect(getAlphaVantageTranscript).toHaveBeenCalledWith("ZZQ", 2026, 4);
  });

  it("rejects the older fiscal quarter's call and caches the print's 8-K under the fiscal key", async () => {
    // Critical 1: the filing dated on the print used to be matched by its
    // CALENDAR quarter (2026 Q3) against the fiscal key (2026, 4) and never
    // matched, so nothing was cached and the result was null.
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZQ's fiscal second quarter 2026 financial conference call."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzq-q4", "2026-10-20", "ZZQ reports fiscal fourth quarter 2026 results. Revenue rose."),
      filing("zzq-q3", "2026-07-21", "ZZQ reports fiscal third quarter 2026 results."),
    ]);

    const result = await fetchTranscript(db, "ZZQ", 2026, 4, print);

    expect(result).not.toBeNull();
    expect(result!.fromCache).toBe(false);
    expect(rowsFor(db, "ZZQ")).toEqual([
      { year: 2026, quarter: 4, source: "edgar_8k", call_date: "2026-10-20", accession_number: "zzq-q4" },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/rejected alpha_vantage ZZQ 2026Q4: stated Q2 2026 but key is Q4 2026/),
    );
  });

  it("accepts the call when it states the expected fiscal quarter — EDGAR never reached", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZQ's fiscal fourth quarter 2026 financial conference call."),
    );

    const result = await fetchTranscript(db, "ZZQ", 2026, 4, print);

    expect(result!.transcript.source).toBe("alpha_vantage");
    expect(getEarnings8KFilings).not.toHaveBeenCalled();
    expect(rowsFor(db, "ZZQ")).toEqual([
      { year: 2026, quarter: 4, source: "alpha_vantage", call_date: null, accession_number: null },
    ]);
  });

  it("rejects a call that states NO quarter (Critical 2) and goes on to the filing", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Good afternoon everyone and thank you for standing by."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzq-q4", "2026-10-21", "ZZQ reports fiscal fourth quarter 2026 results."),
    ]);

    const result = await fetchTranscript(db, "ZZQ", 2026, 4, print);

    expect(result!.transcript.source).toBe("edgar_8k");
    expect(rowsFor(db, "ZZQ").map((r) => r.source)).toEqual(["edgar_8k"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/rejected alpha_vantage ZZQ 2026Q4: expected Q4 2026 but the opening states no fiscal quarter/),
    );
  });

  it("rejects a call whose stated quarter sits behind 600 words of operator text (Critical 2)", async () => {
    const preamble = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall(`${preamble} welcome to the fiscal second quarter 2026 call`),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([]);

    const result = await fetchTranscript(db, "ZZQ", 2026, 4, print);

    expect(result).toBeNull();
    expect(rowsFor(db, "ZZQ")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stated Q2 2026 but key is Q4 2026/));
  });

  it("rejects a call that only mentions the expected quarter in passing", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Good afternoon. We think demand improves in the fourth quarter."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([]);

    expect(await fetchTranscript(db, "ZZQ", 2026, 4, print)).toBeNull();
    expect(rowsFor(db, "ZZQ")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/only mentions Q4 in passing/));
  });

  it("rejects a call that states the right quarter of the wrong year", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZQ's fiscal fourth quarter 2025 earnings call."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([]);

    expect(await fetchTranscript(db, "ZZQ", 2026, 4, print)).toBeNull();
    expect(rowsFor(db, "ZZQ")).toEqual([]);
  });

  it("stores the date-matched 8-K under the print's key even when the release's own label differs, and logs it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzq-odd", "2026-10-20", "ZZQ reports third quarter 2026 results. Revenue rose."),
    ]);

    const result = await fetchTranscript(db, "ZZQ", 2026, 4, print);

    expect(result!.transcript.quarter).toBe(4);
    expect(rowsFor(db, "ZZQ")).toEqual([
      { year: 2026, quarter: 4, source: "edgar_8k", call_date: "2026-10-20", accession_number: "zzq-odd" },
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/stored edgar_8k ZZQ 2026Q4 by filing date 2026-10-20 for the 2026-10-20 print/),
    );
  });

  it("does not take an 8-K filed outside the print's window, and says why in one line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzq-prev", "2026-07-21", "ZZQ reports fiscal third quarter 2026 results."),
      filing("zzq-late", "2026-10-25", "ZZQ reports fiscal fourth quarter 2026 results."),
    ]);

    expect(await fetchTranscript(db, "ZZQ", 2026, 4, print)).toBeNull();
    expect(rowsFor(db, "ZZQ")).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/no 8-K filing stored for ZZQ 2026Q4: no earnings 8-K filed within 4 days of the 2026-10-20 print/),
    );
  });

  it("picks the filing nearest the print date inside the window", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzq-plus3", "2026-10-23", "ZZQ updates its outlook."),
      filing("zzq-day", "2026-10-20", "ZZQ reports fiscal fourth quarter 2026 results."),
    ]);
    const result = await fetchTranscript(db, "ZZQ", 2026, 4, print);
    expect(result!.transcript.accession_number).toBe("zzq-day");
  });

  it("logs one line and returns null when the EDGAR lookup throws (no silent catch)", async () => {
    vi.mocked(getEarnings8KFilings).mockRejectedValueOnce(new Error("edgar down"));

    expect(await fetchTranscript(db, "ZZQ", 2026, 4, print)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/EDGAR lookup failed for ZZQ 2026Q4: edgar down/),
    );
  });

  it("a cached filing for the print is upgraded by a verified call and otherwise echoed back", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzq-q4", "2026-10-20", "ZZQ reports fiscal fourth quarter 2026 results."),
    ]);
    await fetchTranscript(db, "ZZQ", 2026, 4, print);
    vi.mocked(getEarnings8KFilings).mockClear();

    // Wrong call: the cached filing is echoed back, nothing new is written.
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZQ's fiscal second quarter 2026 earnings call."),
    );
    const echoed = await fetchTranscript(db, "ZZQ", 2026, 4, print);
    expect(echoed).toMatchObject({ fromCache: true, transcript: { source: "edgar_8k" } });
    expect(getEarnings8KFilings).not.toHaveBeenCalled();

    // Right call: upgraded.
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZQ's fiscal fourth quarter 2026 earnings call."),
    );
    const upgraded = await fetchTranscript(db, "ZZQ", 2026, 4, print);
    expect(upgraded).toMatchObject({ fromCache: false, transcript: { source: "alpha_vantage" } });
    expect(rowsFor(db, "ZZQ").map((r) => `${r.source}:${r.year}Q${r.quarter}`)).toEqual([
      "edgar_8k:2026Q4",
      "alpha_vantage:2026Q4",
    ]);
  });

  it("skipAlphaVantage spends no vendor request and still fetches the filing", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzq-q4", "2026-10-20", "ZZQ reports fiscal fourth quarter 2026 results."),
    ]);
    const result = await fetchTranscript(db, "ZZQ", 2026, 4, { ...print, skipAlphaVantage: true });
    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
    expect(result!.transcript.source).toBe("edgar_8k");
  });
});

describe("fetchTranscript — a print whose fiscal quarter is unknown", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("makes no vendor request and keys the filing by the fiscal quarter the release states", async () => {
    // Critical 1, second half: the calendar key (2026, 3) plus a release that
    // says "fiscal fourth quarter 2026" used to throw at the insert and be
    // swallowed by a bare catch.
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzu-q4", "2026-10-20", "ZZU reports fiscal fourth quarter 2026 results. Revenue rose."),
    ]);

    const result = await fetchTranscript(db, "ZZU", 2026, 3, { eventDate: "2026-10-20" });

    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
    expect(getApiNinjasTranscript).not.toHaveBeenCalled();
    expect(result!.fromCache).toBe(false);
    expect(rowsFor(db, "ZZU")).toEqual([
      { year: 2026, quarter: 4, source: "edgar_8k", call_date: "2026-10-20", accession_number: "zzu-q4" },
    ]);
  });

  it("keys the filing by the calendar-derived key when the release states no quarter", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzu-plain", "2026-10-21", "ZZU reports results. Revenue rose and margins held."),
    ]);

    const result = await fetchTranscript(db, "ZZU", 2026, 3, { eventDate: "2026-10-20" });

    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
    expect(result!.transcript.source).toBe("edgar_8k");
    expect(rowsFor(db, "ZZU")).toEqual([
      { year: 2026, quarter: 3, source: "edgar_8k", call_date: "2026-10-21", accession_number: "zzu-plain" },
    ]);
  });

  it("keys by the calendar key when the release states that quarter without a year", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzu-noyr", "2026-10-20", "ZZU reports third quarter results. Revenue rose."),
    ]);
    await fetchTranscript(db, "ZZU", 2026, 3, { eventDate: "2026-10-20" });
    expect(rowsFor(db, "ZZU").map((r) => `${r.year}Q${r.quarter}`)).toEqual(["2026Q3"]);
  });

  it("stores nothing, with one log line, when the release states another quarter and no year", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzu-odd", "2026-10-20", "ZZU reports fourth quarter results. Revenue rose."),
    ]);

    expect(await fetchTranscript(db, "ZZU", 2026, 3, { eventDate: "2026-10-20" })).toBeNull();
    expect(rowsFor(db, "ZZU")).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/states Q4 with no year.*no key to store it under/));
  });

  it("a call cached under the calendar key does not stand in for this print's filing", async () => {
    // A row keyed (2026, 3) may be an older FISCAL third quarter's call.
    seedCached(db, "ZZU", 2026, 3, "api_ninjas", "Jane Doe (CEO): remarks.");
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzu-q4", "2026-10-20", "ZZU reports fiscal fourth quarter 2026 results."),
    ]);

    const result = await fetchTranscript(db, "ZZU", 2026, 3, { eventDate: "2026-10-20" });

    expect(result).toMatchObject({ fromCache: false, transcript: { source: "edgar_8k", quarter: 4 } });
  });

  it("returns the print's cached filing without another EDGAR round trip", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzu-q4", "2026-10-20", "ZZU reports fiscal fourth quarter 2026 results."),
    ]);
    await fetchTranscript(db, "ZZU", 2026, 3, { eventDate: "2026-10-20" });
    vi.mocked(getEarnings8KFilings).mockClear();

    const again = await fetchTranscript(db, "ZZU", 2026, 3, { eventDate: "2026-10-20" });

    expect(again).toMatchObject({ fromCache: true, transcript: { accession_number: "zzu-q4" } });
    expect(getEarnings8KFilings).not.toHaveBeenCalled();
    expect(getCachedFilingForPrint(db, "ZZU", "2026-10-22")?.accession_number).toBe("zzu-q4");
    expect(getCachedFilingForPrint(db, "ZZU", "2026-10-26")).toBeNull();
  });

  it("re-fetching a filing already stored with the same text writes nothing (the desk note survives)", async () => {
    const text = "ZZU reports fiscal fourth quarter 2026 results.";
    vi.mocked(getEarnings8KFilings).mockResolvedValue([filing("zzu-q4", "2026-10-20", text)]);
    await fetchTranscript(db, "ZZU", 2026, 3, { eventDate: "2026-10-20" });
    db.prepare("UPDATE earnings_transcripts SET summary = '**Guidance**\n- note'").run();
    // The Finnhub entry arrives later: same filing, now a known print.
    const again = await fetchTranscript(db, "ZZU", 2026, 4, {
      eventDate: "2026-10-20",
      expectedFiscalQuarter: { year: 2026, quarter: 4 },
      skipAlphaVantage: true,
    });
    expect(again!.fromCache).toBe(true);
    expect(again!.transcript.summary).toBe("**Guidance**\n- note");
  });
});

describe("fetchTranscript — an explicit key (no print)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("rejects a vendor call whose stated quarter contradicts the requested key and falls through", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZX's fiscal second quarter 2026 earnings call."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([]);

    expect(await fetchTranscript(db, "ZZX", 2026, 4)).toBeNull();
    expect(rowsFor(db, "ZZX")).toEqual([]);
    expect(getEarnings8KFilings).toHaveBeenCalledTimes(1);
  });

  it("accepts a vendor call that states nothing (an explicit key is the caller's claim)", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Good afternoon everyone and thank you for standing by."),
    );
    const result = await fetchTranscript(db, "ZZX", 2026, 4);
    expect(result!.transcript.source).toBe("alpha_vantage");
  });

  it("finds an offset-fiscal filing by the fiscal quarter it states", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzx-q4", "2026-10-20", "ZZX reports fiscal fourth quarter 2026 results."),
      filing("zzx-q3", "2026-07-21", "ZZX reports fiscal third quarter 2026 results."),
    ]);
    const result = await fetchTranscript(db, "ZZX", 2026, 3);
    expect(result!.transcript.accession_number).toBe("zzx-q3");
  });

  it("never stores a filing under a key its own text contradicts", async () => {
    // Filed in the calendar third quarter's season, but it is the FISCAL
    // fourth quarter's release. No print date ties it to (2026, 3).
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzx-q4", "2026-10-20", "ZZX reports fiscal fourth quarter 2026 results."),
    ]);
    expect(await fetchTranscript(db, "ZZX", 2026, 3)).toBeNull();
    expect(rowsFor(db, "ZZX")).toEqual([]);
  });
});

describe("the default quarter is the latest print's fiscal quarter (fetch button + chat)", () => {
  let db: Database.Database;
  const printDate = addDays(todayET(), -1);
  beforeEach(() => {
    db = makeDb();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("resolves the latest print that has happened, through a superseded Finnhub twin", () => {
    seedCalendarEvent(db, { symbol: "ZZL", date: addDays(printDate, -91), rawJson: finnhub(3, 2026) });
    seedCalendarEvent(db, { symbol: "ZZL", date: printDate, source: "manual", rawJson: null });
    seedCalendarEvent(db, { symbol: "ZZL", date: addDays(printDate, -1), superseded: 1, rawJson: finnhub(4, 2026) });
    // A future row with a hand-entered pre-release actual is not "the latest print".
    seedCalendarEvent(db, { symbol: "ZZL", date: addDays(todayET(), 30), rawJson: finnhub(1, 2027) });

    expect(latestPrintFiscalQuarter(db, "ZZL")).toEqual({ year: 2026, quarter: 4, eventDate: printDate });
  });

  it("is null when the latest print has no Finnhub entry, or there is no print", () => {
    seedCalendarEvent(db, { symbol: "ZZL", date: printDate, source: "nasdaq", rawJson: null });
    expect(latestPrintFiscalQuarter(db, "ZZL")).toBeNull();
    expect(latestPrintFiscalQuarter(db, "ZZNONE")).toBeNull();
  });

  it("fetchLatestTranscript asks the vendor for the FISCAL quarter and ties the request to the print", async () => {
    seedCalendarEvent(db, { symbol: "ZZL", date: printDate, rawJson: finnhub(4, 2026) });
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZL's fiscal second quarter 2026 earnings call."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("zzl-q4", printDate, "ZZL reports fiscal fourth quarter 2026 results."),
    ]);

    const result = await fetchLatestTranscript(db, "ZZL");

    expect(getAlphaVantageTranscript).toHaveBeenCalledWith("ZZL", 2026, 4);
    expect(result).toMatchObject({ transcript: { source: "edgar_8k", year: 2026, quarter: 4 } });
  });

  it("getTranscriptForChat with no quarter uses the same default", async () => {
    seedCalendarEvent(db, { symbol: "ZZL", date: printDate, rawJson: finnhub(4, 2026) });
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZL's fiscal fourth quarter 2026 earnings call."),
    );

    const out = await getTranscriptForChat(db, "ZZL");

    expect(getAlphaVantageTranscript).toHaveBeenCalledWith("ZZL", 2026, 4);
    expect(out).toMatchObject({ year: 2026, quarter: 4, source: "alpha_vantage" });
  });

  it("getTranscriptForChat with an explicit quarter rejects a contradicting call", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce(
      vendorCall("Welcome to ZZL's fiscal second quarter 2026 earnings call."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([]);

    expect(await getTranscriptForChat(db, "ZZL", 2026, 4)).toBeNull();
    expect(rowsFor(db, "ZZL")).toEqual([]);
  });
});

describe("the latest transcript is never an older call passed off as the latest (fetch button + chat)", () => {
  let db: Database.Database;
  const printDate = addDays(todayET(), -1);
  beforeEach(() => {
    db = makeDb();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("latest print with no Finnhub entry: no vendor request by calendar quarter; the print's 8-K is found by its filing date", async () => {
    seedCalendarEvent(db, { symbol: "ZZL", date: printDate, source: "nasdaq", rawJson: null });
    // What the vendor would hand back for a calendar-quarter request: an
    // older call that states no quarter, which an explicit key accepts.
    vi.mocked(getAlphaVantageTranscript).mockResolvedValue(
      vendorCall("Thank you for standing by and welcome to the ZZL conference call."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValue([
      filing("zzl-latest", printDate, "ZZL reports fiscal fourth quarter 2026 results."),
    ]);

    const result = await fetchLatestTranscript(db, "ZZL");

    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      latestConfirmed: true,
      transcript: { source: "edgar_8k", year: 2026, quarter: 4, call_date: printDate },
    });
    expect(rowsFor(db, "ZZL").map((r) => r.source)).toEqual(["edgar_8k"]);
  });

  it("latest print with no Finnhub entry and no 8-K in its window: nothing is returned, and nothing older is fetched", async () => {
    seedCalendarEvent(db, { symbol: "ZZL", date: printDate, source: "nasdaq", rawJson: null });
    vi.mocked(getAlphaVantageTranscript).mockResolvedValue(
      vendorCall("Thank you for standing by and welcome to the ZZL conference call."),
    );
    vi.mocked(getEarnings8KFilings).mockResolvedValue([
      filing("zzl-prior", addDays(printDate, -91), "ZZL reports fiscal third quarter 2026 results."),
    ]);

    expect(await fetchLatestTranscript(db, "ZZL")).toBeNull();
    expect(await getTranscriptForChat(db, "ZZL")).toBeNull();
    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
    expect(rowsFor(db, "ZZL")).toEqual([]);
  });

  it("no earnings date on file: the calendar default still fetches, and the result says it is not confirmed as the latest", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValue(
      vendorCall("Thank you for standing by and welcome to the ZZN conference call."),
    );

    const result = await fetchLatestTranscript(db, "ZZN");
    expect(result).toMatchObject({ latestConfirmed: false, transcript: { source: "alpha_vantage" } });

    const out = await getTranscriptForChat(db, "ZZN");
    expect(out).toMatchObject({ source: "alpha_vantage", latest_confirmed: false });
    expect(out!.latest_note).toMatch(/could not be confirmed as the most recent/);
    expect(out!.latest_note).toContain(`Q${out!.quarter} ${out!.year}`);
    expect(out!.latest_note).toMatch(/\bcall\b/);
  });

  it("no earnings date on file and only an 8-K comes back: the note calls it a press release, never a call or transcript", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValue(null);
    const cal = getMostRecentQuarter();
    const ordinal = ["first", "second", "third", "fourth"][cal.quarter - 1];
    vi.mocked(getEarnings8KFilings).mockResolvedValue([
      filing("zzn-8k", addDays(todayET(), -30), `ZZN reports fiscal ${ordinal} quarter ${cal.year} results.`),
    ]);

    const out = await getTranscriptForChat(db, "ZZN");

    expect(out).toMatchObject({ source: "edgar_8k", latest_confirmed: false });
    expect(out!.latest_note).toMatch(/8-K press release/);
    expect(out!.latest_note).not.toMatch(/\b(?:call|transcript)\b/i);
  });

  it("a known print is confirmed, and an explicit quarter makes no claim about the latest", async () => {
    seedCalendarEvent(db, { symbol: "ZZL", date: printDate, rawJson: finnhub(4, 2026) });
    vi.mocked(getAlphaVantageTranscript).mockResolvedValue(
      vendorCall("Welcome to ZZL's fiscal fourth quarter 2026 earnings call."),
    );

    const latest = await getTranscriptForChat(db, "ZZL");
    expect(latest).toMatchObject({ year: 2026, quarter: 4, latest_confirmed: true, latest_note: null });

    const named = await getTranscriptForChat(db, "ZZL", 2026, 4);
    expect(named).toMatchObject({ year: 2026, quarter: 4, latest_confirmed: null, latest_note: null });
  });
});

describe("guidance keywords: inflected forms", () => {
  const call = (sentence: string) =>
    [
      "Operator: Good afternoon, and welcome to the ZZG earnings conference call.",
      `Jane Doe (CEO): Demand was steady across the regions during the period. ${sentence}`,
      "Question-and-answer session",
    ].join("\n\n");

  it.each([
    ["expects", "The company expects revenue growth in the low teens on steady demand."],
    ["expecting", "We are expecting revenue growth in the low teens on steady demand."],
    ["expected to", "Revenue growth is expected to land in the low teens on steady demand."],
    ["anticipates", "Management anticipates revenue growth in the low teens on steady demand."],
    ["anticipating", "We are anticipating revenue growth in the low teens on steady demand."],
    ["forecasts", "The company forecasts revenue growth in the low teens on steady demand."],
    ["forecasting", "We are forecasting revenue growth in the low teens on steady demand."],
    ["reaffirms", "The company reaffirms revenue growth in the low teens on steady demand."],
    ["reaffirmed", "We reaffirmed revenue growth in the low teens on steady demand."],
    ["reaffirming", "We are reaffirming revenue growth in the low teens on steady demand."],
  ])("'%s' qualifies a guidance sentence", (_form, sentence) => {
    expect(extractGuidance(call(sentence))).toBe(`Jane Doe (CEO): ${sentence}`);
  });

  it.each([
    ["better than expected", "Revenue came in better than expected on steady demand in the regions."],
    ["as anticipated", "Margins held up as anticipated on steady demand in the regions."],
    ["expectations", "Results exceeded expectations on steady demand in the regions."],
  ])("'%s' describes the quarter just reported and does not qualify", (_form, sentence) => {
    expect(extractGuidance(call(sentence))).toBeNull();
  });
});

describe("extractGuidance / extractRiskFactors", () => {
  // None of these fixtures contains the literal words that used to drive the
  // "prefer" rule; the pool is positional.
  const transcript = [
    "Operator: Good afternoon, and welcome to the ZZG fiscal year 2026 earnings conference call.",
    "Investor Relations: Before we begin, I would like to remind you that today's remarks include forward-looking statements and risks and uncertainties. Jane Doe (CEO): We expect next quarter revenue to improve and we are raising our full-year outlook.",
    "8-K Cover Page: The registrant furnished this report and Exhibit 99.1 under Item 2.02.",
    "Pat Roe (CFO): Tariff pressure and supply disruption risks could affect gross margin.",
    "Question-and-answer session",
    "Morgan Lee (Analyst, Example Securities): Do you expect the same tariff risk to impact guidance?",
  ].join("\n\n");

  it("strips safe-harbor sentences without dropping real guidance in the same paragraph", () => {
    expect(extractGuidance(transcript)).toBe(
      "Jane Doe (CEO): We expect next quarter revenue to improve and we are raising our full-year outlook.",
    );
    expect(extractRiskFactors(transcript)).toBe(
      "Pat Roe (CFO): Tariff pressure and supply disruption risks could affect gross margin.",
    );
  });

  it("guidance plus a safe-harbor sentence in one vendor-shaped turn keeps the guidance and the speaker", () => {
    const text = [
      "Operator (Operator): Good day and welcome to the ZZ third quarter 2026 earnings conference call.",
      "Dana Lee (CFO): Before we begin, today's remarks include forward-looking statements and actual results may differ. For the full year we now expect revenue of 410 to 420 million dollars, raising the midpoint by 5 million.",
      "Sam Roe (CEO): Freight costs remain a headwind and we see continued pressure on gross margin in the fourth quarter.",
      "Operator (Operator): We will now begin the question-and-answer session.",
      "Pat Kim (Analyst, Bigbank): What is the impact of tariffs on your outlook?",
      "Sam Roe (CEO): As we said, the tariff impact is roughly 40 basis points and we expect it to fade.",
    ].join("\n\n");

    expect(extractGuidance(text)).toBe(
      "Dana Lee (CFO): For the full year we now expect revenue of 410 to 420 million dollars, raising the midpoint by 5 million.",
    );
    expect(extractRiskFactors(text)).toBe(
      "Sam Roe (CEO): Freight costs remain a headwind and we see continued pressure on gross margin in the fourth quarter.",
    );
  });

  it("the vendor's 'Operator (Operator):' marker ends the pool: an executive's answer never reaches Guidance", () => {
    // Important 4: the marker regex was anchored to a line starting
    // "Operator:" and never matched the vendor's "Operator (Operator):".
    const text = [
      "Sam Roe (CEO): Results were solid across every region and segment this period, with strong cash generation.",
      "Operator (Operator): Our first question comes from Pat Kim with Bigbank. Please go ahead.",
      "Pat Kim (Analyst, Bigbank): What do you expect for margins?",
      "Sam Roe (CEO): We expect margins to decline given the tariff pressure, as I said earlier.",
    ].join("\n\n");
    expect(extractGuidance(text)).toBeNull();
    expect(extractRiskFactors(text)).toBeNull();
  });

  it("a bare 27-character section heading is found before any length filter", () => {
    const text = [
      "Sam Roe (CEO): We expect full-year revenue growth of eight to ten percent, raising our prior range.",
      "Question-and-answer session",
      "Sam Roe (CEO): In answer to that, we expect margins to decline given tariff pressure in the next quarter.",
    ].join("\n\n");
    expect(extractGuidance(text)).toBe(
      "Sam Roe (CEO): We expect full-year revenue growth of eight to ten percent, raising our prior range.",
    );
    expect(extractRiskFactors(text)).toBeNull();
  });

  it("the first analyst turn is the marker when the operator says nothing", () => {
    const text = [
      "Sam Roe (CEO): Thank you all. We delivered solid results and our project teams executed well across the regions this period.",
      "Dana Lee (CFO): We are reaffirming our outlook for operating margin of 18 to 19 percent for the year.",
      "Pat Kim (Analyst, Bigbank): Do you expect pricing pressure to impact the outlook next quarter?",
      "Sam Roe (CEO): We do not expect any change; pricing has held and the decline in input costs helps.",
    ].join("\n\n");
    expect(extractGuidance(text)).toBe(
      "Dana Lee (CFO): We are reaffirming our outlook for operating margin of 18 to 19 percent for the year.",
    );
    expect(extractRiskFactors(text)).toBeNull();
  });

  it("the operator's opening promise of a later question-and-answer session is NOT the marker", () => {
    const text = [
      "Operator (Operator): Good day. After the speakers' remarks there will be a question-and-answer session.",
      "Lee Park (Head of Investor Relations): After our remarks we will open the call for questions.",
      "Sam Roe (CEO): We expect full-year revenue growth of eight to ten percent.",
    ].join("\n\n");
    expect(extractGuidance(text)).toBe(
      "Sam Roe (CEO): We expect full-year revenue growth of eight to ten percent.",
    );
  });

  it("a closing line that opens the questions keeps that executive's own guidance", () => {
    const text = [
      "Dana Lee (CFO): For the full year we expect revenue of 410 to 420 million dollars. With that, we will now open the line for questions.",
      "Sam Roe (CEO): We expect margins to decline, to answer the first one.",
    ].join("\n\n");
    expect(extractGuidance(text)).toBe(
      "Dana Lee (CFO): For the full year we expect revenue of 410 to 420 million dollars. With that, we will now open the line for questions.",
    );
  });

  it("an excerpt starts at the sentence that matched, not at the top of a long turn", () => {
    const greeting = "Thank you, operator. Revenue was 100 million dollars in the period. ".repeat(12);
    const text = `Sam Roe (CEO): ${greeting}Looking ahead, we expect capital spending of about 60 million dollars.`;
    expect(extractGuidance(text)).toBe(
      "Sam Roe (CEO): Looking ahead, we expect capital spending of about 60 million dollars.",
    );
  });

  it("a call with no real guidance returns null for both sections", () => {
    const text = [
      "Operator (Operator): Good day and welcome to the ZZ call. This call contains forward-looking statements subject to risks and uncertainties.",
      "Sam Roe (CEO): Revenue was 100 million dollars and operating income was 20 million dollars in the period just ended.",
      "Dana Lee (CFO): Cash at period end was 50 million dollars and we repurchased two million shares.",
    ].join("\n\n");
    expect(extractGuidance(text)).toBeNull();
    expect(extractRiskFactors(text)).toBeNull();
  });

  it("an unlabelled transcript uses the whole text as the pool", () => {
    const text = [
      "Thank you for joining us. Revenue grew twelve percent on strength in the services segment during the period.",
      "Looking ahead, we expect capital spending of about 60 million dollars and anticipate margin expansion in the back half.",
      "Supply disruption in one region remains a challenge and created pressure on delivery times.",
      "A second concern is the tariff schedule, which adds uncertainty to our sourcing costs.",
    ].join("\n\n");
    expect(extractGuidance(text)).toBe(
      "Looking ahead, we expect capital spending of about 60 million dollars and anticipate margin expansion in the back half.",
    );
    expect(extractRiskFactors(text)).toBe(
      "Supply disruption in one region remains a challenge and created pressure on delivery times.\n\nA second concern is the tariff schedule, which adds uncertainty to our sourcing costs.",
    );
  });

  it("with no titles and no marker, a short labelled turn that ends in a question starts the Q&A", () => {
    const text = [
      "Sam Roe: We expect full-year revenue growth of eight to ten percent, raising our prior range.",
      "Dana Lee: Wage inflation is a headwind that will pressure margins by about 30 basis points.",
      "Pat Kim: Thanks. Could you talk about what you expect for the tariff impact next quarter?",
      "Sam Roe: Sure, Pat. As I noted, we anticipate a modest drag.",
    ].join("\n\n");
    expect(extractGuidance(text)).toBe(
      "Sam Roe: We expect full-year revenue growth of eight to ten percent, raising our prior range.",
    );
    expect(extractRiskFactors(text)).toBe(
      "Dana Lee: Wage inflation is a headwind that will pressure margins by about 30 basis points.",
    );
  });

  it("turns separated by a single newline are still split by their speaker labels", () => {
    const text = [
      "Sam Roe (CEO): We expect full-year revenue growth of eight to ten percent.",
      "Pat Kim (Analyst, Bigbank): What risk do you see from tariffs and what is the impact?",
      "Sam Roe (CEO): The tariff risk is modest.",
    ].join("\n");
    expect(extractGuidance(text)).toBe(
      "Sam Roe (CEO): We expect full-year revenue growth of eight to ten percent.",
    );
    expect(extractRiskFactors(text)).toBeNull();
  });

  it("boilerplate is stripped by sentence everywhere: a turn that thanks investor relations keeps its guidance", () => {
    const text =
      "Dana Lee (CFO): Thanks to our investor relations team. For the full year we expect revenue of 410 to 420 million dollars.";
    expect(extractGuidance(text)).toBe(
      "Dana Lee (CFO): For the full year we expect revenue of 410 to 420 million dollars.",
    );
  });

  it("'project' as a noun and 'impact' inside a question do not qualify a paragraph", () => {
    const text = [
      "Jane Doe (CEO): Project teams delivered the roadmap on schedule. What impact will tariffs have?",
    ].join("\n\n");
    expect(extractGuidance(text)).toBeNull();
    expect(extractRiskFactors(text)).toBeNull();
  });

  it("never returns the same passage for guidance and risk", () => {
    const both = "Jane Doe (CEO): We expect stronger demand, though tariff risk could affect that outlook.";
    expect(extractGuidance(both)).toContain("stronger demand");
    expect(extractRiskFactors(both)).toBeNull();
  });

  it("removes guidance passages from risk BEFORE the top-2 cut (a third risk paragraph is not lost)", () => {
    // Important 5: one paragraph that is both, plus two more risk paragraphs,
    // used to return a single risk paragraph.
    const text = [
      "Sam Roe (CEO): We expect stronger demand, though tariff risk could affect that outlook.",
      "Dana Lee (CFO): Wage inflation is a headwind that will weigh on margins by about 30 basis points.",
      "Dana Lee (CFO): Currency is a further challenge as the weaker yen reduces translated sales.",
    ].join("\n\n");
    expect(extractGuidance(text)).toBe(
      "Sam Roe (CEO): We expect stronger demand, though tariff risk could affect that outlook.",
    );
    expect(extractRiskFactors(text)).toBe(
      "Dana Lee (CFO): Wage inflation is a headwind that will weigh on margins by about 30 basis points.\n\nDana Lee (CFO): Currency is a further challenge as the weaker yen reduces translated sales.",
    );
  });

  it("a long turn can give a guidance passage and a separate risk passage", () => {
    const text =
      "Sam Roe (CEO): We expect full-year revenue growth of eight to ten percent. Units shipped rose. Freight costs remain a headwind for gross margin.";
    expect(extractGuidance(text)).toBe(
      "Sam Roe (CEO): We expect full-year revenue growth of eight to ten percent. Units shipped rose. Freight costs remain a headwind for gross margin.",
    );
    // The headwind sentence is already shown under Guidance.
    expect(extractRiskFactors(text)).toBeNull();
  });

  it("is deterministic (the stored-row repair relies on it)", () => {
    expect(extractGuidance(transcript)).toBe(extractGuidance(transcript));
    expect(extractRiskFactors(transcript)).toBe(extractRiskFactors(transcript));
  });
});

describe("fetchTranscript — EDGAR filing match for an explicit key", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("rejects an EDGAR filing whose reporting quarter doesn't match the request", async () => {
    // User requests Q1 2026; EDGAR only returns a Q4 2025 filing (Jan 2026
    // file date). It must not be cached under year=2026 q=1 labels.
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("wrong-quarter", "2026-02-03", "this is Q4 content"),
    ]);

    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).toBeNull();
    const cached = db
      .prepare("SELECT COUNT(*) AS c FROM earnings_transcripts")
      .get() as { c: number };
    expect(cached.c).toBe(0);
  });

  it("caches an EDGAR filing whose reporting quarter matches the request", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("right-quarter", "2026-04-22", "this is Q1 2026 content"),
    ]);

    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.transcript.year).toBe(2026);
    expect(result!.transcript.quarter).toBe(1);
    expect(result!.transcript.accession_number).toBe("right-quarter");
    expect(result!.transcript.transcript).toContain("Q1 2026 content");
  });

  it("picks the matching filing from a list of multiple candidates", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      filing("q4-2025", "2026-02-03", "Q4 2025 content"),
      filing("q1-2026", "2026-04-25", "Q1 2026 content"),
      filing("q3-2025", "2025-11-04", "Q3 2025 content"),
    ]);

    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.transcript.accession_number).toBe("q1-2026");
    expect(result!.transcript.transcript).toContain("Q1 2026 content");
  });
});
