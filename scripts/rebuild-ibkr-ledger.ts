/**
 * rebuild-ibkr-ledger.ts
 *
 * Retires canonical batch 17 (the incomplete 2024-01→2026-03 IBKR backfill
 * imported from `dashboard_IBKR_transactions.csv` — see the 2026-08-03 FIFO
 * audit) and rebuilds the IBKR ledger from the 6 real IBKR activity
 * statements via the native `ibkr-activity` parser, which now understands
 * the Transfers section (Task 1 — ACATS in-kind arrivals become
 * TRANSFER_IN/TRANSFER_OUT rows) and treats TRANSFER_IN as lot-creating
 * (Task 2). After re-import, `repairAcatsOpeningLots` (Task 4) refines the
 * 4 approximate Jan-2024 ACATS legs into the 9 worksheet-exact original
 * lots, and tax lots + daily valuations recompute once at the end.
 *
 * Dry-run by default: preflight and the batch-17 sanity check (steps 1
 * and 3) always run for real — neither mutates `data/vanguard.db`
 * (preflight only reads statement files; the sanity check is a read-only
 * SELECT). Step 2's backup file write also always happens for real (it
 * writes a SEPARATE file, never the live DB). Steps 4-8 (delete, reimport,
 * repair, recompute, closing census) only PRINT their plan unless
 * `--apply` is passed — except step 5's per-file parse + validate +
 * dedup-precheck reporting, which is itself pure/read-only and so runs
 * for real in BOTH modes to give a genuinely informative dry run.
 *
 * `runMigrations(db)` is gated on `--apply` (NOT unconditional) — a dry
 * run must never write to the live DB, and `runMigrations` is a write the
 * instant a pending migration exists (this branch's own opening commit
 * ships migration 075, which drops two columns). The dry-run reads in
 * steps 1/3 don't depend on any pending migration being applied first.
 * The call is ALSO placed AFTER step 2's backup succeeds (not immediately
 * on DB open) — an apply run whose backup step fails must never have
 * already migrated the schema; "abort HARD if backup fails" (step 2's
 * comment) only actually holds if nothing else has mutated the DB first.
 *
 * NEVER proceeds past step 2 without a verified backup.
 *
 * CLI usage:
 *   npx tsx scripts/rebuild-ibkr-ledger.ts            (dry run)
 *   npx tsx scripts/rebuild-ibkr-ledger.ts --apply     (executes)
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ParsedImportResult } from "@/lib/import/types";

// ─── Config ──────────────────────────────────────────────────────

/** Live statement files, in chronological order. Verified to exist on disk
 * per the 2026-08-03 audit (docs/superpowers/plans/2026-08-03-ibkr-ledger-rebuild.md). */
const FILES = [
  "/Users/Yitzi/Desktop/Trading - Local/IBKR 2024 activity.csv",
  "/Users/Yitzi/Desktop/Trading - Local/2025 Annual IBKR.csv",
  "/Users/Yitzi/Desktop/Trading - Local/Trading/IBKR 2026-01 activity.csv",
  "/Users/Yitzi/Desktop/Trading - Local/Trading/2026-02 IBKR Activity Statement.csv",
  "/Users/Yitzi/Desktop/Trading - Local/Trading/IBKR march 26.csv",
  "/Users/Yitzi/Desktop/Trading - Local/july 2026 IBKR statement.csv",
];

const CANONICAL_BATCH_ID = 17;
/** Re-verified against the live DB by the 2026-08-03 audit — if this has
 * changed, the DB moved since the audit and a human must re-verify before
 * this script proceeds. */
const EXPECTED_BATCH_17_TRANSACTION_COUNT = 2493;

// ─── Step 1: preflight ───────────────────────────────────────────

export interface PreflightResult {
  period: string | null;
  tradeRows: number;
  ok: boolean;
}

