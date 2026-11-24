import type Database from "better-sqlite3";
import {
  getInvestmentsHoldings,
  loadPlaidConfig,
  PlaidApiError,
  type PlaidClientConfig,
} from "./client";
import { mapPlaidHoldings, type PlaidMapResult, type UnmatchedPlaidSecurity } from "./map-holdings";
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
import { isPlaidSourcedHolding, liveOverwritableHoldingSql } from "@/lib/db/holding-sources";
import { cashEquivalentSecuritySql, isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import {
  bumpTaxGenerationIfPresent,
  bumpIfPricesAffectSyntheticCloses,
} from "@/lib/compute/tax-convention";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { nowET, todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed, previousTradingDay } from "@/lib/calendar/market-holidays";
import { isSyncing, setSyncComplete, setSyncError, setSyncPhase } from "@/lib/tws/sync-state";
import { sendPushover } from "@/lib/alerts/notify-pushover";

export interface PlaidRefreshResult {
  skippedReason: "market_closed" | "already_synced_today" | null;
  accountsSynced: number;
  holdingsWritten: number;
  pricesWritten: number;
  /**
   * Stock/ETF prices whose Plaid as-of date was not the session the price is
   * dated on (a null as-of is not counted). Logged so the gap can be watched.
   */
  priceAsOfMismatches: number;
  /**
   * Stock/ETF prices NOT stored because the read was taken at or after the
   * regular open, or on a closed market day: only a pre-open read is known
   * to describe the previous session, and a price is never given a guessed
   * date.
   */
  equityPricesSkipped: number;
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
}

const EMPTY: Omit<PlaidRefreshResult, "skippedReason"> = {
  accountsSynced: 0,
  holdingsWritten: 0,
  pricesWritten: 0,
  priceAsOfMismatches: 0,
  equityPricesSkipped: 0,
  staleRemoved: 0,
  cashEquivalentRowsWritten: 0,
  cashEquivalentRetired: 0,
  cashEquivalentSkipped: [],
  unmatched: [],
  securitiesCreated: [],
};

type PlaidWriteResult = Omit<PlaidRefreshResult, "skippedReason" | "unmatched">;

/**
 * The DB half — exported for tests. Mirrors writeIbkrHoldings but with
 * 'plaid' provenance: conditional upserts that can never claim a
 * statement row, source='plaid' live snapshot, and Vanguard's own price for
 * held stocks, ETFs and mutual funds (never options or bonds).
 *
 * Price dating:
 *  - Stock/ETF: always `previousTradingDay(today)`. The read is taken before
 *    the open and describes the previous session's close; Plaid's as-of date
 *    is not trusted (measured one session early on fund rows). Never a closed
 *    market day.
 *  - Mutual fund: `asOf ?? today`, unchanged — the session-dating work moves
 *    it together with a history repair, so one series never mixes two rules.
 *
 * Money-market funds: Plaid folds them into cash (cash_value is unchanged),
 * and when the stored security is a cash equivalent by the shared rule its
 * own holdings row is refreshed from Plaid's balance. daily_valuations
 * excludes such rows, so account totals do not move.
 */
export function writePlaidHoldings(
  db: Database.Database,
  mapped: PlaidMapResult,
  accountMap: Record<string, number>,
  today: string,
  opts: { storeEquityPrices?: boolean } = {},
): PlaidWriteResult {
  // Default true keeps the DB half testable on its own; the refresh passes
  // the real answer (see isPreOpenRead).
  const storeEquityPrices = opts.storeEquityPrices ?? true;
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

  let accountsSynced = 0;
  let holdingsWritten = 0;
  let pricesWritten = 0;
  let priceAsOfMismatches = 0;
  let equityPricesSkipped = 0;
  let staleRemoved = 0;
  let cashEquivalentRowsWritten = 0;
  let cashEquivalentRetired = 0;
  const cashEquivalentSkipped: string[] = [];
  // Stock/ETF prices describe the previous session (see the doc above).
  const sessionDate = previousTradingDay(today);
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
    // look like "everything sold" — skip the account entirely.
    if (positions.length === 0) continue;
    accountsSynced++;

    // Whole per-account DB-mutation block (pre-state reads through the
    // trailing reconcile) is ONE transaction (spec 2026-08-31
    // reconciler-hardening §5): a mid-write failure must not leave a
    // superseded tombstone half-written with no matching tax-generation
    // bump, or vice versa. reconcileClosedEquityHoldings nests as a
    // savepoint — better-sqlite3 supports nested db.transaction() calls.
    db.transaction(() => {
      // Pre-state read INSIDE the transaction so it reflects exactly the
      // book this account's writes are about to mutate. computeTaxLots reads
      // statement-grade holdings only (spec 2026-10-02 statement-only
      // synthetic closes §2.3), so a Plaid write is a tax input only if it
      // removed statement-grade evidence — which the liveOverwritable upsert
      // guard already forbids. The count is kept as a fail-closed check, not
      // an expected path. Newer-date re-buys over a tombstone, `:live`
      // tombstone replacement and the same-day stale cleanup are live-data
      // events and no longer bump.
      const stmtGradeBefore = countStatementGradeRowsOnDate(db, localAccountId, today);

      const syncedSecurityIds: number[] = [];
      // Mapper symbol → the security id its holding landed on, so the
      // price path never resolves a symbol differently from the holding.
      const securityIdBySymbol = new Map<string, number>();
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
          today,
          `plaid:${localAccountId}:${securityId}:${today}`,
        );
        if (res.changes > 0) holdingsWritten++;
      }

      // ── Money-market funds Plaid folded into cash ──────────────────────
      // Refresh the fund's own row from Plaid's balance, but only onto an
      // EXISTING security the shared identity rule calls a cash equivalent
      // (daily_valuations then excludes it, so totals are conserved). A fund
      // that is also reported as a position this run keeps that one row.
      const seenToday = new Set(syncedSecurityIds);
      for (const ce of mapped.cashEquivalentHoldings.filter((c) => c.plaidAccountId === plaidAccountId)) {
        const existing = resolveExistingSymbol(ce.symbol);
        const identity = existing
          ? (securityIdentity.get(existing.id) as { security_type: string | null; fund_category: string | null })
          : null;
        if (!existing || !identity || !isCashEquivalentSecurity(identity)) {
          cashEquivalentSkipped.push(ce.symbol);
          continue;
        }
        if (seenToday.has(existing.id)) continue;
        seenToday.add(existing.id);
        syncedSecurityIds.push(existing.id);
        const res = upsertHolding.run(
          localAccountId,
          existing.id,
          ce.quantity,
          today,
          `plaid:${localAccountId}:${existing.id}:${today}`,
        );
        if (res.changes > 0) cashEquivalentRowsWritten++;
      }
      // Retire a fund Plaid used to report by ticker and no longer does: its
      // latest row is a non-zero plaid: row and it is absent from this run.
      // The zero row is dated today, so it supersedes both that row and any
      // older statement row (latestHoldingsPredicate picks it and filters
      // it out) — the fund reads zero, never frozen or resurrected. A fund
      // whose latest row is a statement row is left alone: Plaid may simply
      // report it inside its generic cash line, and the next statement
      // settles it. The reconciler exempts cash equivalents, so this is the
      // only live path that can retire one.
      for (const row of latestCashEquivalentRows.all(localAccountId) as {
        security_id: number;
        quantity: number;
        source_key: string | null;
      }[]) {
        if (seenToday.has(row.security_id)) continue;
        if (row.quantity === 0 || !isPlaidSourcedHolding(row.source_key)) continue;
        seenToday.add(row.security_id);
        syncedSecurityIds.push(row.security_id);
        const res = upsertHolding.run(
          localAccountId,
          row.security_id,
          0,
          today,
          `plaid:${localAccountId}:${row.security_id}:${today}`,
        );
        if (res.changes > 0) cashEquivalentRetired++;
      }

      const stale = removeStaleSameDayTwsHoldings(db, {
        accountId: localAccountId,
        asOfDate: today,
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
          today,
          total,
          mapped.cashByAccount[plaidAccountId] ?? null,
        );
      }

      const pricePairs: { securityId: number; date: string }[] = [];
      for (const ip of mapped.institutionPrices.filter((m) => m.plaidAccountId === plaidAccountId)) {
        if (!Number.isFinite(ip.price) || ip.price <= 0) continue;
        const securityId = securityIdBySymbol.get(ip.symbol) ?? resolveExistingSymbol(ip.symbol)?.id;
        if (securityId == null) continue;
        let priceDate: string;
        if (ip.kind === "equity") {
          if (!storeEquityPrices) {
            equityPricesSkipped++;
            continue;
          }
          priceDate = sessionDate;
          if (ip.asOf != null && ip.asOf !== sessionDate) priceAsOfMismatches++;
        } else {
          // Legacy fund dating, deliberately unchanged (see the doc above).
          priceDate = ip.asOf ?? today;
        }
        const res = upsertPrice.run(securityId, priceDate, ip.price);
        if (res.changes > 0) pricesWritten++;
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
        pricePairs.push({ securityId, date: priceDate });
      }

      const stmtGradeAfter = countStatementGradeRowsOnDate(db, localAccountId, today);
      // Consuming statement-grade evidence is a RECONCILE_CLOSE input change.
      if (stmtGradeAfter < stmtGradeBefore) bumpTaxGenerationIfPresent(db);
      bumpIfPricesAffectSyntheticCloses(db, pricePairs);

      purgeExpiredOptionHoldings(db, 1, {
        accountId: localAccountId,
        liveOnly: true,
        today,
      });
      purgeMaturedBondHoldings(db, 1, {
        accountId: localAccountId,
        liveOnly: true,
        today,
      });
      // Live-only expiry/maturity cleanup is not a tax input and is inside the
      // same transaction as the Plaid write, so a later reconcile failure
      // rolls it back with the rest of the account sync.

      // Snapshot-diff closure sweep: equities absent from today's full book
      // get quantity=0 rows (non-destructive, shrink-guarded).
      reconcileClosedEquityHoldings(db, { accountId: localAccountId });
    })();
  }

  if (priceAsOfMismatches > 0) {
    console.log(
      `[plaid] ${priceAsOfMismatches} stock/ETF price(s) carried an as-of date other than the session ${sessionDate}`,
    );
  }

  return {
    accountsSynced,
    holdingsWritten,
    pricesWritten,
    priceAsOfMismatches,
    equityPricesSkipped,
    staleRemoved,
    cashEquivalentRowsWritten,
    cashEquivalentRetired,
    cashEquivalentSkipped,
    securitiesCreated,
  };
}

