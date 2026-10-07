import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import {
  deriveFilingReportingQuarter,
  expectedFiscalQuarterForPrint,
  extractGuidance,
  extractRiskFactors,
  fetchTranscript,
  getTranscriptForChat,
  statedFiscalQuarterFromTranscript,
} from "@/lib/transcripts/fetch";
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

  it("legacy edgar_8k cache (<=5200 chars) is invalidated when fullText=true", async () => {
    // Seed a cache row that looks like the pre-E2 EDGAR truncation.
    const legacy = "x".repeat(4800);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", legacy);

    // Verify the legacy row was seeded via its deterministic source_key.
    const seeded = db
      .prepare("SELECT transcript FROM earnings_transcripts WHERE source_key = ?")
      .get("edgar_8k:AAPL:2026:1") as { transcript: string } | undefined;
    expect(seeded?.transcript).toBe(legacy);

    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, {
      fullText: true,
    });

    // Either the re-fetch succeeded (new content != legacy) or it failed and
    // the row is gone entirely. Both outcomes are correct — the legacy
    // short body must never be returned under a "full text" claim.
    if (out !== null) {
      expect(out.excerpt).not.toBe(legacy);
    }
    const afterRow = db
      .prepare("SELECT transcript FROM earnings_transcripts WHERE source_key = ?")
      .get("edgar_8k:AAPL:2026:1") as { transcript: string } | undefined;
    if (afterRow) {
      expect(afterRow.transcript).not.toBe(legacy);
    }
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

describe("transcript fiscal-quarter evidence", () => {
  it.each([
    ["third quarter 2026", { quarter: 3, year: 2026 }],
    ["fiscal second quarter 2026", { quarter: 2, year: 2026 }],
    ["second quarter fiscal 2026", { quarter: 2, year: 2026 }],
    ["Second Quarter Fiscal Year 2026", { quarter: 2, year: 2026 }],
    ["Q2 Fiscal Year 2026", { quarter: 2, year: 2026 }],
    ["Q2 FY26", { quarter: 2, year: 2026 }],
    ["fourth quarter and full year fiscal 2026", { quarter: 4, year: 2026 }],
    ["first quarter fiscal 2027", { quarter: 1, year: 2027 }],
    ["second quarter earnings call", { quarter: 2, year: null }],
  ])("reads %s", (phrase, expected) => {
    expect(statedFiscalQuarterFromTranscript(`Operator: Welcome to ZZ Test's ${phrase}.`)).toEqual(
      expected,
    );
  });

  it("does not read an unrelated quarter sentence deep in the call", () => {
    const text = `${"Introductory operating remarks without quarter labels. ".repeat(360)}

Jane Doe (CEO): A customer asked about third quarter 2026 budgets in a separate context.`;
    expect(statedFiscalQuarterFromTranscript(text)).toBeNull();
  });
});

describe("expectedFiscalQuarterForPrint", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  function seedCalendarEvent(opts: {
    symbol: string;
    date: string;
    source?: string;
    superseded?: number;
    rawJson?: string | null;
  }) {
    db.prepare(
      `INSERT INTO calendar_events
        (source, event_type, event_date, release_time, title, symbol, actual_value, source_key, week_of, superseded, raw_json)
       VALUES (?, 'earnings', ?, '16:00', ?, ?, 'EPS 1.00', ?, ?, ?, ?)`,
    ).run(
      opts.source ?? "finnhub",
      opts.date,
      `${opts.symbol} earnings`,
      opts.symbol,
      `${opts.source ?? "finnhub"}:${opts.symbol}:${opts.date}:${opts.superseded ?? 0}`,
      opts.date,
      opts.superseded ?? 0,
      opts.rawJson ?? JSON.stringify({ entry: { quarter: 4, year: 2026 } }),
    );
  }

  it("reads Finnhub quarter/year from a nearby superseded twin", () => {
    seedCalendarEvent({
      symbol: "ZZF",
      date: "2026-09-30",
      source: "manual",
      rawJson: null,
    });
    seedCalendarEvent({
      symbol: "ZZF",
      date: "2026-09-29",
      superseded: 1,
      rawJson: JSON.stringify({ entry: { quarter: 4, year: 2026 } }),
    });

    expect(expectedFiscalQuarterForPrint(db, "ZZF", "2026-09-30")).toEqual({
      quarter: 4,
      year: 2026,
    });
  });

  it("returns null for malformed raw_json instead of throwing", () => {
    seedCalendarEvent({ symbol: "ZZB", date: "2026-09-30", rawJson: "{bad json" });
    expect(expectedFiscalQuarterForPrint(db, "ZZB", "2026-09-30")).toBeNull();
  });
});