/**
 * Confirms `content` is a genuine IBKR *Activity* statement (has a
 * `Statement,Data,Period` line AND at least one `Trades,Data,Order` row) —
 * guards against a same-folder Mark-to-Market-only export (the
 * `IBKR MTM 2024/` folder files) silently being fed through the pipeline as
 * if it were a full activity statement. Pure line-scan, no CSV-quoting
 * awareness needed for these two literal prefixes.
 */
export function preflightStatementFile(content: string): PreflightResult {
  const lines = content.split(/\r?\n/);
  let period: string | null = null;
  let tradeRows = 0;

  const PERIOD_PREFIX = "Statement,Data,Period,";
  const TRADE_ROW_PREFIX = "Trades,Data,Order,";

  for (const line of lines) {
    if (period === null && line.startsWith(PERIOD_PREFIX)) {
      period = line.slice(PERIOD_PREFIX.length).trim().replace(/^"|"$/g, "");
    }
    if (line.startsWith(TRADE_ROW_PREFIX)) {
      tradeRows++;
    }
  }

  return { period, tradeRows, ok: period !== null && tradeRows >= 1 };
}

// ─── Step 5 helper: unusual asset-category detection ────────────

export interface UnusualAssetCategoryRow {
  symbol: string;
  securityType: string;
  transactionCount: number;
}

/** Real statements occasionally include IBKR asset categories the parser
 * has no special handling for — "Forex" pairs and "Forecast Contracts by
 * ForecastEx" prediction-market contracts both fall into the parser's
 * generic stock branch (BUY/SELL under the raw symbol), which is almost
 * certainly not the right ledger representation. This does NOT filter
 * them (that's a parser decision, out of this task's scope) — it only
 * surfaces them so a human reviews before trusting the rebuilt ledger. */
const UNUSUAL_ASSET_CATEGORY_PATTERN = /forecast|forex/i;

export function findUnusualAssetCategoryRows(
  parsed: ParsedImportResult
): UnusualAssetCategoryRow[] {
  return parsed.securities
    .filter(
      (s) => s.securityType && UNUSUAL_ASSET_CATEGORY_PATTERN.test(s.securityType)
    )
    .map((s) => ({
      symbol: s.symbol,
      securityType: s.securityType as string,
      transactionCount: parsed.transactions.filter((t) => t.symbol === s.symbol)
        .length,
    }));
}

// ─── Step 5 helper: read-only dedup precheck ─────────────────────

/** Counts how many of `sourceKeys` already exist in `transactions` — a pure
 * SELECT, safe to run in dry-run mode as a preview of what commitImport's
 * INSERT-OR-IGNORE dedup would report for real. */
export function countExistingSourceKeys(
  db: Database.Database,
  sourceKeys: string[]
): number {
  const stmt = db.prepare("SELECT 1 FROM transactions WHERE source_key = ?");
  let count = 0;
  for (const key of sourceKeys) {
    if (stmt.get(key)) count++;
  }
  return count;
}

// ─── Step 3 helper: batch sanity ─────────────────────────────────

export interface BatchSanity {
  count: number;
  minDate: string | null;
  maxDate: string | null;
}

export function getBatchSanity(
  db: Database.Database,
  batchId: number
): BatchSanity {
  return db
    .prepare(
      `SELECT COUNT(*) as count, MIN(trade_date) as minDate, MAX(trade_date) as maxDate
       FROM transactions WHERE import_batch_id = ?`
    )
    .get(batchId) as BatchSanity;
}

// ─── Step 2 helper: backup ────────────────────────────────────────

export interface BackupResult {
  created: boolean;
  path: string;
  sizeBytes: number;
}

/**
 * A same-day backup file already exists on disk. Before trusting it as
 * "the backup is satisfied," verify it wasn't left behind by an
 * interrupted prior VACUUM INTO (Mac slept, disk filled, process killed
 * mid-write) — a 0-byte or truncated file must never be silently accepted
 * as a real backup, since "NEVER proceed unbacked" is the whole point of
 * this step. Two checks, because neither alone is sufficient (verified
 * live): a 0-byte file opens fine as a valid *empty* SQLite database and
 * `PRAGMA integrity_check` reports "ok" on it — the explicit size check
 * is what catches that case. A non-empty but corrupted/garbage file fails
 * `PRAGMA integrity_check` (or fails to open at all) — that's what the
 * size check alone would miss.
 */
