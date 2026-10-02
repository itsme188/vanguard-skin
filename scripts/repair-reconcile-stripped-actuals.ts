/**
 * repair-reconcile-stripped-actuals.ts — repairs earnings clusters damaged by
 * the pre-2026-10-02 reconciler (QA HIGH earnings-reconcile--printed-user-row-
 * loses-actuals-vendor-twin-resurfaces-sent-emails-read-pending).
 *
 * The defect: a manual, user_confirmed earnings row dated ON the print but
 * typed BEFORE it was judged a phantom. A whole-book reconcile then stripped
 * its actuals (`clearInheritedActuals`) and flipped the same-date vendor twin
 * back to canonical, while the manual row kept the sent preview/recap emails —
 * so the twin read as un-recapped and could draw a duplicate recap. The
 * reconciler is fixed (same-date agreement + evidence belt); this script
 * repairs rows the old code already damaged.
 *
 * A damaged cluster is:
 *   - a manual row: source='manual', date_status='user_confirmed',
 *     superseded=0, actual_value NULL, event_date <= today (ET), owning at
 *     least one DELIVERED earnings email (`deliveredSql`), and
 *   - at least one same-symbol, same-date, non-manual twin with superseded=0
 *     that carries an actual_value.
 *
 * The plan per cluster is exactly what a reconcile pass does to a losing row,
 * through the reconciler's own `createTwinFolder`: every live same-date twin
 * (freshest-enriched first) is marked superseded (date_status / conflict
 * cleared), its consensus / actual / reaction / enriched_at / matching
 * manual_actuals_at COALESCE onto the manual row, its audit children repoint
 * (UPDATE OR IGNORE — a duplicate recap colliding with the manual row's own
 * recap stays on the twin), and its registry state merges. One armed-events
 * outbox row is written when a merge moved anything, as the reconciler does.
 *
 * NOT touched: earnings_emails rows are never deleted — a duplicate recap on
 * the twin records a real delivery and is only REPORTED. The manual row's
 * raw_json (whose epsActual/revenueActual the old strip removed) is not
 * rebuilt: the reconciler never carries raw_json, and actual_value is what
 * every reader keys on.
 *
 * Idempotent: after an apply the manual row carries actual_value, so it no
 * longer matches, and a rerun finds nothing.
 *
 * Everything runs in ONE transaction; a dry run executes the full plan and
 * rolls it back, so the printed before→after table is the exact outcome.
 *
 * Usage (from the repo root — the `@/` alias resolves off the cwd tsconfig):
 *   npx tsx scripts/repair-reconcile-stripped-actuals.ts                  # dry run
 *   npx tsx scripts/repair-reconcile-stripped-actuals.ts --apply          # write
 *   npx tsx scripts/repair-reconcile-stripped-actuals.ts --db <path>      # or REPAIR_DB_PATH
 *   npx tsx scripts/repair-reconcile-stripped-actuals.ts --symbol XYZ     # one name
 */

import type Database from "better-sqlite3";
import { createTwinFolder, type TwinDonor } from "@/lib/calendar/reconcile-earnings-dates";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";
import { deliveredSql, sendStateFor } from "@/lib/earnings/email-states";

/** Columns the plan diffs on every row it touches. */
const DIFF_COLUMNS = [
  "superseded",
  "date_status",
  "date_conflict_with",
  "actual_value",
  "enriched_at",
  "reaction_snapshot",
  "consensus_estimate",
  "consensus_value",
  "manual_actuals_at",
] as const;

type DiffColumn = (typeof DIFF_COLUMNS)[number];
type Cell = string | number | null;

export interface ClusterEmail {
  id: number;
  eventId: number;
  phase: string;
  sentAt: string;
  state: string;
}

