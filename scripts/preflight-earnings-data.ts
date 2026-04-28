/**
 * One-off pre-flight syncs for the earnings digest MVP — runs analyst-coverage
 * and press-release backfills for the symbols passed on the command line.
 *
 * Usage:
 *   npx tsx scripts/preflight-earnings-data.ts GLW TER
 *
 * Env: FINNHUB_API_KEY (required), reads .env.local automatically.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { syncAnalystCoverage } from "../lib/apis/analyst-estimates";
import { fetchAndCachePressReleases } from "../lib/apis/press-releases";

async function main() {
  const symbols = process.argv.slice(2).map((s) => s.toUpperCase());
  if (symbols.length === 0) {
    console.error("usage: npx tsx scripts/preflight-earnings-data.ts SYM1 [SYM2 ...]");
    process.exit(1);
  }

  for (const sym of symbols) {
    console.log(`\n━━━ ${sym} ━━━`);

    console.log(`[${sym}] Syncing analyst coverage...`);
    const a = await syncAnalystCoverage(db, sym);
    console.log(
      `  recommendations upserted: ${a.recommendationsUpserted}, ` +
        `price target: ${a.priceTargetUpserted ? "yes" : "no"}, ` +
        `rating changes upserted: ${a.ratingChangesUpserted}`,
    );
    if (a.errors.length > 0) {
      console.log(`  errors: ${a.errors.join("; ")}`);
    }

    console.log(`[${sym}] Fetching press releases (last 30 days)...`);
    const p = await fetchAndCachePressReleases(db, sym, 30);
    console.log(`  press releases upserted: ${p.upserted}`);
    if (p.error) console.log(`  error: ${p.error}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
