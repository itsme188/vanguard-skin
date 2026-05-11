import type Database from "better-sqlite3";
import { computeSecurityRegression } from "@/lib/compute/security-regression";
import { upsertRegression } from "@/lib/queries/security-regressions";

/**
 * Default benchmark set for the regression cache. Three majors cover the
 * typical comparator set across our scopes (SPY=all/Roth, QQQ=IBKR, VTI=Vanguard).
 */
export const DEFAULT_REGRESSION_BENCHMARKS = ["SPY", "QQQ", "VTI"] as const;

export interface RegressionBackfillSummary {
  processed: number; // (security, benchmark) pairs attempted
  succeeded: number; // wrote a row
  skipped: number; // computeSecurityRegression returned null (insufficient data)
  failed: number; // threw — logged + isolated, did not stop the batch
}

export interface RegressionBackfillOptions {
  /** Override the benchmark list. Defaults to DEFAULT_REGRESSION_BENCHMARKS. */
  benchmarks?: readonly string[];
}

interface SecurityRow {
  id: number;
  symbol: string;
}

/**
 * Walk every security that the user actually owns (JOIN on holdings — never
 * backfill regressions for securities we don't hold) and refresh the
 * security_regressions cache for each (security, benchmark) pair.
 *
 * Per-security errors are isolated via try/catch so one bad name (e.g. an
 * option symbol with no benchmark overlap, a price-table quirk) cannot kill
 * the whole batch. `skipped` counts insufficient-data nulls returned by
 * computeSecurityRegression; `failed` counts thrown errors logged to console.
 *
 * Both the manual one-off script (scripts/backfill-security-regressions.ts)
 * and the Sunday briefing pipeline call this same function — single source
 * of truth for the backfill loop.
 */
export function backfillSecurityRegressions(
  db: Database.Database,
  options: RegressionBackfillOptions = {}
): RegressionBackfillSummary {
  const benchmarks = options.benchmarks ?? DEFAULT_REGRESSION_BENCHMARKS;

  const securities = db
    .prepare(
      `SELECT DISTINCT s.id AS id, s.symbol AS symbol
         FROM securities s
         INNER JOIN holdings h ON h.security_id = s.id
        ORDER BY s.symbol ASC`
    )
    .all() as SecurityRow[];

  const summary: RegressionBackfillSummary = {
    processed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
  };

  for (const sec of securities) {
    for (const benchmark of benchmarks) {
      summary.processed += 1;
      try {
        const result = computeSecurityRegression(db, sec.id, benchmark);
        if (result === null) {
          summary.skipped += 1;
          continue;
        }
        upsertRegression(db, {
          securityId: sec.id,
          benchmarkSymbol: benchmark,
          result,
        });
        summary.succeeded += 1;
      } catch (err) {
        summary.failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[backfillSecurityRegressions] ${sec.symbol} (id=${sec.id}) vs ${benchmark} failed: ${msg}`
        );
      }
    }
  }

  return summary;
}
