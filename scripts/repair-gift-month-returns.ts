/**
 * Restate the stored monthly statement return in gift months
 * (owner ruling 2026-11-15; convention: DECISIONS 2026-10-07 ruling 1,
 * 2026-10-12 (evening) items 3-4 and "June 2026 restated on live").
 *
 * A gift of shares out of an account is an EXTERNAL OUTFLOW for performance,
 * not an investment loss. From September 2026 the stored `monthly_snapshots.twr`
 * already says so, and June 2026 was restated by hand on 2026-10-12. Earlier
 * gift months still store (end - start - cash flows) / start, which books the
 * gift as a loss. This script restates them with the SAME formula June used:
 *
 *   r = (E - S - C + G) / (S - SUM w_i * G_i),   w_i = (D - d_i) / D
 *
 *   S, E  the row's starting_value and total_value (statement figures)
 *   C     the row's deposits_withdrawals (cash only; it stays unchanged and
 *         keeps the weight the stored figure already gave it, end of month)
 *   G_i   each gift: an in-kind TRANSFER_OUT leg linked to a donation as its
 *         'out' leg (`donation_leg_links.role = 'out'`), at the leg's amount,
 *         which linking stamped with the fund's transfer-date fair value
 *   d_i   the leg's day of month; D the days in the month (end-of-day
 *         convention, the same weight `computeMonthlyDietz` uses)
 *
 * Routing-artifact legs, unlinked sub-account journals and every other
 * in-kind leg are NOT gifts and are left inside the month's gain, as June's
 * restatement left its one unlinked option journal.
 *
 * Columns written, per row, in one guarded UPDATE (it matches only while the
 * row still holds the values the plan read):
 *   twr              the restated return, rounded to the precision the stored
 *                    figure had (4 places for a statement-printed figure, as
 *                    June was stored; 6 for a computed one)
 *   investment_gain  the stored gain plus the gift total (gifts excluded, as
 *                    June and September store it)
 *   notes            a machine-readable marker carrying the ORIGINAL twr and
 *                    investment_gain, appended to any existing note, so the
 *                    statement's own figure stays recoverable from the row
 *                    itself (June's original lives only in a backup)
 * deposits_withdrawals is never touched (it stays cash-only).
 *
 * Nothing is hard-coded: every figure is read from the ledger and the row at
 * run time. A row is:
 *   pending          stored twr equals the unadjusted return; restated by --apply
 *   restated         carries this script's marker and already holds the
 *                    restated figures (a second run changes nothing)
 *   already-correct  no marker, but the stored twr already equals the restated
 *                    return (June and September 2026); left alone
 *   blocked          anything else (a figure matches neither state, the start
 *                    value disagrees with the prior month-end, a gift leg's
 *                    amount differs from the donation's value, a December
 *                    annual-summary row, a null field). --apply refuses while
 *                    any row is blocked.
 *
 * Output: returns and basis points per row, never a dollar figure.
 *
 * Usage (from the repo root; dry run is the default):
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-gift-month-returns.ts
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-gift-month-returns.ts --apply
 *   npx tsx scripts/repair-gift-month-returns.ts --db /path/to/copy.db [--apply]
 *
 * Rehearse --apply on a VACUUM copy first. A run against the live database
 * needs the owner's go, and --apply makes a VACUUM backup next to the database
 * before it writes.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  fetchPriorMonthTotal,
  isAnnualSummaryRow,
  priorMonthEndDate,
} from "../lib/compute/monthly-snapshot-utils";
import { reconcileTwrAgainstStatements } from "../lib/compute/twr-reconcile";

/** Statement row sources whose `twr` is a monthly statement return. */
const STATEMENT_SOURCES = ["canonical", "vanguard-pdf", "ibkr-activity"] as const;
/** The one source that stores `twr` as a percent (see snapshotTwrFraction). */
const PERCENT_SCALE_SOURCE = "ibkr-activity";

export const MARKER_PREFIX = "gift-month-restated";
const MARKER_RE = /gift-month-restated \S+: twr_was=(-?[0-9.eE+-]+) investment_gain_was=(-?[0-9.eE+-]+|null)/;

export type GiftMonthState = "pending" | "restated" | "already-correct" | "blocked";

