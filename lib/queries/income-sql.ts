import type Database from "better-sqlite3";

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
 *   cent, or, failing that, for the dividend minus ONE of that day's
 *   withholding rows (see `pairIncomeLegs`); every row is used at most
 *   once. A paired REINVESTMENT adds nothing.
 * - A negative unpaired REINVESTMENT is not income; it is counted
 *   (`UNPAIRED_NEGATIVE_REINVESTMENT_SQL`) so the reader can say so.
 * - Interest earned = positive INTEREST amounts; interest paid = the
 *   magnitude of negative INTEREST amounts (margin interest is a cost).
 * - Fees keep their current rule (ruling P6): ABS of FEE and COMMISSION.
 * - Net income = dividends + interest earned - interest paid - fees.
 *
 * Usage: put `incomePairingCtes(db)` inside a WITH clause, select from
 * `transactions t` with `INCOME_PAIRED_JOIN`, filter rows with
 * `INCOME_TYPES_SQL`, and sum the per-row expressions below. The pairing
 * reads every row (pairing is within one trade date, so a date window on
 * the outer query never splits a pair).
 */

/** One DIVIDEND, REINVESTMENT or TAX_WITHHELD row, as the pairing reads it. */
export interface IncomeLeg {
  id: number;
  type: "DIVIDEND" | "REINVESTMENT" | "TAX_WITHHELD";
  account_id: number;
  security_id: number | null;
  trade_date: string;
  amount: number;
}

/** One reinvestment and the dividend it is the purchase leg of. */
export interface IncomePair {
  reinvestmentId: number;
  dividendId: number;
  /** The withholding row the net match used; null for a gross match. */
  withholdingId: number | null;
}

/** Every row the pairing reads (all dates: a pair never spans two days). */
export function loadIncomeLegs(db: Database.Database): IncomeLeg[] {
  return db
    .prepare(
      `SELECT id, UPPER(type) AS type, account_id, security_id, trade_date, amount
       FROM transactions
       WHERE UPPER(type) IN ('DIVIDEND', 'REINVESTMENT', 'TAX_WITHHELD') AND amount IS NOT NULL`
    )
    .all() as IncomeLeg[];
}

const cents = (amount: number) => Math.round(Math.abs(amount) * 100);
const byCentsThenId = (a: IncomeLeg, b: IncomeLeg) => cents(a.amount) - cents(b.amount) || a.id - b.id;

/**
 * Pair reinvestments with their dividends, one-to-one all the way down
 * (review RF-6). Within one account, security and trade date:
 *  1. gross: a REINVESTMENT pairs with a DIVIDEND of the same absolute
 *     amount to the cent;
 *  2. net: a REINVESTMENT still unpaired pairs with a DIVIDEND (positive,
 *     still unpaired) and ONE TAX_WITHHELD row (still unused) when
 *     dividend - |withholding| = reinvestment to the cent (dividend 100,
 *     15 withheld, 85 reinvested). The withholding is read by magnitude:
 *     the ledger stores it with either sign (both are present in real
 *     data, the positive form more often).
 * Each row is used at most once. Tie-break (deterministic, greedy):
 * reinvestments are taken in order of amount then row id, and each takes
 * the first fitting dividend (then withholding) in order of amount then
 * row id.
 */
export function pairIncomeLegs(legs: readonly IncomeLeg[]): IncomePair[] {
  const groups = new Map<string, { d: IncomeLeg[]; r: IncomeLeg[]; w: IncomeLeg[] }>();
  for (const leg of legs) {
    const key = `${leg.account_id}|${leg.security_id ?? "null"}|${leg.trade_date}`;
    const g = groups.get(key) ?? { d: [], r: [], w: [] };
    if (leg.type === "DIVIDEND") g.d.push(leg);
    else if (leg.type === "REINVESTMENT") g.r.push(leg);
    else if (leg.amount !== 0) g.w.push(leg);
    groups.set(key, g);
  }
  const pairs: IncomePair[] = [];
  for (const g of groups.values()) {
    if (g.d.length === 0 || g.r.length === 0) continue;
    g.d.sort(byCentsThenId);
    g.r.sort(byCentsThenId);
    g.w.sort(byCentsThenId);
    const usedD = new Set<number>();
    const usedW = new Set<number>();
    const unpairedR: IncomeLeg[] = [];
    for (const r of g.r) {
      const d = g.d.find((x) => !usedD.has(x.id) && cents(x.amount) === cents(r.amount));
      if (d) {
        usedD.add(d.id);
        pairs.push({ reinvestmentId: r.id, dividendId: d.id, withholdingId: null });
      } else {
        unpairedR.push(r);
      }
    }
    if (g.w.length === 0) continue;
    for (const r of unpairedR) {
      let found: { d: IncomeLeg; w: IncomeLeg } | null = null;
      for (const d of g.d) {
        if (usedD.has(d.id) || d.amount <= 0) continue;
        const w = g.w.find((x) => !usedW.has(x.id) && cents(d.amount) - cents(x.amount) === cents(r.amount));
        if (w) {
          found = { d, w };
          break;
        }
      }
      if (found) {
        usedD.add(found.d.id);
        usedW.add(found.w.id);
        pairs.push({ reinvestmentId: r.id, dividendId: found.d.id, withholdingId: found.w.id });
      }
    }
  }
  return pairs;
}

/**
 * The CTE that defines `paired_reinvestments(id)`, no leading WITH. The
 * pairing runs in `pairIncomeLegs` (one-to-one matching is not a SQL
 * join); the ids are integers read from this database, spliced as a JSON
 * array.
 */
export function incomePairingCtes(db: Database.Database): string {
  const ids = pairIncomeLegs(loadIncomeLegs(db)).map((p) => Math.trunc(p.reinvestmentId));
  return `paired_reinvestments AS MATERIALIZED (
    SELECT CAST(value AS INTEGER) AS id FROM json_each('${JSON.stringify(ids)}')
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
