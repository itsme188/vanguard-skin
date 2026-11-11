/**
 * Monthly performance, per account and blended across a scope — the display
 * lane for the Performance page's month view.
 *
 * ONE formula, stated on screen and here:
 *
 *     r = (V_end − V_start − F) / (V_start + Σ w_i·F_i),   w_i = (D − d_i)/D
 *
 * Modified Dietz. D is the calendar days in the month, d_i a flow's
 * day-of-month, end-of-day convention (a flow dated on the month-end itself
 * carries weight 0). With no flows the weighted sum is 0 and the equation
 * collapses to (V_end − V_start)/V_start — so there is never a second
 * formula on this surface, only a different set of weights. F is the signed
 * net external flow (deposits positive, withdrawals negative), cash and
 * in-kind alike; it is SUBTRACTED out of the numerator, which is what
 * "a contribution is never performance" means arithmetically.
 *
 * V_start and V_end are month-end STATEMENT balances
 * (`monthly_snapshots`, live tws/plaid rows excluded by the readers in
 * monthly-snapshot-utils.ts). V_start is the EXACT adjacent prior month-end:
 * a gap is refused, never bridged to an older statement.
 *
 * THE BLENDED FIGURE AGGREGATES BALANCES AND FLOWS, THEN RUNS THE EQUATION
 * ONCE. It is never the mean of the accounts' percentages — a 10% month on a
 * small account and a 1% month on a large one do not average to 5.5%.
 *
 * ── Relationship to lib/compute/dietz.ts ───────────────────────────────
 * `computeMonthlyDietz` is the same equation, written as a RECONCILIATION
 * lane: its job is to disagree with `monthly_snapshots.twr`, so it refuses
 * any month it cannot independently stand behind. Two of its refusals are
 * wrong for a display lane and are deliberately not reproduced here:
 *
 *  - `flow-total-unavailable` — a NULL `deposits_withdrawals` means the
 *    statement offers no month total to CROSS-CHECK the ledger against. It
 *    does not mean the flows are unknown: the dated ledger rows come from
 *    the same statement. Here the month is computed and labelled
 *    `ledger-unverified` instead of withheld. (Live data, Nov 2026: the
 *    IBKR activity statements carry no month total from May 2026 on, which
 *    would have blanked six months of the year for that account.)
 *
 *  - `seam-straddled` — that check asks whether ANY `monthly_snapshots` row
 *    inside the window has a different `source` than the one before it. It
 *    is the right question for the DAILY flow-adjusted index, which is
 *    anchored on those rows, live ones included. It is the wrong question
 *    here: both endpoints of a month-end statement return are statement-grade
 *    by construction, and the daily Plaid/TWS rows written between them are
 *    never read. (Live data: Plaid went live mid-July 2026 and its daily
 *    Vanguard rows made every month from July on read as a seam.)
 *
 * Nothing in this module writes, and nothing here touches an existing
 * performance figure: `computeMonthlyDietz`, `computeTwr`, `computeXirr` and
 * the reconciler are untouched.
 */

import type Database from "better-sqlite3";
import {
  fetchMonthSnapshot,
  fetchPriorMonthTotal,
  isAnnualSummaryRow,
  priorMonthEndDate,
} from "@/lib/compute/monthly-snapshot-utils";
import {
  fetchNetFlowsByDate,
  fetchInKindFlowsByDate,
} from "@/lib/compute/flow-adjusted";
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { getAllAccounts } from "@/lib/queries/accounts";

/** Dollar tolerance for "the ledger agrees with the statement's own total". */
export const FLOW_AGREEMENT_TOL_USD = 1.0;

/** Dollar tolerance for "this statement opens where the last one closed". */
export const STATEMENT_CHAIN_TOL_USD = 1.0;

/**
 * How the month's external flows were established. Display copy for each
 * lives in the UI section (one place), not here.
 */
export const MONTHLY_FLOW_SOURCES = [
  /** Dated ledger flows, and the statement's own month total agrees. */
  "ledger-verified",
  /** Dated ledger flows; the statement reports no month total to check them against. */
  "ledger-unverified",
  /** The ledger disagreed with the statement's month total; the statement's total used, undated. */
  "statement-total",
] as const;
export type MonthlyFlowSource = (typeof MONTHLY_FLOW_SOURCES)[number];

/** Modified Dietz with real weights, or with every weight at zero. */
export const MONTHLY_PERF_METHODS = ["modified-dietz", "undated-flows"] as const;
export type MonthlyPerfMethod = (typeof MONTHLY_PERF_METHODS)[number];

