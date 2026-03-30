/**
 * Option-specific database queries.
 *
 * Provides read-only access to option positions, P&L, expirations,
 * and underlying groupings for the options analytics features.
 */

import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";

// ─── Types ──────────────────────────────────────────────────────

export interface OptionPosition {
  securityId: number;
  symbol: string;
  name: string | null;
  underlying: string;
  optionType: "CALL" | "PUT";
  strike: number;
  expiration: string;
  quantity: number;
  multiplier: number;
  costBasis: number | null;
  currentPrice: number | null;
  underlyingPrice: number | null;
  accountId: number;
  accountName: string;
  marketValue: number | null;
  unrealizedPnl: number | null;
}

export interface OptionsByUnderlying {
  underlying: string;
  underlyingSecurityId: number | null;
  underlyingPrice: number | null;
  positions: OptionPosition[];
  totalDelta?: number;
}

export interface ExpiringOption {
  securityId: number;
  symbol: string;
  underlying: string;
  optionType: "CALL" | "PUT";
  strike: number;
  expiration: string;
  daysToExpiry: number;
  quantity: number;
  accountName: string;
}

export interface ClosedOptionTrade {
  symbol: string;
  underlying: string;
  optionType: string;
  strike: number;
  expiration: string;
  quantitySold: number;
  costBasis: number;
  proceeds: number;
  realizedGain: number;
  isLongTerm: boolean;
  saleDate: string;
  holdingDays: number;
}

export interface OptionsPnL {
  openPositions: OptionPosition[];
  closedTrades: ClosedOptionTrade[];
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
}

// ─── Queries ────────────────────────────────────────────────────

/**
 * Get all current option positions with underlying prices.
 */
export function getOptionPositions(
  db: Database.Database,
  accountId?: number
): OptionPosition[] {
  const accountFilter = accountId ? "AND h.account_id = ?" : "";
  const params: (string | number)[] = [];
  if (accountId) params.push(accountId);

  const rows = db
    .prepare(
      `SELECT
        s.id AS security_id,
        s.symbol,
        s.name,
        s.underlying_symbol,
        s.option_type,
        s.strike_price,
        s.expiration_date,
        COALESCE(s.multiplier, 1) AS multiplier,
        h.quantity,
        h.cost_basis,
        h.account_id,
        a.name AS account_name,
        (SELECT p.close FROM prices p
         WHERE p.security_id = s.id
         ORDER BY p.price_date DESC LIMIT 1) AS current_price,
        (SELECT p.close FROM prices p
         JOIN securities su ON su.id = p.security_id
         WHERE su.symbol = s.underlying_symbol
         ORDER BY p.price_date DESC LIMIT 1) AS underlying_price
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
       WHERE s.security_type = 'option'
         AND s.strike_price IS NOT NULL
         AND s.expiration_date IS NOT NULL
         AND s.option_type IS NOT NULL
         AND s.underlying_symbol IS NOT NULL
         AND h.as_of_date = (
           SELECT MAX(h2.as_of_date) FROM holdings h2
         )
         ${accountFilter}
       ORDER BY s.underlying_symbol, s.expiration_date, s.strike_price`
    )
    .all(...params) as Array<{
    security_id: number;
    symbol: string;
    name: string | null;
    underlying_symbol: string;
    option_type: string;
    strike_price: number;
    expiration_date: string;
    multiplier: number;
    quantity: number;
    cost_basis: number | null;
    account_id: number;
    account_name: string;
    current_price: number | null;
    underlying_price: number | null;
  }>;

  return rows.map((r) => {
    const mv =
      r.current_price != null
        ? r.quantity * r.current_price * r.multiplier
        : null;
    return {
      securityId: r.security_id,
      symbol: r.symbol,
      name: r.name,
      underlying: r.underlying_symbol,
      optionType: r.option_type.toUpperCase() as "CALL" | "PUT",
      strike: r.strike_price,
      expiration: r.expiration_date,
      quantity: r.quantity,
      multiplier: r.multiplier,
      costBasis: r.cost_basis,
      currentPrice: r.current_price,
      underlyingPrice: r.underlying_price,
      accountId: r.account_id,
      accountName: r.account_name,
      marketValue: mv,
      unrealizedPnl: mv != null && r.cost_basis != null ? mv - r.cost_basis : null,
    };
  });
}

/**
 * Group option positions by underlying symbol.
 */
