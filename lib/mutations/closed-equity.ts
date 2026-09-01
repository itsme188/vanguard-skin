import type Database from "better-sqlite3";
import {
  RECON_HOLDING_SOURCE_PREFIX,
  RECON_STMT_SUFFIX,
  RECON_LIVE_SUFFIX,
  statementSourcedHoldingSql,
} from "@/lib/db/holding-sources";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { bumpTaxGenerationIfPresent } from "@/lib/compute/tax-convention";

export interface ReconcileClosedEquityOptions {
  /** Scope to a single account. Omit to reconcile every account. */
  accountId?: number;
  /**
   * Refuse to reconcile when the latest snapshot holds fewer than this fraction
   * of the prior snapshot's positions — a guard against a partial/failed TWS
   * sync or an under-extracted statement PDF wiping the book. Default 0.5.
   */
  shrinkFloor?: number;
  /**
   * Batch-ownership hygiene (spec §2): when set, tombstones minted for
   * accounts in `ownedAccountIds` are stamped with this batch id so
   * undoImport removes them. NEVER stamps other accounts' tombstones.
   */
  importBatchId?: number;
  ownedAccountIds?: number[];
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
 *  1. STATEMENT pass (all security types EXCEPT cash equivalents). An
 *     imported broker statement is a complete book of everything the account
 *     holds — equities, options, bonds, mutual funds, sweep funds. So for
 *     each account with statement-sourced holdings rows (classified by
 *     `source_key` prefix via `statementSourcedHoldingSql`, never an inline
 *     LIKE), let S be the latest statement `as_of_date`: any position whose
 *     latest row predates S is marked flat at S. This is the only pass that
 *     can retire a mutual fund or a bond, because no live source reports them
 *     (Plaid books carry neither) — real case: two Vanguard funds sold
 *     2026-05-05 whose 2026-04-30 statement rows stayed "latest" through
 *     three later statements that correctly omitted them. Its shrink guard
 *     compares statement to PRIOR STATEMENT, never statement to live
 *     snapshot — a Plaid book holds zero bonds/funds, so a cross-source
 *     comparison would read as a collapse.
 *
 *     EXCLUSION (Codex-flagged, 2026-08-30): a money-market sweep fund
 *     (`isCashEquivalentSecurity`, lib/compute/cash-equivalents.ts) is
 *     excluded from this pass, even though it can appear as a statement
 *     holdings row. Some statements list the sweep fund as a line item;
 *     others fold it straight into the cash balance and never emit a
 *     position for it — a plumbing difference with no economic event behind
 *     it (the same ambiguity `isCashEquivalentSecurity`'s doc comment
 *     describes for Plaid vs. statement). Absent that exclusion, a statement
 *     that folds the sweep fund into cash looks identical to a sold fund —
 *     one row disappearing from a large statement, which the 50% shrink
 *     guard does not catch — and `daily_valuations` counts sweep funds as
 *     CASH, so a phantom tombstone here would corrupt the account's cash
 *     balance. The filter is applied in TS against `isCashEquivalentSecurity`
 *     (never a hand-rolled `money_market`/`VMFXX` string list — that
 *     predicate is the single source of truth).
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
 * Cash equivalents are excluded from every pass, statement and live alike.
 * The live passes' `typeSql` (stock/etf, option) already excludes a sweep
 * fund whose `security_type` correctly reads 'Mutual Fund' or 'money_market'
 * — but `isCashEquivalentSecurity`'s signal 2 (`fund_category = 'Cash
 * Equivalent'`) is independent of `security_type`, and brokers routinely
 * mislabel a sweep fund's `security_type` as plain 'Stock'. Left unfiltered,
 * such a row would slide through the equity pass's typeSql. So every phantom
 * candidate — statement pass and both live-pass classes — is filtered
 * through `isCashEquivalentSecurity` in TS before tombstoning, making the
 * exclusion explicit and pass-independent rather than an accident of typeSql.
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
 * Tombstone model (spec: 2026-08-31 reconciler-hardening): a tombstone is
 * SUPERSEDABLE (a later real row on a newer date wins, see SELF-HEALING
 * above) and DERIVED (never authority — see `statementOverwritableHoldingSql`
 * / `liveOverwritableHoldingSql`). Every tombstone this function mints is
 * ORIGIN-SUFFIXED with which pass minted it — `RECON_STMT_SUFFIX` for pass 1,
 * `RECON_LIVE_SUFFIX` for passes 2/3 — so `removeOrphanedReconTombstones`
 * (below) can apply the right evidence rule per origin; legacy unsuffixed
 * rows are treated as statement-grade. And when `opts.importBatchId` is set,
 * a tombstone minted for an account in `opts.ownedAccountIds` is BATCH-OWNED
 * (stamped with that batch id) so `undoImport` removes it with the rest of
 * the batch — never stamped for an account outside that set.
 *
 * The whole run (every pass, every account, plus the tax-generation bump) is
 * one transaction: a mid-run failure leaves zero tombstones from that run.
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
   * A phantom candidate row, carrying the fields `isCashEquivalentSecurity`
   * needs so callers can filter cash equivalents out in TS before tombstoning
   * (never a hand-rolled `money_market`/`VMFXX` SQL string list — the
   * predicate in lib/compute/cash-equivalents.ts is the single source).
   */
  interface PhantomRow {
    security_id: number;
    security_type: string | null;
    fund_category: string | null;
  }

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
     SELECT lps.security_id AS security_id,
            s.security_type AS security_type,
            s.fund_category AS fund_category
       FROM latest_per_sec lps
       JOIN holdings h
         ON h.account_id = ? AND h.security_id = lps.security_id AND h.as_of_date = lps.d
       JOIN securities s ON s.id = lps.security_id
      WHERE lps.d < ?
        AND h.quantity != 0
        ${typeSql ? `AND ${typeSql}` : ""}`;

  /** Cash equivalents are never eligible for tombstoning — see the pass-1 doc above. */
  const excludingCashEquivalents = (rows: PhantomRow[]): PhantomRow[] =>
    rows.filter((r) => !isCashEquivalentSecurity(r));

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
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key, import_batch_id)
     VALUES (?, ?, 0, 0, ?, ?, ?)`,
  );

  let marked = 0;
  /**
   * `recon:closed-equity:` is the engine-owned tombstone prefix — historical
   * name, now covering every class this reconciler retires. It sits outside the
   * statement/live taxonomy in lib/db/holding-sources.ts (always quantity = 0,
   * so inert for value predicates); do not rename it. Every tombstone now
   * carries an origin suffix (`RECON_STMT_SUFFIX` / `RECON_LIVE_SUFFIX`) and,
   * for an owned account, a batch stamp — see the "Tombstone model" doc above.
   */
  const ownedAccounts = new Set(opts.ownedAccountIds ?? []);
  // Hoisted once (not re-asserted per tombstone call): coerces `undefined` to
  // `null` up front so the closure below can branch on `owned` without a
  // non-null assertion — `importBatchId` is already `number | null`, which is
  // exactly what the `owned ? importBatchId : null` ternary needs either way.
  const importBatchId: number | null = opts.importBatchId ?? null;
  const tombstone = (
    accountId: number,
    securityId: number,
    date: string,
    origin: typeof RECON_STMT_SUFFIX | typeof RECON_LIVE_SUFFIX,
  ): void => {
    const owned = importBatchId != null && ownedAccounts.has(accountId);
    insertZeroStmt.run(
      accountId,
      securityId,
      date,
      `${RECON_HOLDING_SOURCE_PREFIX}${accountId}:${securityId}:${date}${origin}`,
      owned ? importBatchId : null,
    );
    marked++;
  };

  /** True when `count` is a plausible successor to `priorCount`. */
  const passesShrinkGuard = (count: number, priorCount: number): boolean =>
    priorCount <= 0 || count >= priorCount * shrinkFloor;

  db.transaction(() => {
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
          const phantoms = excludingCashEquivalents(
            anyPhantomsStmt.all(accountId, accountId, stmtDate) as PhantomRow[],
          );
          for (const p of phantoms) tombstone(accountId, p.security_id, stmtDate, RECON_STMT_SUFFIX);
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

        const phantoms = excludingCashEquivalents(
          cls.phantoms.all(accountId, accountId, latestDate) as PhantomRow[],
        );
        for (const p of phantoms) tombstone(accountId, p.security_id, latestDate, RECON_LIVE_SUFFIX);
      }
    }
    // Tombstone creation changes RECONCILE_CLOSE synthesis in computeTaxLots —
    // a tax event regardless of caller (spec §4). Inside the transaction so a
    // rollback takes the bump with it.
    if (marked > 0) bumpTaxGenerationIfPresent(db);
  })();

  return marked;
}

