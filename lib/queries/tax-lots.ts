import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import {
  isPendingStatementLot,
  pendingStatementKey,
  pendingStatementKeySet,
} from "@/lib/queries/pending-statement";

export interface TaxLotWithSecurity {
  is_short: number;
  id: number;
  account_id: number;
  account_name: string;
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  /**
   * The contract multiplier (`COALESCE(s.multiplier, 1)`). Display only: it
   * names the unit of `acquisition_price` on an option row ("× 100 per
   * contract"). No figure is derived from it here.
   */
  multiplier?: number;
  expiration_date: string | null;
  acquisition_date: string;
  acquisition_price: number;
  quantity_acquired: number;
  quantity_remaining: number;
  cost_basis: number;
  adjusted_cost_basis: number;
  current_price: number | null;
  current_value: number | null;
  unrealized_gain: number | null;
  is_from_opening_snapshot: number;
  /**
   * The lot belongs to a position closed per LIVE data whose broker
   * statement has not arrived (lib/queries/pending-statement.ts). The
   * position is no longer held, so `current_value` / `unrealized_gain` are
   * null and every unrealized total excludes the lot; it stays listed (with
   * a "pending statement" chip) because it is still open in the ledger.
   */
  pending_statement: boolean;
  currency_conversion: boolean;
  expired_option: boolean;
}

export interface TaxLotSaleWithDetails {
  id: number;
  account_name: string;
  account_id: number;
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  acquisition_date: string;
  sale_date: string;
  quantity_sold: number;
  acquisition_price: number;
  sale_price: number;
  proceeds: number;
  proceeds_usd: number;
  cost_basis_allocated: number;
  cost_basis_allocated_usd: number;
  realized_gain_loss: number;
  realized_gain_loss_usd: number;
  is_long_term: number;
  holding_period_days: number;
  currency: string;
  /** 1 for a short round-trip lot (SELL_TO_OPEN → cover); see lib/compute/tax-lots.ts. */
  is_short: number;
  /**
   * True when the sale transaction is the engine-owned synthetic
   * RECONCILE_CLOSE row (never real broker activity — computeTaxLots
   * synthesizes it to close a lot the broker's own snapshot shows zeroed
   * with no matching statement SELL). Already excluded from filing
   * surfaces (`filingOnly`); operational P&L surfaces that still show
   * these rows must label the realized figure "estimated" rather than
   * hide it (finding 1, number-trust durable fixes).
   */
  is_synthetic_close: boolean;
  currency_conversion: boolean;
}

/**
 * How much of a realized bucket comes from engine-synthesized
 * `RECONCILE_CLOSE` sales rather than real broker activity.
 *
 * Per the "disclose, never exclude" ruling (QA finding
 * tax-lots--headline-tiles-include-reconcile-close-engine-rows), the headline
 * tiles KEEP those rows — the economic view is deliberately whole — but must
 * SAY how much of each figure is engine-estimated, because the TAX REPORT
 * card and the 8949 exports on the same page drop them (`filingOnly`) and the
 * two numbers otherwise disagree on one screen with nothing explaining it.
 *
 * Conventions, mirroring the fields these sit beside:
 * - the `…Gain` sums are USD-only (`USD_ONLY`), exactly like
 *   `totalRealizedGain` / `longTermGain` / `shortTermGain`;
 * - the `…Sales` counts cover every currency, exactly like
 *   `totalClosedSales` (the non-USD exclusion carries its own disclosure via
 *   `excludedNonUsdSales`).
 *
 * Premium-rollover rows are deliberately NOT counted here. `filingOnly` drops
 * those too, but they are zero-gain BY CONSTRUCTION in `computeTaxLots`
 * (proceeds is forced equal to cost_basis_allocated), so they move no tile
 * figure — and calling them "engine-estimated closes" would name a count the
 * user cannot reconcile to the "Estimated" chips in the Closed Sales table.
 */
