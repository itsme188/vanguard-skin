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
import { loadIbkrConfig } from "./config";
import {
  openSession,
  getPortfolioAccounts,
  getPositions,
  getLedger,
} from "./web-api";
import { mapPosition, type MappedPosition } from "./map-positions";
import type { IbkrOAuthConfig } from "./oauth-client";

const DB_ACCOUNT_NAME = "IBKR";

export interface IbkrPortfolioSnapshot {
  accountCode: string;
  positions: MappedPosition[];
  netLiq: number | null;
  cash: number | null;
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

  return { accountCode, positions, netLiq, cash };
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
      });
      if (m.conid != null) updateConId.run(m.conid, securityId);
      upsertHolding.run(accountId, securityId, m.quantity, m.costBasis, today, `tws-${accountId}-${securityId}-${today}`);
      positionsWritten++;
      if (m.mktPrice != null && m.mktPrice > 0) {
        upsertPrice.run(securityId, today, m.mktPrice);
        pricesWritten++;
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
  return writeIbkrHoldings(db, snapshot);
}