export interface GiftLeg {
  transactionId: number;
  donationId: number;
  date: string;
  amount: number;
  weight: number;
}

export interface GiftMonthPlanRow {
  snapshotId: number;
  accountId: number;
  accountName: string;
  monthEndDate: string;
  source: string;
  state: GiftMonthState;
  reason: string | null;
  gifts: GiftLeg[];
  giftTotal: number;
  /** Gift total as a share of the start-of-month value. */
  giftShareOfStart: number | null;
  /** Fractions (never percent), whatever the stored scale. */
  storedTwr: number | null;
  unadjustedTwr: number | null;
  restatedTwr: number | null;
  /** Decimal places the restated figure is stored with (fraction scale). */
  precision: number;
  /** The figures the guarded UPDATE writes (stored scale), when pending. */
  write: { twr: number; investmentGain: number; notes: string } | null;
  /** The figures the guarded UPDATE requires to still be there. */
  expect: { twr: number | null; investmentGain: number | null; notes: string | null };
  /** Other dated flows in the month, for the operator's eye. */
  cashFlowTotal: number | null;
  otherInKindNet: number;
}

export interface GiftMonthPlan {
  rows: GiftMonthPlanRow[];
  counts: Record<GiftMonthState, number>;
}

interface SnapshotRow {
  id: number;
  account_id: number;
  account_name: string;
  month_end_date: string;
  source: string;
  starting_value: number | null;
  total_value: number;
  deposits_withdrawals: number | null;
  twr: number | null;
  investment_gain: number | null;
  notes: string | null;
}

