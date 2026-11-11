/**
 * Income semantics, as SQL fragments: the ONE copy (plan 2026-11-11,
 * Contract J and ruling P13). Read by the chat income tool
 * (`getIncomeSummaryForChat`, lib/queries/chat-tools.ts) and the dashboard
 * income reader (`getIncomeSummary`, lib/queries/income.ts).
 *
 * - Dividend income = signed DIVIDEND amounts (a reversal nets), plus a
 *   REINVESTMENT amount only when it is positive and UNPAIRED.
 * - A REINVESTMENT is the purchase leg of a DIVIDEND, not a second payout.
 *   It pairs one-to-one with a DIVIDEND on the same account, the same
 *   security and the same trade date for the same absolute amount to the
 *   cent, or, failing that, for the dividend minus that day's TAX_WITHHELD
 *   (see `incomePairingCtes`); each DIVIDEND pairs with at most one
 *   REINVESTMENT (ranked by row id within that key). A paired
 *   REINVESTMENT adds nothing.
 * - A negative unpaired REINVESTMENT is not income; it is counted
 *   (`UNPAIRED_NEGATIVE_REINVESTMENT_SQL`) so the reader can say so.
 * - Interest earned = positive INTEREST amounts; interest paid = the
 *   magnitude of negative INTEREST amounts (margin interest is a cost).
 * - Fees keep their current rule (ruling P6): ABS of FEE and COMMISSION.
 * - Net income = dividends + interest earned - interest paid - fees.
 *
 * Usage: put `incomePairingCtes()` inside a WITH clause, select from
 * `transactions t` with `INCOME_PAIRED_JOIN`, filter rows with
 * `INCOME_TYPES_SQL`, and sum the per-row expressions below. The pairing
 * CTEs read every row (pairing is within one trade date, so a date window
 * on the outer query never splits a pair).
 */

/** Same account, security and day, same amount to the cent; ranked by id. */
function rankedLegs(name: string, type: string): string {
  return `${name} AS (
    SELECT t.id, t.account_id, t.security_id, t.trade_date,
           CAST(ROUND(ABS(t.amount) * 100) AS INTEGER) AS cents,
           ROW_NUMBER() OVER (
             PARTITION BY t.account_id, t.security_id, t.trade_date, CAST(ROUND(ABS(t.amount) * 100) AS INTEGER)
             ORDER BY t.id
           ) AS leg_rank
    FROM transactions t
    WHERE UPPER(t.type) = '${type}' AND t.amount IS NOT NULL
  )`;
}

/** The pair key: same account, security (NULL matches NULL), day, cents and rank. */
const PAIR_ON = `d.account_id = r.account_id
     AND d.security_id IS r.security_id
     AND d.trade_date = r.trade_date
     AND d.cents = r.cents
     AND d.leg_rank = r.leg_rank`;

/**
 * The CTEs that define `paired_reinvestments(id)`. No leading WITH.
 *
 * Two passes, each one-to-one:
 *  1. gross: a REINVESTMENT equal to its DIVIDEND;
 *  2. net of withholding (review R2-2): among the legs pass 1 left, a
 *     REINVESTMENT equal to its DIVIDEND minus the same-day TAX_WITHHELD on
 *     the same account and security (dividend 100, 15 withheld, 85
 *     reinvested). Only dividends with withholding that day take part.
 * The withheld tax itself is not an income row (unchanged): dividend
 * income stays the gross payout.
 */
