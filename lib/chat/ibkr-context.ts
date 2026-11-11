import type Database from "better-sqlite3";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { getHoldingsForChat, getTransactionsForChat } from "@/lib/queries/chat-tools";
import { getAccountCashLine } from "@/lib/queries/account-cash-line";
import { computeFactorAnalysis } from "@/lib/compute/factors";

// ─── Types ──────────────────────────────────────────────────────

export interface IbkrTradingContext {
  /** Signed: negative when the account borrows (cash below zero). */
  cashPct: number;
  /** The account's own cash line (US dollars); may be negative. 0 when `cashSource` is "none". */
  estimatedCash: number;
  accountTotal: number;
  portfolioBeta: number | null;
  bullishnessScore: number; // 1-5
  activePositionCount: number;
  sectorTilts: { sector: string; weight: number }[];
  repeatNames: { symbol: string; tradeCount: number; lastTraded: string }[];
  avgHoldingDays: number | null;
  recentTrades: { date: string; symbol: string; type: string; amount: number }[];
  longShortSummary: string;
  // Cash provenance (plan Contract E / P12), from getAccountCashLine.
  /** The day the cash figure was measured (the measured day when carried). */
  cashAsOf: string | null;
  cashSource: "daily_valuation" | "none";
  cashCarried: boolean;
  /** Live anchor on the valuation day. */
  cashTimingResidual: boolean;
  cashPriceDateMismatch: boolean;
  accountTotalAsOf: string | null;
  /** True when the cash figure cannot carry a stance: none, carried, a timing residual or a price-date mismatch. */
  stanceWithheld: boolean;
}

// ─── Bullishness Scoring ────────────────────────────────────────

export function computeBullishness(cashPct: number, beta: number | null): number {
  let score: number;
  if (cashPct >= 50) score = 1;
  else if (cashPct >= 40) score = 2;
  else if (cashPct >= 30) score = 3;
  else if (cashPct >= 20) score = 4;
  else score = 5;

  if (beta != null) {
    if (beta < 0.5) score = Math.max(1, score - 1);
    if (beta > 1.2) score = Math.min(5, score + 1);
  }

  return score;
}

// ─── Main Context Computation ───────────────────────────────────

