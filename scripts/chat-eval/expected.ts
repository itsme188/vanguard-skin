/**
 * Chat evaluation: the expected figures, DERIVED from the eval database at
 * run time by the repo's own readers and engines. Nothing here is a typed-in
 * figure, so a change to the demo seed or the fixture moves the expectations
 * with it. Where a figure cannot be derived (for example no IBKR holdings),
 * the field is null and the question that needs it drops that check and
 * says so in its report.
 */

import type Database from "better-sqlite3";
import { getHoldingsForChat, getIncomeSummaryForChat, type HoldingResult } from "../../lib/queries/chat-tools";
import { getClosedTaxLotSales } from "../../lib/queries/tax-lots";
import { isTaxableAccount } from "../../lib/compute/tax-treatment";
import { addDays, calendarDaysBetween } from "../../lib/calendar/date-utils";
import { CHAT_TOOLS } from "../../lib/chat/tools";
import { runCompositeTool } from "../../lib/chat/composite";
import type { EvalManifest } from "./manifest";

export interface ExpectedContext {
  today: string;
  manifest: EvalManifest;
  /** Names of the tools the app registers today (CHAT_TOOLS). */
  registeredTools: string[];
  /** The IBKR account's largest position by |weight| on the account base. */
  ibkrTopWeight: {
    symbol: string;
    name: string | null;
    /** Share of the account's long market value (the holdings reader's own weight). */
    accountWeightPct: number;
    /** Share of the account's value INCLUDING cash (latest daily valuation total), or null. */
    accountValueWeightPct: number | null;
    wholeBookWeightPct: number | null;
  } | null;
  /** Dividend income over the last 365 days, counted once (Contract J). */
  dividends12m: { single: number; naiveDoubleCount: number; marginInterestPaid: number } | null;
  /** Realized gains in the current calendar year, taxable accounts, filing rows. */
  realized: {
    year: number;
    shortTerm: number;
    longTerm: number;
    lifetimeAllAccounts: number;
    /** Underlying symbols of the instruments that closed this year (stocks and options alike). */
    closedThisYear: string[];
    /** Symbols with a sale on file only in OTHER years (the wrong source of this year's gain). */
    closedOtherYearsOnly: string[];
  } | null;
  /** The foreign holding as the readers report it. */
  foreign: { symbol: string; currency: string; nativePrice: number; usdValue: number; quantity: number } | null;
  /** The lot waiting for long-term treatment. */
  longTermWait: { symbol: string; daysToLongTerm: number; firstLongTermDay: string; unrealizedGain: number | null } | null;
  /** The month before today's, by name (e.g. "October"). */
  previousMonthName: string;
  /** The oldest price date behind a current holding (what "stale" must name). */
  stalePriceDate: string | null;
  /** The short's dollar day effect: quantity x (last close - previous close); negative when it rose. */
  shortDayEffect: number | null;
  /** The harvest candidate's unrealized result (negative: a loss), from the holdings reader. */
  harvestLoss: number | null;
  /** The Roth loser's and the pending lot's unrealized results (they must not be summed in). */
  excludedLosses: { roth: number | null; pending: number | null };
  /** How many positions query_scenarios lists in unmodelled_positions (all accounts), or null. */
  unmodelledPositions: number | null;
  /** Names of the accounts whose tax treatment is taxable (`isTaxableAccount`). */
  taxableAccounts: string[];
}

function deriveStalePriceDate(db: Database.Database): string | null {
  const dates = holdingsFor(db)
    .filter((r) => r.quantity !== 0 && r.price_date)
    .map((r) => r.price_date as string)
    .sort();
  return dates[0] ?? null;
}

