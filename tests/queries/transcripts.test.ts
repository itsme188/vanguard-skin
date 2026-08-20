import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTranscriptsSummary } from "@/lib/queries/transcripts";
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
  quarter = 2
): void {
  upsertTranscript(db, {
    security_id: securityId,
    ticker,
    year,
    quarter,
    source: "api_ninjas",
    summary: `${ticker} Q${quarter} summary`,
    source_key: `api_ninjas:${ticker}:${year}:${quarter}`,
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
});