function assertValidBackupFile(backupPath: string): number {
  const size = fs.statSync(backupPath).size;
  if (size === 0) {
    throw new Error(
      `existing backup file is 0 bytes (an interrupted prior VACUUM INTO) — ` +
        `delete it and re-run for a fresh backup`
    );
  }

  let check: Database.Database | undefined;
  try {
    check = new Database(backupPath, { readonly: true });
    const rows = check.pragma("integrity_check(1)") as Array<
      Record<string, string>
    >;
    const verdict = rows[0]?.integrity_check;
    if (verdict !== "ok") {
      throw new Error(
        `existing backup file failed integrity_check ("${verdict ?? "unknown"}") — ` +
          `delete it and re-run for a fresh backup`
      );
    }
  } finally {
    check?.close();
  }

  return size;
}

/**
 * `VACUUM INTO` refuses to write to a path that already exists (verified
 * live — it throws "output file already exists", not a silent overwrite).
 * The driver runs steps 1-3 unconditionally in BOTH dry-run and --apply
 * (they never mutate the live DB), and Task 7's runbook does a dry-run
 * followed by an --apply on the same ET day — so the second invocation
 * would otherwise hit that error and (per "abort HARD if backup fails")
 * refuse to proceed even though a same-day backup already exists. Treat a
 * VALID existing file at the target path as "already satisfied" rather
 * than a failure (see `assertValidBackupFile` for what "valid" means);
 * only a genuine write failure (permissions, disk full) or an invalid
 * existing file aborts.
 */
export function ensureBackup(
  db: Database.Database,
  backupPath: string
): BackupResult {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });

  if (fs.existsSync(backupPath)) {
    const sizeBytes = assertValidBackupFile(backupPath);
    return { created: false, path: backupPath, sizeBytes };
  }

  db.prepare("VACUUM INTO ?").run(backupPath);
  const sizeBytes = fs.statSync(backupPath).size;
  return { created: true, path: backupPath, sizeBytes };
}

// ─── Step 8 helper: closing census ───────────────────────────────

export interface ClosingCensus {
  byType: Array<{ type: string; count: number }>;
  negativeHpdCount: number;
  /**
   * Negative-HPD rows on short lots (SELL_TO_OPEN round-trips) — EXPECTED
   * under the signed-holding-period-days convention (number-trust durable
   * fixes, WS1). Not an anomaly.
   */
  negativeHpdShortCount: number;
  /**
   * Negative-HPD rows on NON-short lots — this is the real anomaly signal.
   * A negative holding period on a normal long lot means acquisition
   * postdates the sale, which should never happen; investigate if > 0.
   */
  negativeHpdNonShortCount: number;
  reconcileCloseCount: number;
}

export function getClosingCensus(db: Database.Database): ClosingCensus {
  const byType = db
    .prepare(
      `SELECT t.type as type, COUNT(*) as count
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE a.name = 'IBKR'
       GROUP BY t.type
       ORDER BY count DESC`
    )
    .all() as Array<{ type: string; count: number }>;

  const negativeHpdCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM tax_lot_sales WHERE holding_period_days < 0")
      .get() as { c: number }
  ).c;

  // Split the total by whether the lot is a legitimate short round-trip —
  // shorts are now SYSTEMATICALLY negative by the signed-HPD convention, so
  // the total count alone can no longer serve as an anomaly signal.
  const negativeHpdShortCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM tax_lot_sales tls
         JOIN tax_lots tl ON tl.id = tls.tax_lot_id
         WHERE tls.holding_period_days < 0 AND tl.is_short = 1`
      )
      .get() as { c: number }
  ).c;

  const negativeHpdNonShortCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM tax_lot_sales tls
         JOIN tax_lots tl ON tl.id = tls.tax_lot_id
         WHERE tls.holding_period_days < 0 AND tl.is_short = 0`
      )
      .get() as { c: number }
  ).c;

  const reconcileCloseCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM transactions WHERE type = 'RECONCILE_CLOSE'")
      .get() as { c: number }
  ).c;

  return {
    byType,
    negativeHpdCount,
    negativeHpdShortCount,
    negativeHpdNonShortCount,
    reconcileCloseCount,
  };
}