/**
 * True when a Plaid read taken at `now` is known to describe the previous
 * session's close: a trading day, before the regular open (09:30 Eastern).
 * The scheduled sync runs in that window. A forced read later in the day or
 * on a closed day may already carry newer figures, so its stock/ETF prices
 * are not stored (never a guessed date).
 */
export function isPreOpenRead(now: Date): boolean {
  return !isMarketClosed(todayET(now)) && nowET(now) < "09:30";
}

/** Why a Plaid sync cannot run right now. */
export type PlaidRefreshBlocker =
  | "not_configured"
  | "not_connected"
  | "no_account_mapped"
  | "sync_in_progress";

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
  if (!conn.accessToken) return "not_connected";
  if (Object.keys(conn.accountMap).length === 0) return "no_account_mapped";
  if (isSyncing()) return "sync_in_progress";
  return null;
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

export async function refreshVanguardHoldingsFromPlaid(
  db: Database.Database,
  opts: { cfg?: PlaidClientConfig | null; force?: boolean; now?: Date } = {},
): Promise<PlaidRefreshResult | null> {
  const cfg = opts.cfg !== undefined ? opts.cfg : loadPlaidConfig();
  const conn = getPlaidConnection(db);
  const blocker = plaidRefreshBlocker(db, cfg, conn);
  if (blocker === "sync_in_progress") {
    console.log("[plaid] refresh skipped — a sync is already in progress");
  }
  // The second and third tests only narrow the types; the blocker already
  // returned for both.
  if (blocker || !cfg || !conn.accessToken) return null;

  const today = todayET(opts.now);
  if (!opts.force && isMarketClosed(today)) {
    return { ...EMPTY, skippedReason: "market_closed" };
  }
  if (!opts.force && conn.lastSyncAt && todayET(new Date(conn.lastSyncAt)) === today) {
    return { ...EMPTY, skippedReason: "already_synced_today" };
  }

  const startTime = Date.now();
  setSyncPhase("positions");

  let mapped: PlaidMapResult;
  try {
    const resp = await getInvestmentsHoldings(cfg, conn.accessToken);
    mapped = mapPlaidHoldings(resp);
  } catch (err) {
    if (err instanceof PlaidApiError && err.errorCode === "ITEM_LOGIN_REQUIRED") {
      setPlaidConnectionStatus(db, "reauth_required");
      // Stamp BEFORE push so a Pushover failure can't cause repeat alerts.
      if (!getPlaidReauthAlertedAt(db)) {
        setPlaidReauthAlertedAt(db, (opts.now ?? new Date()).toISOString());
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

  setSyncPhase("valuations");
  let written: PlaidWriteResult;
  try {
    written = writePlaidHoldings(db, mapped, conn.accountMap, today, {
      storeEquityPrices: isPreOpenRead(opts.now ?? new Date()),
    });
    try {
      computeDailyValuations(db);
    } catch {
      // Non-critical (mirrors the TWS + IBKR paths).
    }

    // Stamp with the injected clock so this write and the
    // already-synced-today gate agree on what "today" is (tests pin
    // opts.now; in production both are the wall clock).
    setPlaidLastSyncAt(db, (opts.now ?? new Date()).toISOString());
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
      valuationsRecomputed: true,
      benchmarksSynced: 0,
      alertsFired: 0,
      errors: mapped.unmatched.map((u) => `unmatched: ${u.name ?? "?"} (${u.reason})`),
      durationMs: Date.now() - startTime,
    },
    "plaid",
  );

  return { ...written, skippedReason: null, unmatched: mapped.unmatched };
}
