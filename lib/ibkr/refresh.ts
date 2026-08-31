/**
 * IBKR Tier 2 refresh — TWS-independent portfolio sync via the headless Web API.
 *
 * Split into a network `fetchIbkrPortfolio` and a DB `writeIbkrHoldings` so the
 * write half (which mirrors the TWS sync) is unit-testable with an in-memory DB.
 * `refreshIbkrHoldingsFromWebApi` orchestrates both and is the entry point the
 * auto-refresh route calls when TWS is unavailable.
 */

import type Database from "better-sqlite3";
import { upsertSecurity } from "../mutations/securities";
import { computeDailyValuations } from "../compute/daily-valuation";
import { todayET } from "../calendar/date-utils";
import { isMarketClosed } from "../calendar/market-holidays";
import { upsertFxRate } from "../mutations/fx-rates";
import { zeroLatestSecurityIds, countReconRowsOnDate } from "../mutations/closed-equity";
import { bumpTaxGenerationIfPresent, bumpIfPricesAffectSyntheticCloses } from "../compute/tax-convention";
import { loadIbkrConfig } from "./config";
import {
  openSession,
  getPortfolioAccounts,
  getPositions,
  getLedger,
  IbkrSessionYieldError,
} from "./web-api";
import { mapPosition, extractLedgerFxRates, type MappedPosition } from "./map-positions";
import { getLiveSessionToken, type IbkrOAuthConfig } from "./oauth-client";
import { getMarketDataSnapshot, type ParsedQuote } from "./market-data";
import { getQuoteCandidateConids } from "../queries/security-quotes";
import { upsertSecurityQuote } from "../mutations/security-quotes";
import { runLevelScanCycle } from "../alerts/scan-cycle";
import {
  isSyncing,
  setSyncComplete,
  setSyncError,
  setSyncPhase,
} from "../tws/sync-state";
import {
  fetchFinnhubDividendYields,
  getYieldRefreshCandidates,
  type YieldFetcher,
} from "../quotes/finnhub-dividend-yield";

const DB_ACCOUNT_NAME = "IBKR";

export interface IbkrPortfolioSnapshot {
  accountCode: string;
  positions: MappedPosition[];
  netLiq: number | null;
  cash: number | null;
  /** USD per unit per non-USD currency, from the ledger's `exchangerate`. */
  fxRates?: Record<string, number>;
}

export interface IbkrWriteResult {
  accountId: number;
  asOfDate: string;
  positionsWritten: number;
  pricesWritten: number;
  netLiq: number | null;
  cash: number | null;
}

/**
 * Network: pull live positions + cost basis + account values. SESSIONLESS —
 * probe-verified 2026-07-21 (scripts/probe-ibkr-compete.ts, scenario-b run):
 * /portfolio/accounts, /portfolio/{acct}/positions/{page}, and
 * /portfolio/{acct}/ledger all return HTTP 200 with full data using only a
 * signed LST, with NO brokerage session opened at all (no ssodh/init). This
 * path therefore never competes for or evicts the one-per-username brokerage
 * session — it works in every scenario, TWS open or closed. Only
 * /iserver-needing consumers (quote enrichment below, earnings-intel) call
 * openSession.
 */
export async function fetchIbkrPortfolio(
  cfg: IbkrOAuthConfig,
): Promise<IbkrPortfolioSnapshot> {
  const lst = await getLiveSessionToken(cfg);
  const accts = await getPortfolioAccounts(cfg, lst.token);
  const accountCode = accts[0].accountId;

  const raw = await getPositions(cfg, lst.token, accountCode);
  const positions = raw.map(mapPosition);

  const ledger = (await getLedger(cfg, lst.token, accountCode)) as Record<
    string,
    Record<string, unknown>
  >;
  const base =
    ledger.BASE ??
    ledger.USD ??
    Object.values(ledger).find((v) => (v as { currency?: string })?.currency === "USD") ??
    {};
  const netLiq = (base.netliquidationvalue as number | undefined) ?? null;
  const cash =
    (base.cashbalance as number | undefined) ?? (base.settledcash as number | undefined) ?? null;

  return { accountCode, positions, netLiq, cash, fxRates: extractLedgerFxRates(ledger) };
}

/**
 * DB write — mirrors lib/tws/positions.ts exactly (holdings source_key `tws-…`,
 * prices/snapshot source='tws', then computeDailyValuations). Skips zero-quantity
 * rows. Writes the given as_of date; prior dates untouched.
 */
