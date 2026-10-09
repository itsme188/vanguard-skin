/**
 * The key audit and filings stored by filing date.
 *
 * An 8-K press release fetched for a known print is stored under the print's
 * key on the evidence of its FILING DATE, even when the release labels the
 * quarter differently (`upsertTranscript`, rule 2). That is the design, so the
 * audit must not list such a row as a contradiction. The rows here are written
 * by the real writer, `upsertTranscript`, the same way `fetchFiling` calls it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import { deriveFilingReportingQuarter } from "@/lib/transcripts/fetch";
import { auditTranscriptKeys } from "../../scripts/audit-transcript-keys";

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function seedPrint(opts: {
  symbol: string;
  date: string;
  source?: string;
  superseded?: number;
  fiscal?: { quarter: number; year: number } | null;
}): void {
  seq += 1;
  db.prepare(
    `INSERT INTO calendar_events
      (source, event_type, event_date, release_time, title, symbol, actual_value, source_key, week_of, superseded, raw_json)
     VALUES (?, 'earnings', ?, '16:00', ?, ?, 'EPS 1.00', ?, ?, ?, ?)`,
  ).run(
    opts.source ?? "finnhub",
    opts.date,
    `${opts.symbol} earnings`,
    opts.symbol,
    `seed:${opts.symbol}:${opts.date}:${seq}`,
    opts.date,
    opts.superseded ?? 0,
    opts.fiscal ? JSON.stringify({ entry: opts.fiscal }) : null,
  );
}

/** Store a filing the way `fetchFiling` does for a print. */
function storeFilingForPrint(opts: {
  ticker: string;
  year: number;
  quarter: number;
  filingDate: string;
  printDate: string;
  text: string;
}): void {
  upsertTranscript(db, {
    ticker: opts.ticker,
    year: opts.year,
    quarter: opts.quarter,
    call_date: opts.filingDate,
    source: "edgar_8k",
    transcript: opts.text,
    summary: null,
    accession_number: `acc-${opts.ticker}`,
    filing_url: null,
    source_key: `edgar_8k:acc-${opts.ticker}`,
    print_event_date: opts.printDate,
  });
}

describe("audit-transcript-keys: filings stored by filing date", () => {
  it("does not list a filing stored under its print's Finnhub fiscal quarter, and counts it separately", () => {
    // The release labels itself the third quarter; the print is fiscal Q4.
    seedPrint({ symbol: "ZZA", date: "2026-08-20", fiscal: { quarter: 4, year: 2026 } });
    storeFilingForPrint({
      ticker: "ZZA",
      year: 2026,
      quarter: 4,
      filingDate: "2026-08-21",
      printDate: "2026-08-20",
      text: "ZZA reports third quarter 2026 results.",
    });

    const audit = auditTranscriptKeys(db);

    expect(audit.contradictions).toEqual([]);
    expect(audit.dateMatchedFilings).toEqual([
      expect.objectContaining({
        ticker: "ZZA",
        key_year: 2026,
        key_quarter: 4,
        stated_year: 2026,
        stated_quarter: 3,
        source: "edgar_8k",
        print_date: "2026-08-20",
      }),
    ]);
  });

  it("finds the print through a superseded Finnhub twin beside a live row with no entry", () => {
    seedPrint({ symbol: "ZZB", date: "2026-08-20", source: "nasdaq", fiscal: null });
    seedPrint({ symbol: "ZZB", date: "2026-08-19", superseded: 1, fiscal: { quarter: 4, year: 2026 } });
    storeFilingForPrint({
      ticker: "ZZB",
      year: 2026,
      quarter: 4,
      filingDate: "2026-08-20",
      printDate: "2026-08-20",
      text: "ZZB reports third quarter 2026 results.",
    });

    const audit = auditTranscriptKeys(db);
    expect(audit.contradictions).toEqual([]);
    expect(audit.dateMatchedFilings).toHaveLength(1);
  });

  it("does not list a filing stored under the calendar key of a print with no fiscal quarter on file", () => {
    seedPrint({ symbol: "ZZC", date: "2026-08-20", source: "nasdaq", fiscal: null });
    const cal = deriveFilingReportingQuarter("2026-08-20");
    // A passing mention only: too weak to key the filing, enough to differ.
    storeFilingForPrint({
      ticker: "ZZC",
      year: cal.year,
      quarter: cal.quarter,
      filingDate: "2026-08-20",
      printDate: "2026-08-20",
      text: "ZZC announces a dividend. In the fourth quarter we closed the plant sale.",
    });

    const audit = auditTranscriptKeys(db);
    expect(audit.contradictions).toEqual([]);
    expect(audit.dateMatchedFilings).toHaveLength(1);
  });

  it("still lists a filing whose key is NOT its print's fiscal quarter", () => {
    seedPrint({ symbol: "ZZD", date: "2026-08-20", fiscal: { quarter: 4, year: 2026 } });
    // Written straight to the table: the real writer would refuse this row.
    db.prepare(
      `INSERT INTO earnings_transcripts
        (ticker, year, quarter, call_date, source, transcript, source_key, fetched_at)
       VALUES ('ZZD', 2026, 2, '2026-08-20', 'edgar_8k',
        'ZZD reports third quarter 2026 results.', 'edgar_8k:acc-ZZD', datetime('now'))`,
    ).run();

    const audit = auditTranscriptKeys(db);
    expect(audit.contradictions).toEqual([
      expect.objectContaining({ ticker: "ZZD", key_quarter: 2, stated_quarter: 3 }),
    ]);
    expect(audit.dateMatchedFilings).toEqual([]);
  });

  it("still lists a filing with no earnings print inside the filing window", () => {
    seedPrint({ symbol: "ZZE", date: "2026-05-20", fiscal: { quarter: 4, year: 2026 } });
    db.prepare(
      `INSERT INTO earnings_transcripts
        (ticker, year, quarter, call_date, source, transcript, source_key, fetched_at)
       VALUES ('ZZE', 2026, 4, '2026-08-20', 'edgar_8k',
        'ZZE reports third quarter 2026 results.', 'edgar_8k:acc-ZZE', datetime('now'))`,
    ).run();

    const audit = auditTranscriptKeys(db);
    expect(audit.contradictions).toHaveLength(1);
    expect(audit.dateMatchedFilings).toEqual([]);
  });

  it("never exempts a call, whatever its date", () => {
    seedPrint({ symbol: "ZZF", date: "2026-08-20", fiscal: { quarter: 4, year: 2026 } });
    db.prepare(
      `INSERT INTO earnings_transcripts
        (ticker, year, quarter, call_date, source, transcript, source_key, fetched_at)
       VALUES ('ZZF', 2026, 4, '2026-08-20', 'api_ninjas',
        'Operator: Welcome to the ZZF fiscal third quarter 2026 earnings call.',
        'api_ninjas:ZZF:2026:4', datetime('now'))`,
    ).run();

    const audit = auditTranscriptKeys(db);
    expect(audit.contradictions).toEqual([
      expect.objectContaining({ ticker: "ZZF", source: "api_ninjas" }),
    ]);
    expect(audit.dateMatchedFilings).toEqual([]);
  });
});