// ─── CLI orchestration ────────────────────────────────────────────

async function main() {
  const { runMigrations } = await import("@/lib/db/migrate");
  const { parseImport, commitImport } = await import("@/lib/import/engine");
  const { deleteImportBatch } = await import("@/lib/mutations/import-batches");
  const { validateParsedResult } = await import("@/lib/import/validate");
  const { repairAcatsOpeningLots } = await import(
    "@/scripts/repair-acats-opening-lots"
  );
  const { computeTaxLots } = await import("@/lib/compute/tax-lots");
  const { computeDailyValuations } = await import("@/lib/compute/daily-valuation");
  const { todayET } = await import("@/lib/calendar/date-utils");

  const apply = process.argv.includes("--apply");
  console.log(
    `IBKR Ledger Rebuild ${apply ? "[APPLY]" : "[DRY RUN]"}\n${"=".repeat(70)}`
  );

  // ── Step 1: preflight every file ──────────────────────────────
  console.log("\n[1/8] Preflighting statement files...");
  const failures: string[] = [];
  for (const file of FILES) {
    if (!fs.existsSync(file)) {
      console.log(`  ${file}: MISSING`);
      failures.push(`${file}: file not found`);
      continue;
    }
    const content = fs.readFileSync(file, "utf-8");
    const result = preflightStatementFile(content);
    console.log(
      `  ${path.basename(file)}: period="${result.period ?? "MISSING"}" ` +
        `tradeRows=${result.tradeRows} ${result.ok ? "OK" : "FAIL"}`
    );
    if (!result.ok) {
      failures.push(
        `${file}: preflight failed (period=${result.period ?? "none"}, tradeRows=${result.tradeRows})`
      );
    }
  }
  if (failures.length > 0) {
    console.error("\nABORT — preflight failed for:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("  All files pass preflight.");

  // ── Open the live DB ──────────────────────────────────────────
  const dataDir = process.env.VANGUARD_DB_DIR || path.join(process.cwd(), "data");
  const dbPath = path.join(dataDir, "vanguard.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`\nABORT — database not found at ${dbPath}`);
    process.exit(1);
  }
  const db: Database.Database = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ── Step 2: backup ─────────────────────────────────────────────
  console.log("\n[2/8] Backing up database...");
  const backupPath = path.join(dataDir, "backups", `pre-ibkr-rebuild-${todayET()}.db`);
  try {
    const backup = ensureBackup(db, backupPath);
    console.log(
      backup.created
        ? `  Backup created: ${backup.path} (${backup.sizeBytes} bytes)`
        : `  Backup for today already exists — verified valid, reusing: ${backup.path} (${backup.sizeBytes} bytes)`
    );
  } catch (err) {
    console.error(
      `\nABORT — backup FAILED: ${(err as Error).message}\nNever proceeding without a verified backup.`
    );
    db.close();
    process.exit(1);
  }

  // Gated on --apply, and deliberately placed AFTER the backup above
  // succeeds: a dry run must never write to the live DB, and
  // runMigrations() applies any pending migration immediately (this
  // branch's own opening commit ships migration 075, which drops two
  // columns) — an apply run whose backup step fails must never have
  // already migrated the schema. Steps 1 and 3's reads (file preflight,
  // batch-17 count) don't depend on any pending migration having run.
  if (apply) {
    runMigrations(db);
  }

  // ── Step 3: batch-17 sanity gate ───────────────────────────────
  console.log(`\n[3/8] Sanity-checking canonical batch ${CANONICAL_BATCH_ID}...`);
  const sanity = getBatchSanity(db, CANONICAL_BATCH_ID);
  console.log(
    `  transactions=${sanity.count} span=[${sanity.minDate ?? "?"} .. ${sanity.maxDate ?? "?"}]`
  );
  if (sanity.count !== EXPECTED_BATCH_17_TRANSACTION_COUNT) {
    console.error(
      `\nABORT — batch ${CANONICAL_BATCH_ID} has ${sanity.count} transaction(s), expected exactly ` +
        `${EXPECTED_BATCH_17_TRANSACTION_COUNT}. The DB has changed since the 2026-08-03 audit — ` +
        `re-verify manually before proceeding.`
    );
    db.close();
    process.exit(1);
  }
  console.log(`  Matches expected count (${EXPECTED_BATCH_17_TRANSACTION_COUNT}).`);

  // ── Step 4: retire batch 17 ─────────────────────────────────────
  console.log(`\n[4/8] ${apply ? "" : "DRY RUN — "}Retiring batch ${CANONICAL_BATCH_ID}...`);
  if (apply) {
    deleteImportBatch(db, CANONICAL_BATCH_ID);
    console.log(
      `  Deleted ${sanity.count} transaction(s) + cleared derived tax_lots/tax_lot_sales/` +
        `daily_valuations (regenerated in step 7).`
    );
  } else {
    console.log(
      `  Would call deleteImportBatch(db, ${CANONICAL_BATCH_ID}), removing ${sanity.count} ` +
        `transaction(s) and clearing derived tax_lots/tax_lot_sales/daily_valuations.`
    );
  }

  // ── Step 5: reimport each file ──────────────────────────────────
  console.log(`\n[5/8] ${apply ? "Importing" : "DRY RUN — parsing"} ${FILES.length} statement file(s)...`);
  for (const file of FILES) {
    const basename = path.basename(file);
    const content = fs.readFileSync(file, "utf-8");
    console.log(`\n  ${basename}`);

    const parsed: ParsedImportResult = await parseImport(content, basename);

    // Deliberately asymmetric with step 1: preflight collects every
    // file's failure before aborting (nothing has been touched yet, so
    // there's no cost to reporting the full picture up front); here the
    // DB may already reflect prior files in this same loop (batch 17
    // deleted, earlier files committed under --apply), so stopping at the
    // FIRST offending file avoids reasoning about a partially-imported,
    // hard-to-describe mid-rebuild state.
    if (parsed.sourceType !== "ibkr-activity") {
      console.error(
        `\nABORT — ${basename} was auto-detected as source type "${parsed.sourceType}", ` +
          `expected "ibkr-activity". Refusing to import — investigate the file's header before retrying.`
      );
      db.close();
      process.exit(1);
    }

    if (parsed.errors.length > 0) {
      console.error(`\nABORT — ${basename} produced parse errors:`);
      for (const e of parsed.errors) console.error(`    - ${e}`);
      db.close();
      process.exit(1);
    }

    if (parsed.warnings.length > 0) {
      console.log(`    parser warnings:`);
      for (const w of parsed.warnings) console.log(`      - ${w}`);
    }

    const unusual = findUnusualAssetCategoryRows(parsed);
    if (unusual.length > 0) {
      console.log(
        `    unusual asset-category rows (not filtered by the parser — review before trusting the ledger):`
      );
      for (const u of unusual) {
        console.log(`      - ${u.symbol} (${u.securityType}): ${u.transactionCount} transaction(s)`);
      }
    }

    // validateParsedResult's top-level `warnings` is the validation-only
    // list (settlement-date clears, unknown-type notices, the "N row(s)
    // excluded" summary) — distinct from the parser's own `parsed.warnings`
    // already printed above, so no dedup needed here.
    const { skippedRows: validationSkipped, warnings: validationWarnings } =
      validateParsedResult(parsed);
    if (validationSkipped.length > 0) {
      console.log(`    validation would exclude ${validationSkipped.length} row(s):`);
      for (const s of validationSkipped) {
        console.log(`      - ${s.category}[${s.index}]: ${s.reason}`);
      }
    }
    for (const w of validationWarnings) {
      console.log(`      - ${w}`);
    }

    const sourceKeys = parsed.transactions.map((t) => t.sourceKey);
    const wouldCollide = countExistingSourceKeys(db, sourceKeys);

    if (!apply) {
      console.log(
        `    DRY RUN — would commit ${parsed.transactions.length} transaction(s), ` +
          `${parsed.holdings.length} holding(s), ${parsed.prices.length} price(s), ` +
          `${parsed.snapshots.length} snapshot(s). ${wouldCollide} source_key(s) already exist ` +
          `in the DB (expect ~0 except genuine overlaps).`
      );
      continue;
    }

    const result = commitImport(db, parsed);
    console.log(
      `    committed: ${result.newTransactions} new transaction(s), ${result.skippedDuplicates} ` +
        `deduped, ${result.newHoldings} holding(s), ${result.newPrices} price(s), ` +
        `${result.newSnapshots} snapshot(s), ${result.newSecurities} new securit(y/ies) ` +
        `(precheck estimated ${wouldCollide} collision(s))`
    );
  }

  // ── Step 6: ACATS opening-lot repair ─────────────────────────────
  console.log(`\n[6/8] ${apply ? "Repairing" : "DRY RUN — would repair"} ACATS opening lots...`);
  if (apply) {
    const repair = repairAcatsOpeningLots(db, { apply: true });
    console.log(`  deleted=${repair.deleted} inserted=${repair.inserted}`);
    for (const s of repair.skipped) console.log(`    - ${s}`);
  } else {
    console.log(
      `  Would call repairAcatsOpeningLots(db, { apply: true }) after the reimport above — ` +
        `replaces the 4 auto ibkr:xfer:2024-01-05:* rows with the 9 worksheet-exact lots.`
    );
  }

  // ── Step 7: recompute ─────────────────────────────────────────────
  console.log(
    `\n[7/8] ${apply ? "Recomputing" : "DRY RUN — would recompute"} tax lots + daily valuations...`
  );
  if (apply) {
    const taxResult = computeTaxLots(db);
    console.log(`  tax lots: ${JSON.stringify(taxResult)}`);
    const valResult = computeDailyValuations(db);
    console.log(`  valuations: ${JSON.stringify(valResult)}`);
  } else {
    console.log(`  Would call computeTaxLots(db) then computeDailyValuations(db).`);
  }

  // ── Step 8: closing census ───────────────────────────────────────
  console.log(
    `\n[8/8] ${apply ? "Closing census (post-rebuild)" : "Current census (pre-rebuild — informational only; will differ after --apply)"}:`
  );
  const census = getClosingCensus(db);
  console.log("  IBKR transactions by type:");
  for (const row of census.byType) console.log(`    ${row.type}: ${row.count}`);
  console.log(
    `  negative-holding-period tax_lot_sales rows: ${census.negativeHpdCount} total — ` +
      `${census.negativeHpdShortCount} expected (short round-trips, signed-HPD convention), ` +
      `${census.negativeHpdNonShortCount} unexpected on non-short lots (investigate if > 0)`
  );
  console.log(`  RECONCILE_CLOSE rows: ${census.reconcileCloseCount}`);

  db.close();
  console.log(
    `\n${apply ? "Rebuild complete." : "DRY RUN complete — re-run with --apply to execute."}`
  );
}

// Detect if this file is being run directly (mirrors
// scripts/repair-acats-opening-lots.ts / scripts/refresh-vanguard-betas.ts).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("rebuild-ibkr-ledger.ts") ||
    process.argv[1].endsWith("rebuild-ibkr-ledger.js"));

if (isMain) {
  main().catch((err) => {
    console.error("\nFatal error:", err);
    process.exit(1);
  });
}
