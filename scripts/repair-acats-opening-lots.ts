/**
 * repair-acats-opening-lots.ts
 *
 * Refines the 4 approximate TRANSFER_IN rows the IBKR-activity parser
 * creates from the Jan-2024 Robinhood ACATS statement leg
 * (`ibkr:xfer:2024-01-05:{SQQQ|TQQQ|TTD|UCO}:{qty}:In`, priced at the
 * transfer-date market value) into the 9 EXACT original lots per the user's
 * IBKR Form 8949 worksheet — original acquisition dates + worksheet cost
 * basis. Each auto row's quantity happens to equal the sum of its curated
 * lots (SQQQ 2500 = 100+100+500+1800, TQQQ 150, TTD 150 = 50+100,
 * UCO 350 = 200+150), so this is a pure lot-shape refinement, not a
 * quantity change.
 *
 * Idempotent: curated rows carry a deterministic
 * `ibkr:xferlot:{acqDate}:{symbol}:{qty}` source_key (INSERT OR IGNORE), and
 * the auto-row delete only fires when a matching row is still present. A
 * second run reports deleted:0, inserted:0.
 *
 * Runs as step 6 of the ledger rebuild driver (scripts/rebuild-ibkr-ledger.ts,
 * BEFORE computeTaxLots/computeDailyValuations), and is independently
 * runnable as a standalone repair.
 *
 * CLI usage:
 *   npx tsx scripts/repair-acats-opening-lots.ts            (dry run)
 *   npx tsx scripts/repair-acats-opening-lots.ts --apply     (executes +
 *     recomputes tax lots and daily valuations)
 */

import type Database from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────

export interface AcatsRepairResult {
  deleted: number;
  inserted: number;
  skipped: string[];
}

interface AcatsLot {
  symbol: string;
  qty: number;
  acqDate: string;
  basis: number;
}

// ─── Curated worksheet data (copy EXACTLY — from the IBKR Form 8949 worksheet) ──

const ACATS_LOTS: readonly AcatsLot[] = [
  { symbol: "SQQQ", qty: 100, acqDate: "2023-11-27", basis: 1647.21 },
  { symbol: "SQQQ", qty: 100, acqDate: "2023-12-05", basis: 1674.95 },
  { symbol: "SQQQ", qty: 500, acqDate: "2023-12-22", basis: 8873.79 },
  // Worksheet lists this lot's acquisition as "VARIOUS" — dated at the
  // ACATS transfer date; basis is exact. Sold 2024-01-09, so holding-period
  // display is approximate but ST/LT classification is unaffected.
  { symbol: "SQQQ", qty: 1800, acqDate: "2024-01-05", basis: 30038.2 },
  { symbol: "TQQQ", qty: 150, acqDate: "2023-12-13", basis: 7352.5 },
  { symbol: "TTD", qty: 50, acqDate: "2023-12-18", basis: 3762.5 },
  { symbol: "TTD", qty: 100, acqDate: "2023-12-18", basis: 7525.0 },
  { symbol: "UCO", qty: 200, acqDate: "2023-12-05", basis: 6663.0 },
  { symbol: "UCO", qty: 150, acqDate: "2023-12-05", basis: 4997.25 },
] as const;

const XFER_DATE = "2024-01-05";
const IBKR_ACCOUNT_NAME = "IBKR";
const NOTES = "ACATS from Robinhood 2024-01-05; basis per IBKR Form 8949 worksheet 2024";

// ─── Core repair function ─────────────────────────────────────────

interface PlannedSymbol {
  symbol: string;
  securityId: number;
  autoRowIds: number[];
  lotsToInsert: AcatsLot[];
}

/**
 * Replaces the 4 approximate ACATS auto rows with the 9 curated worksheet
 * lots. Pure DB writes only — the caller (CLI wrapper / rebuild driver) is
 * responsible for recomputing tax lots + daily valuations afterward.
 *
 * When `opts.apply` is false, the plan is computed exactly as it would be
 * for a real run and its counts are returned, but nothing is written.
 */
