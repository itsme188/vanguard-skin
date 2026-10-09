/**
 * Dry-run-default repair for stored reaction snapshots that are not
 * measurements (owner ruling 2026-10-08, finding
 * `today-week-ahead--reaction-line-zero-pct-from-window-that-never-elapsed`).
 *
 * The test is the shared one — lib/calendar/reaction-validity.ts, the same
 * function the capture gate and the renderers use. Per stored snapshot:
 *
 *   - captured before its window ended (`captured_at` < t0 + window_min):
 *     the whole snapshot is CLEARED (reaction_snapshot = NULL);
 *   - otherwise, legs that are not measurements (an identical pre/post pair,
 *     a 0.00% leg on a row enriched before the window could have been
 *     measured, or the old all-zero placeholder):
 *       - release still inside the runner's re-capture window (release + 150
 *         minutes): the whole snapshot is CLEARED so the runner captures
 *         every leg again on its next tick;
 *       - older than that: only the bad legs are REMOVED and the measured
 *         legs are kept, because the runner will not come back for this row
 *         and the good legs cannot be re-read later. With no usable
 *         SPY/QQQ/TLT leg left the snapshot is CLEARED.
 *
 * A cleared row outside the re-capture window stays empty. It can be
 * backfilled by hand, while the vendor still keeps one-minute bars, with
 * `scripts/backfill-reaction-from-yahoo.ts <eventId>` (that script goes to the
 * network; this one never does).
 *
 * It touches reaction_snapshot only: never actual_value, consensus_value,
 * enriched_at or any email row. It prints event ids, dates, tickers and
 * reasons, never a price. Running it twice changes nothing the second time.
 *
 * Usage (rehearse on a copy first, from the repo root):
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-premature-reaction-snapshots.ts
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-premature-reaction-snapshots.ts --apply --acknowledge-repair
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { parseReactionSnapshot } from "../lib/calendar/reaction-snapshot-core";
import {
  assessReactionSnapshot,
  parseUtcInstantMs,
  REACTION_RECAPTURE_HORIZON_MS,
  withoutReactionLegs,
  type ReactionLegKey,
} from "../lib/calendar/reaction-validity";

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
const ACK_FLAG = "--acknowledge-repair";

interface SnapshotRow {
  id: number;
  event_type: string;
  event_date: string;
  symbol: string | null;
  title: string | null;
  enriched_at: string | null;
  reaction_snapshot: string;
}

export type ReactionRepairAction = "clear" | "strip_legs";

export interface ReactionRepairItem {
  eventId: number;
  eventDate: string;
  /** Ticker for an earnings row, else the event type. Public calendar data. */
  label: string;
  action: ReactionRepairAction;
  reasons: string[];
  /** Legs removed by a strip (empty for a clear). */
  strippedLegs: ReactionLegKey[];
  /** A cleared row the runner will capture again on a coming tick. */
  willBeRecaptured: boolean;
  /** Exact stored text this plan was made from (guards the write). */
  before: string;
  /** New stored text; null clears. */
  after: string | null;
}

export interface ReactionRepairPlan {
  scanned: number;
  unreadable: number;
  items: ReactionRepairItem[];
}

export function planPrematureReactionRepair(
  db: Database.Database,
  opts: { now?: Date } = {},
): ReactionRepairPlan {
  const nowMs = (opts.now ?? new Date()).getTime();
  const rows = db
    .prepare(
      `SELECT id, event_type, event_date, symbol, title, enriched_at, reaction_snapshot
         FROM calendar_events
        WHERE reaction_snapshot IS NOT NULL
        ORDER BY event_date, id`,
    )
    .all() as SnapshotRow[];

  let unreadable = 0;
  const items: ReactionRepairItem[] = [];
  for (const row of rows) {
    const snap = parseReactionSnapshot(row.reaction_snapshot);
    if (!snap || typeof snap !== "object" || typeof snap.t0_utc !== "string") {
      // Not this script's class of problem; left exactly as stored.
      unreadable += 1;
      continue;
    }
    const assessment = assessReactionSnapshot(snap, { rowEnrichedAt: row.enriched_at });
    if (assessment.valid) continue;

    const t0Ms = parseUtcInstantMs(snap.t0_utc);
    const insideRecapture =
      t0Ms != null && nowMs - t0Ms >= 0 && nowMs - t0Ms <= REACTION_RECAPTURE_HORIZON_MS;

    const reasons: string[] = [];
    if (assessment.premature) reasons.push("captured before its window ended");
    for (const leg of assessment.pendingLegs) reasons.push(`${leg.key}: ${leg.reason}`);
    for (const key of assessment.placeholderLegs) reasons.push(`${key}: zero-price placeholder`);

    const badLegs: ReactionLegKey[] = [
      ...assessment.pendingLegs.map((l) => l.key),
      ...assessment.placeholderLegs,
    ];
    let after: string | null = null;
    if (!assessment.premature && !insideRecapture) {
      const stripped = withoutReactionLegs(snap, badLegs);
      after = stripped ? JSON.stringify(stripped) : null;
    }

    items.push({
      eventId: row.id,
      eventDate: row.event_date,
      label: row.symbol ?? row.event_type,
      action: after == null ? "clear" : "strip_legs",
      reasons,
      strippedLegs: after == null ? [] : badLegs,
      willBeRecaptured: after == null && insideRecapture,
      before: row.reaction_snapshot,
      after,
    });
  }
  return { scanned: rows.length, unreadable, items };
}

