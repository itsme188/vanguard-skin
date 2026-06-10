/**
 * repair-canonical-option-prices.ts — One-off repair for the per-contract
 * option prices written by the 2026-05-04 canonical import (batch 66,
 * "VB 04-26 holdings.csv").
 *
 * Root cause: the 16 affected option securities were CREATED by that import,
 * at a time when option `multiplier` defaulted to NULL (the multiplier→100
 * write-boundary normalization only shipped 2026-06-05, 94dbce9). The
 * holdings-derived price step computed marketValue / quantity / 1 — the full
 * per-CONTRACT value — instead of dividing by 100. Valuation then multiplies
 * by the (since-repaired) multiplier 100 again, inflating each position 100×.
 *
 * Damage: Vanguard Taxable holdings_value on 2026-04-30 was ~$3.56M too high,
 * which poisoned the month-end inferred-cash anchor (cash = snapshot_total −
 * holdings_value = −$3.52M) and made every May daily valuation negative —
 * surfacing as a 184% max drawdown on the Performance view.
 *
 * The 5 other option price rows in batch 66 (AKAM/IBKR/NAUT/SHOP/XLF, ids
 * 1985–2057) belonged to pre-existing securities that already had
 * multiplier=100 and were derived correctly — they are NOT touched.
 *
 * This script:
 *  1. Divides the 16 verified price rows by 100 (idempotent — each UPDATE is
 *     guarded by the exact recorded bad value, so a re-run is a no-op).
 *  2. Recomputes daily valuations.
 *  3. Verifies no daily total remains negative.
 *
 * Usage: npx tsx scripts/repair-canonical-option-prices.ts [--dry-run]
 */

import Database from "better-sqlite3";
import path from "node:path";
import { computeDailyValuations } from "../lib/compute/daily-valuation";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

/**
 * Verified damaged rows: prices.import_batch_id = 66, option securities
 * created by that import (multiplier was NULL at derive time). `badPrice` is
 * the exact stored per-contract value — used as an UPDATE guard so the script
 * cannot double-divide on a re-run.
 */
const DAMAGED_ROWS: Array<{ symbol: string; badPrice: number }> = [
  { symbol: "AMZN  270617C00260000", badPrice: 4800.0 },
  { symbol: "EWG   260717P00041000", badPrice: 130.0 },
  { symbol: "FEZ   260515P00068000", badPrice: 210.0 },
  { symbol: "FROG  260618C00042500", badPrice: 700.0 },
  { symbol: "FROG  280121C00042500", badPrice: 1550.0 },
  { symbol: "GLW   260618C00150000", badPrice: 2400.0 },
  { symbol: "GLW   260821C00150000", badPrice: 3168.0 },
  { symbol: "HOOD  260717C00090000", badPrice: 293.0 },
  { symbol: "HOOD  270521C00085000", badPrice: 1700.0 },
  { symbol: "INTC  260501P00060000", badPrice: 1.0 },
  { symbol: "INTC  270115P00080000", badPrice: 1330.0 },
  { symbol: "KDEF  261120C00060000", badPrice: 750.0 },
  { symbol: "MSFT  260618P00400000", badPrice: 1240.0 },
  { symbol: "TER   260717P00370000", badPrice: 5310.0 },
  { symbol: "U     270521C00022000", badPrice: 880.0 },
  { symbol: "XOM   261016C00150000", badPrice: 1525.0 },
];

const PRICE_DATE = "2026-04-30";
const BATCH_ID = 66;

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  console.log(`Repairing batch-${BATCH_ID} per-contract option prices (${PRICE_DATE})`);
  if (dryRun) console.log("DRY RUN — no writes\n");

  const select = db.prepare(`
    SELECT p.id, p.close_price
    FROM prices p
    JOIN securities s ON s.id = p.security_id
    WHERE s.symbol = ? AND p.date = ? AND p.import_batch_id = ?
  `);
  const update = db.prepare(`
    UPDATE prices SET close_price = close_price / 100.0
    WHERE id = ? AND close_price = ?
  `);

  let fixed = 0;
  let alreadyFixed = 0;
  let missing = 0;

  const repair = db.transaction(() => {
    for (const row of DAMAGED_ROWS) {
      const price = select.get(row.symbol, PRICE_DATE, BATCH_ID) as
        | { id: number; close_price: number }
        | undefined;
      if (!price) {
        console.log(`  MISSING  ${row.symbol} — no batch-${BATCH_ID} price row`);
        missing++;
        continue;
      }
      if (price.close_price !== row.badPrice) {
        console.log(
          `  SKIP     ${row.symbol} — current ${price.close_price} != recorded bad value ${row.badPrice} (already repaired?)`
        );
        alreadyFixed++;
        continue;
      }
      console.log(
        `  ${dryRun ? "WOULD FIX" : "FIXED"} ${row.symbol}  ${row.badPrice} → ${row.badPrice / 100}`
      );
      if (!dryRun) {
        const res = update.run(price.id, row.badPrice);
        if (res.changes !== 1) {
          throw new Error(`Expected 1 row updated for ${row.symbol}, got ${res.changes}`);
        }
      }
      fixed++;
    }
  });
  repair();

  console.log(`\n${dryRun ? "Would fix" : "Fixed"}: ${fixed}, already fixed: ${alreadyFixed}, missing: ${missing}`);

  if (dryRun) {
    db.close();
    return;
  }

  console.log("\nRecomputing daily valuations…");
  const result = computeDailyValuations(db);
  console.log(`  ${JSON.stringify(result).slice(0, 200)}`);

  const negatives = db
    .prepare(
      `SELECT valuation_date, SUM(total_value) AS total
       FROM daily_valuations GROUP BY valuation_date HAVING total < 0`
    )
    .all() as Array<{ valuation_date: string; total: number }>;
  if (negatives.length > 0) {
    console.error(`\n⚠ ${negatives.length} dates still have negative portfolio totals:`);
    for (const n of negatives.slice(0, 10)) {
      console.error(`  ${n.valuation_date}  ${Math.round(n.total)}`);
    }
    process.exit(1);
  }
  console.log("\n✅ No negative daily totals remain.");

  const may = db
    .prepare(
      `SELECT MIN(t) AS min_t, MAX(t) AS max_t FROM
       (SELECT SUM(total_value) AS t FROM daily_valuations
        WHERE valuation_date LIKE '2026-05%' GROUP BY valuation_date)`
    )
    .get() as { min_t: number; max_t: number };
  console.log(
    `May 2026 portfolio total range: ${Math.round(may.min_t).toLocaleString()} – ${Math.round(may.max_t).toLocaleString()}`
  );

  db.close();
}

main();
