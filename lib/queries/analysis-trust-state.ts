import type Database from "better-sqlite3";

export interface AnalysisTrustState {
  factorCoverage: {
    totalNames: number;
    classified: number;
    percentage: number;
    missingSymbols: string[];
  };
  lastClassification: string | null;
  performanceReconciledThru: string | null; // populated by Slice D
  stalePrices: { count: number; symbols: string[] };
  bondDuration: { totalBonds: number; withDuration: number };
}

const STALE_PRICE_DAYS = 4;

export function getAnalysisTrustState(
  db: Database.Database,
  accountIds?: number[]
): AnalysisTrustState {
  const accountFilter = accountIds?.length
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const params: number[] = accountIds?.length ? [...accountIds] : [];

  // ── Factor coverage ──────────────────────────────────────────────────
  const factorRow = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE h.as_of_date = (
        SELECT MAX(h2.as_of_date) FROM holdings h2
        WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
      ) AND h.quantity != 0 ${accountFilter}
      GROUP BY h.security_id
    )
    SELECT
      COUNT(DISTINCT s.id) AS total,
      COUNT(DISTINCT sf.security_id) AS classified,
      GROUP_CONCAT(CASE WHEN sf.security_id IS NULL THEN s.symbol END) AS missing
    FROM latest l
    JOIN securities s ON s.id = l.security_id
    LEFT JOIN security_factors sf ON sf.security_id = s.id
  `
    )
    .get(...params) as { total: number; classified: number; missing: string | null };

  const total = factorRow.total ?? 0;
  const classified = factorRow.classified ?? 0;
  const missingSymbols = factorRow.missing
    ? factorRow.missing.split(",").filter(Boolean)
    : [];
  const percentage = total > 0 ? classified / total : 0;

  // ── Last classification ──────────────────────────────────────────────
  const lastClassRow = db
    .prepare(`SELECT MAX(updated_at) AS last FROM security_factors`)
    .get() as { last: string | null };

  // ── Stale prices ─────────────────────────────────────────────────────
  // Param order: accountIds first (in CTE), STALE_PRICE_DAYS last (outer WHERE)
  const staleRows = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE h.as_of_date = (
        SELECT MAX(h2.as_of_date) FROM holdings h2
        WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
      ) AND h.quantity != 0 ${accountFilter}
      GROUP BY h.security_id
    ),
    latest_prices AS (
      SELECT p.security_id, MAX(p.date) AS latest_date
      FROM prices p
      JOIN latest l ON l.security_id = p.security_id
      GROUP BY p.security_id
    )
    SELECT s.symbol
    FROM latest_prices lp
    JOIN securities s ON s.id = lp.security_id
    WHERE julianday('now') - julianday(lp.latest_date) > ?
    ORDER BY s.symbol
  `
    )
    .all(...params, STALE_PRICE_DAYS) as { symbol: string }[];

  // ── Bond duration coverage ───────────────────────────────────────────
  const bondRow = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE h.as_of_date = (
        SELECT MAX(h2.as_of_date) FROM holdings h2
        WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
      ) AND h.quantity != 0 ${accountFilter}
      GROUP BY h.security_id
    )
    SELECT
      COUNT(s.id) AS total_bonds,
      COUNT(s.duration_years) AS with_duration
    FROM latest l
    JOIN securities s ON s.id = l.security_id
    WHERE LOWER(s.security_type) = 'bond'
  `
    )
    .get(...params) as { total_bonds: number; with_duration: number };

  return {
    factorCoverage: { totalNames: total, classified, percentage, missingSymbols },
    lastClassification: lastClassRow.last,
    performanceReconciledThru: null, // Slice D populates
    stalePrices: {
      count: staleRows.length,
      symbols: staleRows.map((r) => r.symbol),
    },
    bondDuration: {
      totalBonds: bondRow.total_bonds,
      withDuration: bondRow.with_duration,
    },
  };
}
