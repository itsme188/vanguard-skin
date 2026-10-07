import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import { auditTranscriptKeys } from "../../scripts/audit-transcript-keys";
import {
  planTranscriptSectionsRepair,
  runTranscriptSectionsRepair,
} from "../../scripts/repair-transcript-sections";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedTranscript(opts: {
  ticker: string;
  year: number;
  quarter: number;
  sourceKey: string;
  transcript: string;
  source?: "alpha_vantage" | "api_ninjas" | "edgar_8k";
  callDate?: string | null;
  guidance?: string | null;
  riskFactors?: string | null;
}): number {
  return upsertTranscript(db, {
    ticker: opts.ticker,
    year: opts.year,
    quarter: opts.quarter,
    call_date: opts.callDate ?? null,
    source: opts.source ?? "alpha_vantage",
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

describe("audit-transcript-keys", () => {
  it("reports key contradictions and counts rows with no stated quarter without writing", () => {
    seedTranscript({
      ticker: "ZZA",
      year: 2026,
      quarter: 2,
      sourceKey: "alpha_vantage:ZZA:2026:2",
      transcript: "Operator: Welcome to ZZA's fiscal second quarter 2026 earnings call.",
    });
    db.prepare(
      `INSERT INTO earnings_transcripts
        (ticker, year, quarter, source, transcript, source_key, fetched_at)
       VALUES ('ZZB', 2026, 4, 'alpha_vantage',
        'Operator: Welcome to ZZB fiscal second quarter 2026 earnings call.',
        'alpha_vantage:ZZB:2026:4', datetime('now'))`,
    ).run();
    seedTranscript({
      ticker: "ZZC",
      year: 2026,
      quarter: 3,
      sourceKey: "alpha_vantage:ZZC:2026:3",
      transcript: "Jane Doe (CEO): Operating remarks without a quarter phrase.",
    });

    const before = (db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts").get() as {
      c: number;
    }).c;
    const audit = auditTranscriptKeys(db);

    expect(audit.contradictions).toEqual([
      expect.objectContaining({
        ticker: "ZZB",
        key_year: 2026,
        key_quarter: 4,
        stated_year: 2026,
        stated_quarter: 2,
      }),
    ]);
    expect(audit.noStatementCount).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM earnings_transcripts").get() as { c: number }).c,
    ).toBe(before);
  });
});

describe("repair-transcript-sections", () => {
  it("dry-runs extractor changes, apply rewrites rows, and rerun is idempotent", () => {
    const transcript = [
      "Operator: Welcome to the ZZG fiscal year 2026 earnings conference call.",
      "Investor Relations: Before we begin, today's remarks include forward-looking statements and risks and uncertainties. Jane Doe (CEO): We expect next quarter revenue to improve and we are raising our full-year outlook.",
      "Pat Roe (CFO): Tariff pressure and supply disruption risks could affect gross margin.",
    ].join("\n\n");
    const rowId = seedTranscript({
      ticker: "ZZG",
      year: 2026,
      quarter: 2,
      sourceKey: "alpha_vantage:ZZG:2026:2",
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

  it("skips API Ninjas rows and rows with empty transcript text", () => {
    const apiRow = seedTranscript({
      ticker: "ZZN",
      year: 2026,
      quarter: 2,
      source: "api_ninjas",
      sourceKey: "api_ninjas:ZZN:2026:2",
      transcript: "Jane Doe (CEO): We expect demand to improve next quarter.",
      guidance: null,
    });
    db.prepare(
      `INSERT INTO earnings_transcripts
        (ticker, year, quarter, source, transcript, guidance, source_key, fetched_at)
       VALUES ('ZZE', 2026, 2, 'alpha_vantage', '   ', NULL,
        'alpha_vantage:ZZE:2026:2', datetime('now'))`,
    ).run();

    const plan = planTranscriptSectionsRepair(db);

    expect(plan.rows.map((r) => r.id)).not.toContain(apiRow);
    expect(plan.changed).toBe(0);
  });
});