export function runPrematureReactionRepair(
  db: Database.Database,
  opts: { apply?: boolean; acknowledgeRepair?: boolean; now?: Date } = {},
): { plan: ReactionRepairPlan; applied: boolean; cleared: number; stripped: number } {
  if (!opts.apply) {
    return { plan: planPrematureReactionRepair(db, opts), applied: false, cleared: 0, stripped: 0 };
  }
  if (!opts.acknowledgeRepair) {
    throw new Error(
      `Refusing to write without ${ACK_FLAG}. Dry-run is the default; rehearse on a REPAIR_DB_PATH copy first.`,
    );
  }

  return db.transaction(() => {
    const plan = planPrematureReactionRepair(db, opts);
    // The WHERE pins the exact text the plan read: a row that changed in
    // between is not overwritten, and the whole run rolls back.
    const write = db.prepare(
      "UPDATE calendar_events SET reaction_snapshot = ? WHERE id = ? AND reaction_snapshot = ?",
    );
    let cleared = 0;
    let stripped = 0;
    for (const item of plan.items) {
      const changes = write.run(item.after, item.eventId, item.before).changes;
      if (changes !== 1) {
        throw new Error(`event ${item.eventId}: snapshot changed while repairing; rolled back, nothing written`);
      }
      if (item.after == null) cleared += 1;
      else stripped += 1;
    }
    return { plan, applied: true, cleared, stripped };
  })();
}

function printResult(result: ReturnType<typeof runPrematureReactionRepair>) {
  const { plan, applied } = result;
  console.log(`Scanned ${plan.scanned} stored reaction snapshot(s).`);
  if (plan.unreadable > 0) {
    console.log(`${plan.unreadable} could not be read and were left as they are.`);
  }
  if (plan.items.length === 0) {
    console.log("Every readable snapshot is a measurement. Nothing to repair.");
    return;
  }
  const verb = (item: ReactionRepairItem) =>
    item.action === "clear"
      ? applied
        ? "cleared"
        : "would clear"
      : `${applied ? "removed" : "would remove"} leg(s) ${item.strippedLegs.join(", ")}, kept the rest`;
  for (const item of plan.items) {
    const fate =
      item.action !== "clear"
        ? ""
        : item.willBeRecaptured
          ? " The runner captures it again on a coming tick."
          : " Older than the runner's re-capture window: it stays empty unless backfilled.";
    console.log(
      `  event ${item.eventId} ${item.eventDate} ${item.label}: ${verb(item)} (${item.reasons.join("; ")}).${fate}`,
    );
  }
  const clears = plan.items.filter((i) => i.action === "clear").length;
  const strips = plan.items.length - clears;
  console.log(
    `${applied ? "Cleared" : "Would clear"} ${clears} snapshot(s); ` +
      `${applied ? "removed" : "would remove"} bad legs from ${strips}.`,
  );
  if (!applied) {
    console.log(`Dry-run (default). Re-run with --apply ${ACK_FLAG} on a rehearsed copy to write.`);
  }
}

function main() {
  const apply = process.argv.includes("--apply");
  const acknowledgeRepair = process.argv.includes(ACK_FLAG);
  if (apply && !acknowledgeRepair) {
    throw new Error(
      `Refusing to write without ${ACK_FLAG}. Dry-run is the default; rehearse on a REPAIR_DB_PATH copy first.`,
    );
  }
  const db = new BetterSqlite3(DB_PATH, { readonly: !apply, timeout: 60_000 });
  try {
    printResult(runPrematureReactionRepair(db, { apply, acknowledgeRepair }));
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes("repair-premature-reaction-snapshots")) main();
