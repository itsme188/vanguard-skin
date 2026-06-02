import type Database from "better-sqlite3";

export interface ReconcileClosedEquityOptions {
  /** Scope to a single account. Omit to reconcile every account. */
  accountId?: number;
  /**
   * Refuse to reconcile when the latest snapshot holds fewer than this fraction
   * of the prior snapshot's positions — a guard against a partial/failed TWS
   * sync or an under-extracted statement PDF wiping the book. Default 0.5.
   */
  shrinkFloor?: number;
}

/**
 * Snapshot-diff reconciliation for closed EQUITY (stock / ETF) positions.
 *
 * Unlike `purgeExpiredOptionHoldings` (attribute-based) and
 * `purgeClosedOptionHoldings` (transaction-net-zero), equities have neither a
 * maturity attribute nor — in this system — a reliably complete local trade
 * ledger (statements lag; TWS is intermittent). So the authoritative "is this
 * position closed" signal is the broker/statement snapshot itself: a position
 * absent from the account's most-recent full holdings snapshot has been closed.
 *
 * For each account, this finds the latest holdings `as_of_date` (always a full
 * snapshot — TWS full-sync and statement imports both write complete books;
 * quick refreshes write no holdings) and, for every stock/ETF whose latest row
 * predates that date with a non-zero quantity, inserts a `quantity = 0` row at
 * the snapshot date. This is intentionally NON-destructive (preserves the
 * cost-basis / history audit trail), SELF-HEALING (a later real sync writes a
 * fresh row on a newer date that wins), and IDEMPOTENT (after the zero-row the
 * security is no longer "absent" from the latest date).
 *
 * Safety: skips an account whose latest snapshot is empty, or is suspiciously
 * smaller than the prior snapshot (< shrinkFloor), so a broken snapshot can
 * never flatten the book. Better to under-reconcile (self-heals next cycle).
 *
 * Returns the number of positions marked flat.
 */
export function reconcileClosedEquityHoldings(
  db: Database.Database,
  opts: ReconcileClosedEquityOptions = {},
): number {
  const shrinkFloor = opts.shrinkFloor ?? 0.5;

  const accounts =
    opts.accountId != null
      ? [{ id: opts.accountId }]
      : (db
          .prepare(`SELECT DISTINCT account_id AS id FROM holdings`)
          .all() as { id: number }[]);

  const latestDateStmt = db.prepare(
    `SELECT MAX(as_of_date) AS d FROM holdings WHERE account_id = ?`,
  );
  const countOnDateStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM holdings
      WHERE account_id = ? AND as_of_date = ? AND quantity != 0`,
  );
  const priorDateStmt = db.prepare(
    `SELECT MAX(as_of_date) AS d FROM holdings
      WHERE account_id = ? AND as_of_date < ?`,
  );
  const phantomsStmt = db.prepare(
    `WITH latest_per_sec AS (
       SELECT security_id, MAX(as_of_date) AS d
         FROM holdings WHERE account_id = ?
        GROUP BY security_id
     )
     SELECT lps.security_id AS security_id
       FROM latest_per_sec lps
       JOIN holdings h
         ON h.account_id = ? AND h.security_id = lps.security_id AND h.as_of_date = lps.d
       JOIN securities s ON s.id = lps.security_id
      WHERE lps.d < ?
        AND h.quantity != 0
        AND LOWER(s.security_type) IN ('stock', 'etf')`,
  );
  const insertZeroStmt = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, 0, 0, ?, ?)`,
  );

  let marked = 0;

  for (const { id: accountId } of accounts) {
    const latestDate = (latestDateStmt.get(accountId) as { d: string | null }).d;
    if (!latestDate) continue;

    const latestCount = (countOnDateStmt.get(accountId, latestDate) as { c: number }).c;
    if (latestCount === 0) continue; // no real snapshot landed

    const priorDate = (priorDateStmt.get(accountId, latestDate) as { d: string | null }).d;
    if (priorDate) {
      const priorCount = (countOnDateStmt.get(accountId, priorDate) as { c: number }).c;
      if (priorCount > 0 && latestCount < priorCount * shrinkFloor) {
        // Latest snapshot looks partial/failed — refuse to flatten the book.
        continue;
      }
    }

    const phantoms = phantomsStmt.all(accountId, accountId, latestDate) as {
      security_id: number;
    }[];
    for (const p of phantoms) {
      insertZeroStmt.run(
        accountId,
        p.security_id,
        latestDate,
        `recon:closed-equity:${accountId}:${p.security_id}:${latestDate}`,
      );
      marked++;
    }
  }

  return marked;
}