describe("fetchTranscript — fiscal self-consistency guard", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    vi.clearAllMocks();
  });

  it("accepts a calendar-year call through the phrase path without any vendor date", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce({
      transcript:
        "Operator: Welcome to ZZC's third quarter 2026 earnings call.\n\nJane Doe (CEO): We expect demand to improve next quarter.",
      participants: [{ name: "Jane Doe", title: "CEO" }],
      overall_sentiment: 0.2,
    });

    const result = await fetchTranscript(db, "ZZC", 2026, 3, {
      eventDate: "2026-09-30",
      expectedFiscalQuarter: { year: 2026, quarter: 3 },
    });

    expect(result).not.toBeNull();
    expect(result!.transcript.source).toBe("alpha_vantage");
    expect(result!.transcript.call_date).toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts WHERE ticker = 'ZZC'").get() as {
        c: number;
      }).c,
    ).toBe(1);
  });

  it("rejects an off-calendar wrong fiscal quarter and falls through to the EDGAR step", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce({
      transcript:
        "Operator: Welcome to ZZQ's fiscal second quarter 2026 financial conference call.\n\nJane Doe (CEO): Prepared remarks.",
      participants: [{ name: "Jane Doe", title: "CEO" }],
      overall_sentiment: 0.1,
    });
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      {
        accessionNumber: "fallback-accession",
        filingDate: "2026-10-01",
        filingUrl: "https://example.test/fallback",
        pressReleaseText: "fallback ".repeat(2000),
      },
    ]);

    const result = await fetchTranscript(db, "ZZQ", 2026, 4, {
      eventDate: "2026-09-30",
      expectedFiscalQuarter: { year: 2026, quarter: 4 },
    });

    expect(result).toBeNull();
    expect(getEarnings8KFilings).toHaveBeenCalledWith("ZZQ", expect.any(Object));
  });

  it("accepts an off-calendar transcript when it states the expected fiscal quarter", async () => {
    vi.mocked(getAlphaVantageTranscript).mockResolvedValueOnce({
      transcript:
        "Operator: Welcome to ZZQ's fiscal fourth quarter 2026 financial conference call.\n\nJane Doe (CEO): Prepared remarks.",
      participants: [{ name: "Jane Doe", title: "CEO" }],
      overall_sentiment: 0.1,
    });

    const result = await fetchTranscript(db, "ZZQ", 2026, 4, {
      eventDate: "2026-10-22",
      expectedFiscalQuarter: { year: 2026, quarter: 4 },
    });

    expect(result).not.toBeNull();
    expect(result!.transcript.source).toBe("alpha_vantage");
    expect(getEarnings8KFilings).not.toHaveBeenCalled();
  });

  it("skips Alpha Vantage when a print has no Finnhub fiscal quarter and still tries EDGAR", async () => {
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      {
        accessionNumber: "fallback-accession",
        filingDate: "2026-10-01",
        filingUrl: "https://example.test/fallback",
        pressReleaseText: "fallback ".repeat(2000),
      },
    ]);

    const result = await fetchTranscript(db, "ZZU", 2026, 3, {
      eventDate: "2026-10-01",
      skipAlphaVantage: true,
    });

    expect(getAlphaVantageTranscript).not.toHaveBeenCalled();
    expect(getEarnings8KFilings).toHaveBeenCalledTimes(1);
    expect(result!.transcript.source).toBe("edgar_8k");
  });
});

