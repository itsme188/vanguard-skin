/**
 * The year's gain so far, in dollars, for a scope of accounts.
 *
 *     gain = Σ_accounts ( value now − Dec 31 statement total − net external flows in USD )
 *
 * Per account:
 *  - value now and its date: `getPortfolioCurrentValues` (the Portfolio
 *    strip's own per-account value, so the two never disagree);
 *  - the base: the account's STATEMENT row for Dec 31 of the prior year
 *    (`fetchMonthSnapshot`, live tws/plaid rows excluded);
 *  - flows: `fetchNetFlowsUsdByDate` over (Dec 31, the account's own value
 *    date]. A flow after the value date is not yet in the value, so it is
 *    not subtracted either.
 *
 * The figure is REFUSED (gainUsd null, the account listed) when any account
 * has no base, no current value, a current value dated before Jan 1, or a
 * flow with no USD rate. Each of those would put a missing input into the
 * gain (a deposit with no rate would read as gain), so no partial sum is
 * ever offered as the scope's gain.
 *
 * Reconciliation: through the latest month-end of the year (before today)
 * that has a statement for every account, the statement-based gain must
 * equal the sum of the monthly performance lane's gains. What the page does
 * with each status is the page's rule.
 *
 * Read-only. `accountIds`: undefined is every account, `[]` is none and
 * reads nothing.
 */

import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import { getPortfolioCurrentValues } from "@/lib/queries/dashboard";
import { fetchMonthSnapshot } from "@/lib/compute/monthly-snapshot-utils";
import { fetchNetFlowsUsdByDate } from "@/lib/compute/flow-adjusted";
import { transactionAmountCurrencySql } from "@/lib/queries/transaction-amount-currency";
import {
  computeMonthlyPerformance,
  FLOW_AGREEMENT_TOL_USD,
} from "@/lib/compute/monthly-performance";

export interface YearGainAccount {
  accountId: number;
  name: string;
  valueUsd: number | null;
  asOfDate: string | null;
}

export type YearGainReconciliationStatus = "agrees" | "differs" | "not-checked";

export interface YearGainResult {
  gainUsd: number | null;
  valueNowUsd: number;
  baseValueUsd: number;
  netFlowsUsd: number;
  /** `${year - 1}-12-31` */
  baseDate: string;
  accounts: YearGainAccount[];
  missingBaseAccounts: { accountId: number; name: string }[];
  unusableCurrentAccounts: {
    accountId: number;
    name: string;
    reason: "no-current-value" | "value-before-year";
  }[];
  unconvertedFlowAccounts: { accountId: number; name: string; count: number }[];
  reconciliation: {
    status: YearGainReconciliationStatus;
    throughMonth: string | null;
    differenceUsd: number | null;
    /** Why the check could not stand (or, for flows-disagree, why it differs with no figure). */
    reason?: YearGainReconciliationReason;
  };
}

/**
 * Precedence when several apply, strongest first: a real disagreement, then
 * lanes that are not comparable, then a check that would only test the
 * ledger against itself, then a month with no figure.
 */
export type YearGainReconciliationReason =
  | "flows-disagree"
  | "foreign-in-kind"
  | "ledger-unverified"
  | "month-without-figure";

const NOT_CHECKED: YearGainResult["reconciliation"] = {
  status: "not-checked",
  throughMonth: null,
  differenceUsd: null,
};

