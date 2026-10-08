/**
 * repair-stranded-earnings-suppressions.ts — lift earnings-date suppressions
 * that have left a company with no earnings date at all.
 *
 * Why it exists (owner ruling 2026-09-02, option 2): "Fix date" on the
 * Earnings Hub deletes the vendor's wrong-dated row, records a suppression for
 * that (symbol, date) so no sync re-inserts it, and mints a corrected manual
 * row. Removing that corrected row afterwards left the suppression behind: the
 * company had no earnings event and no vendor sync could bring one back. The
 * delete confirm now offers "Remove and restore vendor date"; this script is
 * the one-time repair for suppressions stranded before that.
 *
 * What counts as stranded: an earnings suppression whose company (the symbol
 * and its share-class siblings) has NO earnings row of any source, live or
 * superseded, within 45 days either side of the suppressed date. While any
 * such row exists the suppression is doing its job and is left alone.
 *
 * What it cannot tell: a stranded suppression looks the same whether it came
 * from "Fix date" followed by a remove, or from a vendor row the owner removed
 * on purpose with the row's remove button (which is meant to stay removed).
 * So `--apply` never lifts by itself: it lifts only the stranded suppressions
 * of the symbols named with `--symbols`. The dry run lists every candidate so
 * the owner can choose.
 *
 * What it changes: it DELETEs the chosen rows of `calendar_event_suppressions`
 * and nothing else. No calendar event is created; the vendor's date returns on
 * the next calendar sync, if the vendor still carries it. Lifting a suppression
 * for a date already past changes nothing unless that week is synced again.
 *
 * Usage (from the repo root — tsx resolves the "@/" alias off the tsconfig it
 * finds from cwd):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-stranded-earnings-suppressions.ts
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-stranded-earnings-suppressions.ts --apply --symbols AAA,BBB
 *
 * Dry run is the default and opens the database read-only. `--apply` writes
 * every change in one transaction. Running it again changes nothing.
 * REPAIR_DB_PATH overrides the database path so --apply can be rehearsed on a
 * copy (`sqlite3 data/vanguard.db "VACUUM INTO '/tmp/rehearsal.db'"`) before
 * it is ever pointed at the live file.
 *
 * The output names suppression ids, ticker symbols, dates and the stored
 * reason text: public calendar data only, no quantity, price or dollar figure.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { issuerSiblings } from "@/lib/securities/issuer-family";

// ─── Shapes ─────────────────────────────────────────────────────────

/** Days either side of the suppressed date that count as "the same print". */
export const SAME_PRINT_WINDOW_DAYS = 45;

export interface RepairSuppressionsOptions {
  apply?: boolean;
  /** Symbols whose stranded suppressions `--apply` lifts. Uppercased. */
  symbols?: string[];
  /** ET today; injectable for tests. */
  today?: string;
}

export interface StrandedSuppression {
  id: number;
  symbol: string;
  eventDate: string;
  reason: string | null;
  /** The suppressed date is today or later, so a sync can still restore it. */
  upcoming: boolean;
  /** Named in `symbols`: an apply lifts it. */
  selected: boolean;
}

export interface SuppressionRepairPlan {
  /** Every earnings suppression examined. */
  examined: number;
  /** The company still has an earnings row near the date: left alone. */
  covered: number;
  stranded: StrandedSuppression[];
  /** Symbols named in `symbols` that have no stranded suppression. */
  unmatchedSymbols: string[];
}

// ─── Plan ───────────────────────────────────────────────────────────