export interface EngineEstimatedDisclosure {
  /** RECONCILE_CLOSE-sourced sales in the window (all currencies). */
  engineEstimatedSales: number;
  /** USD realized gain contributed by those sales. */
  engineEstimatedGain: number;
  engineEstimatedLongTermSales: number;
  engineEstimatedLongTermGain: number;
  engineEstimatedShortTermSales: number;
  engineEstimatedShortTermGain: number;
}

/**
 * Positions closed per live data, awaiting the broker statement
 * (lib/queries/pending-statement.ts). Their lots are excluded from
 * `totalUnrealizedGain` and disclosed separately with these figures.
 */
export interface PendingStatementDisclosure {
  /** Distinct (account, security) pairs pending a statement. */
  pendingStatementPositions: number;
  /** Open lots belonging to those pairs (counted in totalOpenLots too). */
  pendingStatementLots: number;
  /** Still-open USD basis of those lots. */
  pendingStatementBasis: number;
}

export interface TaxLotSummary extends EngineEstimatedDisclosure, PendingStatementDisclosure {
  /** Every open lot, pending-statement lots included (matches the Open Lots table). */
  totalOpenLots: number;
  totalClosedSales: number;
  /** Excludes pending-statement lots — those positions are no longer held. */
  totalUnrealizedGain: number;
  totalRealizedGain: number;
  longTermGain: number;
  shortTermGain: number;
  /** Sales on non-USD securities excluded from the USD realized totals above (never fabricate an FX vintage on tax rows). */
  excludedNonUsdSales: number;
  /** Forex conversion lots kept in the ledger but excluded from capital open-lot counts. */
  currencyConversionOpenLots?: number;
  /** Expired option contracts kept open in the ledger, awaiting real broker closing entries. */
  expiredOptionLotsAwaitingClose?: number;
}

export interface AccountTaxSummary extends EngineEstimatedDisclosure {
  account_id: number;
  account_name: string;
  totalClosedSales: number;
  totalRealizedGain: number;
  longTermGain: number;
  shortTermGain: number;
  excludedNonUsdSales: number;
}

/** Realized G/L is stored native per security; only USD rows may sum into USD totals. */
export const USD_ONLY = `COALESCE(s.currency, 'USD') = 'USD'`;
export const CURRENCY_CONVERSION_SECURITY_SQL = `LOWER(TRIM(COALESCE(s.security_type, ''))) = 'forex'`;

export function isCurrencyConversionSecurityType(securityType: string | null | undefined): boolean {
  return (securityType ?? "").trim().toLowerCase() === "forex";
}

export function isCurrencyConversionTaxLot(
  row: Pick<TaxLotWithSecurity | TaxLotSaleWithDetails, "security_type" | "currency_conversion">
): boolean {
  return row.currency_conversion || isCurrencyConversionSecurityType(row.security_type);
}

/**
 * The engine-owned reconciliation close. Written exactly as
 * `getClosedTaxLotSales`'s `filingOnly` predicate does, off the SAME
 * `transactions` join, so the tiles' disclosure and the filing surface can
 * never drift apart on what counts as engine-estimated.
 */
const ENGINE_ESTIMATED = `t.type = 'RECONCILE_CLOSE'`;

/**
 * The six `EngineEstimatedDisclosure` columns. Requires `tls`, `s` and a
 * `JOIN transactions t ON t.id = tls.sale_transaction_id` in scope.
 * `sale_transaction_id` is NOT NULL with an FK to `transactions`, so the join
 * is row-preserving — the surrounding COUNT(*) totals are unaffected.
 */