function deriveShortDayEffect(db: Database.Database, m: EvalManifest): number | null {
  const row = holdingsFor(db, m.accounts.ibkr).find((r) => r.symbol === m.short);
  if (!row) return null;
  const closes = db
    .prepare(
      `SELECT p.close_price FROM prices p JOIN securities s ON s.id = p.security_id
        WHERE s.symbol = ? ORDER BY p.date DESC LIMIT 2`,
    )
    .all(m.short) as { close_price: number }[];
  if (closes.length < 2) return null;
  return round2(row.quantity * (closes[0].close_price - closes[1].close_price));
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function holdingsFor(db: Database.Database, accountName?: string): HoldingResult[] {
  return getHoldingsForChat(db, {
    ...(accountName ? { account_name: accountName } : {}),
    includeShorts: true,
    noLimit: true,
    sort_by: "market_value",
  });
}

function deriveIbkrTopWeight(db: Database.Database, m: EvalManifest): ExpectedContext["ibkrTopWeight"] {
  const rows = holdingsFor(db, m.accounts.ibkr).filter((r) => r.position_weight_pct !== null);
  if (rows.length === 0) return null;
  const top = rows.reduce((a, b) => (Math.abs(b.position_weight_pct ?? 0) > Math.abs(a.position_weight_pct ?? 0) ? b : a));
  const whole = holdingsFor(db).find((r) => r.account_name === m.accounts.ibkr && r.symbol === top.symbol);
  const total = (
    db
      .prepare(
        `SELECT v.total_value FROM daily_valuations v JOIN accounts a ON a.id = v.account_id
          WHERE a.name = ? ORDER BY v.valuation_date DESC LIMIT 1`,
      )
      .get(m.accounts.ibkr) as { total_value: number } | undefined
  )?.total_value;
  return {
    symbol: top.symbol,
    name: top.security_name,
    accountWeightPct: top.position_weight_pct ?? 0,
    accountValueWeightPct: total && top.market_value !== null ? (top.market_value / total) * 100 : null,
    wholeBookWeightPct: whole?.position_weight_pct ?? null,
  };
}

/**
 * Dividend income as the APP computes it: the chat tool's own reader
 * (`getIncomeSummaryForChat`, the one the dashboard's income SQL shares),
 * trailing twelve months, summed over accounts. The wrong figure the
 * question exists to catch is a separately named NAIVE sum: every DIVIDEND
 * plus the magnitude of every REINVESTMENT in the same window (the old
 * double count), read straight from the ledger.
 */
function deriveDividends(db: Database.Database, today: string): ExpectedContext["dividends12m"] {
  const rows = getIncomeSummaryForChat(db, { period: "trailing_12m", group_by: "account" });
  if (rows.length === 0) return null;
  const single = round2(rows.reduce((s, r) => s + (r.total_dividends ?? 0), 0));
  const marginInterestPaid = round2(rows.reduce((s, r) => s + (r.interest_paid ?? 0), 0));
  // The same window the reader uses (same month/day one year back, Eastern).
  const md = today.slice(5);
  const from = `${Number(today.slice(0, 4)) - 1}-${md === "02-29" ? "02-28" : md}`;
  const naive = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN UPPER(type) = 'DIVIDEND' THEN amount
                                WHEN UPPER(type) = 'REINVESTMENT' THEN ABS(amount) ELSE 0 END), 0) AS naive
         FROM transactions WHERE trade_date >= ? AND trade_date <= ?`,
    )
    .get(from, today) as { naive: number };
  return { single, naiveDoubleCount: round2(naive.naive), marginInterestPaid };
}

function deriveRealized(db: Database.Database, today: string): ExpectedContext["realized"] {
  const year = Number(today.slice(0, 4));
  const treatment = new Map(
    (db.prepare("SELECT id, tax_treatment FROM accounts").all() as { id: number; tax_treatment: string | null }[]).map(
      (a) => [a.id, a.tax_treatment],
    ),
  );
  const rows = getClosedTaxLotSales(db, year, { filingOnly: true }).filter((r) => isTaxableAccount(treatment.get(r.account_id)));
  const lifetime = getClosedTaxLotSales(db, undefined, { filingOnly: true });
  const sum = (xs: { realized_gain_loss_usd: number }[]) => round2(xs.reduce((s, r) => s + (r.realized_gain_loss_usd ?? 0), 0));
  const root = (symbol: string) => symbol.trim().split(/\s+/)[0];
  const thisYear = [...new Set(rows.map((r) => root(r.symbol)))].sort();
  const otherYears = [...new Set(lifetime.filter((r) => !r.sale_date.startsWith(String(year))).map((r) => root(r.symbol)))]
    .filter((s) => !thisYear.includes(s))
    .sort();
  return {
    year,
    shortTerm: sum(rows.filter((r) => !r.is_long_term)),
    longTerm: sum(rows.filter((r) => r.is_long_term)),
    lifetimeAllAccounts: sum(lifetime),
    closedThisYear: thisYear,
    closedOtherYearsOnly: otherYears,
  };
}

function unrealizedOf(db: Database.Database, account: string, symbol: string): number | null {
  const row = holdingsFor(db, account).find((r) => r.symbol === symbol);
  return row?.unrealized_gain ?? null;
}

/** The pending lot's would-be result at its last price (its holdings row is flat, so it is read from the lot). */
function pendingLossOf(db: Database.Database, m: EvalManifest): number | null {
  const row = db
    .prepare(
      `SELECT SUM(tl.cost_basis * tl.quantity_remaining / tl.quantity_acquired) AS basis, SUM(tl.quantity_remaining) AS qty,
              (SELECT p.close_price FROM prices p WHERE p.security_id = s.id ORDER BY p.date DESC LIMIT 1) AS px
         FROM tax_lots tl JOIN securities s ON s.id = tl.security_id
        WHERE s.symbol = ? AND tl.quantity_remaining > 0`,
    )
    .get(m.pendingLot) as { basis: number | null; qty: number | null; px: number | null } | undefined;
  if (!row || row.basis === null || row.qty === null || row.px === null) return null;
  return round2(row.qty * row.px - row.basis);
}

function deriveForeign(db: Database.Database, m: EvalManifest): ExpectedContext["foreign"] {
  const row = holdingsFor(db).find((r) => r.symbol === m.foreign.symbol);
  if (!row || row.latest_price === null || row.market_value === null) return null;
  return { symbol: row.symbol, currency: row.currency, nativePrice: row.latest_price, usdValue: row.market_value, quantity: row.quantity };
}

function deriveLongTermWait(db: Database.Database, m: EvalManifest, today: string): ExpectedContext["longTermWait"] {
  // Long-term means held MORE than one year: the first long-term sale day is
  // the day after the anniversary.
  const acquired = m.longTermWait.acquired;
  const anniversary = `${Number(acquired.slice(0, 4)) + 1}${acquired.slice(4)}`;
  const firstLongTermDay = addDays(anniversary, 1);
  const days = firstLongTermDay > today ? calendarDaysBetween(today, firstLongTermDay) : 0;
  const row = holdingsFor(db, m.accounts.taxable).find((r) => r.symbol === m.longTermWait.symbol);
  return { symbol: m.longTermWait.symbol, daysToLongTerm: days, firstLongTermDay, unrealizedGain: row?.unrealized_gain ?? null };
}

/** The scenario tool's own unmodelled list, all accounts (what an answer can be asked to name). */
function deriveUnmodelled(db: Database.Database, today: string): number | null {
  const r = runCompositeTool("query_scenarios", db, {}, { accountIds: undefined, today }) as { unmodelled_positions?: unknown[] };
  return Array.isArray(r?.unmodelled_positions) ? r.unmodelled_positions.length : null;
}

function deriveTaxableAccounts(db: Database.Database): string[] {
  return (db.prepare("SELECT name, tax_treatment FROM accounts ORDER BY name").all() as { name: string; tax_treatment: string | null }[])
    .filter((a) => isTaxableAccount(a.tax_treatment))
    .map((a) => a.name);
}

export function deriveExpected(db: Database.Database, manifest: EvalManifest, today: string): ExpectedContext {
  const month = Number(today.slice(5, 7));
  return {
    today,
    manifest,
    registeredTools: CHAT_TOOLS.map((t) => t.name),
    ibkrTopWeight: deriveIbkrTopWeight(db, manifest),
    dividends12m: deriveDividends(db, today),
    realized: deriveRealized(db, today),
    foreign: deriveForeign(db, manifest),
    longTermWait: deriveLongTermWait(db, manifest, today),
    previousMonthName: MONTHS[(month + 10) % 12],
    stalePriceDate: deriveStalePriceDate(db),
    shortDayEffect: deriveShortDayEffect(db, manifest),
    harvestLoss: unrealizedOf(db, manifest.accounts.taxable, manifest.harvestCandidate),
    excludedLosses: {
      roth: unrealizedOf(db, manifest.accounts.roth, manifest.rothLoser),
      pending: pendingLossOf(db, manifest),
    },
    unmodelledPositions: deriveUnmodelled(db, today),
    taxableAccounts: deriveTaxableAccounts(db),
  };
}
