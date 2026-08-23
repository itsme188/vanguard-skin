/**
 * Independent monthly Modified Dietz return — a durable, statement-
 * independent verification lane for the reconciler (Task 13) to compare
 * against the statement-reported `monthly_snapshots.twr` (see CLAUDE.md
 * "TWR 'reconciliation' is statement-self-referential" — the existing
 * `computeTwr` just echoes `snap.twr` back when present; this module
 * recomputes the return from first principles off the ledger instead).
 *
 * Equation (spec WS2): r = (V_end − V_start − F) / (V_start + Σ w_i·F_i),
 * w_i = (D − d_i)/D — D = calendar days in the month, d_i = the flow's
 * day-of-month, end-of-day convention (a flow dated on the month-end itself
 * gets weight 0). F = Σ F_i over ALL flows (cash + in-kind). No
 * intermediate rounding — `dietzReturn` carries full float precision.
 *
 * Precedence (first match wins; `rule` names which one fired). This order
 * is the spec's binding edge-precedence LIST ORDER — not a re-derivation —
 * so nonpositive-denominator is checked ahead of the flow-total
 * cross-checks even though it's computed from the same ledger data:
 *   1. December annual-summary row                                  → not_comparable / annual-summary-row
 *      (checked BEFORE any flow logic at all — a December
 *      annual-summary row's starting_value/deposits_withdrawals are
 *      CUMULATIVE-YEAR figures, not monthly ones; this must win even
 *      over a null deposits_withdrawals, which would otherwise read as
 *      flow-total-unavailable)
 *   2. missing V_start (no exact adjacent prior month-end snapshot,
 *      or no current-month snapshot at all)                          → insufficient / missing-v-start
 *   3. nonpositive denominator (V_start + Σ w_i·F_i ≤ 0)              → insufficient / nonpositive-denominator
 *      (fires even when deposits_withdrawals is null — this beats
 *      flow-total-unavailable too, since it's earlier in the list)
 *   4. |ledger CASH flow sum − deposits_withdrawals| > $1             → insufficient / flow-total-mismatch
 *      (in-kind flows are NEVER part of this comparison — they have no
 *      statement-reported counterpart; only evaluable when
 *      deposits_withdrawals is non-null)
 *   5. null deposits_withdrawals (nothing to cross-check the ledger
 *      against)                                                      → insufficient / flow-total-unavailable
 *   6. an anchor-source seam inside (priorMonthEnd, monthEndDate]     → not_comparable / seam-straddled
 *   7. otherwise                                                     → banded
 *
 * `missing-statement-twr` is declared for schema parity with the
 * reconciler (Task 13, which separately needs the statement's own `twr`
 * field to compare against) but is never produced by this module — this
 * module never reads `monthly_snapshots.twr`.
 */

import type Database from "better-sqlite3";
import {
  fetchMonthSnapshot,
  fetchPriorMonthTotal,
  isAnnualSummaryRow,
} from "@/lib/compute/monthly-snapshot-utils";
import {
  fetchNetFlowsByDate,
  fetchInKindFlowsByDate,
  fetchAnchorSourceSeamDates,
} from "@/lib/compute/flow-adjusted";

export const DIETZ_CONSISTENT_BP = 125;
export const DIETZ_FLOW_TOL_USD = 1.0;

export type DietzBand = "consistent" | "investigate" | "not_comparable" | "insufficient";

export interface MonthlyDietzResult {
  monthEndDate: string;
  dietzReturn: number | null;
  vStart: number | null;
  vEnd: number | null;
  netFlow: number;
  flowCount: number;
  seamStraddled: boolean;
  rule:
    | "annual-summary-row"
    | "missing-v-start"
    | "missing-statement-twr"
    | "nonpositive-denominator"
    | "flow-total-mismatch"
    | "flow-total-unavailable"
    | "seam-straddled"
    | "banded";
}

/** The last calendar day of monthEndDate's own month, e.g. "2026-04-30" → 30. */
function daysInMonth(monthEndDate: string): number {
  const [y, m] = monthEndDate.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The last calendar day of the month BEFORE monthEndDate's month — same
 *  recipe as monthly-snapshot-utils.ts's private priorMonthEndDate (not
 *  exported there, so duplicated here rather than reaching into it). */
function priorMonthEndDate(monthEndDate: string): string {
  const d = new Date(monthEndDate + "T00:00:00Z");
  const prior = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return prior.toISOString().slice(0, 10);
}

/** Day-of-month, 1-31, parsed directly from a YYYY-MM-DD date string. */
function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

function insufficientOrNotComparable(
  monthEndDate: string,
  vStart: number | null,
  vEnd: number | null,
  netFlow: number,
  flowCount: number,
  seamStraddled: boolean,
  rule: MonthlyDietzResult["rule"]
): MonthlyDietzResult {
  return {
    monthEndDate,
    dietzReturn: null,
    vStart,
    vEnd,
    netFlow,
    flowCount,
    seamStraddled,
    rule,
  };
}