export interface StrippedActualsCluster {
  symbol: string;
  eventDate: string;
  manualId: number;
  /** Live same-date twins the repair folds into the manual row. */
  twinIds: number[];
  /**
   * Same-date vendor rows that carry a print and sit in the manual row's own
   * release slot (same release_time), superseded or not. They are folded
   * FIRST: `carryEnrichment` only fills empty columns, so the first donor's
   * actuals and reaction window win — a twin parked in the wrong slot (an AMC
   * time for a pre-open print) would otherwise donate a reaction snapshot
   * measured around the wrong timestamp.
   */
  slotDonorIds: number[];
  /** Emails on the manual row (kept). */
  manualEmails: ClusterEmail[];
  /** Emails on the twins — e.g. a duplicate recap. Reported, never deleted. */
  twinEmails: ClusterEmail[];
}

export interface RowChange {
  id: number;
  columns: Partial<Record<DiffColumn, { before: Cell; after: Cell }>>;
}

export interface EmailMove {
  id: number;
  fromEventId: number;
  toEventId: number;
}

export interface RepairReport {
  applied: boolean;
  today: string;
  clusters: StrippedActualsCluster[];
  changes: RowChange[];
  emailMoves: EmailMove[];
  outboxWritten: boolean;
}

interface TwinRow extends TwinDonor {
  enriched_at: string | null;
}

class DryRunRollback extends Error {}

function emailsFor(db: Database.Database, eventId: number): ClusterEmail[] {
  return (
    db
      .prepare(
        "SELECT id, event_id, phase, sent_at, error FROM earnings_emails WHERE event_id = ? ORDER BY id",
      )
      .all(eventId) as {
      id: number;
      event_id: number;
      phase: string;
      sent_at: string;
      error: string | null;
    }[]
  ).map((e) => ({
    id: e.id,
    eventId: e.event_id,
    phase: e.phase,
    sentAt: e.sent_at,
    state: sendStateFor(e.error),
  }));
}

/** Read-only: every damaged cluster, oldest print first. */
export function findStrippedActualsClusters(
  db: Database.Database,
  opts: { today: string; symbol?: string },
): StrippedActualsCluster[] {
  const symbol = opts.symbol?.trim().toUpperCase() || null;
  const manuals = db
    .prepare(
      `SELECT m.id, m.symbol, m.event_date
         FROM calendar_events m
        WHERE m.event_type = 'earnings'
          AND m.source = 'manual'
          AND m.date_status = 'user_confirmed'
          AND COALESCE(m.superseded, 0) = 0
          AND m.actual_value IS NULL
          AND m.event_date <= ?
          AND (? IS NULL OR UPPER(m.symbol) = ?)
          AND EXISTS (SELECT 1 FROM earnings_emails ee
                       WHERE ee.event_id = m.id AND ${deliveredSql("ee.error")})
          AND EXISTS (SELECT 1 FROM calendar_events t
                       WHERE t.event_type = 'earnings'
                         AND t.source != 'manual'
                         AND UPPER(t.symbol) = UPPER(m.symbol)
                         AND t.event_date = m.event_date
                         AND COALESCE(t.superseded, 0) = 0
                         AND t.actual_value IS NOT NULL)
        ORDER BY m.event_date, m.id`,
    )
    .all(opts.today, symbol, symbol) as { id: number; symbol: string; event_date: string }[];

  const twinsOf = db.prepare(
    `SELECT id FROM calendar_events
      WHERE event_type = 'earnings' AND source != 'manual'
        AND UPPER(symbol) = UPPER(?) AND event_date = ?
        AND COALESCE(superseded, 0) = 0
      ORDER BY COALESCE(enriched_at, '') DESC, id`,
  );

  const slotDonorsOf = db.prepare(
    `SELECT t.id FROM calendar_events t
       JOIN calendar_events m ON m.id = ?
      WHERE t.event_type = 'earnings' AND t.source != 'manual'
        AND UPPER(t.symbol) = UPPER(m.symbol) AND t.event_date = m.event_date
        AND t.actual_value IS NOT NULL
        AND m.release_time IS NOT NULL AND t.release_time = m.release_time
      ORDER BY COALESCE(t.enriched_at, '') DESC, t.id`,
  );

  return manuals.map((m) => {
    const twinIds = (twinsOf.all(m.symbol, m.event_date) as { id: number }[]).map((t) => t.id);
    const slotDonorIds = (slotDonorsOf.all(m.id) as { id: number }[]).map((t) => t.id);
    return {
      symbol: m.symbol,
      eventDate: m.event_date,
      manualId: m.id,
      twinIds,
      slotDonorIds,
      manualEmails: emailsFor(db, m.id),
      twinEmails: twinIds.flatMap((id) => emailsFor(db, id)),
    };
  });
}

