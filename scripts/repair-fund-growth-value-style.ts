/**
 * Dry-run-default repair: an AI-classified fund whose stored growth_vs_value
 * disagrees with its classification style takes the style (2026-10-28).
 *
 * The factor classifier used to force every security onto Growth or Value, so
 * Blend index funds landed on either side (SPY Value, VTI Growth). New rows
 * now take a fund's style through `fundStyleGrowthValue`; this script brings
 * the stored rows in line with the same rule. Only `factor_source = 'auto'`
 * rows are touched: hand-imported (`csv_import`) and default rows are never
 * changed. Prints symbols and labels only.
 *
 * Usage (from the repo root):
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-fund-growth-value-style.ts
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-fund-growth-value-style.ts --apply --acknowledge-repair
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { fundStyleGrowthValue } from "@/lib/compute/classify-factors";

const ACK_FLAG = "--acknowledge-repair";

export interface FundStyleChange {
  securityId: number;
  symbol: string;
  from: string | null;
  to: string;
}

export function planFundGrowthValueRepair(db: Database.Database): FundStyleChange[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.symbol, s.security_type, s.style, sf.growth_vs_value
         FROM security_factors sf
         JOIN securities s ON s.id = sf.security_id
        WHERE sf.factor_source = 'auto'
        ORDER BY s.symbol`,
    )
    .all() as Array<{
      id: number;
      symbol: string;
      security_type: string | null;
      style: string | null;
      growth_vs_value: string | null;
    }>;
  const changes: FundStyleChange[] = [];
  for (const r of rows) {
    const to = fundStyleGrowthValue(r);
    if (to !== null && to !== r.growth_vs_value) {
      changes.push({ securityId: r.id, symbol: r.symbol, from: r.growth_vs_value, to });
    }
  }
  return changes;
}

export function runFundGrowthValueRepair(
  db: Database.Database,
  opts: { apply?: boolean; acknowledgeRepair?: boolean } = {},
): { changes: FundStyleChange[]; applied: boolean } {
  if (!opts.apply) return { changes: planFundGrowthValueRepair(db), applied: false };
  if (!opts.acknowledgeRepair) {
    throw new Error(`Refusing to write without ${ACK_FLAG}. Dry-run is the default; rehearse on a REPAIR_DB_PATH copy first.`);
  }
  return db.transaction(() => {
    const changes = planFundGrowthValueRepair(db);
    const update = db.prepare(
      `UPDATE security_factors
          SET growth_vs_value = ?, updated_at = datetime('now')
        WHERE security_id = ? AND factor_source = 'auto'`,
    );
    for (const c of changes) update.run(c.to, c.securityId);
    return { changes, applied: true };
  })();
}

function main() {
  const dbPath = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
  const apply = process.argv.includes("--apply");
  const acknowledgeRepair = process.argv.includes(ACK_FLAG);
  console.log(`Database: ${dbPath}`);
  console.log(apply ? "Mode: APPLY" : "Mode: dry run (pass --apply --acknowledge-repair to write)");
  const db = new BetterSqlite3(dbPath, { readonly: !apply });
  try {
    const { changes, applied } = runFundGrowthValueRepair(db, { apply, acknowledgeRepair });
    for (const c of changes) console.log(`  ${c.symbol}: ${c.from ?? "(empty)"} -> ${c.to}`);
    console.log(`${changes.length} fund row(s) ${applied ? "updated" : "would change"}.`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === "repair-fund-growth-value-style.ts") main();
