import type Database from "better-sqlite3";

/**
 * Read queries for the `read_through_pairs` table (migration 044).
 *
 * A read-through pair is a directional claim: "when REPORTER prints, the read
 * on TARGET's upcoming print updates." The earnings preview composer uses
 * `getReadThroughsForTargets` to pull pairs where the upcoming-print symbol
 * is the target; the calendar sweep uses `getReadThroughReporterSymbols` to
 * make sure non-held reporter symbols (e.g. PRTO, RDDT) reach
 * `calendar_events` so their actual + reaction snapshot can be enriched.
 *
 * Design doc: docs/plans/2026-05-02-stock-to-stock-read-throughs.md.
 */

export interface ReadThroughPair {
  reporter_symbol: string;
  target_symbol: string;
  hypothesis: string | null;
  weight: number;
  group_label: string | null;
}

export function getReadThroughReporterSymbols(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT reporter_symbol FROM read_through_pairs ORDER BY reporter_symbol`,
    )
    .all() as { reporter_symbol: string }[];
  return rows.map((r) => r.reporter_symbol);
}

export function getReadThroughsForTargets(
  db: Database.Database,
  targetSymbols: readonly string[],
): ReadThroughPair[] {
  if (targetSymbols.length === 0) return [];
  const placeholders = targetSymbols.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT reporter_symbol, target_symbol, hypothesis, weight, group_label
       FROM read_through_pairs
       WHERE target_symbol IN (${placeholders})
       ORDER BY weight DESC, reporter_symbol`,
    )
    .all(...targetSymbols) as ReadThroughPair[];
  return rows;
}