/**
 * Why a month carries no figure. Never an estimate, never a partial blend.
 * The list is a runtime const so the UI's copy table can be checked against
 * it: a new code needs an owner-facing sentence before it can reach a screen
 * (tests/dashboard/monthly-performance-month-view.test.ts).
 */
export const MONTHLY_PERF_REFUSALS = [
  /** No month-end statement for this account and month. */
  "no-statement",
  /** No statement for the exact prior month-end: nothing to measure from. */
  "no-prior-statement",
  /** A December row whose starting_value is the YEAR start (cumulative figures). */
  "annual-summary-row",
  /** The statement's own beginning balance is not the prior statement's close. */
  "statements-do-not-chain",
  /** V_start, or the whole denominator, is not positive. */
  "no-measurable-base",
  /**
   * The dated ledger flows and the statement's own monthly total disagree by
   * more than a dollar. Which is right is unknowable here, and the
   * difference would land in the numerator as return.
   */
  "flows-disagree",
] as const;
export type MonthlyPerfRefusal = (typeof MONTHLY_PERF_REFUSALS)[number];

export interface AccountMonthPerformance {
  accountId: number;
  accountName: string;
  monthEndDate: string;
  /** Prior month-end statement balance, or null when refused. */
  beginningValue: number | null;
  /** This month-end's statement balance, or null when there is no statement. */
  endingValue: number | null;
  /** Signed net external flow for the month (0 when refused before flows are read). */
  netFlow: number;
  /** Dated flow rows behind `netFlow` (0 under `statement-total`). */
  flowCount: number;
  /** V_end − V_start − F: the money the market made, flows removed. */
  gainLoss: number | null;
  /** The return as a fraction (0.0421 = +4.21%). */
  returnFraction: number | null;
  method: MonthlyPerfMethod | null;
  flowSource: MonthlyFlowSource | null;
  refusal: MonthlyPerfRefusal | null;
}

export interface BlendedAccountBlocker {
  accountId: number;
  accountName: string;
  refusal: MonthlyPerfRefusal;
}

export interface BlendedMonthPerformance {
  monthEndDate: string;
  beginningValue: number | null;
  endingValue: number | null;
  netFlow: number;
  gainLoss: number | null;
  returnFraction: number | null;
  method: MonthlyPerfMethod | null;
  flowSource: MonthlyFlowSource | null;
  /**
   * True when the blend is not a statement about the whole scope: at least
   * one account in it carries no figure (see `blockedBy`), the scope is
   * empty, or the aggregate has no measurable base. A blended figure is
   * NEVER computed from the accounts that happen to be present.
   */
  incomplete: boolean;
  /** The accounts that blocked the blend, with the reason for each. */
  blockedBy: BlendedAccountBlocker[];
  /** Set when the scope's own aggregate could not be measured. */
  refusal: MonthlyPerfRefusal | null;
}

export interface MonthlyPerformanceResult {
  monthEndDate: string;
  accounts: AccountMonthPerformance[];
  blended: BlendedMonthPerformance;
}