export function writeIbkrHoldings(
  db: Database.Database,
  snapshot: IbkrPortfolioSnapshot,
  opts: { asOfDate?: string; dbAccountName?: string } = {},
): IbkrWriteResult {
  const today = opts.asOfDate ?? todayET();
  const acctRow = db
    .prepare("SELECT id FROM accounts WHERE name = ?")
    .get(opts.dbAccountName ?? DB_ACCOUNT_NAME) as { id: number } | undefined;
  if (!acctRow) {
    throw new Error(`IBKR refresh: DB account '${opts.dbAccountName ?? DB_ACCOUNT_NAME}' not found`);
  }
  const accountId = acctRow.id;

  const upsertHolding = db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?,?,?,?,?,?)`,
  );
  const upsertPrice = db.prepare(
    `INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?,?,?,'tws')`,
  );
  const updateConId = db.prepare(
    `UPDATE securities SET ib_con_id = ? WHERE id = ? AND ib_con_id IS NULL`,
  );

  let positionsWritten = 0;
  let pricesWritten = 0;

  db.transaction(() => {
    // Pre-state reads (spec §4, T3): captured at the TOP of the transaction,
    // before any write, so a same-run REPLACE or re-buy is measured against
    // the state that existed before this sync started.
    const zeroLatest = zeroLatestSecurityIds(db, accountId);
    const reconBefore = countReconRowsOnDate(db, accountId, today);
    let newerDateSupersession = false;
    const pricePairs: { securityId: number; date: string }[] = [];

    for (const m of snapshot.positions) {
      if (m.quantity === 0) continue; // mirror TWS: skip closed
      const securityId = upsertSecurity(db, {
        symbol: m.symbol,
        securityType: m.securityType,
        assetClass: m.assetClass,
        underlyingSymbol: m.underlyingSymbol,
        strikePrice: m.strikePrice,
        expirationDate: m.expirationDate,
        optionType: m.optionType,
        multiplier: m.multiplier,
        currency: m.currency,
      });
      if (m.conid != null) updateConId.run(m.conid, securityId);
      upsertHolding.run(accountId, securityId, m.quantity, m.costBasis, today, `tws-${accountId}-${securityId}-${today}`);
      positionsWritten++;
      if (zeroLatest.has(securityId)) newerDateSupersession = true;
      if (m.mktPrice != null && m.mktPrice > 0) {
        upsertPrice.run(securityId, today, m.mktPrice);
        pricesWritten++;
        pricePairs.push({ securityId, date: today });
      }

      // Foreign-currency positions: the Web API's per-position `mktValue` is
      // NATIVE currency (live-verified 2026-07-03: 402340 @ 1,601,000 KRW ×
      // 10 sh → mktValue 16,010,000 KRW, baseMktValue null), so deriving a
      // rate from it always lands ≈1 — the first go-live sync wrote KRW=1.0
      // that way. The authoritative source is the ledger's per-currency
      // `exchangerate` (0.0006531 on the same probe), threaded in via
      // snapshot.fxRates. When the ledger lacks the currency, write NOTHING —
      // getUsdPerUnit's missing-rate path is honest; a bogus 1.0 is not.
      if (m.currency && m.currency !== "USD") {
        const rate = snapshot.fxRates?.[m.currency.toUpperCase()];
        if (rate != null) {
          upsertFxRate(db, { currency: m.currency, usdPerUnit: rate, asOf: today, source: "ibkr_ledger" });
        }
      }
    }

    // Transition detection + bump — inside the same transaction as the
    // writes (spec §4, atomicity rule): a mid-loop throw rolls both back
    // together. `INSERT OR REPLACE` consumes a same-date tombstone by
    // replacing it, so reconAfter < reconBefore catches that case; a
    // non-zero write hitting a security whose prior latest row was a
    // tombstone (newerDateSupersession) catches the newer-date re-buy case.
    const reconAfter = countReconRowsOnDate(db, accountId, today);
    if (reconAfter < reconBefore || newerDateSupersession) bumpTaxGenerationIfPresent(db);
    bumpIfPricesAffectSyntheticCloses(db, pricePairs);
  })();

  if (snapshot.netLiq != null) {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
       VALUES (?,?,?,?,'tws')
       ON CONFLICT(account_id, month_end_date) DO UPDATE SET
         total_value = excluded.total_value, cash_value = excluded.cash_value, source = excluded.source
       WHERE monthly_snapshots.source IN ('tws','manual')`,
    ).run(accountId, today, snapshot.netLiq, snapshot.cash);
  }

  try {
    computeDailyValuations(db);
  } catch {
    // Non-critical (mirrors the TWS path).
  }

  return { accountId, asOfDate: today, positionsWritten, pricesWritten, netLiq: snapshot.netLiq, cash: snapshot.cash };
}

