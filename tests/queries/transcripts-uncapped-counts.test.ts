/**
 * QA findings
 *   research-transcripts-list--caps-at-50-of-86-no-pagination-no-count
 *   research-transcripts-group-header--count-derived-from-50-row-page-undercounts
 *
 * getTranscriptsSummary caps its rows. Before this change nothing on a row
 * said how many rows the cap withheld, so the Earnings tab could neither
 * print "showing N of M" nor count a ticker's transcripts honestly: the
 * per-ticker header counted the rows that survived the cap.
 *
 * Every returned row now carries `total_count` (matching rows, no cap) and
 * `ticker_sources` (the source of every matching quarter for that ticker,
 * no cap).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTranscriptsSummary } from "@/lib/queries/transcripts";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import { transcriptCountLabel } from "@/lib/transcripts/presentation";

let db: Database.Database;

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedTranscript(
  securityId: number,
  ticker: string,
  year: number,
  quarter: number,
  source: "alpha_vantage" | "edgar_8k" = "alpha_vantage",
): void {
  upsertTranscript(db, {
    security_id: securityId,
    ticker,
    year,
    quarter,
    source,
    summary: `${ticker} Q${quarter} ${year} summary`,
    guidance: null,
    source_key: `${source}:${ticker}:${year}:${quarter}`,
  });
}

function sourcesOf(row: { ticker_sources?: string | null }): string[] {
  return (row.ticker_sources ?? "").split(",").filter(Boolean).sort();
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getTranscriptsSummary reports what the row cap withheld", () => {
  it("total_count is the uncapped number of matching quarters", () => {
    const aaa = seedSecurity("AAA");
    const zzz = seedSecurity("ZZZ");
    seedTranscript(aaa, "AAA", 2026, 2);
    seedTranscript(aaa, "AAA", 2026, 1);
    seedTranscript(aaa, "AAA", 2025, 4);
    seedTranscript(zzz, "ZZZ", 2026, 2);
    seedTranscript(zzz, "ZZZ", 2026, 1);

    const capped = getTranscriptsSummary(db, { limit: 2 });
    expect(capped).toHaveLength(2);
    for (const row of capped) expect(row.total_count).toBe(5);
  });

  it("a ticker cut by the cap still reports every quarter it holds", () => {
    const aaa = seedSecurity("AAA");
    const zzz = seedSecurity("ZZZ");
    seedTranscript(aaa, "AAA", 2026, 2);
    seedTranscript(aaa, "AAA", 2026, 1);
    seedTranscript(aaa, "AAA", 2025, 4, "edgar_8k");
    seedTranscript(zzz, "ZZZ", 2026, 2);

    // Newest-first with a cap of 2: one AAA row and one ZZZ row survive.
    const capped = getTranscriptsSummary(db, { limit: 2 });
    const aaaRows = capped.filter((r) => r.ticker === "AAA");
    expect(aaaRows).toHaveLength(1);
    expect(sourcesOf(aaaRows[0])).toEqual(["alpha_vantage", "alpha_vantage", "edgar_8k"]);
    // The header label counts calls and filings apart, from the uncapped set.
    expect(
      transcriptCountLabel(sourcesOf(aaaRows[0]).map((source) => ({ source }))),
    ).toBe("2 transcripts, 1 filing");
  });

  it("counts one row per quarter, the same dedupe the list uses", () => {
    const aaa = seedSecurity("AAA");
    // Two sources for ONE quarter: the list shows one card, so the count is 1.
    seedTranscript(aaa, "AAA", 2026, 2, "alpha_vantage");
    seedTranscript(aaa, "AAA", 2026, 2, "edgar_8k");

    const rows = getTranscriptsSummary(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].total_count).toBe(1);
    expect(sourcesOf(rows[0])).toEqual(["alpha_vantage"]);
  });

  it("both counts follow the search filter, so header and cards agree", () => {
    const aaa = seedSecurity("AAA");
    const zzz = seedSecurity("ZZZ");
    seedTranscript(aaa, "AAA", 2026, 2);
    seedTranscript(aaa, "AAA", 2026, 1);
    seedTranscript(zzz, "ZZZ", 2026, 2);

    const rows = getTranscriptsSummary(db, { search: "aaa", limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].total_count).toBe(2);
    expect(sourcesOf(rows[0])).toHaveLength(2);
  });
});
