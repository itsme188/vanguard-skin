import type Database from "better-sqlite3";
import {
  getInvestmentsHoldings,
  loadPlaidConfig,
  PlaidApiError,
  type PlaidClientConfig,
  type PlaidHoldingsResponse,
} from "./client";
import { mapPlaidHoldings, type PlaidMapResult, type UnmatchedPlaidSecurity } from "./map-holdings";
import {
  getDatingBoundary,
  getDatingState,
  hasLegacyPriceAfter,
  hasLegacyRowsAfter,
  isInStoreWindow,
  newFormatHoldingSourceKey,
  PLAID_STORE_WINDOW_START_ET,
  plaidSessionDate,
  recordFirstNewFormatWrite,
  settleFreshDatingVersion,
  storeWindowRunDay,
  type DatingState,
} from "./session-dating";
import {
  getPlaidConnection,
  getPlaidReauthAlertedAt,
  setPlaidConnectionStatus,
  setPlaidLastSyncAt,
  setPlaidReauthAlertedAt,
} from "@/lib/queries/plaid-settings";
import { upsertSecurity } from "@/lib/mutations/securities";
import { removeStaleSameDayTwsHoldings } from "@/lib/mutations/same-day-tws-holdings";
import { purgeExpiredOptionHoldings } from "@/lib/mutations/expired-options";
import { purgeMaturedBondHoldings } from "@/lib/mutations/matured-bonds";
import {
  reconcileClosedEquityHoldings,
  countStatementGradeRowsOnDate,
} from "@/lib/mutations/closed-equity";
import {
  isPlaidSourcedHolding,
  liveOverwritableHoldingSql,
  statementSourcedHoldingSql,
} from "@/lib/db/holding-sources";
import { cashEquivalentSecuritySql, isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import {
  bumpTaxGenerationIfPresent,
  bumpIfPricesAffectSyntheticCloses,
} from "@/lib/compute/tax-convention";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { nowET, todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed, nextTradingDay } from "@/lib/calendar/market-holidays";
import { isSyncing, setSyncComplete, setSyncError, setSyncPhase } from "@/lib/tws/sync-state";
import { sendPushover } from "@/lib/alerts/notify-pushover";

/**
 * Why a whole refresh stored nothing (plan v4 A2). Each is checked by the
 * refresh in this order:
 *  - `market_closed`: today (Eastern) is not a trading day. Checked before
 *    the Plaid call. `force` does NOT bypass it.
 *  - `before_window`: the clock was before 07:30 Eastern before the call
 *    (`PLAID_STORE_WINDOW_START_ET`). No Plaid call is made and
 *    `plaid_last_sync_at` does not move, so the 07:30 scheduled read still
 *    runs. `force` does NOT bypass it.
 *  - `after_open`: the clock was at or after 09:30 Eastern before the call.
 *    No Plaid call is made.
 *  - `already_synced_today`: a read was already stored today. `force`
 *    bypasses this one only.
 *  - `read_finished_after_open`: the answer arrived at or after 09:30
 *    Eastern (or on another Eastern day). The answer is discarded and
 *    `plaid_last_sync_at` does not move.
 */
export type PlaidRefreshSkipReason =
  | "market_closed"
  | "before_window"
  | "after_open"
  | "already_synced_today"
  | "read_finished_after_open";

/**
 * Why one mapped account was not stored by a read that was otherwise stored:
 *  - `missing_in_response`: Plaid's answer does not list the account.
 *  - `no_positions`: the account is listed but holds no position (a partial
 *    answer must never look like "everything sold").
 *  - `statement_on_session`: a statement already holds this account's book
 *    for the session (A5: the statement wins).
 *  - `legacy_rows_after_session`: the account's first new-format write would
 *    sit under older run-day-dated Plaid rows (A6). Lasts until the session
 *    passes those rows or the history repair runs.
 */
export type PlaidAccountSkipReason =
  | "missing_in_response"
  | "no_positions"
  | "statement_on_session"
  | "legacy_rows_after_session";

export interface PlaidAccountRef {
  accountId: number;
  /** The local account's name (shown by the sync button). */
  accountName: string;
}

export interface PlaidSkippedAccount extends PlaidAccountRef {
  reason: PlaidAccountSkipReason;
}

/**
 * `DatingState` of the whole database after the call, or `"unreadable"` when
 * the dating settings are damaged (only possible on a skip path: a write
 * throws on damaged settings instead).
 */
export type PlaidResultDatingState = DatingState | "unreadable";

export interface PlaidRefreshResult {
  skippedReason: PlaidRefreshSkipReason | null;
  /**
   * The session (YYYY-MM-DD) the stored read describes: the trading day
   * before the run day. Null when nothing was read and stored.
   */
  session: string | null;
  /** The dating state after the call (for the launchd log line). */
  datingState: PlaidResultDatingState;
  /** Accounts whose book (holdings and snapshot) was stored. */
  accountsSynced: number;
  storedAccounts: PlaidAccountRef[];
  skippedAccounts: PlaidSkippedAccount[];
  holdingsWritten: number;
  pricesWritten: number;
  /**
   * Prices whose Plaid as-of date was not the session they are dated on (a
   * null as-of is not counted). Plaid's as-of date is never used as a date;
   * it is only counted so the gap can be watched.
   */
  priceAsOfMismatches: number;
  /**
   * Prices not stored because older run-day-dated Plaid prices for the same
   * security sit after the session (A6, per security).
   */
  pricesHeldLegacyAfter: number;
  staleRemoved: number;
  /** Money-market fund rows refreshed from Plaid's daily balance. */
  cashEquivalentRowsWritten: number;
  /** Money-market fund rows set to zero because Plaid stopped reporting them. */
  cashEquivalentRetired: number;
  /**
   * Funds Plaid called cash whose stored security the shared identity rule
   * does not call a cash equivalent (or that has no stored security): no row
   * is written, so the fund is never counted both as a position and as cash.
   */
  cashEquivalentSkipped: string[];
  unmatched: UnmatchedPlaidSecurity[];
  securitiesCreated: string[];
  /**
   * False when the daily-valuation recompute after the write threw (A8). The
   * stored books stay (they are correct); the next sync recomputes.
   */
  valuationsRecomputed: boolean;
  /** The recompute's error message when it threw (message only), else null. */
  valuationError: string | null;
  /**
   * True only when a FORCED read was skipped before the Plaid call
   * (`market_closed`, `before_window`, `after_open`) while the stored
   * connection status was `reauth_required`, and the Plaid call made as a
   * connection check succeeded: the status is now ok and the re-auth alert
   * cleared. Nothing was stored. A failed check throws, as a failed read does.
   */
  connectionChecked: boolean;
}

/** What the DB half returns (the refresh adds the call-level fields). */
export type PlaidWriteResult = Omit<
  PlaidRefreshResult,
  "skippedReason" | "unmatched" | "valuationsRecomputed" | "valuationError" | "connectionChecked"
>;

/**
 * The DB half — exported for tests. Mirrors writeIbkrHoldings but with
 * 'plaid' provenance: conditional upserts that can never claim a
 * statement row, source='plaid' live snapshot, and Vanguard's own price for
 * held stocks, ETFs and mutual funds (never options or bonds).
 *
 * Dating (plan v4 A1): `session` is the trading session the read describes
 * (the refresh passes `previousTradingDay(run day)` for a pre-open read).
 * Holdings, the snapshot, the new-format source key
 * (`plaid:s:<acct>:<sec>:<session>`), money-market rows and EVERY Plaid
 * price (stock, ETF, mutual fund) are dated on it. Plaid's
 * `institution_price_as_of` is never a date; a mismatch is only counted.
 *
 * Run-day uses stay on the run day (A4): the expiry and maturity purges.
 * `opts.runDay` defaults to `nextTradingDay(session)`, which is the only run
 * day whose previous trading day is `session`.
 *
 * Per account, in one transaction:
 *  - A5: a statement-prefix holdings row already dated `session` means the
 *    statement holds that book; holdings and snapshot are skipped
 *    (`statement_on_session`). Prices still go through the upsert, which
 *    never claims a statement or TWS price.
 *  - A6: on the account's first new-format write (no entry in the dating
 *    map), a legacy Plaid holdings row or snapshot dated after `session`
 *    skips the account (`legacy_rows_after_session`). The same per security
 *    for its price (`pricesHeldLegacyAfter`). No probe once repaired.
 *  - The dating map entry (account, and each security whose price is
 *    written) and the fresh-database version are written in the same
 *    transaction as the rows.
 *
 * Money-market funds: Plaid folds them into cash (cash_value is unchanged),
 * and when the stored security is a cash equivalent by the shared rule its
 * own holdings row is refreshed from Plaid's balance, dated `session` with a
 * new-format key like every other Plaid holdings row. daily_valuations
 * excludes such rows, so account totals do not move.
 */
export function writePlaidHoldings(
  db: Database.Database,
  mapped: PlaidMapResult,
  accountMap: Record<string, number>,
  session: string,
  opts: { runDay?: string } = {},
): PlaidWriteResult {
  const runDay = opts.runDay ?? nextTradingDay(session);
  // A live writer may only claim live rows and live-origin tombstones — never
  // a :stmt or legacy (unsuffixed) tombstone, which is statement-grade
  // closure evidence a live sync cannot re-derive if masked (spec 2026-08-31
  // reconciler-hardening §directional supersession).
  const upsertHolding = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE SET
       quantity = excluded.quantity,
       cost_basis = excluded.cost_basis,
       source_key = excluded.source_key
     WHERE ${liveOverwritableHoldingSql()}`,
  );
  const upsertSnapshot = db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
     VALUES (?, ?, ?, ?, 'plaid')
     ON CONFLICT(account_id, month_end_date) DO UPDATE SET
       total_value = excluded.total_value,
       cash_value = excluded.cash_value,
       source = excluded.source
     WHERE monthly_snapshots.source IN ('tws', 'manual', 'plaid')`,
  );
  // Prices: plaid may only claim plaid/manual rows — tws + statement prices win.
  const upsertPrice = db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source)
     VALUES (?, ?, ?, 'plaid')
     ON CONFLICT(security_id, date) DO UPDATE SET
       close_price = excluded.close_price,
       source = excluded.source
     WHERE prices.source IN ('plaid', 'manual')`,
  );
  // A5: the statement already holds this account's book for the session.
  const statementOnSession = db.prepare(
    `SELECT 1 FROM holdings h
      WHERE h.account_id = ? AND h.as_of_date = ? AND ${statementSourcedHoldingSql()}
      LIMIT 1`,
  );
  const accountName = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
  const nameOf = (id: number): string =>
    (accountName.get(id) as { name: string } | undefined)?.name ?? `Account ${id}`;

  let accountsSynced = 0;
  let holdingsWritten = 0;
  let pricesWritten = 0;
  let priceAsOfMismatches = 0;
  let pricesHeldLegacyAfter = 0;
  let staleRemoved = 0;
  let cashEquivalentRowsWritten = 0;
  let cashEquivalentRetired = 0;
  const cashEquivalentSkipped: string[] = [];
  const storedAccounts: PlaidAccountRef[] = [];
  const skippedAccounts: PlaidSkippedAccount[] = [];
  // Symbol-drift from Plaid tickers can create duplicate securities that
  // cause phantom closures (reconcileClosedEquityHoldings sees the "old"
  // symbol vanish) — surface every brand-new security so the user can
  // eyeball it in Settings rather than discover it downstream. Existence
  // is checked BEFORE the upsert so a symbol that already existed (even
  // if this call updates it) is never misreported as "created".
  const securitiesCreated: string[] = [];
  const checkExistingSecurity = db.prepare(`SELECT id FROM securities WHERE symbol = ?`);
  /**
   * The one symbol → existing-security resolution, shared by the holdings,
   * price and money-market paths so a price always lands on the holding's
   * security. Share-class form drift: statements store BRK/B, Plaid says
   * BRK.B — the dotted form falls back to the slash form.
   */
  const resolveExistingSymbol = (raw: string): { symbol: string; id: number } | null => {
    const exact = checkExistingSecurity.get(raw) as { id: number } | undefined;
    if (exact) return { symbol: raw, id: exact.id };
    if (raw.includes(".")) {
      const slashForm = raw.replace(/\./g, "/");
      const slash = checkExistingSecurity.get(slashForm) as { id: number } | undefined;
      if (slash) return { symbol: slashForm, id: slash.id };
    }
    return null;
  };
  const securityIdentity = db.prepare(
    `SELECT security_type, fund_category FROM securities WHERE id = ?`,
  );
  // Cash-equivalent pairs in one account whose LATEST row is non-zero —
  // the candidates to retire when Plaid no longer reports them.
  const latestCashEquivalentRows = db.prepare(
    `SELECT h.security_id, h.quantity, h.source_key
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
      WHERE ${latestHoldingsPredicate({ accountFilter: "AND h.account_id = ?" })}
        AND ${cashEquivalentSecuritySql("s")}`,
  );

  for (const [plaidAccountId, localAccountId] of Object.entries(accountMap)) {
    const positions = mapped.positions.filter((p) => p.plaidAccountId === plaidAccountId);
    // Zero-holdings guard: a partial/failed Plaid response must never
    // look like "everything sold" — skip the account entirely, and say why.
    if (positions.length === 0) {
      const listed = Object.prototype.hasOwnProperty.call(mapped.totalByAccount, plaidAccountId);
      skippedAccounts.push({
        accountId: localAccountId,
        accountName: nameOf(localAccountId),
        reason: listed ? "no_positions" : "missing_in_response",
      });
      continue;
    }

    // Whole per-account DB-mutation block (pre-state reads through the
    // trailing reconcile) is ONE transaction (spec 2026-08-31
    // reconciler-hardening §5): a mid-write failure must not leave a
    // superseded tombstone half-written with no matching tax-generation
    // bump, or vice versa. The dating map entry and the fresh-database
    // version commit or roll back with the rows. reconcileClosedEquityHoldings
    // nests as a savepoint — better-sqlite3 supports nested db.transaction().
    db.transaction(() => {
      // Read inside the transaction: an earlier account of this run may
      // have added an entry or settled the version.
      const boundary = getDatingBoundary(db);

      let bookSkip: PlaidAccountSkipReason | null = null;
      if (statementOnSession.get(localAccountId, session)) {
        bookSkip = "statement_on_session";
      } else if (
        !boundary.repaired &&
        !boundary.accounts.has(localAccountId) &&
        hasLegacyRowsAfter(db, localAccountId, session, boundary)
      ) {
        bookSkip = "legacy_rows_after_session";
      }

      let wroteNewFormat = false;
      // Mapper symbol → the security id its holding landed on, so the
      // price path never resolves a symbol differently from the holding.
      const securityIdBySymbol = new Map<string, number>();
      let stmtGradeBefore = 0;

      if (bookSkip) {
        skippedAccounts.push({
          accountId: localAccountId,
          accountName: nameOf(localAccountId),
          reason: bookSkip,
        });
      } else {
        accountsSynced++;
        storedAccounts.push({ accountId: localAccountId, accountName: nameOf(localAccountId) });
        wroteNewFormat = true;

        // Pre-state read INSIDE the transaction so it reflects exactly the
        // book this account's writes are about to mutate (the session's
        // date: the only date the upserts touch). computeTaxLots reads
        // statement-grade holdings only (spec 2026-10-02 statement-only
        // synthetic closes §2.3), so a Plaid write is a tax input only if
        // it removed statement-grade evidence — which the liveOverwritable
        // upsert guard already forbids. The count is kept as a fail-closed
        // check, not an expected path.
        stmtGradeBefore = countStatementGradeRowsOnDate(db, localAccountId, session);

        const syncedSecurityIds: number[] = [];
        for (const p of positions) {
          // Creating the dotted twin makes the reconciler phantom-close the
          // real slash-form row (observed live 2026-07-11) — resolve onto the
          // existing security instead.
          const existing = resolveExistingSymbol(p.symbol);
          const symbol = existing?.symbol ?? p.symbol;
          const existed = existing !== null;
          const securityId = upsertSecurity(db, {
            symbol,
            name: p.name ?? undefined,
            securityType: p.securityType,
            underlyingSymbol: p.underlyingSymbol,
            strikePrice: p.strikePrice,
            expirationDate: p.expirationDate,
            optionType: p.optionType,
          });
          if (!existed) securitiesCreated.push(symbol);
          syncedSecurityIds.push(securityId);
          securityIdBySymbol.set(p.symbol, securityId);
          const res = upsertHolding.run(
            localAccountId,
            securityId,
            p.quantity,
            session,
            newFormatHoldingSourceKey(localAccountId, securityId, session),
          );
          if (res.changes > 0) holdingsWritten++;
        }

        // ── Money-market funds Plaid folded into cash ────────────────────
        // Refresh the fund's own row from Plaid's balance, but only onto an
        // EXISTING security the shared identity rule calls a cash equivalent
        // (daily_valuations then excludes it, so totals are conserved). A
        // fund that is also reported as a position this run keeps that one
        // row. Dated on the session like the rest of the book.
        const seenThisRead = new Set(syncedSecurityIds);
        for (const ce of mapped.cashEquivalentHoldings.filter((c) => c.plaidAccountId === plaidAccountId)) {
          const existing = resolveExistingSymbol(ce.symbol);
          const identity = existing
            ? (securityIdentity.get(existing.id) as { security_type: string | null; fund_category: string | null })
            : null;
          if (!existing || !identity || !isCashEquivalentSecurity(identity)) {
            cashEquivalentSkipped.push(ce.symbol);
            continue;
          }
          if (seenThisRead.has(existing.id)) continue;
          seenThisRead.add(existing.id);
          syncedSecurityIds.push(existing.id);
          const res = upsertHolding.run(
            localAccountId,
            existing.id,
            ce.quantity,
            session,
            newFormatHoldingSourceKey(localAccountId, existing.id, session),
          );
          if (res.changes > 0) cashEquivalentRowsWritten++;
        }
        // Retire a fund Plaid used to report by ticker and no longer does:
        // its latest row is a non-zero plaid: row (either key format) and it
        // is absent from this read. The zero row is dated on the session, so
        // it supersedes both that row and any older statement row
        // (latestHoldingsPredicate picks it and filters it out) — the fund
        // reads zero, never frozen or resurrected. A6 guarantees no legacy
        // Plaid row sits after the session on a first write, and a later
        // session is never written before an earlier one. A fund whose
        // latest row is a statement row is left alone: Plaid may simply
        // report it inside its generic cash line, and the next statement
        // settles it. The reconciler exempts cash equivalents, so this is
        // the only live path that can retire one.
        for (const row of latestCashEquivalentRows.all(localAccountId) as {
          security_id: number;
          quantity: number;
          source_key: string | null;
        }[]) {
          if (seenThisRead.has(row.security_id)) continue;
          if (row.quantity === 0 || !isPlaidSourcedHolding(row.source_key)) continue;
          seenThisRead.add(row.security_id);
          syncedSecurityIds.push(row.security_id);
          const res = upsertHolding.run(
            localAccountId,
            row.security_id,
            0,
            session,
            newFormatHoldingSourceKey(localAccountId, row.security_id, session),
          );
          if (res.changes > 0) cashEquivalentRetired++;
        }

        // A forced re-read of a stored session replaces that book (A3): drop
        // the session's own `plaid:` rows this read no longer reports. Both
        // key formats match `plaid:%`; statement and TWS rows are never
        // touched.
        const stale = removeStaleSameDayTwsHoldings(db, {
          accountId: localAccountId,
          asOfDate: session,
          syncedSecurityIds,
          sourceKeyLike: "plaid:%",
        });
        staleRemoved += stale.deleted;
        // No bump: the cleanup deletes only `plaid:` rows, which the
        // statement-only synthetic-close anchor never reads (spec 2026-10-02
        // §2.3).

        const total = mapped.totalByAccount[plaidAccountId];
        if (total != null) {
          upsertSnapshot.run(
            localAccountId,
            session,
            total,
            mapped.cashByAccount[plaidAccountId] ?? null,
          );
        }

        recordFirstNewFormatWrite(db, { accountId: localAccountId, session });
      }

      // ── Prices (A5: still written when the book is skipped) ─────────────
      const pricePairs: { securityId: number; date: string }[] = [];
      for (const ip of mapped.institutionPrices.filter((m) => m.plaidAccountId === plaidAccountId)) {
        if (!Number.isFinite(ip.price) || ip.price <= 0) continue;
        const securityId = securityIdBySymbol.get(ip.symbol) ?? resolveExistingSymbol(ip.symbol)?.id;
        if (securityId == null) continue;
        // A6 per security. The boundary is read again: this run may have
        // added the security's entry already (two accounts holding it).
        const b = getDatingBoundary(db);
        if (!b.repaired && !b.securities.has(securityId) && hasLegacyPriceAfter(db, securityId, session, b)) {
          pricesHeldLegacyAfter++;
          continue;
        }
        if (ip.asOf != null && ip.asOf !== session) priceAsOfMismatches++;
        const res = upsertPrice.run(securityId, session, ip.price);
        if (res.changes > 0) {
          pricesWritten++;
          wroteNewFormat = true;
          recordFirstNewFormatWrite(db, { securityId, session });
        }
        // Collected UNCONDITIONALLY (unlike the import engine's Ruling-B gate
        // on `res.changes > 0` — see the pricePairs comment in
        // lib/import/engine.ts) — deliberate, not an asymmetry to close. This
        // is a daily live sync: an over-bump here just costs one acceptance
        // re-run (fail-closed doctrine — an under-bump risks a wrong filing).
        // The engine's Ruling-B gate exists for a narrower, sharper reason: a
        // fully-deduped statement RE-IMPORT writing byte-identical prices
        // would otherwise clear a filing-ready acceptance stamp with zero
        // data change. A daily Plaid sync has no analogous
        // no-op-refetch-clears-acceptance shape worth guarding — it never
        // claims "nothing changed" the way a re-import does.
        pricePairs.push({ securityId, date: session });
      }

      if (!bookSkip) {
        const stmtGradeAfter = countStatementGradeRowsOnDate(db, localAccountId, session);
        // Consuming statement-grade evidence is a RECONCILE_CLOSE input change.
        if (stmtGradeAfter < stmtGradeBefore) bumpTaxGenerationIfPresent(db);
      }
      bumpIfPricesAffectSyntheticCloses(db, pricePairs);

      if (!bookSkip) {
        // Run-day uses (A4): an option or bond that expired or matured
        // before the run day is purged from live rows.
        purgeExpiredOptionHoldings(db, 1, {
          accountId: localAccountId,
          liveOnly: true,
          today: runDay,
        });
        purgeMaturedBondHoldings(db, 1, {
          accountId: localAccountId,
          liveOnly: true,
          today: runDay,
        });
        // Live-only expiry/maturity cleanup is not a tax input and is inside
        // the same transaction as the Plaid write, so a later reconcile
        // failure rolls it back with the rest of the account sync.

        // Snapshot-diff closure sweep: equities absent from the account's
        // newest book get quantity=0 rows (non-destructive, shrink-guarded).
        // It reads the newest date on its own, which is this session (A6
        // keeps older run-day-dated rows from sitting above it), so its
        // tombstones land on the session too.
        reconcileClosedEquityHoldings(db, { accountId: localAccountId });
      }

      // A database that never held old-format rows needs no repair: the
      // first new-format write settles it as repaired.
      if (wroteNewFormat) settleFreshDatingVersion(db);
    })();
  }

  if (priceAsOfMismatches > 0) {
    console.log(
      `[plaid] ${priceAsOfMismatches} price(s) carried an as-of date other than the session ${session}`,
    );
  }
  if (pricesHeldLegacyAfter > 0) {
    console.log(
      `[plaid] ${pricesHeldLegacyAfter} price(s) held back: older run-day-dated Plaid prices sit after ${session}`,
    );
  }

  return {
    session,
    datingState: getDatingState(db),
    accountsSynced,
    storedAccounts,
    skippedAccounts,
    holdingsWritten,
    pricesWritten,
    priceAsOfMismatches,
    pricesHeldLegacyAfter,
    staleRemoved,
    cashEquivalentRowsWritten,
    cashEquivalentRetired,
    cashEquivalentSkipped,
    securitiesCreated,
  };
}

/**
 * Kept as a thin alias of `isInStoreWindow` (`lib/plaid/session-dating.ts`)
 * for older callers: true on an Eastern trading day from 07:30 to before
 * 09:30 Eastern.
 * The refresh itself uses `isInStoreWindow` and `storeWindowRunDay`.
 */
export function isPreOpenRead(now: Date): boolean {
  return isInStoreWindow(now);
}

/** Why a Plaid sync cannot run right now. */
export type PlaidRefreshBlocker =
  | "not_configured"
  | "not_connected"
  | "no_account_mapped"
  | "sync_in_progress";

function connectionBlocker(
  conn: Pick<ReturnType<typeof getPlaidConnection>, "accessToken" | "accountMap">,
): PlaidRefreshBlocker | null {
  if (!conn.accessToken) return "not_connected";
  if (Object.keys(conn.accountMap).length === 0) return "no_account_mapped";
  if (isSyncing()) return "sync_in_progress";
  return null;
}

/**
 * The one gate in front of a Plaid sync, in the order the refresh checks it.
 * `refreshVanguardHoldingsFromPlaid` returns null for exactly these cases, and
 * the manual sync route reads the same function to say WHICH one it was.
 */
export function plaidRefreshBlocker(
  db: Database.Database,
  cfg: PlaidClientConfig | null = loadPlaidConfig(),
  conn: Pick<ReturnType<typeof getPlaidConnection>, "accessToken" | "accountMap"> = getPlaidConnection(db),
): PlaidRefreshBlocker | null {
  if (!cfg) return "not_configured";
  return connectionBlocker(conn);
}

/**
 * What the manual sync route tells the user when the refresh returned null.
 * A null blocker means the cause cleared between the attempt and this read
 * (another sync finished in between).
 */
export function plaidSyncUnavailableMessage(blocker: PlaidRefreshBlocker | null): string {
  switch (blocker) {
    case "not_configured":
      return "Plaid credentials are not set — add PLAID_CLIENT_ID and PLAID_SECRET to .env.local or settings.json, then restart the app.";
    case "not_connected":
      return "Plaid is not connected — open Settings → Vanguard Live (Plaid) to connect.";
    case "no_account_mapped":
      return "No Vanguard account is mapped to a local account — open Settings → Vanguard Live (Plaid) and save the account mapping.";
    case "sync_in_progress":
      return "Another sync is already running — try again when it finishes.";
    default:
      return "The sync did not run because another sync was finishing — try again.";
  }
}

/**
 * Fetches Plaid's holdings answer for an access token. The default calls
 * Plaid (`getInvestmentsHoldings`). Tests and the sandbox-only fake-sync
 * script inject one that returns a synthetic answer; the app itself never
 * does.
 */
export type PlaidHoldingsFetcher = (accessToken: string) => Promise<PlaidHoldingsResponse>;

export interface PlaidRefreshOptions {
  /** Plaid credentials; defaults to `loadPlaidConfig()`. */
  cfg?: PlaidClientConfig | null;
  /** The in-app button's read: bypasses `already_synced_today` only (A3). */
  force?: boolean;
  /** The request start. Defaults to the wall clock. */
  now?: Date;
  /**
   * Read after the Plaid call returns, for the response-arrival check (A1).
   * Defaults to `() => now` when `now` is pinned (so a test that pins only
   * `now` reads as an instant answer), else the wall clock.
   */
  clock?: () => Date;
  /**
   * Injected holdings fetcher. When given, Plaid credentials are not needed
   * (the "not configured" gate is skipped); the connection's access token and
   * account map still are.
   */
  fetchHoldings?: PlaidHoldingsFetcher;
}

/** The dating state for a skip answer; never throws (see `PlaidResultDatingState`). */
function datingStateForAnswer(db: Database.Database): PlaidResultDatingState {
  try {
    return getDatingState(db);
  } catch (err) {
    console.error(`[plaid] dating settings unreadable: ${err instanceof Error ? err.message : String(err)}`);
    return "unreadable";
  }
}

function skipped(db: Database.Database, reason: PlaidRefreshSkipReason): PlaidRefreshResult {
  return {
    skippedReason: reason,
    session: null,
    datingState: datingStateForAnswer(db),
    accountsSynced: 0,
    storedAccounts: [],
    skippedAccounts: [],
    holdingsWritten: 0,
    pricesWritten: 0,
    priceAsOfMismatches: 0,
    pricesHeldLegacyAfter: 0,
    staleRemoved: 0,
    cashEquivalentRowsWritten: 0,
    cashEquivalentRetired: 0,
    cashEquivalentSkipped: [],
    unmatched: [],
    securitiesCreated: [],
    // Nothing was written, so nothing needed recomputing.
    valuationsRecomputed: true,
    valuationError: null,
    connectionChecked: false,
  };
}

export async function refreshVanguardHoldingsFromPlaid(
  db: Database.Database,
  opts: PlaidRefreshOptions = {},
): Promise<PlaidRefreshResult | null> {
  const cfg = opts.cfg !== undefined ? opts.cfg : loadPlaidConfig();
  const conn = getPlaidConnection(db);
  const blocker = !cfg && !opts.fetchHoldings ? "not_configured" : connectionBlocker(conn);
  if (blocker === "sync_in_progress") {
    console.log("[plaid] refresh skipped — a sync is already in progress");
  }
  // The token and cfg tests below only narrow the types; the blocker
  // already returned for both.
  if (blocker || !conn.accessToken) return null;
  const accessToken = conn.accessToken;
  let fetchHoldings: PlaidHoldingsFetcher;
  if (opts.fetchHoldings) {
    fetchHoldings = opts.fetchHoldings;
  } else if (cfg) {
    const config = cfg;
    fetchHoldings = (token) => getInvestmentsHoldings(config, token);
  } else {
    return null;
  }

  const start = opts.now ?? new Date();
  const pinned = opts.now;
  const clock = opts.clock ?? (pinned ? () => pinned : () => new Date());
  const today = todayET(start);

  const startTime = Date.now();

  /**
   * The one Plaid call. A login-required error sets `reauth_required` and
   * alerts once; every error releases the sync mutex and is rethrown.
   */
  const callPlaid = async (): Promise<PlaidMapResult> => {
    setSyncPhase("positions");
    try {
      const resp = await fetchHoldings(accessToken);
      return mapPlaidHoldings(resp);
    } catch (err) {
      if (err instanceof PlaidApiError && err.errorCode === "ITEM_LOGIN_REQUIRED") {
        setPlaidConnectionStatus(db, "reauth_required");
        // Stamp BEFORE push so a Pushover failure can't cause repeat alerts.
        if (!getPlaidReauthAlertedAt(db)) {
          setPlaidReauthAlertedAt(db, start.toISOString());
          void sendPushover({
            title: "Plaid: Vanguard re-auth required",
            message:
              "The Plaid connection to Vanguard needs to be re-authenticated. Open Settings → Vanguard Live (Plaid) → Reconnect.",
          }).catch(() => {});
        }
      }
      setSyncError(err instanceof Error ? err.message : "Plaid refresh failed");
      throw err;
    }
  };

  /**
   * After a Plaid call whose answer is not stored: the call worked, so the
   * login is fine. Status ok, re-auth alert cleared, mutex released;
   * plaid_last_sync_at does not move.
   */
  const connectionConfirmedNothingStored = (note: string): void => {
    setPlaidConnectionStatus(db, "ok");
    setPlaidReauthAlertedAt(db, null);
    setSyncComplete(
      {
        positionsSynced: 0,
        securitiesEnriched: 0,
        pricesUpdated: 0,
        valuationsRecomputed: false,
        benchmarksSynced: 0,
        alertsFired: 0,
        errors: [note],
        durationMs: Date.now() - startTime,
      },
      "plaid",
    );
  };

  // A2, before the Plaid call. Scheduled and forced reads alike.
  const preCallSkip: PlaidRefreshSkipReason | null = isMarketClosed(today)
    ? "market_closed"
    : nowET(start) < PLAID_STORE_WINDOW_START_ET
      ? "before_window"
      : !isInStoreWindow(start)
        ? "after_open"
        : null;
  if (preCallSkip) {
    // Planner ruling 2026-11-26: a forced read (the button, or the re-auth
    // page's sync) while the stored status is `reauth_required` still makes
    // the Plaid call, as a connection check only, so a re-auth done outside
    // the window clears "Reconnect". Nothing is stored. The scheduled read
    // never makes this call.
    if (opts.force && conn.connectionStatus === "reauth_required") {
      await callPlaid();
      console.log(`[plaid] connection check only (${preCallSkip}) — login confirmed, nothing stored`);
      connectionConfirmedNothingStored("Plaid connection checked; nothing stored outside the 7:30-9:30 a.m. window");
      return { ...skipped(db, preCallSkip), connectionChecked: true };
    }
    return skipped(db, preCallSkip);
  }
  if (!opts.force && conn.lastSyncAt && todayET(new Date(conn.lastSyncAt)) === today) {
    return skipped(db, "already_synced_today");
  }

  const mapped = await callPlaid();

  // A1/A2, after the call: the answer must have arrived inside the same
  // morning's store window, or it cannot be tied to one session.
  const runDay = storeWindowRunDay(start, clock());
  if (runDay === null) {
    console.log("[plaid] read finished at or after 09:30 Eastern — answer discarded, nothing stored");
    connectionConfirmedNothingStored("Plaid read finished after 9:30 a.m. Eastern; nothing stored");
    return skipped(db, "read_finished_after_open");
  }
  const session = plaidSessionDate(runDay);

  setSyncPhase("valuations");
  let written: PlaidWriteResult;
  let valuationsRecomputed = true;
  let valuationError: string | null = null;
  try {
    written = writePlaidHoldings(db, mapped, conn.accountMap, session, { runDay });
    // A8: reported, never swallowed. The books stay stored (they are
    // correct) and plaid_last_sync_at still moves; the next TWS sync or
    // Plaid read recomputes (both call it).
    try {
      computeDailyValuations(db);
    } catch (err) {
      valuationsRecomputed = false;
      valuationError = err instanceof Error ? err.message : String(err);
      console.error(`[plaid] daily valuation recompute failed after the write: ${valuationError}`);
    }

    // Stamp with the injected start so this write and the
    // already-synced-today gate agree on what "today" is (tests pin
    // opts.now; in production both are the wall clock).
    setPlaidLastSyncAt(db, start.toISOString());
    setPlaidConnectionStatus(db, "ok");
    setPlaidReauthAlertedAt(db, null);
  } catch (err) {
    // The fetch half above is already guarded (catch → setSyncError →
    // rethrow). This mirrors that for the write half: a throw here (e.g. a
    // DB error mid-write) must not leave sync-state wedged at "syncing" —
    // isSyncing() would then null-gate every future call until restart.
    setSyncError(err instanceof Error ? err.message : "Plaid write failed");
    throw err;
  }

  setSyncComplete(
    {
      positionsSynced: written.holdingsWritten,
      securitiesEnriched: 0,
      pricesUpdated: written.pricesWritten,
      valuationsRecomputed,
      benchmarksSynced: 0,
      alertsFired: 0,
      errors: [
        ...mapped.unmatched.map((u) => `unmatched: ${u.name ?? "?"} (${u.reason})`),
        ...(valuationError ? [`valuation recompute failed: ${valuationError}`] : []),
      ],
      durationMs: Date.now() - startTime,
    },
    "plaid",
  );

  return {
    ...written,
    skippedReason: null,
    unmatched: mapped.unmatched,
    valuationsRecomputed,
    valuationError,
    connectionChecked: false,
  };
}
