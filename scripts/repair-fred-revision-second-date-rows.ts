/**
 * Remove stored Housing Starts revision-slot rows (owner ruling 2026-11-01,
 * item 4; DECISIONS 2026-11-01).
 *
 * FRED release 27 (New Residential Construction) lists two dates a month: the
 * print and, about a week later, a Census revision slot that carries no new
 * observation. Before the ruling the calendar sync made a row for each, so
 * every month showed two "<Month> Housing Starts" rows. The sync now skips
 * the later date (`dropRevisionSecondDates`, lib/calendar/macro-events.ts),
 * and an UN-enriched leftover is removed by the next refresh of its week. An
 * ENRICHED leftover is history to the sync and stays; this script lists and
 * removes those.
 *
 * Rule: rows with source_key `fred:27:<date>` are grouped by the reporting
 * period of that date (year included, lag one month, `reportingPeriodKey`).
 * In a group of two or more, the EARLIEST date is kept and every later row is
 * a candidate.
 *
 * Apply refuses (exit non-zero, nothing written) when:
 *   - a candidate carries an actual and the kept row of its period has none
 *     (deleting it would delete the only recorded figure), or
 *   - any other table points at a candidate (every foreign key to
 *     calendar_events cascades, so the delete would take those rows too;
 *     print_watch_prints and earnings_wire_observations are checked by their
 *     event_id column, which has no foreign key).
 *
 * No suppression row is written: `calendar_event_suppressions` is keyed by
 * symbol and is read for company events only; macro rows have no symbol, and
 * the sync no longer re-creates the revision date anyway.
 *
 * `--since YYYY-MM-DD` limits the run to periods whose kept (earliest) row
 * is dated on or after that day. The early-2026 schedule carried catch-up
 * prints (04-29, 05-05, 05-21, 05-28), which the one-month-lag period rule
 * cannot tell apart from a revision slot; those periods refuse, and
 * `--since` lets the regular monthly pairs after them be repaired.
 *
 * Output is ids, dates, titles and yes/no flags. No figure is printed.
 *
 * Usage (from the repo root; dry run is the default):
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-fred-revision-second-date-rows.ts
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-fred-revision-second-date-rows.ts --apply
 *   npx tsx scripts/repair-fred-revision-second-date-rows.ts --db /path/to/copy.db [--since 2026-06-01] [--apply]
 */
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import path from "node:path";
import { reportingPeriodKey } from "@/lib/calendar/macro-events";

const RELEASE_ID = 27;
const REPORTING_LAG = 1;
const KEY_PREFIX = `fred:${RELEASE_ID}:`;

interface StoredRow {
  id: number;
  date: string;
  title: string;
  hasActual: boolean;
  enriched: boolean;
}

export interface RevisionCandidate extends StoredRow {
  period: string;
  keptId: number;
  keptDate: string;
  keptHasActual: boolean;
  /** `table: count` for every other table holding this row's id. */
  dependents: string[];
  /** Why apply would refuse this candidate; null when it may go. */
  refusal: string | null;
}

export interface RevisionPlan {
  rowsScanned: number;
  candidates: RevisionCandidate[];
}

export interface RevisionResult extends RevisionPlan {
  applied: boolean;
  deleted: number;
  refused: boolean;
}

