import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getTranscriptsSummary,
  getTickersWithTranscripts,
} from "@/lib/queries/transcripts";
import { upsertTranscript } from "@/lib/mutations/transcripts";

// ─── Seed helpers ─────────────────────────────────────────────────

function seedSecurity(db: Database.Database, symbol: string, name?: string): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, name ?? `${symbol} Corp`);
  return result.lastInsertRowid as number;
}

function seedTranscript(
  db: Database.Database,
  securityId: number,
  ticker: string,
  year = 2026,
  quarter = 2,
  text?: { summary?: string; guidance?: string },
  source: "api_ninjas" | "alpha_vantage" | "motley_fool" | "edgar_8k" = "api_ninjas"
): void {
  upsertTranscript(db, {
    security_id: securityId,
    ticker,
    year,
    quarter,
    source,
    summary: text?.summary ?? `${ticker} Q${quarter} summary`,
    guidance: text?.guidance ?? null,
    source_key: `${source}:${ticker}:${year}:${quarter}`,
  });
}

// ─── Test setup ───────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ─── getTranscriptsSummary search filter ───────────────────────────
//
// Regression pin (research-notes-earnings--search-box-ignored-regression-3,
// part 2): the Earnings tab's transcript wall is fed by this function.
// The notes-half of the fix (getEarningsTimeline) filtered correctly, but
// getTranscriptsSummary had no `search` option at all — page.tsx called it
// with only `{ limit: 50 }`, so 50 unfiltered transcript cards rendered
// regardless of the search box. Pin the filter here, at the source.

describe("getTranscriptsSummary search filter", () => {
  it("matches by ticker substring, case-insensitive", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    const ibkrId = seedSecurity(db, "IBKR", "Interactive Brokers Group");
    seedTranscript(db, nflxId, "NFLX");
    seedTranscript(db, ibkrId, "IBKR");

    const results = getTranscriptsSummary(db, { search: "nflx" });
    expect(results.length).toBe(1);
    expect(results[0].ticker).toBe("NFLX");
  });

  it("matches by company name substring, case-insensitive", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    const ibkrId = seedSecurity(db, "IBKR", "Interactive Brokers Group");
    seedTranscript(db, nflxId, "NFLX");
    seedTranscript(db, ibkrId, "IBKR");

    const results = getTranscriptsSummary(db, { search: "netflix" });
    expect(results.length).toBe(1);
    expect(results[0].ticker).toBe("NFLX");
  });

  it("returns no rows when the search text matches nothing", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    seedTranscript(db, nflxId, "NFLX");

    const results = getTranscriptsSummary(db, { search: "ZZZNOMATCH" });
    expect(results).toEqual([]);
  });

  it("combines securityId and search filters", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    const nflxOldQuarter = nflxId; // same security, second quarter
    const ibkrId = seedSecurity(db, "IBKR", "Interactive Brokers Group");
    seedTranscript(db, nflxId, "NFLX", 2026, 2);
    seedTranscript(db, nflxOldQuarter, "NFLX", 2026, 1);
    seedTranscript(db, ibkrId, "IBKR", 2026, 2);

    const results = getTranscriptsSummary(db, { securityId: nflxId, search: "nflx" });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.ticker === "NFLX")).toBe(true);
  });

  it("with no search text, behaves as before (unfiltered)", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    const ibkrId = seedSecurity(db, "IBKR", "Interactive Brokers Group");
    seedTranscript(db, nflxId, "NFLX");
    seedTranscript(db, ibkrId, "IBKR");

    const results = getTranscriptsSummary(db);
    expect(results.length).toBe(2);
  });

  // ─── Unified search semantics (identity OR text) ─────────────────
  //
  // One search box drives both halves of the Earnings tab, so both halves
  // must answer the same question: does this row match on IDENTITY (ticker /
  // company name) or on TEXT (the note's prose / the transcript's summary +
  // guidance)? The first cut searched transcripts on identity only, so
  // typing a word that appears in a summary ("guidance") emptied the whole
  // transcript wall even though every card contained it.

  it("matches by summary text, not just ticker or company name", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    const ibkrId = seedSecurity(db, "IBKR", "Interactive Brokers Group");
    seedTranscript(db, nflxId, "NFLX", 2026, 2, {
      summary: "Paid sharing lapped; ad tier now a material revenue line",
    });
    seedTranscript(db, ibkrId, "IBKR", 2026, 2, {
      summary: "Account growth steady, margin loan balances up",
    });

    const results = getTranscriptsSummary(db, { search: "ad tier" });
    expect(results.length).toBe(1);
    expect(results[0].ticker).toBe("NFLX");
  });

  it("matches by guidance text, case-insensitive", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    const ibkrId = seedSecurity(db, "IBKR", "Interactive Brokers Group");
    seedTranscript(db, nflxId, "NFLX", 2026, 2, {
      summary: "Solid quarter",
      guidance: "Raised full-year operating margin to 29%",
    });
    seedTranscript(db, ibkrId, "IBKR", 2026, 2, { summary: "Solid quarter" });

    const results = getTranscriptsSummary(db, { search: "OPERATING MARGIN" });
    expect(results.length).toBe(1);
    expect(results[0].ticker).toBe("NFLX");
  });

  it("still matches on identity when the text does not contain the term", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    seedTranscript(db, nflxId, "NFLX", 2026, 2, {
      summary: "Streaming demand held up",
    });

    expect(getTranscriptsSummary(db, { search: "nflx" }).length).toBe(1);
    expect(getTranscriptsSummary(db, { search: "netflix" }).length).toBe(1);
  });
});