export function incomePairingCtes(): string {
  return `${rankedLegs("income_dividend_legs", "DIVIDEND")},
  ${rankedLegs("income_reinvestment_legs", "REINVESTMENT")},
  income_gross_pairs AS (
    SELECT r.id AS reinvestment_id, d.id AS dividend_id
    FROM income_reinvestment_legs r
    JOIN income_dividend_legs d ON ${PAIR_ON}
  ),
  income_withheld AS (
    SELECT t.account_id, t.security_id, t.trade_date, SUM(ABS(t.amount)) AS withheld
    FROM transactions t
    WHERE UPPER(t.type) = 'TAX_WITHHELD' AND t.amount IS NOT NULL
    GROUP BY t.account_id, t.security_id, t.trade_date
  ),
  income_net_dividend_legs AS (
    SELECT x.id, x.account_id, x.security_id, x.trade_date, x.cents,
           ROW_NUMBER() OVER (PARTITION BY x.account_id, x.security_id, x.trade_date, x.cents ORDER BY x.id) AS leg_rank
    FROM (
      SELECT t.id, t.account_id, t.security_id, t.trade_date,
             CAST(ROUND((ABS(t.amount) - w.withheld) * 100) AS INTEGER) AS cents
      FROM transactions t
      JOIN income_withheld w
        ON w.account_id = t.account_id AND w.security_id IS t.security_id AND w.trade_date = t.trade_date
      WHERE UPPER(t.type) = 'DIVIDEND' AND t.amount IS NOT NULL
        AND t.id NOT IN (SELECT dividend_id FROM income_gross_pairs)
    ) x
  ),
  income_net_reinvestment_legs AS (
    SELECT x.id, x.account_id, x.security_id, x.trade_date, x.cents,
           ROW_NUMBER() OVER (PARTITION BY x.account_id, x.security_id, x.trade_date, x.cents ORDER BY x.id) AS leg_rank
    FROM income_reinvestment_legs x
    WHERE x.id NOT IN (SELECT reinvestment_id FROM income_gross_pairs)
  ),
  paired_reinvestments AS (
    SELECT reinvestment_id AS id FROM income_gross_pairs
    UNION ALL
    SELECT r.id
    FROM income_net_reinvestment_legs r
    JOIN income_net_dividend_legs d ON ${PAIR_ON}
  )`;
}

/** Joins the pairing result onto `transactions t` as `pr`. */
export const INCOME_PAIRED_JOIN = "LEFT JOIN paired_reinvestments pr ON pr.id = t.id";

/** The rows any income figure reads. */
export const INCOME_TYPES_SQL =
  "UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT', 'INTEREST', 'FEE', 'COMMISSION')";

/** Per-row dividend income (sum it). Needs `t` and `pr`. */
export const DIVIDEND_INCOME_SQL = `(CASE
  WHEN UPPER(t.type) = 'DIVIDEND' THEN COALESCE(t.amount, 0)
  WHEN UPPER(t.type) = 'REINVESTMENT' AND pr.id IS NULL AND t.amount > 0 THEN t.amount
  ELSE 0 END)`;

/** Per-row interest earned (sum it). */
export const INTEREST_EARNED_SQL = `(CASE WHEN UPPER(t.type) = 'INTEREST' AND t.amount > 0 THEN t.amount ELSE 0 END)`;

/** Per-row interest paid, as a positive magnitude (sum it). */
export const INTEREST_PAID_SQL = `(CASE WHEN UPPER(t.type) = 'INTEREST' AND t.amount < 0 THEN -t.amount ELSE 0 END)`;

/** Per-row fees, as a positive magnitude (sum it). Unchanged rule (P6). */
export const FEES_SQL = `(CASE WHEN UPPER(t.type) IN ('FEE', 'COMMISSION') THEN ABS(COALESCE(t.amount, 0)) ELSE 0 END)`;

/** Per-row net income contribution (sum it). */
export const NET_INCOME_SQL = `(${DIVIDEND_INCOME_SQL} + ${INTEREST_EARNED_SQL} - ${INTEREST_PAID_SQL} - ${FEES_SQL})`;

/** Per-row 1 for a negative unpaired REINVESTMENT left out of income (sum it). */
export const UNPAIRED_NEGATIVE_REINVESTMENT_SQL = `(CASE WHEN UPPER(t.type) = 'REINVESTMENT' AND pr.id IS NULL AND t.amount < 0 THEN 1 ELSE 0 END)`;
