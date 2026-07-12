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
import { reconcileClosedEquityHoldings } from "@/lib/mutations/closed-equity";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";
import { isSyncing, setSyncComplete, setSyncError, setSyncPhase } from "@/lib/tws/sync-state";
import { sendPushover } from "@/lib/alerts/notify-pushover";

export interface PlaidRefreshResult {
  skippedReason: "market_closed" | "already_synced_today" | null;
  accountsSynced: number;
  holdingsWritten: number;
  pricesWritten: number;
  staleRemoved: number;
  unmatched: UnmatchedPlaidSecurity[];
  securitiesCreated: string[];
}

const EMPTY: Omit<PlaidRefreshResult, "skippedReason"> = {
  accountsSynced: 0,
  holdingsWritten: 0,
  pricesWritten: 0,
  staleRemoved: 0,
  unmatched: [],
  securitiesCreated: [],
};

/**
 * The DB half — exported for tests. Mirrors writeIbkrHoldings but with
 * 'plaid' provenance: conditional upserts that can never claim a
 * statement row, source='plaid' live snapshot, MF-only prices.
 */
export function writePlaidHoldings(
  db: Database.Database,
  mapped: PlaidMapResult,
  accountMap: Record<string, number>,
  today: string,
): {
  accountsSynced: number;
  holdingsWritten: number;
  pricesWritten: number;
  staleRemoved: number;
  securitiesCreated: string[];
} {
  const upsertHolding = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE SET
       quantity = excluded.quantity,
       cost_basis = excluded.cost_basis,
       source_key = excluded.source_key
     WHERE holdings.source_key LIKE 'tws-%' OR holdings.source_key LIKE 'plaid:%'`,
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
  let staleRemoved = 0;
  // Symbol-drift from Plaid tickers can create duplicate securities that
  // cause phantom closures (reconcileClosedEquityHoldings sees the "old"
  // symbol vanish) — surface every brand-new security so the user can
  // eyeball it in Settings rather than discover it downstream. Existence
  // is checked BEFORE the upsert so a symbol that already existed (even
  // if this call updates it) is never misreported as "created".
  const securitiesCreated: string[] = [];
  const checkExistingSecurity = db.prepare(`SELECT id FROM securities WHERE symbol = ?`);

  for (const [plaidAccountId, localAccountId] of Object.entries(accountMap)) {
    const positions = mapped.positions.filter((p) => p.plaidAccountId === plaidAccountId);
    // Zero-holdings guard: a partial/failed Plaid response must never
    // look like "everything sold" — skip the account entirely.
    if (positions.length === 0) continue;
    accountsSynced++;

    const syncedSecurityIds: number[] = [];
    for (const p of positions) {
      let symbol = p.symbol;
      let existed = checkExistingSecurity.get(symbol) !== undefined;
      // Share-class form drift: statements store BRK/B, Plaid says BRK.B.
      // Creating the dotted twin makes the reconciler phantom-close the
      // real slash-form row (observed live 2026-07-11) — resolve onto the
      // existing security instead.
      if (!existed && symbol.includes(".")) {
        const slashForm = symbol.replace(/\./g, "/");
        if (checkExistingSecurity.get(slashForm) !== undefined) {
          symbol = slashForm;
          existed = true;
        }
      }
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
      const res = upsertHolding.run(
        localAccountId,
        securityId,
        p.quantity,
        today,
        `plaid:${localAccountId}:${securityId}:${today}`,
      );
      if (res.changes > 0) holdingsWritten++;
    }

    const stale = removeStaleSameDayTwsHoldings(db, {
      accountId: localAccountId,
      asOfDate: today,
      syncedSecurityIds,
      sourceKeyLike: "plaid:%",
    });
    staleRemoved += stale.deleted;

    const total = mapped.totalByAccount[plaidAccountId];
    if (total != null) {
      upsertSnapshot.run(
        localAccountId,
        today,
        total,
        mapped.cashByAccount[plaidAccountId] ?? null,
      );
    }

    for (const mf of mapped.mutualFundPrices.filter((m) => m.plaidAccountId === plaidAccountId)) {
      const sec = db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(mf.symbol) as
        | { id: number }
        | undefined;
      if (!sec) continue;
      const res = upsertPrice.run(sec.id, mf.asOf ?? today, mf.price);
      if (res.changes > 0) pricesWritten++;
    }

    // Snapshot-diff closure sweep: equities absent from today's full book
    // get quantity=0 rows (non-destructive, shrink-guarded).
    reconcileClosedEquityHoldings(db, { accountId: localAccountId });
  }

  return { accountsSynced, holdingsWritten, pricesWritten, staleRemoved, securitiesCreated };
}

export async function refreshVanguardHoldingsFromPlaid(
  db: Database.Database,
  opts: { cfg?: PlaidClientConfig | null; force?: boolean; now?: Date } = {},
): Promise<PlaidRefreshResult | null> {
  const cfg = opts.cfg !== undefined ? opts.cfg : loadPlaidConfig();
  if (!cfg) return null;
  const conn = getPlaidConnection(db);
  if (!conn.accessToken || Object.keys(conn.accountMap).length === 0) return null;
  if (isSyncing()) {
    console.log("[plaid] refresh skipped — a sync is already in progress");
    return null;
  }

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
  let written: ReturnType<typeof writePlaidHoldings>;
  try {
    written = writePlaidHoldings(db, mapped, conn.accountMap, today);
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
