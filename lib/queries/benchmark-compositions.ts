import type Database from "better-sqlite3";

export interface BenchmarkSectorWeight {
  sector: string;
  weight: number;
  marketCapBucket: string;
  refreshedAt: string;
}

/**
 * Get the sector composition for a benchmark symbol. Returns rows ordered
 * by weight descending. Returns an empty array if the benchmark isn't seeded
 * (e.g., custom benchmark not yet curated) — callers should fall back to a
 * by-sector heuristic.
 */
export function getBenchmarkComposition(
  db: Database.Database,
  benchmarkSymbol: string
): BenchmarkSectorWeight[] {
  return db
    .prepare(
      `SELECT sector, weight, market_cap_bucket AS marketCapBucket, refreshed_at AS refreshedAt
       FROM benchmark_compositions
       WHERE benchmark_symbol = ?
       ORDER BY weight DESC`
    )
    .all(benchmarkSymbol) as BenchmarkSectorWeight[];
}

/**
 * Lookup map from sector → weight for a given benchmark.
 */
export function getBenchmarkSectorMap(
  db: Database.Database,
  benchmarkSymbol: string
): Map<string, number> {
  const rows = getBenchmarkComposition(db, benchmarkSymbol);
  return new Map(rows.map((r) => [r.sector, r.weight]));
}
