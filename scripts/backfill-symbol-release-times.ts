/**
 * One-shot backfill of release_time for existing future earnings events whose
 * symbol now has a per-symbol override in SYMBOL_RELEASE_TIMES_ET.
 *
 * Run after adding/changing entries in SYMBOL_RELEASE_TIMES_ET. Idempotent —
 * re-running with no schedule changes is a no-op.
 *
 * Usage:
 *   npx tsx scripts/backfill-symbol-release-times.ts            # apply
 *   npx tsx scripts/backfill-symbol-release-times.ts --dry-run  # preview
 */

import { db } from "../lib/db";
import { SYMBOL_RELEASE_TIMES_ET } from "../lib/calendar/release-times";

const dryRun = process.argv.includes("--dry-run");
const symbols = Object.keys(SYMBOL_RELEASE_TIMES_ET);
const placeholders = symbols.map(() => "?").join(",");

const rows = db
  .prepare(
    `SELECT id, symbol, event_date, release_time
     FROM calendar_events
     WHERE event_type = 'earnings'
       AND symbol IN (${placeholders})
       AND event_date >= date('now')`,
  )
  .all(...symbols) as Array<{ id: number; symbol: string; event_date: string; release_time: string | null }>;

let changed = 0;
const update = db.prepare("UPDATE calendar_events SET release_time = ? WHERE id = ?");

for (const r of rows) {
  const target = SYMBOL_RELEASE_TIMES_ET[r.symbol.trim().toUpperCase()];
  if (!target || r.release_time === target) continue;
  console.log(`[${r.id}] ${r.symbol} ${r.event_date}: ${r.release_time ?? "null"} → ${target}`);
  if (!dryRun) update.run(target, r.id);
  changed++;
}

console.log(
  `\n${dryRun ? "[DRY-RUN] would update" : "Updated"} ${changed} row${changed === 1 ? "" : "s"}.`,
);
