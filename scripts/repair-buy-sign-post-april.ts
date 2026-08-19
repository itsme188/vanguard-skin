/**
 * One-off repair: fix wrong-sign amounts on post-2026-04 canonical-csv BUY/SELL rows.
 *
 * Gap this closes (2026-08, live-DB audit): docs/reference/conventions-detail.md
 * "Canonical-CSV amount is the SIGNED CASH EFFECT" — for canonical-csv transaction
 * rows with trade_date >= 2026-04-01, BUY-family amounts must be NEGATIVE and
 * SELL-family amounts must be POSITIVE. 12 BUY_TO_OPEN option rows (May 2026,
 * Vanguard Taxable) were imported with a positive amount before the parser
 * (lib/import/parsers/canonical-csv.ts) started auto-normalizing this sign on
 * ingest. This script repairs the rows that already landed wrong.
 *
 * source_key embeds cents = Math.round(amount * 100)
 * (`canonical:txn:{acct}:{sym}:{date}:{type}:{cents}[:#N]`), so the wrong sign is
 * baked into the dedup key. A naive amount-only UPDATE would leave the key
 * pointing at the old (wrong) cents value, and any future corrected
 * re-transcription of the same fill would then import as a duplicate row instead
 * of deduping. This script rewrites BOTH the amount and the source_key's cents
 * segment in the same transaction, preserving any trailing `:#N` disambiguation
 * ordinal.
 *
 * Selector: source_key LIKE 'canonical:txn:%' AND trade_date >= '2026-04-01' AND
 *   (type IN (BUY,BUY_TO_OPEN,BUY_TO_CLOSE,BUY_TO_COVER) AND amount > 0)
 *   OR (type IN (SELL,SELL_TO_CLOSE,SELL_TO_OPEN) AND amount < 0)
 * (the SELL-family sweep is included for completeness per the parser's scope —
 * it finds 0 rows in the current live DB, all 12 violations are BUY_TO_OPEN.)
 *
 * Usage:
 *   npx tsx scripts/repair-buy-sign-post-april.ts           # dry-run (default)
 *   npx tsx scripts/repair-buy-sign-post-april.ts --apply   # write
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

const SIGNED_CASH_EFFECT_ERA_START = "2026-04-01";
const BUY_FAMILY_TYPES = ["BUY", "BUY_TO_OPEN", "BUY_TO_CLOSE", "BUY_TO_COVER"];
const SELL_FAMILY_TYPES = ["SELL", "SELL_TO_CLOSE", "SELL_TO_OPEN"];

export interface WrongSignRow {
  id: number;
  trade_date: string;
  type: string;
  amount: number;
  source_key: string;
  symbol: string | null;
}

/**
 * Selects canonical-csv transaction rows whose amount sign violates the
 * post-2026-04 signed-cash-effect convention: BUY-family rows with amount > 0,
 * or SELL-family rows with amount < 0. Scoped to `canonical:txn:%` source_keys
 * and `trade_date >= 2026-04-01` — pre-era rows are legacy-positive by design
 * and are never selected.
 */