export function computeIbkrTradingContext(
  db: Database.Database,
  accountId: number,
  accountName: string
): IbkrTradingContext {
  // 1. Cash: the account's OWN cash line (B7), read by id, never by name.
  // Cash, positions and total come from one daily_valuations row, so they
  // tie and share one date; a month-end total is never netted against
  // today's holdings. A negative figure is kept (a margin debit is not
  // clamped to zero), and the line's provenance flags decide whether the
  // figure can carry a stance (ruling P12).
  const cashLine = getAccountCashLine(db, accountId);
  const cashAvailable = cashLine != null && cashLine.cashBalance != null && cashLine.totalValue != null;
  const cashSource: IbkrTradingContext["cashSource"] = cashAvailable ? "daily_valuation" : "none";
  const estimatedCash = cashAvailable ? (cashLine.cashBalance as number) : 0;
  const accountTotal = cashAvailable ? (cashLine.totalValue as number) : 0;
  const cashPct = accountTotal > 0 ? (estimatedCash / accountTotal) * 100 : 0;
  const cashCarried = cashAvailable && cashLine.carried;
  const cashPriceDateMismatch = cashAvailable && cashLine.priceDateMismatch;
  const cashTimingResidual = cashAvailable && cashLine.isLiveSource && !cashLine.priceDateMismatch;
  const cashAsOf = cashAvailable ? (cashLine.carried ? cashLine.measuredDate : cashLine.valuationDate) : null;
  const stanceWithheld = !cashAvailable || cashCarried || cashTimingResidual || cashPriceDateMismatch;

  // 2. Portfolio beta
  const factors = computeFactorAnalysis(db, { accountId });
  const portfolioBeta = factors.marketRegression?.beta ?? null;

  // 3. Bullishness score
  const bullishnessScore = computeBullishness(cashPct, portfolioBeta);

  // 4. Holdings — position count, sector tilts, long/short summary. Opts
  // into includeShorts: the shortPositions/longShortSummary section below
  // can only ever populate from a `!= 0` row set (getHoldingsForChat's
  // default excludes shorts entirely for every other consumer).
  // Every active position (B10): no row limit, read by account id.
  const holdings = getHoldingsForChat(db, { account_ids: [accountId], noLimit: true, includeShorts: true });
  const activePositionCount = holdings.length;

  // Sector tilts: aggregate market value by sector
  const sectorMap = new Map<string, number>();
  let totalMv = 0;
  for (const h of holdings) {
    const sector = h.sector ?? "Unknown";
    const mv = Math.abs(h.market_value ?? 0);
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + mv);
    totalMv += mv;
  }
  const sectorTilts = [...sectorMap.entries()]
    .map(([sector, mv]) => ({ sector, weight: totalMv > 0 ? (mv / totalMv) * 100 : 0 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);

  // Long/short summary
  const longPositions = holdings.filter((h) => h.quantity > 0);
  const shortPositions = holdings.filter((h) => h.quantity < 0);
  const longSectors = summarizeSectors(longPositions);
  const shortSectors = summarizeSectors(shortPositions);
  let longShortSummary = `Long: ${longPositions.length} positions`;
  if (longSectors) longShortSummary += ` (${longSectors})`;
  if (shortPositions.length > 0) {
    longShortSummary += `. Short: ${shortPositions.length} positions`;
    const shortSymbols = shortPositions.map((h) => h.symbol).join(", ");
    longShortSummary += ` (${shortSymbols})`;
    if (shortSectors) longShortSummary += ` [${shortSectors}]`;
  }

  // 5. Repeat names — symbols traded 3+ times in last 90 days
  const ninetyDaysAgo = addDays(todayET(), -90); // counted back from the ET day
  const repeatNames = db
    .prepare(
      `SELECT s.symbol, COUNT(*) as trade_count, MAX(t.trade_date) as last_traded
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN securities s ON s.id = t.security_id
       WHERE a.id = ?
         AND t.trade_date >= ?
         AND UPPER(t.type) IN ('BUY', 'SELL')
       GROUP BY s.symbol
       HAVING COUNT(*) >= 3
       ORDER BY trade_count DESC`
    )
    .all(accountId, ninetyDaysAgo) as { symbol: string; trade_count: number; last_traded: string }[];

  // 6. Avg holding period from closed lots in last 90 days.
  // holding_period_days is SIGNED NEGATIVE for short round-trips (number-trust
  // durable fixes, WS1) — the sign is a bookkeeping convention (always
  // short-term for §1233) rather than a real negative duration, so a plain
  // signed AVG would understate this behavioral metric (or even go negative)
  // for a trader who mixes longs and shorts. AVG(ABS(...)) reports the true
  // average days-in-trade regardless of direction, which is what "how long
  // does this trader typically hold a position" is actually asking. Filtering
  // shorts out entirely (the alternative) would silently drop a real and
  // common IBKR trading style (short-premium options) from the picture.
  const holdingDaysRow = db
    .prepare(
      `SELECT AVG(ABS(tls.holding_period_days)) as avg_days
       FROM tax_lot_sales tls
       JOIN tax_lots tl ON tl.id = tls.tax_lot_id
       WHERE tl.account_id = ?
         AND tls.sale_date >= ?`
    )
    .get(accountId, ninetyDaysAgo) as { avg_days: number | null } | undefined;
  const avgHoldingDays = holdingDaysRow?.avg_days != null ? Math.round(holdingDaysRow.avg_days) : null;

  // 7. Recent trades (last 10 BUY/SELL)
  const allRecent = getTransactionsForChat(db, { account_name: accountName, limit: 20 });
  const recentTrades = allRecent
    .filter((t) => ["BUY", "SELL"].includes(t.type.toUpperCase()))
    .slice(0, 10)
    .map((t) => ({
      date: t.trade_date,
      symbol: t.symbol ?? "?",
      type: t.type,
      amount: Math.abs(t.amount ?? 0),
    }));

  return {
    cashPct: Math.round(cashPct * 10) / 10,
    estimatedCash: Math.round(estimatedCash),
    accountTotal: Math.round(accountTotal),
    portfolioBeta,
    bullishnessScore,
    activePositionCount,
    sectorTilts,
    repeatNames: repeatNames.map((r) => ({
      symbol: r.symbol,
      tradeCount: r.trade_count,
      lastTraded: r.last_traded,
    })),
    avgHoldingDays,
    recentTrades,
    longShortSummary,
    cashAsOf,
    cashSource,
    cashCarried,
    cashTimingResidual,
    cashPriceDateMismatch,
    accountTotalAsOf: cashAsOf,
    stanceWithheld,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function summarizeSectors(
  positions: { sector: string | null; market_value: number | null }[]
): string {
  const sectorMap = new Map<string, number>();
  for (const p of positions) {
    const sector = p.sector ?? "Other";
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + Math.abs(p.market_value ?? 0));
  }
  return [...sectorMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => s)
    .join(", ");
}