export function getOptionsByUnderlying(
  db: Database.Database,
  accountId?: number
): OptionsByUnderlying[] {
  const positions = getOptionPositions(db, accountId);
  const groups = new Map<string, OptionsByUnderlying>();

  for (const pos of positions) {
    let group = groups.get(pos.underlying);
    if (!group) {
      // Look up underlying security ID
      const underlying = db
        .prepare(
          "SELECT id FROM securities WHERE symbol = ? AND security_type != 'option' LIMIT 1"
        )
        .get(pos.underlying) as { id: number } | undefined;

      group = {
        underlying: pos.underlying,
        underlyingSecurityId: underlying?.id ?? null,
        underlyingPrice: pos.underlyingPrice,
        positions: [],
      };
      groups.set(pos.underlying, group);
    }
    group.positions.push(pos);
  }

  return Array.from(groups.values()).sort((a, b) =>
    a.underlying.localeCompare(b.underlying)
  );
}

/**
 * Get options expiring within N days.
 */
export function getExpiringOptions(
  db: Database.Database,
  daysAhead: number = 30,
  accountId?: number
): ExpiringOption[] {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(
    Date.now() + daysAhead * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);

  const accountFilter = accountId ? "AND h.account_id = ?" : "";
  const params: (string | string | number)[] = [today, cutoff];
  if (accountId) params.push(accountId);

  const rows = db
    .prepare(
      `SELECT
        s.id AS security_id,
        s.symbol,
        s.underlying_symbol,
        s.option_type,
        s.strike_price,
        s.expiration_date,
        h.quantity,
        a.name AS account_name
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
       WHERE s.security_type = 'option'
         AND s.expiration_date >= ?
         AND s.expiration_date <= ?
         AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2)
         ${accountFilter}
       ORDER BY s.expiration_date, s.underlying_symbol`
    )
    .all(...params) as Array<{
    security_id: number;
    symbol: string;
    underlying_symbol: string;
    option_type: string;
    strike_price: number;
    expiration_date: string;
    quantity: number;
    account_name: string;
  }>;

  return rows.map((r) => ({
    securityId: r.security_id,
    symbol: r.symbol,
    underlying: r.underlying_symbol,
    optionType: r.option_type.toUpperCase() as "CALL" | "PUT",
    strike: r.strike_price,
    expiration: r.expiration_date,
    daysToExpiry: daysBetween(today, r.expiration_date),
    quantity: r.quantity,
    accountName: r.account_name,
  }));
}

/**
 * Get options P&L: open positions (unrealized) + closed trades (realized).
 */
export function getOptionsPnL(
  db: Database.Database,
  accountId?: number
): OptionsPnL {
  const openPositions = getOptionPositions(db, accountId);

  const accountFilter = accountId ? "AND tl.account_id = ?" : "";
  const params: number[] = [];
  if (accountId) params.push(accountId);

  const closedRows = db
    .prepare(
      `SELECT
        s.symbol,
        s.underlying_symbol,
        s.option_type,
        s.strike_price,
        s.expiration_date,
        tls.quantity_sold,
        tls.cost_basis_allocated,
        tls.proceeds,
        tls.realized_gain_loss,
        tls.is_long_term,
        tls.sale_date,
        tls.holding_period_days
       FROM tax_lot_sales tls
       JOIN tax_lots tl ON tl.id = tls.tax_lot_id
       JOIN securities s ON s.id = tl.security_id
       WHERE s.security_type = 'option'
         ${accountFilter}
       ORDER BY tls.sale_date DESC`
    )
    .all(...params) as Array<{
    symbol: string;
    underlying_symbol: string;
    option_type: string;
    strike_price: number;
    expiration_date: string;
    quantity_sold: number;
    cost_basis_allocated: number;
    proceeds: number;
    realized_gain_loss: number;
    is_long_term: number;
    sale_date: string;
    holding_period_days: number;
  }>;

  const closedTrades: ClosedOptionTrade[] = closedRows.map((r) => ({
    symbol: r.symbol,
    underlying: r.underlying_symbol,
    optionType: r.option_type,
    strike: r.strike_price,
    expiration: r.expiration_date,
    quantitySold: r.quantity_sold,
    costBasis: r.cost_basis_allocated,
    proceeds: r.proceeds,
    realizedGain: r.realized_gain_loss,
    isLongTerm: r.is_long_term === 1,
    saleDate: r.sale_date,
    holdingDays: r.holding_period_days,
  }));

  const totalUnrealizedPnl = openPositions.reduce(
    (sum, p) => sum + (p.unrealizedPnl ?? 0),
    0
  );
  const totalRealizedPnl = closedTrades.reduce(
    (sum, t) => sum + t.realizedGain,
    0
  );

  return {
    openPositions,
    closedTrades,
    totalUnrealizedPnl,
    totalRealizedPnl,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