function daysInMonth(monthEndDate: string): number {
  const [y, m] = monthEndDate.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function roundTo(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

/** 4 places when the figure is a 4-place number (a statement-printed
 *  return, as June 2026 was stored), else 6 (a computed one). */
export function storedPrecision(twrFraction: number): number {
  return Math.abs(roundTo(twrFraction, 4) - twrFraction) < 1e-9 ? 4 : 6;
}

function sameAt(a: number, b: number, places: number): boolean {
  return Math.abs(a - b) <= 0.5 * 10 ** -places + 1e-9;
}

/**
 * The restated return under the June 2026 convention. Exported so the test
 * pins the formula directly. Fractions in, fraction out.
 */
export function giftAdjustedReturn(input: {
  startValue: number;
  endValue: number;
  cashFlows: number;
  gifts: Array<{ amount: number; weight: number }>;
}): number {
  const g = input.gifts.reduce((s, x) => s + x.amount, 0);
  const wg = input.gifts.reduce((s, x) => s + x.amount * x.weight, 0);
  return (input.endValue - input.startValue - input.cashFlows + g) / (input.startValue - wg);
}

function markerText(runDate: string, twrStored: number, igStored: number | null): string {
  return `${MARKER_PREFIX} ${runDate}: twr_was=${twrStored} investment_gain_was=${igStored ?? "null"} (gifts as dated outflows, DECISIONS 2026-11-15)`;
}

export function parseMarker(notes: string | null): { twr: number; investmentGain: number | null } | null {
  if (!notes) return null;
  const m = MARKER_RE.exec(notes);
  if (!m) return null;
  return { twr: Number(m[1]), investmentGain: m[2] === "null" ? null : Number(m[2]) };
}

export function planGiftMonthRestatement(
  db: Database.Database,
  opts: { runDate: string },
): GiftMonthPlan {
  // Every statement month that holds at least one linked gift OUT leg.
  const months = db
    .prepare(
      `SELECT DISTINCT ms.id, ms.account_id, a.name AS account_name, ms.month_end_date, ms.source,
              ms.starting_value, ms.total_value, ms.deposits_withdrawals, ms.twr,
              ms.investment_gain, ms.notes
         FROM monthly_snapshots ms
         JOIN accounts a ON a.id = ms.account_id
         JOIN transactions t ON t.account_id = ms.account_id
         JOIN donation_leg_links l ON l.transaction_id = t.id AND l.role = 'out'
        WHERE ms.source IN (${STATEMENT_SOURCES.map(() => "?").join(",")})
          AND t.type = 'TRANSFER_OUT' AND t.security_id IS NOT NULL
          AND t.trade_date > date(ms.month_end_date, 'start of month', '-1 day')
          AND t.trade_date <= ms.month_end_date
        ORDER BY ms.account_id, ms.month_end_date`,
    )
    .all(...STATEMENT_SOURCES) as SnapshotRow[];

  const giftLegs = db.prepare(
    `SELECT t.id AS transaction_id, l.donation_id, t.trade_date, t.amount, t.is_external_flow,
            d.fmv_usd, d.kind
       FROM transactions t
       JOIN donation_leg_links l ON l.transaction_id = t.id AND l.role = 'out'
       JOIN donations d ON d.id = l.donation_id
      WHERE t.account_id = ? AND t.type = 'TRANSFER_OUT' AND t.security_id IS NOT NULL
        AND t.trade_date > ? AND t.trade_date <= ?
      ORDER BY t.trade_date, t.id`,
  );
  const otherInKind = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN t.type = 'TRANSFER_OUT' THEN -ABS(t.amount) ELSE t.amount END), 0) AS net
       FROM transactions t
       LEFT JOIN donation_leg_links l ON l.transaction_id = t.id AND l.role = 'out'
      WHERE t.account_id = ? AND t.type IN ('TRANSFER_IN','TRANSFER_OUT') AND t.security_id IS NOT NULL
        AND t.is_external_flow = 1 AND l.id IS NULL
        AND t.trade_date > ? AND t.trade_date <= ?`,
  );

  const rows: GiftMonthPlanRow[] = [];
  for (const r of months) {
    const prior = priorMonthEndDate(r.month_end_date);
    const D = daysInMonth(r.month_end_date);
    const legRows = giftLegs.all(r.account_id, prior, r.month_end_date) as Array<{
      transaction_id: number;
      donation_id: number;
      trade_date: string;
      amount: number | null;
      is_external_flow: number;
      fmv_usd: number;
      kind: string;
    }>;
    const gifts: GiftLeg[] = legRows.map((g) => ({
      transactionId: g.transaction_id,
      donationId: g.donation_id,
      date: g.trade_date,
      amount: Math.abs(g.amount ?? 0),
      weight: (D - Number(g.trade_date.slice(8, 10))) / D,
    }));
    const giftTotal = gifts.reduce((s, g) => s + g.amount, 0);
    const otherInKindNet = (otherInKind.get(r.account_id, prior, r.month_end_date) as { net: number }).net;

    const scale = r.source === PERCENT_SCALE_SOURCE ? 100 : 1;
    const storedTwr = r.twr === null ? null : r.twr / scale;
    const marker = parseMarker(r.notes);
    const originalTwr = marker ? marker.twr / scale : storedTwr;
    const precision = originalTwr === null ? 6 : storedPrecision(originalTwr);

    const base: GiftMonthPlanRow = {
      snapshotId: r.id,
      accountId: r.account_id,
      accountName: r.account_name,
      monthEndDate: r.month_end_date,
      source: r.source,
      state: "blocked",
      reason: null,
      gifts,
      giftTotal,
      giftShareOfStart: r.starting_value ? giftTotal / r.starting_value : null,
      storedTwr,
      unadjustedTwr: null,
      restatedTwr: null,
      precision,
      write: null,
      expect: { twr: r.twr, investmentGain: r.investment_gain, notes: r.notes },
      cashFlowTotal: r.deposits_withdrawals,
      otherInKindNet,
    };
    const block = (reason: string) => rows.push({ ...base, state: "blocked", reason });

    const priorTotal = fetchPriorMonthTotal(db, r.account_id, r.month_end_date);
    if (isAnnualSummaryRow({ month_end_date: r.month_end_date, starting_value: r.starting_value }, priorTotal)) {
      block("December annual-summary row");
      continue;
    }
    if (r.starting_value === null || r.starting_value <= 0) {
      block("no starting value");
      continue;
    }
    if (priorTotal === null || Math.abs(priorTotal - r.starting_value) > 1) {
      block("starting value differs from the prior month-end statement");
      continue;
    }
    if (r.deposits_withdrawals === null) {
      block("no deposits_withdrawals");
      continue;
    }
    if (storedTwr === null || originalTwr === null) {
      block("no stored return");
      continue;
    }
    const badLeg = legRows.find(
      (g) => g.kind !== "stock" || g.is_external_flow !== 1 || g.amount === null || Math.abs(Math.abs(g.amount) - g.fmv_usd) > 0.01,
    );
    if (badLeg) {
      block(`gift leg ${badLeg.transaction_id} is not an external in-kind flow at the donation's value`);
      continue;
    }

    const S = r.starting_value;
    const E = r.total_value;
    const C = r.deposits_withdrawals;
    const unadjusted = (E - S - C) / S;
    const restated = giftAdjustedReturn({ startValue: S, endValue: E, cashFlows: C, gifts });
    const restatedStored = roundTo(restated, precision) * scale;
    const withRow = { ...base, unadjustedTwr: unadjusted, restatedTwr: restated };

    if (marker) {
      const igOk =
        marker.investmentGain === null
          ? r.investment_gain === null
          : r.investment_gain !== null && Math.abs(r.investment_gain - roundTo(marker.investmentGain + giftTotal, 2)) <= 0.005;
      if (sameAt(storedTwr, restated, precision) && igOk) {
        rows.push({ ...withRow, state: "restated" });
      } else {
        rows.push({ ...withRow, state: "blocked", reason: "marker present but the row no longer holds the restated figures" });
      }
      continue;
    }
    if (sameAt(storedTwr, restated, precision)) {
      rows.push({ ...withRow, state: "already-correct" });
      continue;
    }
    if (!sameAt(storedTwr, unadjusted, precision)) {
      rows.push({
        ...withRow,
        state: "blocked",
        reason: "stored return matches neither the unadjusted nor the restated return",
      });
      continue;
    }
    if (r.investment_gain === null) {
      rows.push({ ...withRow, state: "blocked", reason: "no stored investment_gain" });
      continue;
    }
    const mark = markerText(opts.runDate, r.twr as number, r.investment_gain);
    rows.push({
      ...withRow,
      state: "pending",
      write: {
        twr: restatedStored,
        investmentGain: roundTo(r.investment_gain + giftTotal, 2),
        notes: r.notes && r.notes.trim() !== "" ? `${r.notes}; ${mark}` : mark,
      },
    });
  }

  const counts: Record<GiftMonthState, number> = { pending: 0, restated: 0, "already-correct": 0, blocked: 0 };
  for (const row of rows) counts[row.state] += 1;
  return { rows, counts };
}

