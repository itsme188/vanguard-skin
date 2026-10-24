/**
 * repair-ghost-securities.ts — remove securities that nothing points at.
 *
 * Why (2026-10-24 QA): undoing an import deleted the batch's rows but left
 * the securities it had created, searchable forever with no way to remove
 * them. `deleteImportBatch` now removes the ghosts a batch leaves behind
 * (lib/mutations/ghost-securities.ts); this script is the one-time sweep for
 * the ghosts already stranded. Same reader, same rule: a security with no row
 * in any anchoring table (transactions, holdings, prices, lots, notes,
 * levels, watchlist, calendar rows ...) is a ghost; derived rows (factors,
 * betas, quotes, narratives, regressions) never anchor one and go with it.
 *
 * Dry-run by default: lists the ghosts and writes nothing. `--apply` deletes
 * them in one transaction.
 *
 * Usage (from the repo root — tsx resolves the "@/" alias off the tsconfig
 * it finds from cwd):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-ghost-securities.ts
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-ghost-securities.ts --apply
 *
 * REPAIR_DB_PATH (or --db <path>) overrides the database path so --apply can
 * be rehearsed on a copy (`sqlite3 data/vanguard.db "VACUUM INTO
 * '/tmp/rehearsal.db'"`) before it is ever pointed at the live file.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { findGhostSecurities, removeGhostSecurities } from "../lib/mutations/ghost-securities";

function resolveDbPath(argv: string[]): string {
  const i = argv.indexOf("--db");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  if (process.env.REPAIR_DB_PATH) return path.resolve(process.env.REPAIR_DB_PATH);
  return path.resolve(process.cwd(), "data", "vanguard.db");
}

function main(): void {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dbPath = resolveDbPath(argv);
  // Printed BEFORE the file is opened, so a wrong override is seen first.
  console.log(`database: ${dbPath}`);
  console.log(`mode: ${apply ? "APPLY" : "dry-run (pass --apply to delete)"}`);

  const db = new BetterSqlite3(dbPath, { readonly: !apply });
  db.pragma("foreign_keys = ON");
  try {
    const ghosts = findGhostSecurities(db);
    console.log(`ghost securities: ${ghosts.length}`);
    for (const g of ghosts) {
      console.log(`  #${g.id}  ${g.symbol}  ${g.security_type ?? "?"}  ${g.name ?? ""}`);
    }
    if (!apply || ghosts.length === 0) return;
    const removed = db.transaction(() => removeGhostSecurities(db, ghosts.map((g) => g.id)))();
    console.log(`removed: ${removed.length}`);
  } finally {
    db.close();
  }
}

main();
