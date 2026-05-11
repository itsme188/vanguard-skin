/**
 * scripts/merge-duplicate-securities.ts
 *
 * Manual cleanup for duplicate securities rows produced by Co-Work's
 * inconsistent symbol convention across Vanguard statements (audit
 * 2026-05-11). Each PAIR below is two securities.id rows that describe
 * the same real-world instrument under different naming:
 *
 *   - BRK B (space) vs BRK/B (slash) — Vanguard class-B share symbol drift
 *   - Treasury bonds stored by NAME vs by CUSIP — same security, two rows
 *
 * For each pair the script repoints every FK reference from oldId to
 * newId (UPDATE OR IGNORE) then deletes any leftover rows that collided
 * with the new ID's existing data. Finally deletes the orphan securities
 * row. Defaults to dry-run (prints what it would do). Pass --apply to
 * commit. Pairs are hardcoded — read-only by default for safety.
 *
 * Run:
 *   npx tsx scripts/merge-duplicate-securities.ts          # dry-run (default)
 *   npx tsx scripts/merge-duplicate-securities.ts --apply  # actually merge
 *
 * Upstream fix needed: the Co-Work prompt in
 * app/dashboard/components/CanonicalCsvGuide.tsx should enforce a stable
 * symbol convention across statements (prefer CUSIP for bonds, slash form
 * for dual-class equities like BRK/B). This script is one-shot cleanup;
 * fixing the prompt prevents new duplicates.
 */

import Database from "better-sqlite3";
import path from "node:path";

interface MergePair {
  oldId: number;
  newId: number;
  label: string;
}

const PAIRS: MergePair[] = [
  { oldId: 1892, newId: 1996, label: "BRK B -> BRK/B" },
  { oldId: 1927, newId: 2079, label: "U S TREASURY BOND 3 2/15/48 -> 912810SA7" },
  { oldId: 1851, newId: 2080, label: "U S TREASURY BOND 4.75 5/15/55 -> 912810UK2" },
];

// Every table that has a security_id column (verified against live schema
// 2026-05-11 via sqlite_master). UPDATE OR IGNORE handles UNIQUE collisions
// gracefully; the subsequent DELETE clears leftover old-id rows.
const FK_TABLES = [
  "calendar_events",
  "corporate_actions",
  "earnings_transcripts",
  "holdings",
  "level_alerts",
  "notes",
  "ohlcv_bars",
  "prices",
  "research_article_securities",
  "security_betas",
  "security_factors",
  "security_levels",
  "security_regressions",
  "suggested_level_narratives",
  "tax_lots",
  "trade_roundtrips",
  "transactions",
  "watchlist",
];

const apply = process.argv.includes("--apply");

const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
const db = new Database(dbPath);
db.pragma("foreign_keys = OFF"); // defer FK enforcement; we re-enable post-merge

console.log(`Merge duplicate securities - ${apply ? "APPLY MODE" : "dry-run (use --apply to commit)"}`);
console.log(`DB: ${dbPath}`);
console.log();

for (const { oldId, newId, label } of PAIRS) {
  console.log(`-- ${label} (${oldId} -> ${newId}) --`);

  const oldSec = db.prepare("SELECT symbol, name FROM securities WHERE id = ?").get(oldId) as
    | { symbol: string; name: string | null }
    | undefined;
  const newSec = db.prepare("SELECT symbol, name FROM securities WHERE id = ?").get(newId) as
    | { symbol: string; name: string | null }
    | undefined;
  if (!oldSec) {
    console.log(`  WARN: old securities.id=${oldId} not found - already merged?`);
    continue;
  }
  if (!newSec) {
    console.log(`  ERR: new securities.id=${newId} not found - aborting this pair`);
    continue;
  }
  console.log(`  old: ${oldSec.symbol} | ${oldSec.name ?? ""}`);
  console.log(`  new: ${newSec.symbol} | ${newSec.name ?? ""}`);

  for (const table of FK_TABLES) {
    const before = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE security_id = ?`)
      .get(oldId) as { n: number };
    if (before.n === 0) continue;

    if (!apply) {
      console.log(`  [dry] ${table.padEnd(30)} ${before.n} old row(s) would migrate to ${newId}`);
      continue;
    }

    const updateResult = db
      .prepare(`UPDATE OR IGNORE ${table} SET security_id = ? WHERE security_id = ?`)
      .run(newId, oldId);
    const remainingRow = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE security_id = ?`)
      .get(oldId) as { n: number };
    let deleted = 0;
    if (remainingRow.n > 0) {
      const delResult = db
        .prepare(`DELETE FROM ${table} WHERE security_id = ?`)
        .run(oldId);
      deleted = delResult.changes;
    }
    console.log(
      `  OK ${table.padEnd(30)} updated ${updateResult.changes}, deleted-as-dup ${deleted} (had ${before.n})`
    );
  }

  if (apply) {
    const secDel = db.prepare("DELETE FROM securities WHERE id = ?").run(oldId);
    console.log(`  OK deleted securities row (changes=${secDel.changes})`);
  }
  console.log();
}

if (apply) {
  db.pragma("foreign_keys = ON");
  // Integrity check after merges
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  if (fk.length > 0) {
    console.error("WARN: Foreign-key integrity issues after merge:");
    console.error(fk);
    process.exit(1);
  }
  console.log("OK foreign_key_check clean");
}

db.close();
