/**
 * Chat evaluation: the expected figures, DERIVED from the eval database at
 * run time by the repo's own readers and engines. Nothing here is a typed-in
 * figure, so a change to the demo seed or the fixture moves the expectations
 * with it. Where a figure cannot be derived (for example no IBKR holdings),
 * the field is null and the question that needs it drops that check and
 * says so in its report.
 */

import type Database from "better-sqlite3";
import { getHoldingsForChat, type HoldingResult } from "../../lib/queries/chat-tools";
import { getClosedTaxLotSales } from "../../lib/queries/tax-lots";
import {
  DIVIDEND_INCOME_SQL,
  INCOME_PAIRED_JOIN,
  INTEREST_PAID_SQL,
  incomePairingCtes,
} from "../../lib/queries/income-sql";
import { isTaxableAccount } from "../../lib/compute/tax-treatment";
import { addDays, calendarDaysBetween } from "../../lib/calendar/date-utils";
import { CHAT_TOOLS } from "../../lib/chat/tools";
import type { EvalManifest } from "./manifest";

export interface ExpectedContext {
  today: string;
  manifest: EvalManifest;
  /** Names of the tools the app registers today (CHAT_TOOLS). */
  registeredTools: string[];
  /** The IBKR account's largest position by |weight| on the account base. */
  ibkrTopWeight: { symbol: string; name: string | null; accountWeightPct: number; wholeBookWeightPct: number | null } | null;
  /** Dividend income over the last 365 days, counted once (Contract J). */
  dividends12m: { single: number; reinvestedPaired: number; marginInterestPaid: number } | null;
  /** Realized gains in the current calendar year, taxable accounts, filing rows. */
  realized: { year: number; shortTerm: number; longTerm: number; lifetimeAllAccounts: number } | null;
  /** The foreign holding as the readers report it. */
  foreign: { symbol: string; currency: string; nativePrice: number; usdValue: number } | null;
  /** The lot waiting for long-term treatment. */
  longTermWait: { symbol: string; daysToLongTerm: number; unrealizedGain: number | null } | null;
  /** The month before today's, by name (e.g. "October"). */
  previousMonthName: string;
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
  return {
    symbol: top.symbol,
    name: top.security_name,
    accountWeightPct: top.position_weight_pct ?? 0,
    wholeBookWeightPct: whole?.position_weight_pct ?? null,
  };
}

function deriveDividends(db: Database.Database, today: string): ExpectedContext["dividends12m"] {
  const from = addDays(today, -365);
  const row = db
    .prepare(
      `WITH ${incomePairingCtes()}
       SELECT COALESCE(SUM(${DIVIDEND_INCOME_SQL}), 0) AS single,
              COALESCE(SUM(CASE WHEN UPPER(t.type) = 'REINVESTMENT' AND pr.id IS NOT NULL THEN ABS(t.amount) ELSE 0 END), 0) AS paired,
              COALESCE(SUM(${INTEREST_PAID_SQL}), 0) AS paid
         FROM transactions t
         ${INCOME_PAIRED_JOIN}
        WHERE t.trade_date >= ? AND t.trade_date <= ?`,
    )
    .get(from, today) as { single: number; paired: number; paid: number } | undefined;
  if (!row) return null;
  return { single: round2(row.single), reinvestedPaired: round2(row.paired), marginInterestPaid: round2(row.paid) };
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
  return {
    year,
    shortTerm: sum(rows.filter((r) => !r.is_long_term)),
    longTerm: sum(rows.filter((r) => r.is_long_term)),
    lifetimeAllAccounts: sum(lifetime),
  };
}

function deriveForeign(db: Database.Database, m: EvalManifest): ExpectedContext["foreign"] {
  const row = holdingsFor(db).find((r) => r.symbol === m.foreign.symbol);
  if (!row || row.latest_price === null || row.market_value === null) return null;
  return { symbol: row.symbol, currency: row.currency, nativePrice: row.latest_price, usdValue: row.market_value };
}

function deriveLongTermWait(db: Database.Database, m: EvalManifest, today: string): ExpectedContext["longTermWait"] {
  // Long-term means held MORE than one year: the first long-term sale day is
  // the day after the anniversary.
  const acquired = m.longTermWait.acquired;
  const anniversary = `${Number(acquired.slice(0, 4)) + 1}${acquired.slice(4)}`;
  const firstLongTermDay = addDays(anniversary, 1);
  const days = firstLongTermDay > today ? calendarDaysBetween(today, firstLongTermDay) : 0;
  const row = holdingsFor(db, m.accounts.taxable).find((r) => r.symbol === m.longTermWait.symbol);
  return { symbol: m.longTermWait.symbol, daysToLongTerm: days, unrealizedGain: row?.unrealized_gain ?? null };
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
  };
}