const ENGINE_ESTIMATED_COLUMNS = `
        COALESCE(SUM(CASE WHEN ${ENGINE_ESTIMATED} THEN 1 ELSE 0 END), 0) AS engineEstimatedSales,
        COALESCE(SUM(CASE WHEN ${ENGINE_ESTIMATED} AND ${USD_ONLY} THEN tls.realized_gain_loss ELSE 0 END), 0) AS engineEstimatedGain,
        COALESCE(SUM(CASE WHEN ${ENGINE_ESTIMATED} AND tls.is_long_term = 1 THEN 1 ELSE 0 END), 0) AS engineEstimatedLongTermSales,
        COALESCE(SUM(CASE WHEN ${ENGINE_ESTIMATED} AND ${USD_ONLY} AND tls.is_long_term = 1 THEN tls.realized_gain_loss ELSE 0 END), 0) AS engineEstimatedLongTermGain,
        COALESCE(SUM(CASE WHEN ${ENGINE_ESTIMATED} AND tls.is_long_term = 0 THEN 1 ELSE 0 END), 0) AS engineEstimatedShortTermSales,
        COALESCE(SUM(CASE WHEN ${ENGINE_ESTIMATED} AND ${USD_ONLY} AND tls.is_long_term = 0 THEN tls.realized_gain_loss ELSE 0 END), 0) AS engineEstimatedShortTermGain`;

/**
 * The basis of the quantity STILL OPEN in a lot, in USD, as a SQL fragment:
 * the lot's fee-inclusive cost_basis prorated by remaining / acquired, times
 * the FX factor. Requires `tax_lots tl` and `LEFT JOIN fx_rates fx` in scope.
 * The one copy: the Tax Lots reads here, the chat tax-lot tool
 * (lib/queries/chat-tools.ts) and the chat summary
 * (lib/queries/portfolio-summary.ts) all measure an open lot's unrealized
 * figure against it. Never rebuild it from quantity x acquisition_price: that
 * drops the fees the engine capitalized into the lot.
 */
export function remainingLotBasisSql(): string {
  return "(CASE WHEN tl.quantity_acquired != 0 THEN tl.cost_basis * tl.quantity_remaining / tl.quantity_acquired ELSE 0 END) * COALESCE(fx.usd_per_unit, 1)";
}

/**
 * The side sign of an open lot, as a SQL fragment: -1 for a short lot, +1 for
 * a long one. A short lot stores a POSITIVE quantity_remaining (is_short is
 * the flag) and gains when the price FALLS, so every unrealized figure is
 * `sign * (current value - opening value)`. The one copy: the Tax Lots reads
 * here, the chat summary (lib/queries/portfolio-summary.ts) and the chat
 * tax-lot tool (lib/queries/chat-tools.ts) all multiply by it.
 */
export function lotSideSignSql(alias: string): string {
  return `(CASE WHEN ${alias}.is_short=1 THEN -1 ELSE 1 END)`;
}

export interface TaxLotReadOptions {
  today?: string;
}

function openLotRows(
  db: Database.Database,
  securityId: number | undefined,
  opts: TaxLotReadOptions | undefined,
  extraWhere: string
): Omit<TaxLotWithSecurity, "pending_statement" | "currency_conversion" | "expired_option">[] {
  const rows = db
    .prepare(
      `SELECT
        tl.id, tl.account_id, a.name AS account_name, tl.is_short,
        tl.security_id, s.symbol, s.name AS security_name,
        s.security_type, COALESCE(s.multiplier, 1) AS multiplier, s.expiration_date,
        tl.acquisition_date, tl.acquisition_price,
        tl.quantity_acquired, tl.quantity_remaining,
        tl.cost_basis * COALESCE(fx.usd_per_unit, 1) AS cost_basis, tl.is_from_opening_snapshot,
        ${remainingLotBasisSql()} AS adjusted_cost_basis,
        p.close_price AS current_price,
        CASE WHEN p.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          ELSE NULL END AS current_value,
        CASE WHEN p.close_price IS NOT NULL
          THEN ${lotSideSignSql("tl")} * (${adjustedMarketValueSQL("tl.quantity_remaining", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
               - ${remainingLotBasisSql()})
          ELSE NULL END AS unrealized_gain
      FROM tax_lots tl
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN prices p ON p.security_id = tl.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = tl.security_id)
      WHERE tl.quantity_remaining > 0 AND (? IS NULL OR tl.security_id = ?)
        ${extraWhere}
      ORDER BY a.name, s.symbol, tl.acquisition_date`
    )
    .all(securityId ?? null, securityId ?? null) as Omit<
    TaxLotWithSecurity,
    "pending_statement" | "currency_conversion" | "expired_option"
  >[];
  return rows;
}

