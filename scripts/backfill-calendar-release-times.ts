/**
 * One-time backfill of `release_time` on existing calendar_events rows.
 *
 * Runs `resolveReleaseTime()` against every row whose release_time is
 * currently null. Zero network calls — everything the resolver needs is
 * already in the row (event_time, event_type, raw_json).
 *
 * Safe to re-run: the WHERE clause only touches rows with null release_time,
 * so repeated invocations are no-ops.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { resolveReleaseTime } from "../lib/calendar/release-times";

interface Row {
  id: number;
  event_type: string;
  event_time: string | null;
  raw_json: string | null;
}

const DEFAULT_PATH = path.join(process.cwd(), "data", process.env.VGS_DB_FILE ?? "");
const dbPath = process.env.VGS_DB_PATH ?? DEFAULT_PATH;
if (!dbPath || dbPath.endsWith(path.sep + "data" + path.sep)) {
  throw new Error("Pass VGS_DB_PATH or VGS_DB_FILE");
}
const db = new Database(dbPath);

const rows = db
  .prepare(
    `SELECT id, event_type, event_time, raw_json
     FROM calendar_events
     WHERE release_time IS NULL`,
  )
  .all() as Row[];

const update = db.prepare(
  `UPDATE calendar_events SET release_time = ? WHERE id = ?`,
);

let resolved = 0;
let skipped = 0;
const unresolvedByType = new Map<string, number>();

const txn = db.transaction((rows: Row[]) => {
  for (const row of rows) {
    const rt = resolveReleaseTime(row);
    if (rt) {
      update.run(rt, row.id);
      resolved++;
    } else {
      skipped++;
      unresolvedByType.set(
        row.event_type,
        (unresolvedByType.get(row.event_type) ?? 0) + 1,
      );
    }
  }
});
txn(rows);

console.log(
  `Backfill complete: ${resolved} resolved, ${skipped} skipped, ${rows.length} total.`,
);
if (unresolvedByType.size > 0) {
  console.log("Unresolved by event_type:");
  for (const [type, count] of unresolvedByType) {
    console.log(`  ${type}: ${count}`);
  }
}

db.close();
