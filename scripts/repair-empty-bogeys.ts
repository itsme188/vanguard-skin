/**
 * repair-empty-bogeys.ts — remove stored bogey rows that hold nothing.
 *
 * Why it exists (owner ruling 2026-08-12, option 3): a bogey row whose every
 * content column is empty is not coverage, yet any surface that asks "does
 * this event have bogeys?" by counting rows counts it. New ones are no longer
 * stored (`upsertBogey` skips them and the manual route refuses them) and the
 * bogeys modal no longer lists them, but the rows stored before that stay in
 * the table until this one-time purge.
 *
 * What it changes: it DELETES rows of `earnings_bogeys`, and only rows where
 * every content column is empty — the same rule the write path applies,
 * `bogeyHasContentSql` in lib/mutations/earnings-bogeys.ts (no figure, no
 * vendor figure, no guidance, no notes, no segment split, no extra metric).
 * A row with a note and no number is NOT empty and is left alone. Nothing
 * else is touched: an empty row feeds no sheet line, so no live sheet needs
 * re-deriving, and no table references a bogey row.
 *
 * Usage (from the repo root — tsx resolves the "@/" alias off the tsconfig it
 * finds from cwd):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-empty-bogeys.ts
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-empty-bogeys.ts --apply
 *
 * Dry run is the default and opens the database read-only. `--apply` deletes
 * every listed row in one transaction. Running it again changes nothing.
 * REPAIR_DB_PATH overrides the database path so --apply can be rehearsed on a
 * copy (`sqlite3 data/vanguard.db "VACUUM INTO '/tmp/rehearsal.db'"`) before
 * it is ever pointed at the live file.
 *
 * The output names each row's id, its event (id, symbol, date), its source
 * and source label, and counts. An empty row has no figure to print. It runs
 * on the owner's machine; do not paste its output into a committed file.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { bogeyHasContentSql } from "@/lib/mutations/earnings-bogeys";

// ─── Shapes ─────────────────────────────────────────────────────────

export interface RepairEmptyBogeysOptions {
  apply?: boolean;
}

export interface EmptyBogeyRow {
  id: number;
  eventId: number;
  symbol: string | null;
  eventDate: string | null;
  source: string;
  sourceLabel: string | null;
}

export interface EmptyBogeyRepairPlan {
  /** Every bogey row examined. */
  totalRows: number;
  /** Rows with every content column empty. */
  emptyRows: EmptyBogeyRow[];
  /** Events whose ONLY bogey rows are empty: these lose the "has bogeys" mark. */
  eventsLeftWithoutBogeys: number;
}

// ─── Plan ───────────────────────────────────────────────────────────

/** Read-only. Lists what an apply would delete. */
export function planEmptyBogeyRepair(db: Database.Database): EmptyBogeyRepairPlan {
  const { n: totalRows } = db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get() as { n: number };
  const emptyRows = db
    .prepare(
      `SELECT b.id AS id, b.event_id AS eventId, ce.symbol AS symbol, ce.event_date AS eventDate,
              b.source AS source, b.source_label AS sourceLabel
         FROM earnings_bogeys b
         LEFT JOIN calendar_events ce ON ce.id = b.event_id
        WHERE NOT ${bogeyHasContentSql("b")}
        ORDER BY b.id`,
    )
    .all() as EmptyBogeyRow[];
  const { n: eventsLeftWithoutBogeys } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT b.event_id FROM earnings_bogeys b
          GROUP BY b.event_id
         HAVING SUM(CASE WHEN ${bogeyHasContentSql("b")} THEN 1 ELSE 0 END) = 0
       )`,
    )
    .get() as { n: number };
  return { totalRows, emptyRows, eventsLeftWithoutBogeys };
}

/**
 * Plan, then (only with `apply`) delete. The plan is resolved INSIDE the write
 * transaction and each delete repeats the emptiness rule, so a row that gained
 * content between the read and the write is not removed; any listed row that
 * does not delete exactly once rolls the whole run back.
 */
export function runEmptyBogeyRepair(
  db: Database.Database,
  opts: RepairEmptyBogeysOptions = {},
): { plan: EmptyBogeyRepairPlan; applied: boolean; deleted: number } {
  if (!opts.apply) return { plan: planEmptyBogeyRepair(db), applied: false, deleted: 0 };

  const del = db.prepare(`DELETE FROM earnings_bogeys WHERE id = ? AND NOT ${bogeyHasContentSql()}`);
  const result = db.transaction(() => {
    const plan = planEmptyBogeyRepair(db);
    let deleted = 0;
    for (const row of plan.emptyRows) {
      const { changes } = del.run(row.id);
      if (changes !== 1) {
        throw new Error(`bogey id ${row.id}: expected to delete 1 row, deleted ${changes}; nothing was written`);
      }
      deleted += changes;
    }
    return { plan, deleted };
  })();
  return { ...result, applied: true };
}

// ─── Output ─────────────────────────────────────────────────────────

function label(value: string | null): string {
  return value == null || value.trim() === "" ? "<none>" : `"${value}"`;
}

/** Ids, symbols, dates, source labels and counts. Never a figure. */
export function formatPlan(plan: EmptyBogeyRepairPlan, applied = false): string[] {
  const lines: string[] = [];
  lines.push(`bogey rows examined:                         ${plan.totalRows}`);
  lines.push(`${applied ? "deleted" : "would delete"} (every content column empty): ${plan.emptyRows.length}`);
  lines.push(`events whose only bogey rows are empty:      ${plan.eventsLeftWithoutBogeys}`);
  if (plan.emptyRows.length > 0) {
    lines.push("");
    lines.push(`Rows ${applied ? "deleted" : "that would be deleted"}:`);
    for (const r of plan.emptyRows) {
      lines.push(
        `  bogey id ${r.id}: event id ${r.eventId} [${r.symbol ?? "?"} ${r.eventDate ?? "?"}], ` +
          `source "${r.source}", label ${label(r.sourceLabel)}`,
      );
    }
  }
  return lines;
}

// ─── CLI ────────────────────────────────────────────────────────────

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
const KNOWN_FLAGS = new Set(["--apply"]);

export function parseArgs(argv: string[]): RepairEmptyBogeysOptions {
  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`unknown argument ${arg} (known: ${[...KNOWN_FLAGS].join(", ")})`);
    }
  }
  return { apply: argv.includes("--apply") };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = new BetterSqlite3(DB_PATH, { readonly: !opts.apply, fileMustExist: true }) as Database.Database;

  try {
    console.log(`Empty bogey repair ${opts.apply ? "[APPLY]" : "[DRY RUN]"}, db: ${DB_PATH}\n`);
    const { plan, applied, deleted } = runEmptyBogeyRepair(db, opts);
    for (const line of formatPlan(plan, applied)) console.log(line);

    if (!applied) {
      console.log("\nDry run (default): nothing was written. Re-run with --apply to delete.");
      console.log(
        "Rehearse first: sqlite3 <db> \"VACUUM INTO '/tmp/rehearsal.db'\" then REPAIR_DB_PATH=/tmp/rehearsal.db ... --apply",
      );
      return;
    }
    console.log(`\nDeleted ${deleted} empty bogey row(s). Reload Today to see the hub chips.`);
  } finally {
    db.close();
  }
}

// Detect direct execution (not an import from tests) — mirrors
// scripts/repair-option-sectors.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-empty-bogeys.ts") || process.argv[1].endsWith("repair-empty-bogeys.js"));

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