/** The last calendar day of monthEndDate's own month (31 for "2026-03-31"). */
function daysInMonth(monthEndDate: string): number {
  const [y, m] = monthEndDate.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Modified Dietz weight for a flow dated inside the month. */
function flowWeight(date: string, totalDays: number): number {
  return (totalDays - Number(date.slice(8, 10))) / totalDays;
}

/** Weakest evidence wins, so a blend never claims more than its weakest leg. */
const FLOW_SOURCE_RANK: Record<MonthlyFlowSource, number> = {
  "ledger-verified": 0,
  "ledger-unverified": 1,
  "statement-total": 2,
};

/**
 * The weakest evidence in a set, or null for an empty set. Exported so the
 * UI's footnote reads the same rule the blend does — a footnote must never
 * claim better evidence than the figures above it.
 */
export function weakestFlowSource(
  sources: readonly MonthlyFlowSource[],
): MonthlyFlowSource | null {
  if (sources.length === 0) return null;
  return sources.reduce<MonthlyFlowSource>(
    (worst, s) => (FLOW_SOURCE_RANK[s] > FLOW_SOURCE_RANK[worst] ? s : worst),
    sources[0],
  );
}

/**
 * Every month-end that has at least one statement-sourced `monthly_snapshots`
 * row in the scope, newest first. `undefined` is every account; a defined
 * empty list is no accounts (and so no months).
 */
export function listStatementMonths(
  db: Database.Database,
  accountIds: readonly number[] | undefined,
): string[] {
  const scope = accountScopeAndSql(accountIds, "account_id");
  const rows = db
    .prepare(
      `SELECT DISTINCT month_end_date
         FROM monthly_snapshots
        WHERE ${excludeLiveSnapshotsSql("source")}
          ${scope.sql}
        ORDER BY month_end_date DESC`,
    )
    .all(...scope.params) as { month_end_date: string }[];
  return rows.map((r) => r.month_end_date);
}

/** Per-account intermediate the blend needs: the operands, not the percentage. */
interface AccountLeg {
  vStart: number;
  vEnd: number;
  netFlow: number;
  weightedFlowTotal: number;
  flowSource: MonthlyFlowSource;
}

function refusedRow(
  accountId: number,
  accountName: string,
  monthEndDate: string,
  beginningValue: number | null,
  endingValue: number | null,
  refusal: MonthlyPerfRefusal,
): AccountMonthPerformance {
  return {
    accountId,
    accountName,
    monthEndDate,
    beginningValue,
    endingValue,
    netFlow: 0,
    flowCount: 0,
    gainLoss: null,
    returnFraction: null,
    method: null,
    flowSource: null,
    refusal,
  };
}

function computeAccountLeg(
  db: Database.Database,
  accountId: number,
  accountName: string,
  monthEndDate: string,
): { row: AccountMonthPerformance; leg: AccountLeg | null } {
  const snap = fetchMonthSnapshot(db, accountId, monthEndDate);
  const vStart = fetchPriorMonthTotal(db, accountId, monthEndDate);
  const vEnd = snap?.total_value ?? null;

  const refuse = (refusal: MonthlyPerfRefusal) => ({
    row: refusedRow(accountId, accountName, monthEndDate, vStart, vEnd, refusal),
    leg: null,
  });

  if (snap === null) return refuse("no-statement");

  // Checked before anything reads starting_value or a flow total: a December
  // annual-summary row's starting_value and deposits_withdrawals are
  // CUMULATIVE-YEAR figures, so the chain check below would also fire on it
  // and name the wrong reason (same precedence as lib/compute/dietz.ts).
  if (
    isAnnualSummaryRow(
      { month_end_date: snap.month_end_date, starting_value: snap.starting_value },
      vStart,
    )
  ) {
    return refuse("annual-summary-row");
  }

  if (vStart === null) return refuse("no-prior-statement");

  // The statement's own beginning balance must be the prior statement's
  // close. When it is not, the two statements describe different books (a
  // restatement, a missing month folded in) and the difference would land in
  // the numerator as return.
  if (
    snap.starting_value !== null &&
    Math.abs(snap.starting_value - vStart) > STATEMENT_CHAIN_TOL_USD
  ) {
    return refuse("statements-do-not-chain");
  }

  const priorMonthEnd = priorMonthEndDate(monthEndDate);
  const totalDays = daysInMonth(monthEndDate);

  const cashFlows = fetchNetFlowsByDate(db, [accountId], priorMonthEnd, monthEndDate, {
    excludeInKind: true,
  });
  const inKindFlows = fetchInKindFlowsByDate(db, [accountId], priorMonthEnd, monthEndDate);
  const cashSum = cashFlows.reduce((s, f) => s + f.net, 0);
  const inKindSum = inKindFlows.reduce((s, f) => s + f.net, 0);

  const statementTotal = snap.deposits_withdrawals;
  // In-kind legs have no statement-reported counterpart, so they are never
  // part of this comparison (same rule as the reconciler's).
  const ledgerAgrees =
    statementTotal !== null &&
    Math.abs(cashSum - statementTotal) <= FLOW_AGREEMENT_TOL_USD;

  let netFlow: number;
  let flowCount: number;
  let weightedFlowTotal: number;
  let flowSource: MonthlyFlowSource;
  let method: MonthlyPerfMethod;

  if (statementTotal !== null && !ledgerAgrees && cashFlows.length > 0) {
    // Two sources, two answers, no way to tell which month the difference
    // belongs to. Refused rather than absorbed into the return — the
    // reconciler refuses the same case (`flow-total-mismatch`).
    return refuse("flows-disagree");
  }

  if (statementTotal !== null && !ledgerAgrees) {
    // The statement reports money moving and the ledger has no dated row for
    // it at all (a known ledger gap). The statement is then the only evidence
    // of how much moved; it just does not say when, so every weight goes to
    // zero — which is the denominator the plain
    // (ending − opening − flows) / opening form uses.
    netFlow = statementTotal + inKindSum;
    flowCount = 0;
    weightedFlowTotal = 0;
    flowSource = "statement-total";
    method = "undated-flows";
  } else {
    netFlow = cashSum + inKindSum;
    flowCount = cashFlows.length + inKindFlows.length;
    weightedFlowTotal = [...cashFlows, ...inKindFlows].reduce(
      (s, f) => s + f.net * flowWeight(f.date, totalDays),
      0,
    );
    flowSource = statementTotal === null ? "ledger-unverified" : "ledger-verified";
    method = "modified-dietz";
  }

  const denominator = vStart + weightedFlowTotal;
  if (vStart <= 0 || denominator <= 0) return refuse("no-measurable-base");

  const gainLoss = snap.total_value - vStart - netFlow;

  return {
    row: {
      accountId,
      accountName,
      monthEndDate,
      beginningValue: vStart,
      endingValue: snap.total_value,
      netFlow,
      flowCount,
      gainLoss,
      returnFraction: gainLoss / denominator,
      method,
      flowSource,
      refusal: null,
    },
    leg: {
      vStart,
      vEnd: snap.total_value,
      netFlow,
      weightedFlowTotal,
      flowSource,
    },
  };
}

/**
 * One month, every account in the scope, plus the blended figure.
 *
 * `accountIds`: `undefined` is every account, a defined empty list is no
 * accounts. Account order follows the accounts table's own id order.
 */
export function computeMonthlyPerformance(
  db: Database.Database,
  accountIds: readonly number[] | undefined,
  monthEndDate: string,
): MonthlyPerformanceResult {
  const all = getAllAccounts(db);
  const scoped =
    accountIds === undefined ? all : all.filter((a) => accountIds.includes(a.id));

  const rows: AccountMonthPerformance[] = [];
  const legs: AccountLeg[] = [];
  const blockedBy: BlendedAccountBlocker[] = [];

  for (const account of scoped) {
    const { row, leg } = computeAccountLeg(db, account.id, account.name, monthEndDate);
    rows.push(row);
    if (leg === null) {
      blockedBy.push({
        accountId: account.id,
        accountName: account.name,
        refusal: row.refusal!,
      });
    } else {
      legs.push(leg);
    }
  }

  const emptyBlend = (refusal: MonthlyPerfRefusal | null): BlendedMonthPerformance => ({
    monthEndDate,
    beginningValue: null,
    endingValue: null,
    netFlow: 0,
    gainLoss: null,
    returnFraction: null,
    method: null,
    flowSource: null,
    incomplete: true,
    blockedBy,
    refusal,
  });

  // A blend is a claim about the WHOLE scope. One account without a figure
  // makes it incomplete — the present accounts are shown on their own rows
  // instead, never silently summed into a scope-wide percentage.
  if (scoped.length === 0 || blockedBy.length > 0) {
    return { monthEndDate, accounts: rows, blended: emptyBlend(null) };
  }

  const beginningValue = legs.reduce((s, l) => s + l.vStart, 0);
  const endingValue = legs.reduce((s, l) => s + l.vEnd, 0);
  const netFlow = legs.reduce((s, l) => s + l.netFlow, 0);
  const flowSource = weakestFlowSource(legs.map((l) => l.flowSource))!;
  // Mixing weighted and unweighted flows in one denominator would be two
  // formulas in one figure. When any leg's flows are undated the whole blend
  // takes the undated form, and the UI says so.
  const anyUndated = legs.some((l) => l.flowSource === "statement-total");
  const weightedFlowTotal = anyUndated
    ? 0
    : legs.reduce((s, l) => s + l.weightedFlowTotal, 0);
  const denominator = beginningValue + weightedFlowTotal;

  if (beginningValue <= 0 || denominator <= 0) {
    return { monthEndDate, accounts: rows, blended: emptyBlend("no-measurable-base") };
  }

  const gainLoss = endingValue - beginningValue - netFlow;

  return {
    monthEndDate,
    accounts: rows,
    blended: {
      monthEndDate,
      beginningValue,
      endingValue,
      netFlow,
      gainLoss,
      returnFraction: gainLoss / denominator,
      method: anyUndated ? "undated-flows" : "modified-dietz",
      flowSource,
      incomplete: false,
      blockedBy: [],
      refusal: null,
    },
  };
}