export interface GiftMonthResult {
  plan: GiftMonthPlan;
  applied: boolean;
  updated: number;
}

export function runGiftMonthRestatement(
  db: Database.Database,
  opts: { apply?: boolean; runDate: string },
): GiftMonthResult {
  const plan = planGiftMonthRestatement(db, { runDate: opts.runDate });
  if (!opts.apply) return { plan, applied: false, updated: 0 };
  if (plan.counts.blocked > 0) {
    throw new Error(`refusing --apply: ${plan.counts.blocked} row(s) blocked (see the table)`);
  }
  const update = db.prepare(
    `UPDATE monthly_snapshots
        SET twr = ?, investment_gain = ?, notes = ?
      WHERE id = ? AND twr IS ? AND investment_gain IS ? AND notes IS ?`,
  );
  let updated = 0;
  db.transaction(() => {
    for (const row of plan.rows) {
      if (row.state !== "pending" || !row.write) continue;
      const res = update.run(
        row.write.twr,
        row.write.investmentGain,
        row.write.notes,
        row.snapshotId,
        row.expect.twr,
        row.expect.investmentGain,
        row.expect.notes,
      );
      if (res.changes !== 1) {
        throw new Error(`snapshot ${row.snapshotId} changed since the plan was read; nothing written`);
      }
      updated += 1;
    }
  })();
  return { plan, applied: true, updated };
}

function pct(x: number | null, places = 4): string {
  return x === null ? "-" : `${(x * 100).toFixed(places)}%`;
}