/** The month-end dates of `year`, January first. */
function monthEndsOfYear(year: number): string[] {
  const out: string[] = [];
  for (let m = 1; m <= 12; m++) {
    // Day 0 of the next month is the last day of this one.
    const d = new Date(Date.UTC(year, m, 0));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function computeYearGain(
  db: Database.Database,
  opts: { accountIds?: number[]; today?: string },
): YearGainResult {
  const today = opts.today ?? todayET();
  const year = Number(today.slice(0, 4));
  const baseDate = `${year - 1}-12-31`;
  const yearStart = `${year}-01-01`;

  const empty: YearGainResult = {
    gainUsd: null,
    valueNowUsd: 0,
    baseValueUsd: 0,
    netFlowsUsd: 0,
    baseDate,
    accounts: [],
    missingBaseAccounts: [],
    unusableCurrentAccounts: [],
    unconvertedFlowAccounts: [],
    reconciliation: { ...NOT_CHECKED },
  };
  // A defined empty scope is no accounts: return before any read.
  if (opts.accountIds !== undefined && opts.accountIds.length === 0) return empty;

  const current = getPortfolioCurrentValues(db, opts.accountIds).accounts;

  const result: YearGainResult = { ...empty, reconciliation: { ...NOT_CHECKED } };
  const bases = new Map<number, number>();

  for (const acct of current) {
    const name = acct.accountName;
    result.accounts.push({
      accountId: acct.accountId,
      name,
      valueUsd: acct.currentValue,
      asOfDate: acct.asOfDate,
    });

    const base = fetchMonthSnapshot(db, acct.accountId, baseDate);
    if (base === null) {
      result.missingBaseAccounts.push({ accountId: acct.accountId, name });
    } else {
      bases.set(acct.accountId, base.total_value);
      result.baseValueUsd += base.total_value;
    }

    if (acct.currentValue === null || acct.asOfDate === null) {
      result.unusableCurrentAccounts.push({ accountId: acct.accountId, name, reason: "no-current-value" });
      continue;
    }
    if (acct.asOfDate < yearStart) {
      result.unusableCurrentAccounts.push({ accountId: acct.accountId, name, reason: "value-before-year" });
      continue;
    }
    result.valueNowUsd += acct.currentValue;

    const { flows, unconvertedCount } = fetchNetFlowsUsdByDate(
      db,
      [acct.accountId],
      baseDate,
      acct.asOfDate,
    );
    result.netFlowsUsd += flows.reduce((s, f) => s + f.net, 0);
    if (unconvertedCount > 0) {
      result.unconvertedFlowAccounts.push({ accountId: acct.accountId, name, count: unconvertedCount });
    }
  }

  const refused =
    current.length === 0 ||
    result.missingBaseAccounts.length > 0 ||
    result.unusableCurrentAccounts.length > 0 ||
    result.unconvertedFlowAccounts.length > 0;
  result.gainUsd = refused
    ? null
    : result.valueNowUsd - result.baseValueUsd - result.netFlowsUsd;

  result.reconciliation = reconcile(db, opts.accountIds, current.map((a) => a.accountId), bases, {
    year,
    today,
    baseDate,
  });

  return result;
}

/**
 * Statement gain through the latest fully-covered month-end vs the sum of
 * the monthly performance lane's blended gains for January through that
 * month. Any input missing is `not-checked`, never a comparison against a
 * partial figure. Rulings (fix round 1), in precedence order:
 *
 *  1. `flows-disagree`: a month the monthly lane refuses because the ledger
 *     and the statement's own flow total disagree is a real disagreement,
 *     so the status is `differs`, with no dollar figure.
 *  2. `foreign-in-kind`: an in-kind leg on a non-USD security in the span.
 *     The monthly lane sums those legs native, this lane in USD, so the two
 *     are not comparable: `not-checked`.
 *  3. `ledger-unverified`: an account-month whose flows are the ledger with
 *     no statement total behind them. "agrees" there would be the ledger
 *     checking itself: `not-checked`.
 *  4. `month-without-figure`: any other month with no blended figure.
 */
function reconcile(
  db: Database.Database,
  scope: number[] | undefined,
  accountIds: number[],
  bases: Map<number, number>,
  ctx: { year: number; today: string; baseDate: string },
): YearGainResult["reconciliation"] {
  if (accountIds.length === 0) return { ...NOT_CHECKED };

  const candidates = monthEndsOfYear(ctx.year).filter((m) => m < ctx.today);
  let throughMonth: string | null = null;
  const statementAt = new Map<number, number>();
  for (let i = candidates.length - 1; i >= 0 && throughMonth === null; i--) {
    const m = candidates[i];
    const rows = accountIds.map((id) => [id, fetchMonthSnapshot(db, id, m)] as const);
    if (rows.every(([, r]) => r !== null)) {
      throughMonth = m;
      for (const [id, r] of rows) statementAt.set(id, r!.total_value);
    }
  }
  if (throughMonth === null) return { ...NOT_CHECKED };
  const through = throughMonth;

  const months = candidates
    .filter((c) => c <= through)
    .map((m) => computeMonthlyPerformance(db, scope, m));
  const accountRows = months.flatMap((m) => m.accounts);
  const notChecked = (reason?: YearGainReconciliationReason): YearGainResult["reconciliation"] =>
    reason ? { ...NOT_CHECKED, reason } : { ...NOT_CHECKED };

  if (accountRows.some((r) => r.refusal === "flows-disagree")) {
    return { status: "differs", throughMonth: through, differenceUsd: null, reason: "flows-disagree" };
  }
  if (countForeignInKindLegs(db, accountIds, ctx.baseDate, through) > 0) {
    return notChecked("foreign-in-kind");
  }
  if (accountRows.some((r) => r.flowSource === "ledger-unverified")) {
    return notChecked("ledger-unverified");
  }
  if (months.some((m) => m.blended.gainLoss === null)) {
    return notChecked("month-without-figure");
  }
  // Every month has a figure, so January found each prior-year statement;
  // kept as a guard so the sum below never reads a missing base.
  if (accountIds.some((id) => !bases.has(id))) return notChecked("month-without-figure");

  let statementGain = 0;
  for (const id of accountIds) {
    const { flows, unconvertedCount } = fetchNetFlowsUsdByDate(db, [id], ctx.baseDate, through);
    if (unconvertedCount > 0) return notChecked();
    const flowSum = flows.reduce((s, f) => s + f.net, 0);
    statementGain += statementAt.get(id)! - bases.get(id)! - flowSum;
  }
  const monthlySum = months.reduce((s, m) => s + m.blended.gainLoss!, 0);

  const differenceUsd = statementGain - monthlySum;
  return {
    status: Math.abs(differenceUsd) <= FLOW_AGREEMENT_TOL_USD ? "agrees" : "differs",
    throughMonth: through,
    differenceUsd,
  };
}

/**
 * In-kind external legs (TRANSFER_IN/OUT with a security) whose stored
 * currency is not USD, in the scoped accounts over (startDate, endDate].
 * The currency is read through the one transaction-currency rule.
 */
function countForeignInKindLegs(
  db: Database.Database,
  accountIds: number[],
  startDate: string,
  endDate: string,
): number {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM transactions t
         LEFT JOIN securities s ON s.id = t.security_id
        WHERE t.is_external_flow = 1
          AND t.type IN ('TRANSFER_IN', 'TRANSFER_OUT')
          AND t.security_id IS NOT NULL
          AND t.trade_date > ? AND t.trade_date <= ?
          AND t.account_id IN (${accountIds.map(() => "?").join(",")})
          AND ${transactionAmountCurrencySql("t", "s")} != 'USD'`,
    )
    .get(startDate, endDate, ...accountIds) as { n: number };
  return n;
}
