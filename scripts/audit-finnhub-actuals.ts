/**
 * Audit Finnhub actual_value drift.
 *
 * For every calendar_events row with source='finnhub' AND actual_value
 * populated, re-fetch the live Finnhub /calendar/earnings entry and
 * compare. Reports drift on EPS or Revenue beyond a threshold.
 *
 * Why: Finnhub occasionally publishes day-of-release "preliminary"
 * actual_value that doesn't match what the company reported, then
 * silently corrects within 1-3 days. If our enrichment runner caught
 * that preliminary value, it sticks in the DB until a refetch.
 *
 * Read-only by default. Pass --fix to update the DB with current
 * Finnhub values for events flagged as drifted.
 */

import { db } from "../lib/db";

const fix = process.argv.includes("--fix");

interface Row {
  id: number;
  symbol: string;
  event_date: string;
  consensus_estimate: string | null;
  actual_value: string;
  enriched_at: string | null;
}

interface FinnhubEntry {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
}

const apiKey = process.env.FINNHUB_API_KEY;
if (!apiKey) {
  console.error("FINNHUB_API_KEY not set");
  process.exit(1);
}

function parseStored(val: string): { eps: number | null; rev: number | null } {
  const eps = /EPS\s+(-?\d+(?:\.\d+)?)/i.exec(val)?.[1];
  const rev = /Rev\s+([\d.,]+)/i.exec(val)?.[1];
  return {
    eps: eps != null ? Number(eps) : null,
    rev: rev != null ? Number(rev.replace(/,/g, "")) : null,
  };
}

function pctDiff(stored: number | null, live: number | null): number | null {
  if (stored == null || live == null) return null;
  if (live === 0) return null;
  return Math.abs((stored - live) / live) * 100;
}

async function main(): Promise<void> {
const rows = db
  .prepare(
    `SELECT id, symbol, event_date, consensus_estimate, actual_value, enriched_at
     FROM calendar_events
     WHERE source = 'finnhub'
       AND actual_value IS NOT NULL
     ORDER BY event_date DESC`,
  )
  .all() as Row[];

console.log(`Auditing ${rows.length} finnhub events with actual_value populated...\n`);

const driftedRows: Array<{
  row: Row;
  liveActual: string;
  liveConsensus: string | null;
  reasons: string[];
}> = [];

const EPS_THRESHOLD_PCT = 5;   // EPS should match within 5%
const REV_THRESHOLD_PCT = 2;   // Revenue should match within 2% (Finnhub re-rounds)

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const url =
    `https://finnhub.io/api/v1/calendar/earnings` +
    `?from=${row.event_date}&to=${row.event_date}&symbol=${encodeURIComponent(row.symbol)}&token=${apiKey}`;

  let live: FinnhubEntry | undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[${row.symbol}] HTTP ${res.status} — skipping`);
      continue;
    }
    const data = (await res.json()) as { earningsCalendar?: FinnhubEntry[] };
    live = data.earningsCalendar?.find(
      (e) => e.date === row.event_date && e.symbol === row.symbol,
    );
  } catch (err) {
    console.warn(`[${row.symbol}] fetch failed: ${err instanceof Error ? err.message : err}`);
    continue;
  }

  if (!live) {
    console.warn(`[${row.symbol} ${row.event_date}] no live Finnhub entry — skipping`);
    continue;
  }

  const stored = parseStored(row.actual_value);
  const epsDrift = pctDiff(stored.eps, live.epsActual);
  const revDrift = pctDiff(stored.rev, live.revenueActual);

  const reasons: string[] = [];
  if (epsDrift != null && epsDrift > EPS_THRESHOLD_PCT) {
    reasons.push(`EPS drifted ${epsDrift.toFixed(1)}% (stored ${stored.eps} → live ${live.epsActual})`);
  }
  if (revDrift != null && revDrift > REV_THRESHOLD_PCT) {
    reasons.push(`Rev drifted ${revDrift.toFixed(1)}% (stored ${stored.rev} → live ${live.revenueActual})`);
  }

  // Build the would-be-corrected actual_value string
  const correctedParts: string[] = [];
  if (live.epsActual != null) correctedParts.push(`EPS ${live.epsActual.toFixed(2)}`);
  if (live.revenueActual != null) {
    correctedParts.push(`Rev ${live.revenueActual.toLocaleString("en-US")}`);
  }
  const liveActual = correctedParts.join(" · ");

  const liveConsensusParts: string[] = [];
  if (live.epsEstimate != null) liveConsensusParts.push(`EPS ${live.epsEstimate.toFixed(2)}`);
  if (live.revenueEstimate != null) {
    liveConsensusParts.push(`Rev ${live.revenueEstimate.toLocaleString("en-US")}`);
  }
  const liveConsensus = liveConsensusParts.length > 0 ? liveConsensusParts.join(" · ") : null;

  if (reasons.length > 0) {
    driftedRows.push({ row, liveActual, liveConsensus, reasons });
    console.log(`✗ ${row.symbol.padEnd(8)} ${row.event_date}`);
    console.log(`    stored: ${row.actual_value}`);
    console.log(`    live:   ${liveActual}`);
    for (const r of reasons) console.log(`    → ${r}`);
  } else {
    console.log(`✓ ${row.symbol.padEnd(8)} ${row.event_date}  ${row.actual_value.slice(0, 60)}`);
  }

  // Pace: Finnhub free is 60/min → 550ms is safe.
  await new Promise((r) => setTimeout(r, 550));
}

console.log("\n" + "=".repeat(60));
console.log(`Total audited: ${rows.length}`);
console.log(`Drifted:       ${driftedRows.length}`);

if (driftedRows.length > 0 && fix) {
  console.log("\nApplying corrections...");
  const update = db.prepare(
    `UPDATE calendar_events SET actual_value = ?, consensus_estimate = ? WHERE id = ?`,
  );
  for (const d of driftedRows) {
    update.run(
      d.liveActual,
      // Only update consensus if live has one; never null out an existing value.
      d.liveConsensus ?? d.row.consensus_estimate,
      d.row.id,
    );
    console.log(`  ✓ updated id=${d.row.id} ${d.row.symbol}`);
  }
} else if (driftedRows.length > 0) {
  console.log("\nRun with --fix to apply corrections.");
}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