/** Read-only. Decides, row by row, what an apply would lift. */
export function planSuppressionRepair(
  db: Database.Database,
  opts: RepairSuppressionsOptions = {},
): SuppressionRepairPlan {
  const today = opts.today ?? todayET();
  const selected = new Set((opts.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean));

  const suppressions = db
    .prepare(
      `SELECT id, symbol, event_date, reason
         FROM calendar_event_suppressions
        WHERE event_type = 'earnings'
        ORDER BY id`,
    )
    .all() as Array<{ id: number; symbol: string; event_date: string; reason: string | null }>;

  const plan: SuppressionRepairPlan = {
    examined: suppressions.length,
    covered: 0,
    stranded: [],
    unmatchedSymbols: [],
  };

  for (const s of suppressions) {
    const symbol = s.symbol.trim().toUpperCase();
    const family = Array.from(
      new Set([symbol, ...issuerSiblings(symbol).map((f) => f.trim().toUpperCase())]),
    );
    const near = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM calendar_events
          WHERE event_type = 'earnings'
            AND symbol IS NOT NULL
            AND UPPER(symbol) IN (${family.map(() => "?").join(", ")})
            AND event_date BETWEEN ? AND ?`,
      )
      .get(
        ...family,
        addDays(s.event_date, -SAME_PRINT_WINDOW_DAYS),
        addDays(s.event_date, SAME_PRINT_WINDOW_DAYS),
      ) as { n: number };
    if (near.n > 0) {
      plan.covered += 1;
      continue;
    }
    plan.stranded.push({
      id: s.id,
      symbol,
      eventDate: s.event_date,
      reason: s.reason,
      upcoming: s.event_date >= today,
      selected: selected.has(symbol),
    });
  }

  const strandedSymbols = new Set(plan.stranded.map((s) => s.symbol));
  plan.unmatchedSymbols = [...selected].filter((s) => !strandedSymbols.has(s)).sort();
  return plan;
}

/**
 * Plan, then (only with `apply`) lift the selected stranded suppressions. The
 * plan is resolved INSIDE the write transaction, so what is lifted is what
 * that same read decided; a row that does not delete exactly once rolls the
 * whole run back.
 */
export function runSuppressionRepair(
  db: Database.Database,
  opts: RepairSuppressionsOptions = {},
): { plan: SuppressionRepairPlan; applied: boolean; lifted: number } {
  if (!opts.apply) return { plan: planSuppressionRepair(db, opts), applied: false, lifted: 0 };
  if (!opts.symbols || opts.symbols.length === 0) {
    throw new Error(
      "--apply needs --symbols: this script cannot tell a stranded correction from a row removed on purpose, so it lifts only the symbols you name",
    );
  }

  const remove = db.prepare(
    "DELETE FROM calendar_event_suppressions WHERE id = ? AND event_type = 'earnings'",
  );
  const result = db.transaction(() => {
    const plan = planSuppressionRepair(db, opts);
    let lifted = 0;
    for (const s of plan.stranded) {
      if (!s.selected) continue;
      const { changes } = remove.run(s.id);
      if (changes !== 1) {
        throw new Error(`suppression id ${s.id}: expected to delete 1 row, deleted ${changes}; nothing was written`);
      }
      lifted += changes;
    }
    return { plan, lifted };
  })();
  return { ...result, applied: true };
}

// ─── Output ─────────────────────────────────────────────────────────

/** Ids, symbols, dates, reason text and counts. Never a figure. */
export function formatPlan(plan: SuppressionRepairPlan, applied = false): string[] {
  const lines: string[] = [];
  const selected = plan.stranded.filter((s) => s.selected);
  lines.push(`earnings suppressions examined:            ${plan.examined}`);
  lines.push(`left alone, company still has a date near: ${plan.covered}`);
  lines.push(`stranded (company has no earnings date):   ${plan.stranded.length}`);
  lines.push(`${applied ? "lifted" : "would lift (named with --symbols)"}: ${selected.length}`);

  if (plan.stranded.length > 0) {
    lines.push("");
    lines.push("Stranded suppressions:");
    for (const s of plan.stranded) {
      const when = s.upcoming ? "upcoming" : "past; lifting changes nothing unless that week is synced again";
      const action = s.selected ? (applied ? "LIFTED" : "would lift") : "kept (not named)";
      lines.push(
        `  id ${s.id} [${s.symbol}] ${s.eventDate} (${when}): ${action}; reason: ${s.reason ?? "<none>"}`,
      );
    }
  }
  if (plan.unmatchedSymbols.length > 0) {
    lines.push("");
    lines.push(`Named but not stranded, nothing to lift: ${plan.unmatchedSymbols.join(", ")}`);
  }
  return lines;
}

// ─── CLI ────────────────────────────────────────────────────────────

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

export function parseArgs(argv: string[]): RepairSuppressionsOptions {
  const opts: RepairSuppressionsOptions = { apply: false, symbols: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      opts.apply = true;
    } else if (arg === "--symbols") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--symbols needs a comma-separated list, e.g. --symbols AAA,BBB");
      opts.symbols = value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else {
      throw new Error(`unknown argument ${arg} (known: --apply, --symbols A,B)`);
    }
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = new BetterSqlite3(DB_PATH, { readonly: !opts.apply, fileMustExist: true }) as Database.Database;

  try {
    console.log(`Stranded earnings suppressions ${opts.apply ? "[APPLY]" : "[DRY RUN]"}, db: ${DB_PATH}\n`);
    const { plan, applied, lifted } = runSuppressionRepair(db, opts);
    for (const line of formatPlan(plan, applied)) console.log(line);

    if (!applied) {
      console.log("\nDry run (default): nothing was written. Re-run with --apply --symbols A,B to lift those symbols.");
      console.log(
        "Rehearse first: sqlite3 <db> \"VACUUM INTO '/tmp/rehearsal.db'\" then REPAIR_DB_PATH=/tmp/rehearsal.db ... --apply --symbols A,B",
      );
      return;
    }
    console.log(
      `\nLifted ${lifted} suppression(s). Use "Refresh from Finnhub" on the Today page to bring the vendor dates back.`,
    );
  } finally {
    db.close();
  }
}

// Detect direct execution (not an import from tests) — mirrors
// scripts/repair-option-sectors.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-stranded-earnings-suppressions.ts") ||
    process.argv[1].endsWith("repair-stranded-earnings-suppressions.js"));

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