function printResult(db: Database.Database, result: GiftMonthResult): void {
  const { plan } = result;
  console.log(
    "account            month       state            gifts share   stored     restated   change   cross-check",
  );
  for (const r of plan.rows) {
    const target = r.restatedTwr === null ? null : roundTo(r.restatedTwr, r.precision);
    const changeBp =
      r.state === "pending" && target !== null && r.storedTwr !== null
        ? `${((target - r.storedTwr) * 1e4).toFixed(1)}bp`
        : "-";
    const rec = reconcileTwrAgainstStatements(db, r.accountId, r.monthEndDate);
    // In a dry run the stored figure is still the old one; show the band the
    // restated figure would get against the same ledger-derived return.
    let band = rec?.band ?? "-";
    if (!result.applied && r.state === "pending" && rec?.dietzReturn != null && target !== null) {
      const gap = Math.abs(target - rec.dietzReturn) * 1e4;
      band = `${rec.band} -> ${gap <= 125 ? "consistent" : "investigate"} (${gap.toFixed(0)}bp)`;
    } else if (rec?.divergenceBp != null) {
      band = `${rec.band} (${rec.divergenceBp}bp)`;
    }
    console.log(
      [
        r.accountName.padEnd(18),
        r.monthEndDate.padEnd(11),
        r.state.padEnd(16),
        String(r.gifts.length).padEnd(5),
        (r.giftShareOfStart === null ? "-" : `${(r.giftShareOfStart * 100).toFixed(2)}%`).padEnd(7),
        pct(r.storedTwr).padEnd(10),
        pct(target).padEnd(10),
        changeBp.padEnd(8),
        band,
      ].join(" "),
    );
    if (r.reason) console.log(`    blocked: ${r.reason}`);
    if (r.cashFlowTotal) console.log("    note: the month also has a cash flow (kept at the stored figure's end-of-month weight)");
    if (Math.abs(r.otherInKindNet) > 0.005) {
      console.log("    note: unlinked in-kind legs in the month do not net to zero (left in the gain, as June did)");
    }
  }
  const c = plan.counts;
  console.log(
    `\npending ${c.pending}, restated ${c.restated}, already-correct ${c["already-correct"]}, blocked ${c.blocked}` +
      (result.applied ? `; updated ${result.updated} row(s)` : "; dry run, nothing written"),
  );
}

/**
 * The database to read: `--db <path>`, else REPAIR_DB_PATH. There is NO
 * default: from the main checkout a cwd-relative default is the live
 * database (review 2026-11-15, R7). null when neither names one.
 */
export function resolveDbPath(argv: string[], env: { REPAIR_DB_PATH?: string } = process.env): string | null {
  const i = argv.indexOf("--db");
  if (i >= 0) {
    const p = argv[i + 1];
    if (!p || p.startsWith("--")) throw new Error("--db needs a path");
    return path.resolve(p);
  }
  const fromEnv = env.REPAIR_DB_PATH;
  return fromEnv && fromEnv.trim() !== "" ? path.resolve(fromEnv) : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dbPath = resolveDbPath(argv);
  if (dbPath === null) {
    console.error("No database named. Pass --db <path> or set REPAIR_DB_PATH (there is no default).");
    process.exitCode = 1;
    return;
  }
  // Printed BEFORE the database is opened (rehearsable-repair rule).
  console.log(`[repair-gift-month-returns] mode=${apply ? "APPLY" : "dry-run"}, db: ${dbPath}`);

  const db = new BetterSqlite3(dbPath, { readonly: !apply, fileMustExist: true, timeout: 60_000 });
  try {
    const { todayET } = await import("../lib/calendar/date-utils");
    const runDate = todayET();
    // A run with nothing to write (the second run) makes no backup.
    if (apply && planGiftMonthRestatement(db, { runDate }).counts.pending > 0) {
      db.pragma("foreign_keys = ON");
      // Relative specifier: the "@/" alias is not resolved for dynamic imports
      // outside the repo cwd.
      const { ensureBackup } = await import("./rebuild-ibkr-ledger");
      const backupPath = path.join(
        path.dirname(dbPath),
        "backups",
        `pre-gift-month-returns-${new Date().toISOString().replace(/:/g, "-")}.db`,
      );
      const backup = ensureBackup(db, backupPath);
      console.log(`Backup ${backup.created ? "created" : "already present"} at ${backup.path}`);
    }
    printResult(db, runGiftMonthRestatement(db, { apply, runDate }));
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith("repair-gift-month-returns.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
