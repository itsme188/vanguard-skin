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
import { upsertFxRate } from "../mutations/fx-rates";
import { loadIbkrConfig } from "./config";
import {
  openSession,
  getPortfolioAccounts,
  getPositions,
  getLedger,
} from "./web-api";
import { mapPosition, extractLedgerFxRates, type MappedPosition } from "./map-positions";
import type { IbkrOAuthConfig } from "./oauth-client";
import { getMarketDataSnapshot, type ParsedQuote } from "./market-data";
import { getQuoteCandidateConids } from "../queries/security-quotes";
import { upsertSecurityQuote } from "../mutations/security-quotes";
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

/** Network: open a session and pull live positions + cost basis + account values. */
export async function fetchIbkrPortfolio(
  cfg: IbkrOAuthConfig,
): Promise<IbkrPortfolioSnapshot> {
  const lst = await openSession(cfg);
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
      if (m.mktPrice != null && m.mktPrice > 0) {
        upsertPrice.run(securityId, today, m.mktPrice);
        pricesWritten++;
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
 * configured (so callers degrade gracefully, like the TWS path does).
 */
export async function refreshIbkrHoldingsFromWebApi(
  db: Database.Database,
  cfg: IbkrOAuthConfig | null = loadIbkrConfig(),
): Promise<IbkrWriteResult | null> {
  if (!cfg) return null;
  const snapshot = await fetchIbkrPortfolio(cfg);
  const result = writeIbkrHoldings(db, snapshot);

  // Best-effort quote enrichment (IV / HV / 52wk range + watchlist price top-up).
  // Never blocks the holdings refresh — mirrors the TWS path's non-fatal steps.
  try {
    const lst = await openSession(cfg);
    const q = await fetchAndStoreQuotes(db, cfg, lst.token);
    console.log(
      `[ibkr] quote enrichment: ${q.securitiesUpdated} securities, ${q.pricesWritten} prices (${q.conidsRequested} conids)`,
    );
  } catch (err) {
    console.warn("[ibkr] quote enrichment failed (non-fatal):", err);
  }

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

  const securityIdByConid = new Map(candidates.map((c) => [c.conid, c.securityId]));
  const conids = candidates.map((c) => c.conid);
  const quotes = await fetchSnapshot(cfg, lst, conids);

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

  let securitiesUpdated = 0;
  let pricesWritten = 0;
  db.transaction(() => {
    for (const q of quotes) {
      if (q.conid == null) continue;
      const securityId = securityIdByConid.get(q.conid);
      if (securityId == null) continue; // not a candidate we asked for
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
      if (q.last != null && q.last > 0) {
        upsertPrice.run(securityId, asOf, q.last);
        pricesWritten++;
      }
    }
  })();

  return { conidsRequested: conids.length, securitiesUpdated, pricesWritten };
}