function readRows(db: Database.Database, ids: number[]): Map<number, Record<DiffColumn, Cell>> {
  const stmt = db.prepare(`SELECT id, ${DIFF_COLUMNS.join(", ")} FROM calendar_events WHERE id = ?`);
  const out = new Map<number, Record<DiffColumn, Cell>>();
  for (const id of ids) out.set(id, stmt.get(id) as Record<DiffColumn, Cell>);
  return out;
}

function readEmailHomes(db: Database.Database, ids: number[]): Map<number, number> {
  const stmt = db.prepare("SELECT id, event_id FROM earnings_emails WHERE event_id = ?");
  const out = new Map<number, number>();
  for (const id of ids) {
    for (const e of stmt.all(id) as { id: number; event_id: number }[]) out.set(e.id, e.event_id);
  }
  return out;
}

/**
 * Plan (and with `apply`, commit) the repair. Always executes the full plan in
 * one transaction; a dry run rolls it back after measuring the diff.
 */
export function repairReconcileStrippedActuals(
  db: Database.Database,
  opts: { apply: boolean; today: string; symbol?: string },
): RepairReport {
  const report: RepairReport = {
    applied: false,
    today: opts.today,
    clusters: [],
    changes: [],
    emailMoves: [],
    outboxWritten: false,
  };

  const run = db.transaction(() => {
    report.clusters = findStrippedActualsClusters(db, opts);
    if (report.clusters.length === 0) return;

    const touched = [
      ...new Set(report.clusters.flatMap((c) => [c.manualId, ...c.slotDonorIds, ...c.twinIds])),
    ];
    const before = readRows(db, touched);
    const emailsBefore = readEmailHomes(db, touched);

    const fold = createTwinFolder(db);
    const twinStmt = db.prepare(
      `SELECT id, consensus_estimate, consensus_value, actual_value, manual_actuals_at,
              reaction_snapshot, enriched_at
         FROM calendar_events WHERE id = ?`,
    );
    // The reconciler's setCanonical for a user_confirmed winner.
    const setCanonical = db.prepare(
      `UPDATE calendar_events
          SET date_status = 'user_confirmed', date_conflict_with = NULL, superseded = 0
        WHERE id = ?`,
    );

    let anyMerged = false;
    for (const c of report.clusters) {
      setCanonical.run(c.manualId);
      // Slot-matched donors first (see StrippedActualsCluster.slotDonorIds), then every
      // remaining live twin; a row in both lists is folded once.
      const order = [...c.slotDonorIds, ...c.twinIds.filter((id) => !c.slotDonorIds.includes(id))];
      for (const twinId of order) {
        const twin = twinStmt.get(twinId) as TwinRow;
        const merged = fold(twin, c.manualId, c.eventDate);
        anyMerged ||= merged;
      }
    }
    if (anyMerged) {
      writeArmedEventsOutboxRow(db, { today: opts.today });
      report.outboxWritten = true;
    }

    const after = readRows(db, touched);
    for (const id of touched) {
      const b = before.get(id)!;
      const a = after.get(id)!;
      const columns: RowChange["columns"] = {};
      for (const col of DIFF_COLUMNS) {
        if (b[col] !== a[col]) columns[col] = { before: b[col], after: a[col] };
      }
      if (Object.keys(columns).length > 0) report.changes.push({ id, columns });
    }
    const homeStmt = db.prepare("SELECT event_id FROM earnings_emails WHERE id = ?");
    for (const [emailId, fromEventId] of emailsBefore) {
      const now = homeStmt.get(emailId) as { event_id: number } | undefined;
      if (now && now.event_id !== fromEventId) {
        report.emailMoves.push({ id: emailId, fromEventId, toEventId: now.event_id });
      }
    }

    if (!opts.apply) throw new DryRunRollback();
  });

  try {
    run();
    report.applied = opts.apply && report.clusters.length > 0;
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return report;
}

function printReport(r: RepairReport): void {
  console.log(`\nDamaged clusters: ${r.clusters.length}`);
  for (const c of r.clusters) {
    console.log(
      `\n  ${c.symbol} ${c.eventDate}: manual row ${c.manualId} ← twin row(s) ${c.twinIds.join(", ")}` +
        (c.slotDonorIds.length ? ` (slot-matched donor(s) first: ${c.slotDonorIds.join(", ")})` : ""),
    );
    for (const e of c.manualEmails) {
      console.log(`    manual email ${e.id}: ${e.phase} sent ${e.sentAt} (${e.state}) — kept`);
    }
    for (const e of c.twinEmails) {
      console.log(
        `    twin email ${e.id} on row ${e.eventId}: ${e.phase} sent ${e.sentAt} (${e.state}) — ` +
          `a real delivery, left in place (report only)`,
      );
    }
  }
  if (r.changes.length > 0) console.log("\nRow changes (before → after):");
  for (const ch of r.changes) {
    console.log(`  row ${ch.id}`);
    for (const [col, v] of Object.entries(ch.columns)) {
      console.log(`    ${col}: ${JSON.stringify(v!.before)} → ${JSON.stringify(v!.after)}`);
    }
  }
  for (const m of r.emailMoves) {
    console.log(`  email ${m.id}: event ${m.fromEventId} → ${m.toEventId}`);
  }
  if (r.outboxWritten) console.log("  + one armed-events cloud_outbox row");
}

// ─── CLI entry point ──────────────────────────────────────────────

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-reconcile-stripped-actuals.ts") ||
    process.argv[1].endsWith("repair-reconcile-stripped-actuals.js"));

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { runMigrations } = await import("@/lib/db/migrate");
    const { ensureBackup } = await import("@/scripts/rebuild-ibkr-ledger");
    const { todayET } = await import("@/lib/calendar/date-utils");
    const path = await import("node:path");
    const fs = await import("node:fs");

    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    function argValue(flag: string): string | undefined {
      const eqArg = args.find((a) => a.startsWith(`${flag}=`));
      if (eqArg) return eqArg.slice(flag.length + 1);
      const idx = args.indexOf(flag);
      if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
      return undefined;
    }

    const dataDir = process.env.VANGUARD_DB_DIR || path.default.join(process.cwd(), "data");
    const dbPath =
      argValue("--db") ?? process.env.REPAIR_DB_PATH ?? path.default.join(dataDir, "vanguard.db");
    const symbol = argValue("--symbol");

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    const today = todayET();
    console.log(
      `Repair reconcile-stripped actuals ${apply ? "[APPLY]" : "[DRY RUN]"} ` +
        `(db=${dbPath}, today=${today}${symbol ? `, symbol=${symbol.toUpperCase()}` : ""})`,
    );

    const plan = repairReconcileStrippedActuals(db, { apply: false, today, symbol });
    printReport(plan);

    if (plan.clusters.length === 0) {
      console.log("\nNothing to repair.");
      db.close();
      return;
    }
    if (!apply) {
      console.log("\nDry run (default). Re-run with --apply to write.");
      db.close();
      return;
    }

    // Backup FIRST — before runMigrations, which writes the moment a migration
    // is pending — and beside the target DB (so a --db rehearsal copy never
    // writes into the live data directory).
    const backupPath = path.default.join(
      path.default.dirname(dbPath),
      "backups",
      `pre-reconcile-stripped-actuals-repair-${today}.db`,
    );
    const backup = ensureBackup(db, backupPath);
    console.log(
      `\nBackup ${backup.created ? "created" : "already present"} at ${backup.path} ` +
        `(${backup.sizeBytes.toLocaleString()} bytes).`,
    );
    // A dry run never reaches this line, so it never migrates.
    runMigrations(db);

    const applied = repairReconcileStrippedActuals(db, { apply: true, today, symbol });
    console.log(
      `\nApplied: ${applied.clusters.length} cluster(s), ${applied.changes.length} row(s) changed.`,
    );
    db.close();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