function decorateOpenLots(
  db: Database.Database,
  rows: Omit<TaxLotWithSecurity, "pending_statement" | "currency_conversion" | "expired_option">[],
  expiredOption: boolean
): TaxLotWithSecurity[] {
  const pendingKeys = pendingStatementKeySet(db);
  return rows.map((lot) =>
    isPendingStatementLot(pendingKeys, lot)
      ? {
          ...lot,
          current_value: null,
          unrealized_gain: null,
          pending_statement: true,
          currency_conversion: isCurrencyConversionSecurityType(lot.security_type),
          expired_option: expiredOption,
        }
      : {
          ...lot,
          pending_statement: false,
          currency_conversion: isCurrencyConversionSecurityType(lot.security_type),
          expired_option: expiredOption,
        }
  );
}

export function getOpenTaxLots(
  db: Database.Database,
  securityId?: number,
  opts?: TaxLotReadOptions
): TaxLotWithSecurity[] {
  const rows = openLotRows(
    db,
    securityId,
    opts,
    `AND ${liveOptionExpirationSql("s", opts?.today)}`
  );
  return decorateOpenLots(db, rows, false);
}

export function getExpiredOptionLotsAwaitingClose(
  db: Database.Database,
  opts?: TaxLotReadOptions & { securityId?: number }
): TaxLotWithSecurity[] {
  const rows = openLotRows(
    db,
    opts?.securityId,
    opts,
    `AND NOT (${liveOptionExpirationSql("s", opts?.today)})`
  );
  return decorateOpenLots(db, rows, true);
}

