/**
 * Dry-run-default repair for legacy OHLCV bars that today's upsert guard would
 * reject: non-finite or non-positive open/high/low/close, or high < low.
 * Zero volume is allowed. Prints counts per security only, never prices.
 *
 * Usage:
 *   REPAIR_DB_PATH=/tmp/rehearsal.db npx tsx scripts/repair-zero-ohlcv-bars.ts
 *   REPAIR_DB_PATH=/tmp/rehearsal.db npx tsx scripts/repair-zero-ohlcv-bars.ts --apply --acknowledge-repair
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
const ACK_FLAG = "--acknowledge-repair";

interface BarRow {
  id: number;
  security_id: number;
  symbol: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}

export interface ZeroOhlcvRepairPlan {
  totalRows: number;
  rejectedRows: number;
  bySecurity: Array<{ securityId: number; symbol: string; count: number }>;
  ids: number[];
}

function isRejectedByCurrentGuard(row: BarRow): boolean {
  const legs = [row.open, row.high, row.low, row.close];
  if (legs.some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0)) return true;
  return (row.high as number) < (row.low as number);
}

export function planZeroOhlcvBarRepair(db: Database.Database): ZeroOhlcvRepairPlan {
  const rows = db
    .prepare(
      `SELECT b.id, b.security_id, COALESCE(s.symbol, 'security ' || b.security_id) AS symbol,
              b.open, b.high, b.low, b.close
         FROM ohlcv_bars b
         LEFT JOIN securities s ON s.id = b.security_id
        ORDER BY b.security_id, b.id`,
    )
    .all() as BarRow[];
  const rejected = rows.filter(isRejectedByCurrentGuard);
  const counts = new Map<number, { securityId: number; symbol: string; count: number }>();
  for (const row of rejected) {
    const current = counts.get(row.security_id) ?? {
      securityId: row.security_id,
      symbol: row.symbol,
      count: 0,
    };
    current.count += 1;
    counts.set(row.security_id, current);
  }
  return {
    totalRows: rows.length,
    rejectedRows: rejected.length,
    bySecurity: [...counts.values()],
    ids: rejected.map((r) => r.id),
  };
}

export function runZeroOhlcvBarRepair(
  db: Database.Database,
  opts: { apply?: boolean; acknowledgeRepair?: boolean } = {},
): { plan: ZeroOhlcvRepairPlan; applied: boolean; deleted: number } {
  if (!opts.apply) return { plan: planZeroOhlcvBarRepair(db), applied: false, deleted: 0 };
  if (!opts.acknowledgeRepair) {
    throw new Error(`Refusing to write without ${ACK_FLAG}. Dry-run is the default; rehearse on a REPAIR_DB_PATH copy first.`);
  }

  return db.transaction(() => {
    const plan = planZeroOhlcvBarRepair(db);
    if (plan.ids.length === 0) return { plan, applied: true, deleted: 0 };
    const deleteStmt = db.prepare("DELETE FROM ohlcv_bars WHERE id = ?");
    let deleted = 0;
    for (const id of plan.ids) deleted += deleteStmt.run(id).changes;
    if (deleted !== plan.ids.length) {
      throw new Error(`expected to delete ${plan.ids.length} OHLCV rows, deleted ${deleted}; rolled back`);
    }
    return { plan, applied: true, deleted };
  })();
}

function printPlan(result: { plan: ZeroOhlcvRepairPlan; applied: boolean; deleted: number }) {
  const { plan } = result;
  console.log(`Scanned ${plan.totalRows} OHLCV bar row(s).`);
  console.log(`${result.applied ? "Deleted" : "Would delete"} ${plan.rejectedRows} rejected row(s).`);
  if (plan.bySecurity.length === 0) {
    console.log("No rejected rows found.");
    return;
  }
  for (const row of plan.bySecurity) {
    console.log(`  ${row.symbol} (security ${row.securityId}): ${row.count} row(s)`);
  }
  if (!result.applied) console.log("Dry-run (default). Re-run with --apply on a rehearsed copy to write.");
}

function main() {
  const apply = process.argv.includes("--apply");
  if (apply && !process.argv.includes(ACK_FLAG)) {
    throw new Error(`Refusing to write without ${ACK_FLAG}. Dry-run is the default; rehearse on a REPAIR_DB_PATH copy first.`);
  }
  const db = new BetterSqlite3(DB_PATH, { readonly: !apply, timeout: 60_000 });
  try {
    printPlan(runZeroOhlcvBarRepair(db, { apply, acknowledgeRepair: process.argv.includes(ACK_FLAG) }));
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes("repair-zero-ohlcv-bars")) main();
