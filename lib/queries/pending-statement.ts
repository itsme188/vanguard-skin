import type Database from "better-sqlite3";
import { liveOriginHoldingSql, statementGradeHoldingSql } from "@/lib/db/holding-sources";
import {
  findLaterImportSplit,
  positionChangingTxnTypesSql,
  type ImportSplitDate,
} from "@/lib/compute/synthetic-close-guards";

/**
 * PENDING STATEMENT — the read model for positions that went flat only in
 * LIVE data (spec docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md
 * §2.2). Nothing is persisted: this is derived on every read.
 *
 * Since 2026-10-02 only statement evidence mints a synthetic close
 * (computeTaxLots' broker-close pass). A position the live sync (TWS / IBKR
 * Web API / Plaid, or a `:live` reconciler tombstone) shows closed keeps its
 * open lots until the broker statement — or the real SELL — arrives. Those
 * lots are no longer held, so their paper gain is NOT unrealized, and their
 * realized figure is unknown until the statement. Every surface that reports
 * open lots, unrealized totals or open-lot counts consumes THIS helper (or
 * `pendingStatementKeySet` built from it) — never a local re-derivation.
 *
 * A pair is pending when ALL of:
 *  (a) its newest holdings row of ANY source has quantity = 0 AND is
 *      live-origin (`liveOriginHoldingSql`);
 *  (b) no statement-grade zero row is the pair's newest statement-grade row
 *      (a statement-flat pair is the engine's job, never "pending");
 *  (c) the engine's universe: long (`is_short = 0`) stock/ETF lots with
 *      `quantity_remaining > 0`;
 *  (d) the engine's own guards would not skip it: the split guard
 *      (`findLaterImportSplit`) and the later-fill guard (an imported
 *      position-changing fill after the zero date means the snapshot is
 *      staler than the ledger) — both shared with the engine via
 *      lib/compute/synthetic-close-guards.ts.
 */
export interface PendingStatementPair {
  account_id: number;
  security_id: number;
  symbol: string;
  /** as_of_date of the live zero row (the newest holdings row of the pair). */
  live_flat_date: string;
  /** Σ quantity_remaining over the pair's open long lots. */
  open_quantity: number;
  /** Still-open share of those lots' stored basis, in USD (FX at read time). */
  open_basis: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

/**
 * Pending-statement pairs, optionally scoped to `accountIds` (a multi-account
 * scope keeps every listed account; an empty list selects nothing).
 */
export function getPendingStatementPairs(
  db: Database.Database,
  accountIds?: readonly number[]
): PendingStatementPair[] {
  if (accountIds && accountIds.length === 0) return [];
  if (!tableExists(db, "holdings") || !tableExists(db, "tax_lots")) return [];

  const scopeSql = accountIds ? `AND tl.account_id IN (${accountIds.map(() => "?").join(", ")})` : "";

  const rows = db
    .prepare(
      `SELECT tl.account_id, tl.security_id, s.symbol,
              h.as_of_date AS live_flat_date,
              SUM(tl.quantity_remaining) AS open_quantity,
              SUM(CASE WHEN tl.quantity_acquired != 0
                       THEN tl.cost_basis * tl.quantity_remaining / tl.quantity_acquired
                       ELSE 0 END * COALESCE(fx.usd_per_unit, 1)) AS open_basis
         FROM tax_lots tl
         JOIN securities s ON s.id = tl.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         JOIN holdings h
           ON h.account_id = tl.account_id AND h.security_id = tl.security_id
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )
        WHERE tl.quantity_remaining > 0 AND tl.is_short = 0
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'etf')
          -- (a) newest row of any source: a LIVE-origin zero
          AND h.quantity = 0
          AND ${liveOriginHoldingSql("h")}
          -- (b) no statement-grade zero that is the newest statement-grade row
          AND NOT EXISTS (
            SELECT 1 FROM holdings z
             WHERE z.account_id = tl.account_id AND z.security_id = tl.security_id
               AND z.quantity = 0
               AND ${statementGradeHoldingSql("z")}
               AND NOT EXISTS (
                 SELECT 1 FROM holdings z2
                  WHERE z2.account_id = z.account_id AND z2.security_id = z.security_id
                    AND z2.as_of_date > z.as_of_date
                    AND ${statementGradeHoldingSql("z2")}
               )
          )
          -- (d) later-fill guard, same type list as the engine
          AND NOT EXISTS (
            SELECT 1 FROM transactions t2
             WHERE t2.account_id = tl.account_id AND t2.security_id = tl.security_id
               AND t2.trade_date > h.as_of_date
               AND LOWER(t2.type) IN (${positionChangingTxnTypesSql()})
          )
          ${scopeSql}
        GROUP BY tl.account_id, tl.security_id
        ORDER BY s.symbol, tl.account_id`
    )
    .all(...(accountIds ?? [])) as PendingStatementPair[];

  if (rows.length === 0 || !tableExists(db, "corporate_actions")) return rows;

  // (d) split guard — the same predicate the engine applies to its orphans,
  // over the same row set (import-sourced corporate actions).
  const splits = db
    .prepare(
      `SELECT security_id, effective_date FROM corporate_actions WHERE source = 'import'`
    )
    .all() as ImportSplitDate[];
  return rows.filter((r) => !findLaterImportSplit(splits, r.security_id, r.live_flat_date));
}

/** The (account, security) key every surface joins pending pairs on. */
export function pendingStatementKey(row: { account_id: number; security_id: number }): string {
  return `${row.account_id}:${row.security_id}`;
}

/** Set of pending keys, for tagging lot rows (`pendingStatementKey`). */
export function pendingStatementKeySet(
  db: Database.Database,
  accountIds?: readonly number[]
): Set<string> {
  return new Set(getPendingStatementPairs(db, accountIds).map(pendingStatementKey));
}

/** True when the lot belongs to a pending-statement pair (long lots only — a short lot never is). */
export function isPendingStatementLot(
  keys: ReadonlySet<string>,
  lot: { account_id: number; security_id: number; is_short?: number | boolean | null }
): boolean {
  if (lot.is_short) return false;
  return keys.has(pendingStatementKey(lot));
}