export function getClosedTaxLotSales(
  db: Database.Database,
  year?: number,
  opts?: { filingOnly?: boolean; accountName?: string }
): TaxLotSaleWithDetails[] {
  const hasFxRates =
    (db
      .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'fx_rates'")
      .get() as { hit?: number } | undefined) != null;
  const fxFactor = hasFxRates ? "COALESCE(fx.usd_per_unit, 1)" : "1";
  const fxJoin = hasFxRates ? "LEFT JOIN fx_rates fx ON fx.currency = s.currency" : "";
  const baseSql = `SELECT
        tls.id, a.name AS account_name, tl.account_id, tl.security_id, tl.is_short,
        s.symbol, s.name AS security_name, s.security_type,
        tl.acquisition_date, tls.sale_date,
        tls.quantity_sold, tl.acquisition_price,
        tls.sale_price, tls.proceeds,
        tls.proceeds * ${fxFactor} AS proceeds_usd,
        tls.cost_basis_allocated, tls.realized_gain_loss,
        tls.cost_basis_allocated * ${fxFactor} AS cost_basis_allocated_usd,
        tls.realized_gain_loss * ${fxFactor} AS realized_gain_loss_usd,
        tls.is_long_term, tls.holding_period_days,
        COALESCE(s.currency, 'USD') AS currency,
        (t.type = 'RECONCILE_CLOSE') AS is_synthetic_close,
        (${CURRENCY_CONVERSION_SECURITY_SQL}) AS currency_conversion
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      JOIN transactions t ON t.id = tls.sale_transaction_id
      ${fxJoin}`;

  // filingOnly (Task 6 dependency): exclude premium-rollover closes (option
  // premium that moved to the underlying leg — not a separate disposition,
  // IRS Pub 550) and engine-synthesized RECONCILE_CLOSE sales (never real
  // broker activity) from anything destined for a filing surface.
  const conditions: string[] = [];
  const params: string[] = [];
  if (year) {
    conditions.push("tls.sale_date >= ? AND tls.sale_date <= ?");
    params.push(`${year}-01-01`, `${year}-12-31`);
  }
  if (opts?.accountName) {
    conditions.push("a.name = ?");
    params.push(opts.accountName);
  }
  if (opts?.filingOnly) {
    conditions.push("tls.premium_rollover = 0 AND t.type != 'RECONCILE_CLOSE'");
    conditions.push(`NOT (${CURRENCY_CONVERSION_SECURITY_SQL})`);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .prepare(`${baseSql} ${whereClause} ORDER BY tls.sale_date DESC, s.symbol`)
    .all(...params) as Array<
    Omit<TaxLotSaleWithDetails, "is_synthetic_close" | "currency_conversion"> & {
      is_synthetic_close: number;
      currency_conversion: number;
    }
  >;
  return rows.map((r) => ({
    ...r,
    is_synthetic_close: Boolean(r.is_synthetic_close),
    currency_conversion: Boolean(r.currency_conversion),
  }));
}

export function getTaxLotSummary(
  db: Database.Database,
  year?: number,
  opts?: TaxLotReadOptions
): TaxLotSummary {
  // Per (account, security, side) so pending-statement pairs can be split
  // out of the unrealized total by the shared read model — never re-derived
  // here. Short lots are their own row: a pending pair is long-only.
  const openGroups = db
    .prepare(
      `SELECT
        tl.account_id, tl.security_id, tl.is_short,
        COUNT(*) AS lots,
        COALESCE(SUM(${remainingLotBasisSql()}), 0) AS basis,
        COALESCE(SUM(
          CASE WHEN p.close_price IS NOT NULL
            THEN ${lotSideSignSql("tl")} * (${adjustedMarketValueSQL("tl.quantity_remaining", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
                 - ${remainingLotBasisSql()})
            ELSE 0 END
        ), 0) AS unrealized
      FROM tax_lots tl
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN prices p ON p.security_id = tl.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = tl.security_id)
      WHERE tl.quantity_remaining > 0
        AND NOT (${CURRENCY_CONVERSION_SECURITY_SQL})
        AND ${liveOptionExpirationSql("s", opts?.today)}
      GROUP BY tl.account_id, tl.security_id, tl.is_short`
    )
    .all() as Array<{
    account_id: number;
    security_id: number;
    is_short: number;
    lots: number;
    basis: number;
    unrealized: number;
  }>;
  const pendingKeys = pendingStatementKeySet(db);
  const openLots = {
    totalOpenLots: 0,
    totalUnrealizedGain: 0,
    pendingStatementPositions: 0,
    pendingStatementLots: 0,
    pendingStatementBasis: 0,
  };
  const pendingPairs = new Set<string>();
  for (const g of openGroups) {
    openLots.totalOpenLots += g.lots;
    if (isPendingStatementLot(pendingKeys, g)) {
      pendingPairs.add(pendingStatementKey(g));
      openLots.pendingStatementLots += g.lots;
      openLots.pendingStatementBasis += g.basis;
    } else {
      openLots.totalUnrealizedGain += g.unrealized;
    }
  }
  openLots.pendingStatementPositions = pendingPairs.size;

  const currencyConversionOpenLots = (
    db.prepare(
      `SELECT COUNT(*) AS count
       FROM tax_lots tl
       JOIN securities s ON s.id = tl.security_id
       WHERE tl.quantity_remaining > 0
         AND ${CURRENCY_CONVERSION_SECURITY_SQL}`
    ).get() as { count: number }
  ).count;

  const expiredOptionLotsAwaitingClose = (
    db.prepare(
      `SELECT COUNT(*) AS count
       FROM tax_lots tl
       JOIN securities s ON s.id = tl.security_id
       WHERE tl.quantity_remaining > 0
         AND NOT (${liveOptionExpirationSql("s", opts?.today)})`
    ).get() as { count: number }
  ).count;

  const closedSalesSql = `SELECT
        COUNT(*) AS totalClosedSales,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} THEN tls.realized_gain_loss ELSE 0 END), 0) AS totalRealizedGain,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND tls.is_long_term = 1 THEN tls.realized_gain_loss ELSE 0 END), 0) AS longTermGain,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND tls.is_long_term = 0 THEN tls.realized_gain_loss ELSE 0 END), 0) AS shortTermGain,
        COALESCE(SUM(CASE WHEN NOT (${USD_ONLY}) THEN 1 ELSE 0 END), 0) AS excludedNonUsdSales,
        ${ENGINE_ESTIMATED_COLUMNS.trim()}
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN securities s ON s.id = tl.security_id
      JOIN transactions t ON t.id = tls.sale_transaction_id
      WHERE NOT (${CURRENCY_CONVERSION_SECURITY_SQL})`;

  const closedSales = (year
    ? db.prepare(`${closedSalesSql} AND tls.sale_date >= ? AND tls.sale_date <= ?`).get(`${year}-01-01`, `${year}-12-31`)
    : db.prepare(closedSalesSql).get()
  ) as EngineEstimatedDisclosure & {
      totalClosedSales: number;
      totalRealizedGain: number;
      longTermGain: number;
      shortTermGain: number;
      excludedNonUsdSales: number;
    };

  return {
    totalOpenLots: openLots.totalOpenLots,
    totalClosedSales: closedSales.totalClosedSales,
    totalUnrealizedGain: openLots.totalUnrealizedGain,
    pendingStatementPositions: openLots.pendingStatementPositions,
    pendingStatementLots: openLots.pendingStatementLots,
    pendingStatementBasis: openLots.pendingStatementBasis,
    totalRealizedGain: closedSales.totalRealizedGain,
    longTermGain: closedSales.longTermGain,
    shortTermGain: closedSales.shortTermGain,
    excludedNonUsdSales: closedSales.excludedNonUsdSales,
    currencyConversionOpenLots,
    expiredOptionLotsAwaitingClose,
    engineEstimatedSales: closedSales.engineEstimatedSales,
    engineEstimatedGain: closedSales.engineEstimatedGain,
    engineEstimatedLongTermSales: closedSales.engineEstimatedLongTermSales,
    engineEstimatedLongTermGain: closedSales.engineEstimatedLongTermGain,
    engineEstimatedShortTermSales: closedSales.engineEstimatedShortTermSales,
    engineEstimatedShortTermGain: closedSales.engineEstimatedShortTermGain,
  };
}

export function getTaxLotSummaryByAccount(
  db: Database.Database,
  year: number
): AccountTaxSummary[] {
  return db
    .prepare(
      `SELECT
        tl.account_id,
        a.name AS account_name,
        COUNT(*) AS totalClosedSales,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} THEN tls.realized_gain_loss ELSE 0 END), 0) AS totalRealizedGain,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND tls.is_long_term = 1 THEN tls.realized_gain_loss ELSE 0 END), 0) AS longTermGain,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND tls.is_long_term = 0 THEN tls.realized_gain_loss ELSE 0 END), 0) AS shortTermGain,
        COALESCE(SUM(CASE WHEN NOT (${USD_ONLY}) THEN 1 ELSE 0 END), 0) AS excludedNonUsdSales,
        ${ENGINE_ESTIMATED_COLUMNS.trim()}
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      JOIN transactions t ON t.id = tls.sale_transaction_id
      WHERE tls.sale_date >= ? AND tls.sale_date <= ?
        AND NOT (${CURRENCY_CONVERSION_SECURITY_SQL})
      GROUP BY tl.account_id
      ORDER BY a.name`
    )
    .all(`${year}-01-01`, `${year}-12-31`) as AccountTaxSummary[];
}

export function getTaxLotAccountNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.name
      FROM accounts a
      JOIN tax_lots tl ON tl.account_id = a.id
      ORDER BY a.name`
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function getAvailableSaleYears(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT CAST(strftime('%Y', sale_date) AS INTEGER) AS year
      FROM tax_lot_sales
      ORDER BY year DESC`
    )
    .all() as { year: number }[];
  return rows.map((r) => r.year);
}