/**
 * Full Tier 2 refresh: fetch live + write. Returns null when IBKR OAuth isn't
 * configured (so callers degrade gracefully, like the TWS path does) OR when a
 * sync is already in progress (shares the TWS pipeline's mutex).
 *
 * R1b (2026-07-07): this path now also (a) reports through sync-state with
 * via='ibkr-webapi' so the header shows the refresh happened while TWS is
 * down, and (b) runs the shared level-scan cycle afterward so MA-based levels
 * fire away from home (the Worker's cloud scan covers static levels only).
 */
export async function refreshIbkrHoldingsFromWebApi(
  db: Database.Database,
  cfg: IbkrOAuthConfig | null = loadIbkrConfig(),
): Promise<IbkrWriteResult | null> {
  if (!cfg) return null;
  if (isSyncing()) {
    console.log("[ibkr] Web API refresh skipped — a sync is already in progress");
    return null;
  }

  const startTime = Date.now();
  setSyncPhase("positions");
  let result: IbkrWriteResult;
  try {
    const snapshot = await fetchIbkrPortfolio(cfg);
    result = writeIbkrHoldings(db, snapshot);
  } catch (err) {
    if (err instanceof IbkrSessionYieldError) {
      // DEFENSIVE, post-pivot (2026-07-21): fetchIbkrPortfolio no longer
      // calls openSession (it's sessionless — see its doc comment), so this
      // branch should be unreachable from a real invocation today. Kept
      // because an LST-mint failure is a DIFFERENT error class (network/auth,
      // not a session yield) and still needs to flow to the generic catch
      // below; this branch only guards against a future refactor that
      // reintroduces a session open on this path. setSyncError still must
      // run if it ever does fire: setSyncPhase above already flipped the
      // mutex to "syncing", and setSyncError is what releases it
      // (lib/tws/sync-state.ts sets status="error", which flips isSyncing()
      // back to false).
      console.log(
        "[ibkr] Web API refresh yielded to an active TWS session — skipping (TWS owns the session)",
      );
      setSyncError("IBKR Web API refresh skipped — yielded to an active TWS session");
      return null;
    }
    setSyncError(err instanceof Error ? err.message : "IBKR Web API refresh failed");
    throw err;
  }

  // Best-effort quote enrichment (IV / HV / 52wk range + watchlist price top-up
  // + held option/bond price-only tier). Never blocks the holdings refresh —
  // mirrors the TWS path's non-fatal steps.
  let quotePricesWritten = 0;
  setSyncPhase("prices");
  try {
    const lst = await openSession(cfg);
    const q = await fetchAndStoreQuotes(db, cfg, lst.token);
    quotePricesWritten = q.pricesWritten;
    console.log(
      `[ibkr] quote enrichment: ${q.securitiesUpdated} securities, ${q.pricesWritten} prices (${q.conidsRequested} conids)`,
    );
  } catch (err) {
    if (err instanceof IbkrSessionYieldError) {
      console.log("[ibkr] quote enrichment skipped — session yielded to TWS");
    } else {
      console.warn("[ibkr] quote enrichment failed (non-fatal):", err);
    }
  }

  // Level-scan cycle on the fresh prices (best-effort, mirrors Step 6).
  let alertsFired = 0;
  setSyncPhase("alerts");
  try {
    const scan = await runLevelScanCycle(db, {
      cronSecret: process.env.CRON_SHARED_SECRET,
      logPrefix: "[ibkr]",
    });
    alertsFired = scan.fired;
  } catch (err) {
    console.warn("[ibkr] level scan failed (non-fatal):", err);
  }

  setSyncComplete(
    {
      positionsSynced: result.positionsWritten,
      securitiesEnriched: 0,
      pricesUpdated: result.pricesWritten + quotePricesWritten,
      valuationsRecomputed: true,
      benchmarksSynced: 0,
      alertsFired,
      errors: [],
      durationMs: Date.now() - startTime,
    },
    "ibkr-webapi",
  );

  return result;
}

// ─── Quote enrichment (IV / HV / 52-week range via /iserver/marketdata/snapshot) ───

export type SnapshotFetcher = (
  cfg: IbkrOAuthConfig,
  lst: string,
  conids: number[],
) => Promise<ParsedQuote[]>;

export interface QuoteRefreshResult {
  conidsRequested: number;
  securitiesUpdated: number;
  pricesWritten: number;
}

/**
 * Fetch IBKR market-data snapshots for held + watchlist securities and cache the
 * IV / historic-vol / 52-week range in `security_quotes`. The snapshot's last
 * price is ALSO written to `prices` (source 'tws') — the "free byproduct" price
 * coverage, which uniquely reaches watchlist (non-held) names no other path
 * prices. DI-shaped: `opts.fetchSnapshot` lets tests inject parsed quotes.
 * Best-effort — the caller treats failures as non-fatal (like the TWS path).
 */
