/**
 * Dry-run-default repair for stored transcript guidance / risk_factors
 * columns. Re-runs the deterministic extractors over cached transcript text.
 *
 * Usage:
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-transcript-sections.ts
 *   REPAIR_DB_PATH=/tmp/rehearsal.db PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-transcript-sections.ts --apply
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { extractGuidance, extractRiskFactors } from "../lib/transcripts/fetch";

export interface TranscriptSectionChange {
  id: number;
  guidance: string | null;
  risk_factors: string | null;
}

export interface TranscriptSectionsRepairResult {
  changed: number;
  rows: TranscriptSectionChange[];
  applied: boolean;
}

export function planTranscriptSectionsRepair(
  db: Database.Database,
): TranscriptSectionsRepairResult {
  const rows = db
    .prepare(
      `SELECT id, source, transcript, guidance, risk_factors
         FROM earnings_transcripts
        WHERE transcript IS NOT NULL
          AND TRIM(transcript) <> ''
          AND source <> 'api_ninjas'
        ORDER BY id`,
    )
    .all() as Array<{
      id: number;
      source: string;
      transcript: string;
      guidance: string | null;
      risk_factors: string | null;
    }>;

  const changes: TranscriptSectionChange[] = [];
  for (const row of rows) {
    const guidance = extractGuidance(row.transcript);
    const riskFactors = extractRiskFactors(row.transcript);
    if (guidance === row.guidance && riskFactors === row.risk_factors) continue;
    changes.push({ id: row.id, guidance, risk_factors: riskFactors });
  }

  return { changed: changes.length, rows: changes, applied: false };
}

export function runTranscriptSectionsRepair(
  db: Database.Database,
  opts: { apply?: boolean } = {},
): TranscriptSectionsRepairResult {
  const plan = planTranscriptSectionsRepair(db);
  if (!opts.apply || plan.rows.length === 0) return plan;
  const update = db.prepare(
    `UPDATE earnings_transcripts
        SET guidance = ?, risk_factors = ?, fetched_at = fetched_at
      WHERE id = ?`,
  );
  const tx = db.transaction((rows: TranscriptSectionChange[]) => {
    for (const row of rows) update.run(row.guidance, row.risk_factors, row.id);
  });
  tx(plan.rows);
  return { ...plan, applied: true };
}

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

function main() {
  const apply = process.argv.includes("--apply");
  const db = new BetterSqlite3(DB_PATH, { readonly: !apply }) as Database.Database;
  try {
    const result = runTranscriptSectionsRepair(db, { apply });
    console.log(
      `Transcript sections repair ${apply ? "[APPLY]" : "[DRY RUN]"} — db: ${DB_PATH}`,
    );
    console.log(`Rows ${apply ? "changed" : "that would change"}: ${result.changed}`);
    for (const row of result.rows) {
      console.log(`id=${row.id}`);
    }
    if (!apply) {
      console.log("Dry run only. Re-run with --apply against a rehearsed REPAIR_DB_PATH copy.");
    }
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith("repair-transcript-sections.ts")) {
  main();
}