export function repairAcatsOpeningLots(
  db: Database.Database,
  opts: { apply: boolean }
): AcatsRepairResult {
  const skipped: string[] = [];

  const account = db
    .prepare("SELECT id FROM accounts WHERE name = ?")
    .get(IBKR_ACCOUNT_NAME) as { id: number } | undefined;

  if (!account) {
    skipped.push(`Account '${IBKR_ACCOUNT_NAME}' not found — nothing to repair`);
    return { deleted: 0, inserted: 0, skipped };
  }

  const bySymbol = new Map<string, AcatsLot[]>();
  for (const lot of ACATS_LOTS) {
    const existing = bySymbol.get(lot.symbol);
    if (existing) existing.push(lot);
    else bySymbol.set(lot.symbol, [lot]);
  }

  const selectSecurity = db.prepare("SELECT id FROM securities WHERE symbol = ?");
  const selectAutoRows = db.prepare(
    `SELECT id FROM transactions WHERE account_id = ? AND source_key LIKE ?`
  );
  const selectExistingLot = db.prepare("SELECT 1 FROM transactions WHERE source_key = ?");

  // ── Build the plan (read-only) — identical whether dry-run or apply ──
  const plan: PlannedSymbol[] = [];
  for (const [symbol, lots] of bySymbol) {
    const sec = selectSecurity.get(symbol) as { id: number } | undefined;
    if (!sec) {
      skipped.push(`${symbol}: security not found in DB — skipped (will exist post-rebuild)`);
      continue;
    }

    const likePattern = `ibkr:xfer:${XFER_DATE}:${symbol}:%:In`;
    const autoRows = selectAutoRows.all(account.id, likePattern) as Array<{ id: number }>;

    const lotsToInsert = lots.filter((lot) => {
      const sourceKey = `ibkr:xferlot:${lot.acqDate}:${lot.symbol}:${lot.qty}`;
      return selectExistingLot.get(sourceKey) === undefined;
    });

    if (autoRows.length === 0 && lotsToInsert.length === 0) continue; // nothing to do

    plan.push({
      symbol,
      securityId: sec.id,
      autoRowIds: autoRows.map((r) => r.id),
      lotsToInsert,
    });
  }

  let deleted = 0;
  let inserted = 0;
  for (const p of plan) {
    deleted += p.autoRowIds.length;
    inserted += p.lotsToInsert.length;
  }

  if (opts.apply && plan.length > 0) {
    const deleteRow = db.prepare("DELETE FROM transactions WHERE id = ?");
    const insertLot = db.prepare(
      `INSERT OR IGNORE INTO transactions
         (account_id, security_id, trade_date, type, quantity, amount, price_per_share,
          is_external_flow, source_key, notes)
       VALUES (?, ?, ?, 'TRANSFER_IN', ?, ?, ?, 1, ?, ?)`
    );

    const run = db.transaction(() => {
      for (const p of plan) {
        for (const id of p.autoRowIds) {
          deleteRow.run(id);
        }
        for (const lot of p.lotsToInsert) {
          const sourceKey = `ibkr:xferlot:${lot.acqDate}:${lot.symbol}:${lot.qty}`;
          insertLot.run(
            account.id,
            p.securityId,
            lot.acqDate,
            lot.qty,
            lot.basis,
            lot.basis / lot.qty,
            sourceKey,
            NOTES
          );
        }
      }
    });
    run();
  }

  return { deleted, inserted, skipped };
}

// ─── CLI entry point ──────────────────────────────────────────────

// Detect if this file is being run directly (not imported by tests / the
// rebuild driver) — mirrors scripts/refresh-vanguard-betas.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-acats-opening-lots.ts") ||
    process.argv[1].endsWith("repair-acats-opening-lots.js"));

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { runMigrations } = await import("@/lib/db/migrate");
    const { computeTaxLots } = await import("@/lib/compute/tax-lots");
    const { computeDailyValuations } = await import("@/lib/compute/daily-valuation");
    const path = await import("path");
    const fs = await import("fs");

    const apply = process.argv.includes("--apply");

    const dataDir = process.env.VANGUARD_DB_DIR || path.default.join(process.cwd(), "data");
    const dbPath = path.default.join(dataDir, "vanguard.db");

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    console.log(
      `Repairing ACATS opening lots (Jan 2024 transfer) ${apply ? "[APPLY]" : "[DRY RUN]"}`
    );

    const result = repairAcatsOpeningLots(db, { apply });
    console.log(JSON.stringify(result, null, 2));

    if (result.skipped.length > 0) {
      console.log("\nSkipped:");
      for (const s of result.skipped) console.log(`  - ${s}`);
    }

    if (!apply) {
      console.log(
        `\nDRY RUN — would delete ${result.deleted}, would insert ${result.inserted}. Re-run with --apply to execute.`
      );
      db.close();
      return;
    }

    console.log(`\nDeleted ${result.deleted} auto row(s), inserted ${result.inserted} lot(s).`);

    console.log("\nRecomputing tax lots…");
    const taxLotResult = computeTaxLots(db);
    console.log(`  ${JSON.stringify(taxLotResult)}`);

    console.log("\nRecomputing daily valuations…");
    const valuationResult = computeDailyValuations(db);
    console.log(`  ${JSON.stringify(valuationResult).slice(0, 200)}`);

    db.close();
  })();
}