/**
 * Deletes recon tombstones whose justifying same-date evidence is gone
 * (spec §2, origin-aware): a tombstone's date IS its reference snapshot's
 * date, so validity requires a surviving same-(account, date) real row —
 * statement-sourced for `:stmt`/legacy tombstones (a same-date live row is
 * NOT statement evidence), any non-recon row for `:live`. History-preserving
 * by design: never a wholesale rebuild, which would re-land tombstones on
 * current reference dates and silently move historical close dates.
 * Bumps the tax generation when it deletes. Returns rows deleted.
 */
export function removeOrphanedReconTombstones(
  db: Database.Database,
  opts: { accountIds?: number[] } = {},
): number {
  const ids = opts.accountIds ?? [];
  const acctFilter = ids.length > 0 ? `AND account_id IN (${ids.map(() => "?").join(",")})` : "";
  return db.transaction(() => {
    const res = db
      .prepare(
        `DELETE FROM holdings
          WHERE source_key LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'
            ${acctFilter}
            AND CASE WHEN source_key LIKE '%${RECON_LIVE_SUFFIX}'
              THEN NOT EXISTS (
                SELECT 1 FROM holdings h2
                 WHERE h2.account_id = holdings.account_id
                   AND h2.as_of_date = holdings.as_of_date
                   AND h2.source_key NOT LIKE '${RECON_HOLDING_SOURCE_PREFIX}%')
              ELSE NOT EXISTS (
                SELECT 1 FROM holdings h2
                 WHERE h2.account_id = holdings.account_id
                   AND h2.as_of_date = holdings.as_of_date
                   AND ${statementSourcedHoldingSql("h2.source_key")})
            END`,
      )
      .run(...ids);
    if (res.changes > 0) bumpTaxGenerationIfPresent(db);
    return res.changes;
  })();
}

