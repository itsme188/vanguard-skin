import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import {
  planStaleTranscriptRepair,
  runStaleTranscriptRepair,
} from "../../scripts/repair-stale-transcripts";
import {
  planTranscriptSectionsRepair,
  runTranscriptSectionsRepair,
} from "../../scripts/repair-transcript-sections";

let db: Database.Database;
let eventCounter = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventCounter = 0;
});

function seedEvent(symbol: string, eventDate: string): number {
  eventCounter += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, release_time, title, symbol,
           actual_value, source_key, week_of, superseded)
         VALUES ('finnhub', 'earnings', ?, '16:00', ?, ?, 'EPS 1.00', ?, ?, 0)`,
      )
      .run(
        eventDate,
        `${symbol} earnings`,
        symbol,
        `finnhub:${symbol}:${eventDate}:${eventCounter}`,
        eventDate,
      ).lastInsertRowid,
  );
}

function seedTranscript(opts: {
  ticker: string;
  year: number;
  quarter: number;
  sourceKey: string;
  transcript: string;
  callDate?: string | null;
  guidance?: string | null;
  riskFactors?: string | null;
}): number {
  return upsertTranscript(db, {
    ticker: opts.ticker,
    year: opts.year,
    quarter: opts.quarter,
    call_date: opts.callDate ?? null,
    source: "alpha_vantage",
    transcript: opts.transcript,
    summary: null,
    guidance: opts.guidance ?? null,
    risk_factors: opts.riskFactors ?? null,
    sentiment_score: null,
    sentiment_label: null,
    participants: null,
    source_key: opts.sourceKey,
  }).id;
}

describe("repair-stale-transcripts", () => {
  it("dry-runs stale call-date mismatches, apply deletes them, and rerun is idempotent", () => {
    seedEvent("ZZS", "2026-09-30");
    const staleId = seedTranscript({
      ticker: "ZZS",
      year: 2026,
      quarter: 2,
      sourceKey: "alpha_vantage:ZZS:2026:2",
      callDate: "2026-03-30",
      transcript: "Jane Doe (CEO): Older call.",
    });
    seedTranscript({
      ticker: "ZZS",
      year: 2026,
      quarter: 2,
      sourceKey: "alpha_vantage:ZZS:fresh",
      callDate: "2026-09-30",
      transcript: "Jane Doe (CEO): Fresh call.",
    });

    const plan = planStaleTranscriptRepair(db);
    expect(plan.rows.map((r) => r.id)).toEqual([staleId]);

    const dryRun = runStaleTranscriptRepair(db, { apply: false });
    expect(dryRun.applied).toBe(false);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts").get() as { c: number }).c,
    ).toBe(2);

    const applied = runStaleTranscriptRepair(db, { apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.rows.map((r) => r.id)).toEqual([staleId]);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts").get() as { c: number }).c,
    ).toBe(1);

    expect(runStaleTranscriptRepair(db, { apply: true }).rows).toEqual([]);
  });
});

describe("repair-transcript-sections", () => {
  it("dry-runs extractor changes, apply rewrites rows, and rerun is idempotent", () => {
    const transcript = [
      "Operator: Welcome to the ZZG fiscal year 2026 earnings conference call.",
      "Investor Relations: Before we begin, today's remarks include forward-looking statements and risks and uncertainties.",
      "8-K Cover Page: The registrant furnished this report and Exhibit 99.1 under Item 2.02.",
      "Jane Doe (CEO): In our prepared remarks, we expect next quarter revenue to improve and we are raising our full-year outlook.",
      "Pat Roe (CFO): Prepared remarks also note tariff pressure and supply disruption risks that could impact gross margin.",
    ].join("\n\n");
    const rowId = seedTranscript({
      ticker: "ZZG",
      year: 2026,
      quarter: 2,
      sourceKey: "alpha_vantage:ZZG:2026:2",
      callDate: "2026-09-30",
      transcript,
      guidance: "Operator: Welcome to the ZZG fiscal year 2026 earnings conference call.",
      riskFactors: "Operator: Welcome to the ZZG fiscal year 2026 earnings conference call.",
    });

    const plan = planTranscriptSectionsRepair(db);
    expect(plan.changed).toBe(1);
    expect(plan.rows.map((r) => r.id)).toEqual([rowId]);

    const dryRun = runTranscriptSectionsRepair(db, { apply: false });
    expect(dryRun.applied).toBe(false);
    const before = db
      .prepare("SELECT guidance, risk_factors FROM earnings_transcripts WHERE id = ?")
      .get(rowId) as { guidance: string | null; risk_factors: string | null };
    expect(before.guidance).toMatch(/^Operator:/);

    const applied = runTranscriptSectionsRepair(db, { apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.changed).toBe(1);
    const after = db
      .prepare("SELECT guidance, risk_factors FROM earnings_transcripts WHERE id = ?")
      .get(rowId) as { guidance: string | null; risk_factors: string | null };
    expect(after.guidance).toContain("raising our full-year outlook");
    expect(after.risk_factors).toContain("supply disruption risks");

    expect(runTranscriptSectionsRepair(db, { apply: true }).changed).toBe(0);
  });
});
