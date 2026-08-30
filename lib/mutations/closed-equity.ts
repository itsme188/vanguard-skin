import type Database from "better-sqlite3";
import { statementSourcedHoldingSql } from "@/lib/db/holding-sources";

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

/** Security types the live-snapshot pass may mark flat, and their eligibility rule. */
const LIVE_PASS_CLASSES = [
  {
    name: "equity",
    typeSql: "LOWER(s.security_type) IN ('stock', 'etf')",
    /**
     * Equities need no presence evidence: every holdings source reports the
     * whole equity book, and an account CAN legitimately hold zero equities
     * (sold everything) — a presence requirement there would leave the last
     * sold positions phantom forever. The per-class shrink guard below still
     * blocks the "snapshot dropped the equities" failure whenever the prior
     * snapshot had any.
     */
    requirePresence: false,
  },
  {
    name: "option",
    typeSql: "LOWER(s.security_type) = 'option'",
    /**
     * Options DO need presence evidence: a snapshot with zero options is
     * ambiguous — it can mean "the option book is empty" or "this source does
     * not report options at all" — and guessing wrong phantom-closes the
     * entire option book. So options are reconciled only against a snapshot
     * that proves it knows about options by carrying at least one.
     */
    requirePresence: true,
  },
] as const;

/**
 * Snapshot-diff reconciliation for closed positions.
 *
 * Unlike `purgeExpiredOptionHoldings` (attribute-based) and
 * `purgeClosedOptionHoldings` (transaction-net-zero), most positions have
 * neither a maturity attribute nor — in this system — a reliably complete
 * local trade ledger (statements lag up to five weeks; TWS is intermittent).
 * So the authoritative "is this position closed" signal is the
 * broker/statement snapshot itself: a position absent from a snapshot that is
 * known to be a COMPLETE BOOK for its asset class has been closed.
 *
 * The whole design turns on that completeness question, which is why the sweep
 * runs as three passes with different scopes:
 *
 *  1. STATEMENT pass (all security types). An imported broker statement is a
 *     complete book of everything the account holds — equities, options,
 *     bonds, mutual funds, sweep funds. So for each account with
 *     statement-sourced holdings rows (classified by `source_key` prefix via
 *     `statementSourcedHoldingSql`, never an inline LIKE), let S be the latest
 *     statement `as_of_date`: any position of ANY type whose latest row
 *     predates S is marked flat at S. This is the only pass that can retire a
 *     mutual fund or a bond, because no live source reports them (Plaid books
 *     carry neither) — real case: two Vanguard funds sold 2026-05-05 whose
 *     2026-04-30 statement rows stayed "latest" through three later statements
 *     that correctly omitted them. Its shrink guard compares statement to
 *     PRIOR STATEMENT, never statement to live snapshot — a Plaid book holds
 *     zero bonds/funds, so a cross-source comparison would read as a collapse.
 *
 *  2. EQUITY pass against the latest snapshot of any source. Live syncs (TWS,
 *     Plaid) report the full equity book, so they can retire equities between
 *     statements.
 *
 *  3. OPTION pass, same latest snapshot, but only when that snapshot carries
 *     at least one non-zero option row (see `requirePresence` above). A source
 *     that reports options at all reports its whole option book (Plaid's daily
 *     Vanguard book matches the statement's option count; TWS positions
 *     include options), so an option missing from it was closed — the case a
 *     lagging statement leaves phantom for weeks.
 *
 * Bonds and mutual funds are deliberately NOT in the live passes: Plaid never
 * reports them, and their statement rows are carried forward onto live-snapshot
 * days by design (see daily-valuation's bond carry-forward).
 *
 * Every pass inserts a `quantity = 0` row at the snapshot date it reconciled
 * against. This is intentionally NON-DESTRUCTIVE (preserves the cost-basis /
 * history audit trail), SELF-HEALING (a later real sync writes a fresh non-zero
 * row on a newer date that wins), and IDEMPOTENT (after the zero-row the
 * security is no longer "absent" from that date, and a zero-quantity latest row
 * is never re-tombstoned).
 *
 * Safety, per pass: skip an account whose reference snapshot is empty, or is
 * suspiciously smaller than the prior comparable snapshot (< shrinkFloor). The
 * live passes carry BOTH the original account-wide guard and a per-class guard,
 * because a class can collapse while the account-wide count still looks healthy
 * (10 equities + 2 of 10 options clears a 50% account-wide floor). Better to
 * under-reconcile — that self-heals on the next cycle, once the prior snapshot
 * is itself the small one — than to flatten a live book, which does not.
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

  // ── statement-scoped variants (pass 1) ──────────────────────────────
  const latestStatementDateStmt = db.prepare(
    `SELECT MAX(h.as_of_date) AS d FROM holdings h
      WHERE h.account_id = ? AND ${statementSourcedHoldingSql()}`,
  );
  const priorStatementDateStmt = db.prepare(
    `SELECT MAX(h.as_of_date) AS d FROM holdings h
      WHERE h.account_id = ? AND h.as_of_date < ? AND ${statementSourcedHoldingSql()}`,
  );
  const statementCountOnDateStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM holdings h
      WHERE h.account_id = ? AND h.as_of_date = ? AND h.quantity != 0
        AND ${statementSourcedHoldingSql()}`,
  );

  /**
   * Positions whose latest row predates `?3` and is non-zero — i.e. absent from
   * the snapshot at `?3`. `typeSql` narrows to a security class ("" = all).
   */
  const phantomsSql = (typeSql: string) => `
     WITH latest_per_sec AS (
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
        ${typeSql ? `AND ${typeSql}` : ""}`;

  const anyPhantomsStmt = db.prepare(phantomsSql(""));
  const classStmts = LIVE_PASS_CLASSES.map((cls) => ({
    ...cls,
    phantoms: db.prepare(phantomsSql(cls.typeSql)),
    countOnDate: db.prepare(
      `SELECT COUNT(*) AS c FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE h.account_id = ? AND h.as_of_date = ? AND h.quantity != 0
          AND ${cls.typeSql}`,
    ),
  }));

  const insertZeroStmt = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, 0, 0, ?, ?)`,
  );

  let marked = 0;
  /**
   * `recon:closed-equity:` is the engine-owned tombstone prefix — historical
   * name, now covering every class this reconciler retires. It sits outside the
   * statement/live taxonomy in lib/db/holding-sources.ts (always quantity = 0,
   * so inert for value predicates); do not rename it.
   */
  const tombstone = (accountId: number, securityId: number, date: string): void => {
    insertZeroStmt.run(
      accountId,
      securityId,
      date,
      `recon:closed-equity:${accountId}:${securityId}:${date}`,
    );
    marked++;
  };

  /** True when `count` is a plausible successor to `priorCount`. */
  const passesShrinkGuard = (count: number, priorCount: number): boolean =>
    priorCount <= 0 || count >= priorCount * shrinkFloor;

  for (const { id: accountId } of accounts) {
    // ── Pass 1: statement snapshot (complete book, every security type) ──
    // Runs FIRST so its tombstones (dated at the statement date) are already in
    // place when the live passes look for phantoms — a position retired here is
    // zero-quantity and therefore invisible to passes 2/3.
    const stmtDate = (latestStatementDateStmt.get(accountId) as { d: string | null }).d;
    if (stmtDate) {
      const stmtCount = (
        statementCountOnDateStmt.get(accountId, stmtDate) as { c: number }
      ).c;
      const priorStmtDate = (
        priorStatementDateStmt.get(accountId, stmtDate) as { d: string | null }
      ).d;
      const priorStmtCount = priorStmtDate
        ? (statementCountOnDateStmt.get(accountId, priorStmtDate) as { c: number }).c
        : 0;
      if (stmtCount > 0 && passesShrinkGuard(stmtCount, priorStmtCount)) {
        const phantoms = anyPhantomsStmt.all(accountId, accountId, stmtDate) as {
          security_id: number;
        }[];
        for (const p of phantoms) tombstone(accountId, p.security_id, stmtDate);
      }
    }

    // ── Passes 2 & 3: latest snapshot of any source ──────────────────────
    const latestDate = (latestDateStmt.get(accountId) as { d: string | null }).d;
    if (!latestDate) continue;

    const latestCount = (countOnDateStmt.get(accountId, latestDate) as { c: number }).c;
    if (latestCount === 0) continue; // no real snapshot landed

    const priorDate = (priorDateStmt.get(accountId, latestDate) as { d: string | null }).d;
    const priorCount = priorDate
      ? (countOnDateStmt.get(accountId, priorDate) as { c: number }).c
      : 0;
    // Account-wide guard: the latest snapshot looks partial/failed as a whole.
    if (!passesShrinkGuard(latestCount, priorCount)) continue;

    for (const cls of classStmts) {
      const latestClassCount = (
        cls.countOnDate.get(accountId, latestDate) as { c: number }
      ).c;
      // Presence evidence: this snapshot must prove it reports the class.
      if (cls.requirePresence && latestClassCount === 0) continue;
      const priorClassCount = priorDate
        ? (cls.countOnDate.get(accountId, priorDate) as { c: number }).c
        : 0;
      // Per-class guard: this class collapsed even if the account-wide count
      // (dominated by another class) still looks healthy.
      if (!passesShrinkGuard(latestClassCount, priorClassCount)) continue;

      const phantoms = cls.phantoms.all(accountId, accountId, latestDate) as {
        security_id: number;
      }[];
      for (const p of phantoms) tombstone(accountId, p.security_id, latestDate);
    }
  }

  return marked;
}
