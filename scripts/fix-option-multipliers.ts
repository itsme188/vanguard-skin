/**
 * One-shot data fix: backfill the 100x contract multiplier on option securities
 * that imported with NULL/<=1 (canonical CSV has no multiplier column, so new
 * options landed at NULL → COALESCE(multiplier,1) → valued at 1/100th, with the
 * shortfall leaking into inferred cash). Then recompute daily valuations so the
 * holdings/cash split corrects. Idempotent — safe to re-run.
 *
 * Prevention lives in lib/mutations/securities.ts::upsertSecurity (defaults
 * option multiplier to 100); this script repairs rows written before that fix.
 *
 *   npx tsx scripts/fix-option-multipliers.ts
 */
import "dotenv/config";
import { db } from "../lib/db";
import { computeDailyValuations } from "../lib/compute/daily-valuation";

const countStale = () =>
  (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM securities
         WHERE LOWER(security_type) = 'option' AND (multiplier IS NULL OR multiplier <= 1)`
      )
      .get() as { n: number }
  ).n;

const before = countStale();
console.log(`Option securities with NULL/<=1 multiplier: ${before}`);

const res = db
  .prepare(
    `UPDATE securities SET multiplier = 100
     WHERE LOWER(security_type) = 'option' AND (multiplier IS NULL OR multiplier <= 1)`
  )
  .run();
console.log(`Updated ${res.changes} option securities → multiplier 100`);
console.log(`Remaining NULL/<=1 option multipliers: ${countStale()}`);

console.log("Recomputing daily valuations…");
const result = computeDailyValuations(db);
console.log("Recompute result:", JSON.stringify(result));

// Verify VB 5/31 lands on the statement numbers.
const vb = db
  .prepare(
    `SELECT ROUND(dv.holdings_value,2) AS holdings, ROUND(dv.cash_balance,2) AS cash, ROUND(dv.total_value,2) AS total
     FROM daily_valuations dv JOIN accounts a ON a.id = dv.account_id
     WHERE a.name = 'Vanguard Taxable' AND dv.valuation_date = '2026-05-31'`
  )
  .get();
console.log("VB 2026-05-31 after fix:", JSON.stringify(vb));
console.log("Expected: holdings ~1430413.80, cash ~26068.92, total 1456482.72");