function readRows(db: Database.Database): StoredRow[] {
  const raw = db
    .prepare(
      `SELECT id, source_key, title,
              actual_value IS NOT NULL AS has_actual,
              (actual_value IS NOT NULL OR enriched_at IS NOT NULL) AS enriched
         FROM calendar_events
        WHERE source_key LIKE ?
        ORDER BY id`,
    )
    .all(`${KEY_PREFIX}%`) as {
    id: number;
    source_key: string;
    title: string;
    has_actual: number;
    enriched: number;
  }[];
  return raw
    .map((r) => ({
      id: r.id,
      // The date comes from the source key: that is the date FRED listed.
      date: r.source_key.slice(KEY_PREFIX.length),
      title: r.title,
      hasActual: r.has_actual === 1,
      enriched: r.enriched === 1,
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}

/** Every (table, column) that holds a calendar_events id. */
function dependentColumns(db: Database.Database): { table: string; column: string }[] {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((t) => t.name);
  const out: { table: string; column: string }[] = [];
  for (const table of tables) {
    if (table === "calendar_events") continue;
    const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
      table: string;
      from: string;
    }[];
    for (const fk of fks) {
      if (fk.table === "calendar_events") out.push({ table, column: fk.from });
    }
  }
  // Keyed on the event id without a foreign key (evidence tables).
  for (const table of ["print_watch_prints", "earnings_wire_observations"]) {
    if (tables.includes(table) && !out.some((d) => d.table === table)) {
      out.push({ table, column: "event_id" });
    }
  }
  return out;
}

function dependentsOf(
  db: Database.Database,
  cols: { table: string; column: string }[],
  id: number,
): string[] {
  const found: string[] = [];
  for (const { table, column } of cols) {
    const n = (
      db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`).get(id) as { n: number }
    ).n;
    if (n > 0) found.push(`${table}: ${n}`);
  }
  return found;
}

export function planFredRevisionRepair(
  db: Database.Database,
  opts: { since?: string } = {},
): RevisionPlan {
  const rows = readRows(db);
  const groups = new Map<string, StoredRow[]>();
  for (const r of rows) {
    const period = reportingPeriodKey(r.date, REPORTING_LAG);
    if (period === null) continue;
    const g = groups.get(period) ?? [];
    g.push(r);
    groups.set(period, g);
  }
  const cols = dependentColumns(db);
  const candidates: RevisionCandidate[] = [];
  for (const [period, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const kept = sorted[0];
    if (opts.since !== undefined && kept.date < opts.since) continue;
    for (const r of sorted.slice(1)) {
      const dependents = dependentsOf(db, cols, r.id);
      let refusal: string | null = null;
      if (r.hasActual && !kept.hasActual) {
        refusal = `carries an actual and the kept row ${kept.id} (${kept.date}) has none`;
      } else if (dependents.length > 0) {
        refusal = `other rows point at it (${dependents.join(", ")})`;
      }
      candidates.push({
        ...r,
        period,
        keptId: kept.id,
        keptDate: kept.date,
        keptHasActual: kept.hasActual,
        dependents,
        refusal,
      });
    }
  }
  return { rowsScanned: rows.length, candidates };
}

export function runFredRevisionRepair(
  db: Database.Database,
  opts: { apply: boolean; since?: string },
): RevisionResult {
  const plan = planFredRevisionRepair(db, { since: opts.since });
  const refused = plan.candidates.some((c) => c.refusal !== null);
  if (!opts.apply || refused || plan.candidates.length === 0) {
    return { ...plan, applied: false, deleted: 0, refused: opts.apply && refused };
  }
  let deleted = 0;
  db.transaction(() => {
    const keptExists = db.prepare("SELECT 1 FROM calendar_events WHERE id = ? AND source_key = ?");
    const del = db.prepare("DELETE FROM calendar_events WHERE id = ? AND source_key = ?");
    for (const c of plan.candidates) {
      if (!keptExists.get(c.keptId, `${KEY_PREFIX}${c.keptDate}`)) {
        throw new Error(
          `kept row ${c.keptId} (${c.keptDate}) is gone; refusing to delete ${c.id} (${c.date}). Nothing was written.`,
        );
      }
      deleted += del.run(c.id, `${KEY_PREFIX}${c.date}`).changes;
    }
  })();
  return { ...plan, applied: true, deleted, refused: false };
}

function printResult(r: RevisionResult): void {
  console.log(`Housing Starts rows scanned: ${r.rowsScanned}`);
  console.log(`Revision second-date candidates: ${r.candidates.length}`);
  for (const c of r.candidates) {
    console.log(
      `  id ${c.id}  ${c.date}  "${c.title}"  period ${c.period}` +
        `  enriched=${c.enriched ? "yes" : "no"} actual=${c.hasActual ? "yes" : "no"}` +
        `  kept: id ${c.keptId} ${c.keptDate} (actual=${c.keptHasActual ? "yes" : "no"})` +
        `  dependents: ${c.dependents.length ? c.dependents.join(", ") : "none"}` +
        (c.refusal ? `  REFUSE: ${c.refusal}` : ""),
    );
  }
  if (r.applied) console.log(`Applied: ${r.deleted} row(s) deleted.`);
  else if (r.refused) console.log("REFUSED: nothing was written (see REFUSE lines).");
  else console.log("Dry run (default). Re-run with --apply on a rehearsed copy to write.");
}

function resolveDbPath(argv: string[]): string {
  const i = argv.indexOf("--db");
  if (i >= 0) {
    const p = argv[i + 1];
    if (!p || p.startsWith("--")) throw new Error("--db needs a path");
    return path.resolve(p);
  }
  return process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
}

function resolveSince(argv: string[]): string | undefined {
  const i = argv.indexOf("--since");
  if (i < 0) return undefined;
  const d = argv[i + 1];
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("--since needs a YYYY-MM-DD date");
  return d;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dbPath = resolveDbPath(argv);
  const since = resolveSince(argv);
  // Printed BEFORE the database is opened (rehearsable-repair rule).
  console.log(`[repair-fred-revision-second-date-rows] mode=${apply ? "APPLY" : "dry-run"}${since ? `, since=${since}` : ""}, db: ${dbPath}`);

  const db = new BetterSqlite3(dbPath, { readonly: !apply, fileMustExist: true, timeout: 60_000 });
  try {
    if (apply) {
      db.pragma("foreign_keys = ON");
      const plan = planFredRevisionRepair(db, { since });
      if (plan.candidates.length > 0 && !plan.candidates.some((c) => c.refusal)) {
        // Relative specifier: the "@/" alias is not resolved for dynamic imports
        // outside the repo cwd.
        const { ensureBackup } = await import("./rebuild-ibkr-ledger");
        const backupPath = path.join(
          path.dirname(dbPath),
          "backups",
          `pre-fred-revision-repair-${new Date().toISOString().replace(/:/g, "-")}.db`,
        );
        const backup = ensureBackup(db, backupPath);
        console.log(`Backup ${backup.created ? "created" : "already present"} at ${backup.path}`);
      }
    }
    const result = runFredRevisionRepair(db, { apply, since });
    printResult(result);
    if (result.refused) process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith("repair-fred-revision-second-date-rows.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