describe("extractGuidance / extractRiskFactors", () => {
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

  it("excludes analyst turns labelled in parentheses and does not let noun/project or question/impact qualify", () => {
    const text = [
      "Jane Doe (CEO): Project teams delivered the roadmap on schedule.",
      "Question-and-answer session",
      "Morgan Lee (Analyst, Example Securities): What impact do you expect from tariffs?",
    ].join("\n\n");
    expect(extractGuidance(text)).toBeNull();
    expect(extractRiskFactors(text)).toBeNull();
  });

  it("uses the whole transcript when no Q&A marker exists", () => {
    const text = "Jane Doe (CEO): We forecast stronger demand next quarter and expect margin to improve.";
    expect(extractGuidance(text)).toContain("forecast stronger demand");
  });

  it("never returns the same paragraph for guidance and risk", () => {
    const both = [
      "Jane Doe (CEO): We expect stronger demand, though tariff risk could affect that outlook.",
    ].join("\n\n");

    expect(extractGuidance(both)).toContain("stronger demand");
    expect(extractRiskFactors(both)).toBeNull();
  });
});

describe("fetchTranscript — EDGAR quarter-match guard", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    vi.clearAllMocks();
  });

  it("rejects an EDGAR filing whose reporting quarter doesn't match the request", async () => {
    // User requests Q1 2026; EDGAR only returns a Q4 2025 filing (Jan 2026
    // file date). Pre-fix this would silently cache the Q4 body under
    // year=2026 q=1 labels. Now it returns null.
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      {
        accessionNumber: "wrong-quarter",
        filingDate: "2026-02-03", // → Q4 2025
        filingUrl: "https://example.test/wrong",
        pressReleaseText: "this is Q4 content",
      },
    ]);

    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).toBeNull();
    const cached = db
      .prepare("SELECT COUNT(*) AS c FROM earnings_transcripts")
      .get() as { c: number };
    expect(cached.c).toBe(0);
  });

  it("caches an EDGAR filing whose reporting quarter matches the request", async () => {
    // User requests Q1 2026; EDGAR returns a filing dated 2026-04-22 → Q1.
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      {
        accessionNumber: "right-quarter",
        filingDate: "2026-04-22", // → Q1 2026
        filingUrl: "https://example.test/right",
        pressReleaseText: "this is Q1 2026 content",
      },
    ]);

    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.transcript.year).toBe(2026);
    expect(result!.transcript.quarter).toBe(1);
    expect(result!.transcript.accession_number).toBe("right-quarter");
    expect(result!.transcript.transcript).toContain("Q1 2026 content");
  });

  it("picks the matching filing from a list of multiple candidates", async () => {
    // EDGAR returns 3 filings; user requests Q1 2026. Only one matches.
    vi.mocked(getEarnings8KFilings).mockResolvedValueOnce([
      {
        accessionNumber: "q4-2025",
        filingDate: "2026-02-03",
        filingUrl: "https://example.test/q4",
        pressReleaseText: "Q4 2025 content",
      },
      {
        accessionNumber: "q1-2026",
        filingDate: "2026-04-25",
        filingUrl: "https://example.test/q1",
        pressReleaseText: "Q1 2026 content",
      },
      {
        accessionNumber: "q3-2025",
        filingDate: "2025-11-04",
        filingUrl: "https://example.test/q3",
        pressReleaseText: "Q3 2025 content",
      },
    ]);

    const result = await fetchTranscript(db, "TER", 2026, 1);

    expect(result).not.toBeNull();
    expect(result!.transcript.accession_number).toBe("q1-2026");
    expect(result!.transcript.transcript).toContain("Q1 2026 content");
  });
});
