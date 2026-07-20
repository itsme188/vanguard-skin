/**
 * Force the cached-EDGAR → Alpha Vantage transcript upgrade for one
 * (ticker, year, quarter) — the manual companion to the same-day sweep's
 * upgrade candidates (thin-8-K fix, 2026-07-19).
 *
 * fetchTranscript already upgrades cached edgar_8k rows on every cache hit;
 * this script just invokes it directly and, on a successful upgrade, runs the
 * AI desk-note summarize so the row matches what the sweep would produce.
 * Honest no-op when AV still has nothing (cached edgar row left untouched).
 *
 * Usage:
 *   npx tsx scripts/upgrade-edgar-transcript.ts NFLX 2026 2
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { fetchTranscript } from "../lib/transcripts/fetch";
import { summarizeTranscript } from "../lib/transcripts/same-day";
import { getCachedTranscript } from "../lib/queries/transcripts";

const [tickerArg, yearArg, quarterArg] = process.argv.slice(2);
if (!tickerArg || !yearArg || !quarterArg) {
  console.error("Usage: npx tsx scripts/upgrade-edgar-transcript.ts <TICKER> <YEAR> <QUARTER>");
  process.exit(1);
}
const ticker = tickerArg.toUpperCase();
const year = Number(yearArg);
const quarter = Number(quarterArg);

async function main() {
  const before = getCachedTranscript(db, ticker, year, quarter);
  if (!before) {
    console.log(`No cached transcript for ${ticker} ${year}Q${quarter} — nothing to upgrade (the sweep's fresh path owns first fetches).`);
    return;
  }
  console.log(
    `Before: source=${before.source}, transcript=${before.transcript?.length ?? 0} chars, summary=${before.summary?.length ?? 0} chars`,
  );
  if (before.source !== "edgar_8k") {
    console.log("Cached row is not edgar_8k — already a real transcript, nothing to do.");
    return;
  }

  const result = await fetchTranscript(db, ticker, year, quarter);
  if (!result || result.fromCache) {
    console.log("Alpha Vantage has no transcript for this quarter yet — cached edgar row unchanged. Re-run later (the sweep also retries daily for 10 days post-release).");
    return;
  }

  console.log(
    `Upgraded: source=${result.transcript.source}, transcript=${result.transcript.transcript?.length ?? 0} chars`,
  );
  await summarizeTranscript(db, result.transcript);
  const after = getCachedTranscript(db, ticker, year, quarter);
  console.log(`Desk note (${after?.summary?.length ?? 0} chars):\n---\n${after?.summary?.slice(0, 600) ?? "(none)"}`);
}

main().then(() => process.exit(0));