/**
 * Securities whose LATEST holdings row for `accountId` is quantity 0 — the
 * tombstone state computeTaxLots' RECONCILE_CLOSE pass keys on. Live
 * writers snapshot this BEFORE writing: a non-zero write for one of these
 * is a newer-date tombstone supersession (re-bought position) and must bump
 * the tax generation (spec §4).
 *
 * Deliberately NOT filtered to stock/ETF, even though RECONCILE_CLOSE itself
 * only synthesizes for stock/ETF (`computeTaxLots`' orphan query). This is
 * an invalidation trigger, not the synthesis query — over-including a
 * bond/fund/option tombstone here just means an occasional harmless extra
 * generation bump (fail-closed doctrine, spec §4 precision note). Do not
 * "fix" the mismatch by narrowing this to stock/ETF: that would risk a
 * fail-OPEN hole if RECONCILE_CLOSE's own scope ever widens without this
 * trigger widening in lockstep.
 */
export function zeroLatestSecurityIds(db: Database.Database, accountId: number): Set<number> {
  const rows = db
    .prepare(
      `SELECT h.security_id AS id FROM holdings h
        WHERE h.account_id = ? AND h.quantity = 0
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id)`,
    )
    .all(accountId) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Recon tombstones for (account, date) — same-date supersession detection.
 * Prepares a fresh statement per call: fine at today's call sites (once per
 * account/date per sync, not per row); a future caller that loops this
 * per-row should hoist the prepare out of its loop.
 */
export function countReconRowsOnDate(db: Database.Database, accountId: number, date: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM holdings
          WHERE account_id = ? AND as_of_date = ?
            AND source_key LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'`,
      )
      .get(accountId, date) as { c: number }
  ).c;
}
