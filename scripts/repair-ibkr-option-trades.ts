/**
 * repair-ibkr-option-trades.ts — One-off repair for the "Equity and Index
 * Options" mis-import (2026-06-09).
 *
 * Two parser bugs corrupted the April + May 2026 IBKR activity imports:
 *  1. The Trades section matched `assetCategory === "Options"` but real
 *     statements say "Equity and Index Options" — every option trade went
 *     down the stock branch (type BUY/SELL, raw IBKR symbol, raw asset
 *     category written as security_type).
 *  2. The pre-f8fd2d8 hardcoded column layout misread Date/Time as the
 *     symbol on the first May import attempt, committing 127 orphan
 *     timestamp-symbol securities (validation rejected the transactions but
 *     the securities array was committed unvalidated — also fixed now).
 *
 * This script:
 *  1. Deletes the mis-typed option transactions (their source_keys embed the
 *     raw symbol, so a fixed re-import would otherwise duplicate them).
 *  2. Deletes the now-orphaned raw-symbol option securities.
 *  3. Deletes the orphan timestamp-symbol securities.
 *  4. Re-imports the April + May statements with the fixed parser.
 *  5. Recomputes tax lots + daily valuations.
 *
 * Usage: npx tsx scripts/repair-ibkr-option-trades.ts <april.csv> <may.csv>
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { parseImport, commitImport } from "../lib/import/engine";
import { computeTaxLots } from "../lib/compute/tax-lots";
import { computeDailyValuations } from "../lib/compute/daily-valuation";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

async function main() {
  const statementPaths = process.argv.slice(2);
  if (statementPaths.length === 0) {
    console.error("Usage: npx tsx scripts/repair-ibkr-option-trades.ts <statement.csv> [...]");
    process.exit(1);
  }
  for (const p of statementPaths) {
    if (!fs.existsSync(p)) {
      console.error(`File not found: ${p}`);
      process.exit(1);
    }
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ── Step 1: delete mis-typed option transactions ──────────────────
  const badTxns = db
    .prepare(
      `SELECT COUNT(*) AS c FROM transactions
       WHERE security_id IN (SELECT id FROM securities WHERE security_type = 'Equity and Index Options')`
    )
    .get() as { c: number };

  // Safety: none of these transactions may be referenced by tax lots or
  // trade reviews (verified ahead of time; re-verify before deleting).
  const refs = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tax_lot_sales WHERE sale_transaction_id IN
            (SELECT t.id FROM transactions t JOIN securities s ON s.id = t.security_id
             WHERE s.security_type = 'Equity and Index Options')) +
         (SELECT COUNT(*) FROM trade_roundtrips WHERE sale_transaction_id IN
            (SELECT t.id FROM transactions t JOIN securities s ON s.id = t.security_id
             WHERE s.security_type = 'Equity and Index Options')) +
         (SELECT COUNT(*) FROM tax_lots WHERE acquisition_transaction_id IN
            (SELECT t.id FROM transactions t JOIN securities s ON s.id = t.security_id
             WHERE s.security_type = 'Equity and Index Options')) AS c`
    )
    .get() as { c: number };
  if (refs.c > 0) {
    console.error(`ABORT: ${refs.c} tax-lot/review rows reference the doomed transactions.`);
    process.exit(1);
  }

  db.prepare(
    `DELETE FROM transactions
     WHERE security_id IN (SELECT id FROM securities WHERE security_type = 'Equity and Index Options')`
  ).run();
  console.log(`Deleted ${badTxns.c} mis-typed option transactions`);

  // ── Step 2: delete orphaned raw-symbol option securities ──────────
  const delRaw = db
    .prepare(
      `DELETE FROM securities
       WHERE security_type = 'Equity and Index Options'
         AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.security_id = securities.id)
         AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.security_id = securities.id)
         AND NOT EXISTS (SELECT 1 FROM prices p WHERE p.security_id = securities.id)
         AND NOT EXISTS (SELECT 1 FROM tax_lots l WHERE l.security_id = securities.id)`
    )
    .run();
  console.log(`Deleted ${delRaw.changes} raw-symbol option securities`);

  // ── Step 3: delete orphan timestamp-symbol securities ─────────────
  const delTimestamp = db
    .prepare(
      `DELETE FROM securities
       WHERE symbol GLOB '20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
         AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.security_id = securities.id)
         AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.security_id = securities.id)
         AND NOT EXISTS (SELECT 1 FROM prices p WHERE p.security_id = securities.id)
         AND NOT EXISTS (SELECT 1 FROM tax_lots l WHERE l.security_id = securities.id)`
    )
    .run();
  console.log(`Deleted ${delTimestamp.changes} orphan timestamp-symbol securities`);

  // ── Step 4: re-import statements with the fixed parser ────────────
  for (const p of statementPaths) {
    const basename = path.basename(p);
    const content = fs.readFileSync(p, "utf-8");
    const parsed = await parseImport(content, basename);
    if (parsed.errors.length > 0) {
      console.error(`Parse errors in ${basename}:`, parsed.errors);
      process.exit(1);
    }
    const result = commitImport(db, parsed);
    console.log(
      `${basename}: +${result.newTransactions} txns, +${result.newSecurities} securities, ` +
        `+${result.newHoldings} holdings, ${result.skippedDuplicates} duplicates skipped`
    );
  }

  // ── Step 5: recompute ──────────────────────────────────────────────
  const taxResult = computeTaxLots(db);
  console.log(`Tax lots: ${taxResult.lotsCreated} lots, ${taxResult.salesProcessed} sales`);
  const valResult = computeDailyValuations(db);
  console.log(`Valuations: ${valResult.datesComputed} dates, ${valResult.accountsProcessed} accounts`);

  // ── Verification ───────────────────────────────────────────────────
  const remaining = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM securities WHERE security_type = 'Equity and Index Options') AS rawSecs,
         (SELECT COUNT(*) FROM securities WHERE symbol GLOB '20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]*') AS tsSecs,
         (SELECT COUNT(*) FROM transactions WHERE type IN ('BUY_TO_OPEN','SELL_TO_CLOSE','SELL_TO_OPEN','BUY_TO_CLOSE')
            AND source_key LIKE 'ibkr:trade:2026-0%') AS optionTxns`
    )
    .get() as { rawSecs: number; tsSecs: number; optionTxns: number };
  console.log(
    `Verify: raw-type securities remaining=${remaining.rawSecs}, timestamp securities remaining=${remaining.tsSecs}, ` +
      `IBKR 2026 option trades now typed correctly=${remaining.optionTxns}`
  );

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