// ─── getTranscriptsSummary source dedupe ───────────────────────────
//
// Regression pin (research-transcripts-list--8k-cover-pages-labelled-
// transcript-duplicate-quarter-cards): earnings_transcripts legitimately
// stores several rows per (ticker, year, quarter) from different sources
// (api_ninjas / alpha_vantage / motley_fool / edgar_8k — the last an SEC
// 8-K cover page fetched as a fallback). getCachedTranscript and
// getLatestCachedTranscript already pick ONE best-source row per quarter;
// getTranscriptsSummary must match that same preference so the card wall
// never shows two cards — or the worse one first — for one quarter.

describe("getTranscriptsSummary source dedupe", () => {
  it("collapses edgar_8k + alpha_vantage for the same quarter into one row, preferring alpha_vantage", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    seedTranscript(db, nflxId, "NFLX", 2026, 2, undefined, "edgar_8k");
    seedTranscript(db, nflxId, "NFLX", 2026, 2, undefined, "alpha_vantage");

    const results = getTranscriptsSummary(db, { ticker: "NFLX" });
    expect(results.length).toBe(1);
    expect(results[0].source).toBe("alpha_vantage");
  });

  it("still returns an edgar_8k row when it is the only source for that quarter", () => {
    const sofiId = seedSecurity(db, "SOFI", "SoFi Technologies");
    seedTranscript(db, sofiId, "SOFI", 2026, 1, undefined, "edgar_8k");

    const results = getTranscriptsSummary(db, { ticker: "SOFI" });
    expect(results.length).toBe(1);
    expect(results[0].source).toBe("edgar_8k");
  });

  it("dedupes before applying the limit — 3 tickers x 2 sources with limit 3 yields 3 distinct tickers", () => {
    const aId = seedSecurity(db, "AAPL", "Apple Inc");
    const bId = seedSecurity(db, "MSFT", "Microsoft Corp");
    const cId = seedSecurity(db, "GOOG", "Alphabet Inc");
    for (const [id, ticker] of [
      [aId, "AAPL"],
      [bId, "MSFT"],
      [cId, "GOOG"],
    ] as const) {
      seedTranscript(db, id, ticker, 2026, 2, undefined, "edgar_8k");
      seedTranscript(db, id, ticker, 2026, 2, undefined, "alpha_vantage");
    }

    const results = getTranscriptsSummary(db, { limit: 3 });
    expect(results.length).toBe(3);
    const tickers = new Set(results.map((r) => r.ticker));
    expect(tickers.size).toBe(3);
    expect(results.every((r) => r.source === "alpha_vantage")).toBe(true);
  });
});

// ─── getTickersWithTranscripts ─────────────────────────────────────
//
// The Earnings tab's "Fetch <TICKER> Transcript" buttons are the COMPLEMENT
// of this set. Deriving the has-transcript set from the (search-filtered)
// transcript wall made already-cached tickers reappear as fetch candidates
// whenever a filter was active — and an edgar_8k-only name spends a real
// Alpha Vantage call on every click. This set is deliberately unfiltered.

describe("getTickersWithTranscripts", () => {
  it("returns every cached ticker, unaffected by any search filter", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    const ibkrId = seedSecurity(db, "IBKR", "Interactive Brokers Group");
    seedTranscript(db, nflxId, "NFLX");
    seedTranscript(db, ibkrId, "IBKR");

    // A search that trims the wall to one card must not shrink this set.
    expect(getTranscriptsSummary(db, { search: "nflx" }).length).toBe(1);
    expect(getTickersWithTranscripts(db).sort()).toEqual(["IBKR", "NFLX"]);
  });

  it("dedupes multiple quarters of the same ticker", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    seedTranscript(db, nflxId, "NFLX", 2026, 1);
    seedTranscript(db, nflxId, "NFLX", 2026, 2);
    seedTranscript(db, nflxId, "NFLX", 2025, 4);

    expect(getTickersWithTranscripts(db)).toEqual(["NFLX"]);
  });

  it("returns uppercase tickers and an empty list when nothing is cached", () => {
    expect(getTickersWithTranscripts(db)).toEqual([]);

    const secId = seedSecurity(db, "SOFI", "SoFi Technologies");
    upsertTranscript(db, {
      security_id: secId,
      ticker: "sofi",
      year: 2026,
      quarter: 1,
      source: "edgar_8k",
      source_key: "edgar_8k:sofi:2026:1",
    });

    expect(getTickersWithTranscripts(db)).toEqual(["SOFI"]);
  });
});
