/**
 * The ONE copy of the owner-facing words for the Performance page's month
 * view. A plain module (no JSX, no imports from a "use client" file), so the
 * section component, any future surface and the guard test all read the same
 * sentences.
 *
 * A new refusal code or flow-evidence code in
 * `lib/compute/monthly-performance.ts` needs a sentence here before it can
 * reach a screen — `tests/dashboard/monthly-performance-month-view.test.ts`
 * fails on a code with no copy.
 */

import type {
  MonthlyFlowSource,
  MonthlyPerfMethod,
  MonthlyPerfRefusal,
} from "@/lib/compute/monthly-performance";

const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-03-31" → "March 2026". */
export function monthLabel(monthEndDate: string): string {
  const [y, m] = monthEndDate.split("-");
  return `${MONTH_FULL[Number(m) - 1]} ${y}`;
}

/** Why this month carries no figure, in owner-facing words. */
export const REFUSAL_TEXT: Record<MonthlyPerfRefusal, string> = {
  "no-statement": "no statement imported for this month",
  "no-prior-statement": "no statement for the prior month-end to measure from",
  "annual-summary-row":
    "the December statement reports year-to-date figures, not a single month",
  "statements-do-not-chain":
    "this statement does not open where the previous one closed",
  "no-measurable-base": "no positive opening balance to measure a return against",
  "flows-disagree":
    "the dated deposits and withdrawals do not add up to the total this statement reports, so the month cannot be measured",
};

/** How the month's deposits and withdrawals were established. */
export const FLOW_SOURCE_TEXT: Record<MonthlyFlowSource, string> = {
  "ledger-verified":
    "Deposits and withdrawals are dated from the ledger and match each statement’s own monthly total.",
  "ledger-unverified":
    "Deposits and withdrawals are dated from the ledger. A statement here reports no monthly total to check them against, so they are shown as recorded.",
  "statement-total":
    "The ledger disagreed with a statement’s own monthly deposit/withdrawal total, so that total is used instead — without dates, which puts every flow weight at zero.",
};

export const METHOD_TEXT: Record<MonthlyPerfMethod, string> = {
  "modified-dietz": "Modified Dietz",
  "undated-flows": "Modified Dietz with undated flows",
};

/**
 * The method sentence under the heading — the formula, stated on the surface
 * that uses it (brief: "METHOD, stated in the PR and in the UI copy").
 */
export const METHOD_BLURB =
  "One month at a time, from the stored month-end statement balances. Each account’s " +
  "return is Modified Dietz — (ending − opening − deposits and withdrawals) over the " +
  "opening balance plus each flow weighted by the share of the month it was invested. " +
  "Money paid in or taken out is never counted as performance. The blended figure adds " +
  "the accounts’ balances and flows and runs that same formula once; it is not an " +
  "average of their percentages.";
