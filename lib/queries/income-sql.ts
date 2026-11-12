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
 *   It pairs one-to-one with a DIVIDEND on the same account and the same
 *   security, dated up to 3 calendar days either side (same date first,
 *   then the nearest), for the same absolute amount to the cent, or,
 *   failing that, for the dividend minus ONE withholding row dated on
 *   the dividend's or the reinvestment's day (see `pairIncomeLegs`); every row is used at most
 *   once. A paired REINVESTMENT adds nothing, so a pair is counted once,
 *   on the DIVIDEND's date.
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
 * reads every row, whatever the outer date window. A pair that straddles
 * the window edge is counted in the period holding the dividend's date: a
 * window holding only the reinvestment shows nothing for it, one holding
 * only the dividend shows it whole, so adjacent windows never lose or
 * double it.
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

/** Every row the pairing reads (all dates: a pair may span up to 3 days). */
export function loadIncomeLegs(db: Database.Database): IncomeLeg[] {
  return db
    .prepare(
      `SELECT id, UPPER(type) AS type, account_id, security_id, trade_date, amount
       FROM transactions
       WHERE UPPER(type) IN ('DIVIDEND', 'REINVESTMENT', 'TAX_WITHHELD') AND amount IS NOT NULL`
    )
    .all() as IncomeLeg[];
}

/**
 * How far apart, in calendar days, a reinvestment and its dividend may be
 * dated (ruling 2026-11-12: brokers date some reinvestments a day or so
 * off their dividend, e.g. across a month end).
 */
export const INCOME_PAIR_MAX_GAP_DAYS = 3;

const cents = (amount: number) => Math.round(Math.abs(amount) * 100);
const byCentsThenId = (a: IncomeLeg, b: IncomeLeg) => cents(a.amount) - cents(b.amount) || a.id - b.id;
/** Calendar day number of a YYYY-MM-DD date (NaN for anything else). */
const dayNumber = (date: string) => Math.floor(Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`) / 86_400_000);

/**
 * Pair reinvestments with their dividends, one-to-one all the way down
 * (review RF-6, date window ruling 2026-11-12). Within one account and
 * security:
 *  1. gross: a REINVESTMENT pairs with a DIVIDEND of the same absolute
 *     amount to the cent;
 *  2. net: a REINVESTMENT pairs with a DIVIDEND (positive, still unpaired)
 *     and ONE TAX_WITHHELD row (still unused) when dividend -
 *     |withholding| = reinvestment to the cent (dividend 100, 15 withheld,
 *     85 reinvested). The withholding is dated on the DIVIDEND's day or,
 *     failing that, on the REINVESTMENT's day (real ledgers do both; one
 *     dated anywhere else never fits). It is read by magnitude: the ledger
 *     stores it with either sign.
 * The dividend may be dated up to INCOME_PAIR_MAX_GAP_DAYS calendar days
 * either side of the reinvestment. Passes run by gap: every reinvestment
 * first tries gap 0 (gross, then net), then gap 1, and so on, so a
 * same-date match always wins and a nearer match beats a farther one.
 * Each row is used at most once. Tie-break (deterministic, greedy):
 * reinvestments in order of amount then row id; each takes the first
 * fitting dividend in order of date (the earlier side first when both
 * sides are equally near), amount, row id, then withholding by amount and
 * row id. A gap-0 run is exactly the old same-day rule.
 *
 * The counted amount of a pair is the DIVIDEND row (the paired
 * reinvestment adds nothing), so the pair's income falls in the period of
 * the dividend's date wherever the reinvestment is dated.
 */
export function pairIncomeLegs(legs: readonly IncomeLeg[]): IncomePair[] {
  type Leg = IncomeLeg & { day: number };
  const groups = new Map<string, { d: Leg[]; r: Leg[]; w: Leg[] }>();
  for (const leg of legs) {
    const day = dayNumber(leg.trade_date);
    if (!Number.isFinite(day)) continue;
    const key = `${leg.account_id}|${leg.security_id ?? "null"}`;
    const g = groups.get(key) ?? { d: [], r: [], w: [] };
    const l: Leg = { ...leg, day };
    if (leg.type === "DIVIDEND") g.d.push(l);
    else if (leg.type === "REINVESTMENT") g.r.push(l);
    else if (leg.amount !== 0) g.w.push(l);
    groups.set(key, g);
  }
  const pairs: IncomePair[] = [];
  for (const g of groups.values()) {
    if (g.d.length === 0 || g.r.length === 0) continue;
    g.r.sort(byCentsThenId);
    // Dividends and withholdings by day, each day's list by amount then id.
    const byDay = (rows: Leg[]) => {
      const m = new Map<number, Leg[]>();
      for (const x of [...rows].sort(byCentsThenId)) {
        const list = m.get(x.day) ?? [];
        list.push(x);
        m.set(x.day, list);
      }
      return m;
    };
    const dByDay = byDay(g.d);
    const wByDay = byDay(g.w);
    const usedD = new Set<number>();
    const usedW = new Set<number>();
    const pairedR = new Set<number>();
    for (let gap = 0; gap <= INCOME_PAIR_MAX_GAP_DAYS; gap++) {
      // The earlier side first when both sides are equally near.
      const candidates = (r: Leg): Leg[] => {
        const days = gap === 0 ? [r.day] : [r.day - gap, r.day + gap];
        return days.flatMap((day) => dByDay.get(day) ?? []).filter((d) => !usedD.has(d.id));
      };
      for (const r of g.r) {
        if (pairedR.has(r.id)) continue;
        const d = candidates(r).find((x) => cents(x.amount) === cents(r.amount));
        if (d) {
          usedD.add(d.id);
          pairedR.add(r.id);
          pairs.push({ reinvestmentId: r.id, dividendId: d.id, withholdingId: null });
        }
      }
      if (g.w.length === 0) continue;
      for (const r of g.r) {
        if (pairedR.has(r.id)) continue;
        for (const d of candidates(r)) {
          if (d.amount <= 0) continue;
          const fits = (x: Leg) => !usedW.has(x.id) && cents(d.amount) - cents(x.amount) === cents(r.amount);
          const w = (wByDay.get(d.day) ?? []).find(fits) ?? (wByDay.get(r.day) ?? []).find(fits);
          if (w) {
            usedD.add(d.id);
            usedW.add(w.id);
            pairedR.add(r.id);
            pairs.push({ reinvestmentId: r.id, dividendId: d.id, withholdingId: w.id });
            break;
          }
        }
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