export async function fetchAndStoreQuotes(
  db: Database.Database,
  cfg: IbkrOAuthConfig,
  lst: string,
  opts: { asOfDate?: string; fetchSnapshot?: SnapshotFetcher; fetchYields?: YieldFetcher } = {},
): Promise<QuoteRefreshResult> {
  const asOf = opts.asOfDate ?? todayET();
  const fetchSnapshot: SnapshotFetcher =
    opts.fetchSnapshot ?? ((c, l, conids) => getMarketDataSnapshot(c, l, conids));
  const fetchYields: YieldFetcher = opts.fetchYields ?? fetchFinnhubDividendYields;

  const candidates = getQuoteCandidateConids(db);
  if (candidates.length === 0) {
    return { conidsRequested: 0, securitiesUpdated: 0, pricesWritten: 0 };
  }

  const candidateByConid = new Map(candidates.map((c) => [c.conid, c]));
  const conids = candidates.map((c) => c.conid);
  // Chunk the snapshot request — the price-only tier (held options + bonds,
  // R1b) roughly doubles the conid count; 80 per call is the batch size the
  // 2026-06-08 ship verified live (84 conids in one request).
  const SNAPSHOT_BATCH = 80;
  const quotes: ParsedQuote[] = [];
  for (let i = 0; i < conids.length; i += SNAPSHOT_BATCH) {
    quotes.push(...(await fetchSnapshot(cfg, lst, conids.slice(i, i + SNAPSHOT_BATCH))));
  }

  // Dividend yield — not exposed by the IBKR session (probe-verified
  // 2026-06-09); a small capped Finnhub batch fills/rotates it instead.
  // Best-effort: a fetcher failure must never block the quote write, and the
  // upsert's keep-last-known COALESCE preserves yields not in this batch.
  const yieldBySecurityId = new Map<number, number>();
  try {
    const yieldCandidates = getYieldRefreshCandidates(db);
    if (yieldCandidates.length > 0) {
      const yields = await fetchYields(yieldCandidates.map((c) => c.symbol));
      for (const c of yieldCandidates) {
        const y = yields[c.symbol.toUpperCase()];
        if (typeof y === "number") yieldBySecurityId.set(c.securityId, y);
      }
    }
  } catch (err) {
    console.warn(
      "[ibkr-refresh] dividend-yield fetch failed (quotes unaffected):",
      err instanceof Error ? err.message : err,
    );
  }

  const upsertPrice = db.prepare(
    `INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?,?,?,'tws')`,
  );

  // Trading-day guard, mirroring fetchSnapshotPrices: every consumer treats
  // the latest `prices` row per date as that date's close, so a weekend or
  // holiday date must never get a row (a stale last price stamped on a
  // non-trading day made the Today view's move pairing read 0.00% across the
  // board). The IV/HV/52wk quote cache below is dated metadata, not a close —
  // it still updates on any day.
  const isTradingDay = !isMarketClosed(asOf);

  let securitiesUpdated = 0;
  let pricesWritten = 0;
  db.transaction(() => {
    const pricePairs: { securityId: number; date: string }[] = [];
    for (const q of quotes) {
      if (q.conid == null) continue;
      const candidate = candidateByConid.get(q.conid);
      if (candidate == null) continue; // not a candidate we asked for
      const securityId = candidate.securityId;
      // Price-only tier (held options + bonds): the snapshot last keeps their
      // prices moving while TWS is down, but security_quotes stays an
      // equities-only IV/HV/52wk cache — never cache a quote row for them.
      if (!candidate.priceOnly) {
        upsertSecurityQuote(db, {
          securityId,
          asOfDate: asOf,
          ivUnderlying: q.ivUnderlying,
          hv30d: q.hv30d,
          week52High: q.week52High,
          week52Low: q.week52Low,
          // Finnhub batch when selected this run; null otherwise — the
          // upsert's COALESCE keeps the last-known value.
          dividendYield: yieldBySecurityId.get(securityId) ?? null,
        });
        securitiesUpdated++;
      }
      if (isTradingDay && q.last != null && q.last > 0) {
        upsertPrice.run(securityId, asOf, q.last);
        pricesWritten++;
        pricePairs.push({ securityId, date: asOf });
      }
    }
    // This function never writes to `holdings` — a bump here is entirely
    // explained by the price path (spec §4).
    bumpIfPricesAffectSyntheticCloses(db, pricePairs);
  })();

  return { conidsRequested: conids.length, securitiesUpdated, pricesWritten };
}
