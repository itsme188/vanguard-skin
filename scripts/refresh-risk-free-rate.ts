/**
 * Fetch DGS3MO (3-month T-bill) from FRED and write to settings cache.
 * Run via: npx tsx scripts/refresh-risk-free-rate.ts
 *
 * Env: FRED_API_KEY (required), loaded from .env.local automatically.
 * Wired into the daily-digest launchd path (scripts/send-daily-digest.sh).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { refreshRiskFreeRateFromFred } from "../lib/queries/risk-free-rate";

async function main() {
  try {
    const rate = await refreshRiskFreeRateFromFred(db);
    console.log(
      `Updated risk-free rate to ${(rate * 100).toFixed(3)}% (DGS3MO via FRED)`,
    );
  } catch (err) {
    console.error("Refresh failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