export function computeMonthlyDietz(
  db: Database.Database,
  accountId: number,
  monthEndDate: string
): MonthlyDietzResult {
  const snap = fetchMonthSnapshot(db, accountId, monthEndDate);
  const vStart = fetchPriorMonthTotal(db, accountId, monthEndDate);
  const vEnd = snap?.total_value ?? null;

  // (1) December annual-summary row — checked BEFORE any flow logic, even
  // when deposits_withdrawals is null (precedence pin: this must win over
  // flow-total-unavailable).
  if (
    snap &&
    isAnnualSummaryRow(
      { month_end_date: snap.month_end_date, starting_value: snap.starting_value },
      vStart
    )
  ) {
    return insufficientOrNotComparable(monthEndDate, vStart, vEnd, 0, 0, false, "annual-summary-row");
  }

  // (2) Missing V_start — no exact adjacent prior month-end snapshot. A
  // missing current-month snapshot (no statement row at all) folds into the
  // same bucket: neither endpoint of the equation is available, and no
  // more specific rule string exists for that case.
  if (vStart === null || snap === null) {
    return insufficientOrNotComparable(monthEndDate, vStart, vEnd, 0, 0, false, "missing-v-start");
  }

  const priorMonthEnd = priorMonthEndDate(monthEndDate);
  const totalDaysInMonth = daysInMonth(monthEndDate);

  const cashFlows = fetchNetFlowsByDate(db, [accountId], priorMonthEnd, monthEndDate, {
    excludeInKind: true,
  });
  const inKindFlows = fetchInKindFlowsByDate(db, [accountId], priorMonthEnd, monthEndDate);

  const cashSum = cashFlows.reduce((s, f) => s + f.net, 0);
  const inKindSum = inKindFlows.reduce((s, f) => s + f.net, 0);
  const netFlow = cashSum + inKindSum;
  const flowCount = cashFlows.length + inKindFlows.length;

  const weight = (date: string): number => {
    const d = dayOfMonth(date);
    return (totalDaysInMonth - d) / totalDaysInMonth;
  };
  const weightedFlowTotal = [...cashFlows, ...inKindFlows].reduce(
    (s, f) => s + f.net * weight(f.date),
    0
  );
  const denominator = vStart + weightedFlowTotal;

  // (3) A degenerate denominator makes the return mathematically
  // meaningless (dividing by a near-zero or negative base). Checked ahead
  // of the flow-total cross-checks below — spec's edge-precedence list is
  // binding in its LISTED order (missing-v-start, nonpositive-denominator,
  // flow-total-mismatch, flow-total-unavailable), so this fires even when
  // deposits_withdrawals is null (collision regression test pins this).
  if (denominator <= 0) {
    return insufficientOrNotComparable(
      monthEndDate,
      vStart,
      vEnd,
      netFlow,
      flowCount,
      false,
      "nonpositive-denominator"
    );
  }

  // (4) The ledger's dated CASH flows don't reconcile with the statement's
  // reported total (in-kind flows are excluded from this comparison — they
  // have no statement-reported counterpart to reconcile against). Only
  // evaluable when deposits_withdrawals is non-null.
  if (
    snap.deposits_withdrawals !== null &&
    Math.abs(cashSum - snap.deposits_withdrawals) > DIETZ_FLOW_TOL_USD
  ) {
    return insufficientOrNotComparable(
      monthEndDate,
      vStart,
      vEnd,
      netFlow,
      flowCount,
      false,
      "flow-total-mismatch"
    );
  }

  // (5) The statement's own deposits_withdrawals is unavailable to
  // cross-check the ledger against.
  if (snap.deposits_withdrawals === null) {
    return insufficientOrNotComparable(
      monthEndDate,
      vStart,
      vEnd,
      netFlow,
      flowCount,
      false,
      "flow-total-unavailable"
    );
  }

  // (6) An anchor-source seam inside the month window mixes two
  // measurement bases into the value step — zero information, not a real
  // return, and therefore not comparable to the statement TWR.
  const seamDates = fetchAnchorSourceSeamDates(db, [accountId], priorMonthEnd, monthEndDate);
  if (seamDates.length > 0) {
    return insufficientOrNotComparable(
      monthEndDate,
      vStart,
      vEnd,
      netFlow,
      flowCount,
      true,
      "seam-straddled"
    );
  }

  // (7) Banded — the actual Modified Dietz return, full precision.
  const numerator = snap.total_value - vStart - netFlow;
  const dietzReturn = numerator / denominator;

  return {
    monthEndDate,
    dietzReturn,
    vStart,
    vEnd,
    netFlow,
    flowCount,
    seamStraddled: false,
    rule: "banded",
  };
}