export function fetchWrongSignRows(db: Database.Database): WrongSignRow[] {
  const buyPlaceholders = BUY_FAMILY_TYPES.map(() => "?").join(",");
  const sellPlaceholders = SELL_FAMILY_TYPES.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT t.id, t.trade_date, t.type, t.amount, t.source_key, s.symbol
       FROM transactions t
       LEFT JOIN securities s ON s.id = t.security_id
       WHERE t.source_key LIKE 'canonical:txn:%'
         AND t.trade_date >= ?
         AND (
           (t.type IN (${buyPlaceholders}) AND t.amount > 0)
           OR (t.type IN (${sellPlaceholders}) AND t.amount < 0)
         )
       ORDER BY t.trade_date, t.id`
    )
    .all(
      SIGNED_CASH_EFFECT_ERA_START,
      ...BUY_FAMILY_TYPES,
      ...SELL_FAMILY_TYPES
    ) as WrongSignRow[];
}

/** BUY-family flips to negative; SELL-family flips to positive. */
export function normalizedAmountFor(type: string, amount: number): number {
  return BUY_FAMILY_TYPES.includes(type) ? -Math.abs(amount) : Math.abs(amount);
}

/**
 * Rewrites the trailing `:{cents}` segment of a canonical-csv transaction
 * source_key to reflect a new amount, preserving any trailing `:#N`
 * disambiguation ordinal.
 *
 * `canonical:txn:{acct}:{sym}:{date}:{type}:220200` -> `...:-220200`
 * `canonical:txn:{acct}:{sym}:{date}:{type}:220200:#2` -> `...:-220200:#2`
 */
export function rewriteSourceKeyCents(sourceKey: string, newAmount: number): string {
  const newCents = Math.round(newAmount * 100);
  const match = sourceKey.match(/^(.+:)(-?\d+)(:#\d+)?$/);
  if (!match) {
    throw new Error(
      `source_key doesn't match the expected canonical:txn: ...:{cents}[:#N] shape: ${sourceKey}`
    );
  }
  const [, prefix, , ordinalSuffix] = match;
  return `${prefix}${newCents}${ordinalSuffix ?? ""}`;
}

function backupDatabase(db: Database.Database): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-buy-sign-post-april-${timestamp}.db`);
  db.prepare(`VACUUM INTO ?`).run(backupPath);
  return backupPath;
}

function main() {
  const apply = process.argv.includes("--apply");
  // 60s lock wait — the live app's background sync can hold the write lock
  // past better-sqlite3's 5s default.
  const db = new Database(DB_PATH, { timeout: 60000 });
  db.pragma("foreign_keys = ON");

  const rows = fetchWrongSignRows(db);

  console.log(`\n── Wrong-sign post-2026-04 BUY/SELL-family rows — ${rows.length} ──`);

  const plan: { row: WrongSignRow; newAmount: number; newSourceKey: string }[] = [];
  const aborted: { row: WrongSignRow; reason: string }[] = [];

  for (const row of rows) {
    const newAmount = normalizedAmountFor(row.type, row.amount);
    const newSourceKey = rewriteSourceKeyCents(row.source_key, newAmount);

    // UNIQUE constraint guard: never write a source_key that already exists
    // (would mean a corrected re-transcription was already imported separately).
    const collision = db
      .prepare(`SELECT id FROM transactions WHERE source_key = ? AND id != ?`)
      .get(newSourceKey, row.id) as { id: number } | undefined;

    if (collision) {
      aborted.push({
        row,
        reason: `target source_key already exists on transaction id ${collision.id} — would violate the UNIQUE constraint. Needs manual review.`,
      });
      continue;
    }

    plan.push({ row, newAmount, newSourceKey });
    console.log(
      `  id ${row.id} (${row.symbol ?? "?"} ${row.type} on ${row.trade_date}): ` +
        `amount ${row.amount} -> ${newAmount}`
    );
    console.log(`    source_key: ${row.source_key}`);
    console.log(`             -> ${newSourceKey}`);
  }

  if (aborted.length > 0) {
    console.log(`\n── Aborted rows (collision — report only) — ${aborted.length} ──`);
    for (const { row, reason } of aborted) {
      console.log(`  id ${row.id} (${row.symbol ?? "?"} ${row.type} on ${row.trade_date}): ${reason}`);
    }
  }

  console.log(`\nTotal selected: ${rows.length}. Writable: ${plan.length}. Aborted: ${aborted.length}.`);

  if (!apply) {
    console.log(`\nDry-run (default). Re-run with --apply to write ${plan.length} row(s).`);
    db.close();
    return;
  }

  if (plan.length === 0) {
    console.log(`\nNothing to write.`);
    db.close();
    return;
  }

  const backupPath = backupDatabase(db);
  console.log(`\nBackup: ${backupPath}`);

  const update = db.prepare(
    `UPDATE transactions SET amount = ?, source_key = ? WHERE id = ? AND amount = ? AND source_key = ?`
  );
  const run = db.transaction(() => {
    let applied = 0;
    for (const { row, newAmount, newSourceKey } of plan) {
      applied += update.run(newAmount, newSourceKey, row.id, row.amount, row.source_key).changes;
    }
    return applied;
  });
  const applied = run();
  console.log(`Applied ${applied} of ${plan.length} fix(es).`);
  db.close();
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-buy-sign-post-april.ts") ||
    process.argv[1].endsWith("repair-buy-sign-post-april.js"));

if (isMain) {
  main();
}
