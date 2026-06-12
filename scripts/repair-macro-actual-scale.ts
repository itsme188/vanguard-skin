/**
 * repair-macro-actual-scale.ts — Repair calendar_events.actual_value rows
 * written by the pre-2026-06-11 FRED formatter.
 *
 * Root cause (deep-QA finding today-releases--macro-enrichment-actuals-
 * stored-at-wrong-scale-units): the old `level_k` format assumed every
 * series was (a) denominated in thousands and (b) quoted as a period
 * delta. FRED series are heterogeneous — ICSA is a raw count quoted as a
 * LEVEL, so the week of 2026-06-06 (229,000 claims) was stored as
 * "+4,000K" (the WoW delta, inflated 1000×). Existing Home Sales stored
 * "+130,000K" for a 4.17M print; Trade Balance stored "-55,881" (raw
 * millions, no unit) for -$55.9B. ADP also pointed at the WEEKLY raw
 * series; the monthly headline series is ADPMNUSNERSA.
 *
 * 2026-06-12 second wave: the original scope assumed "pct_* releases were
 * always correct" — disproved against real FRED data. Pre-fix pct_yoy rows
 * stored the PRIOR month's YoY (CPI 6/10 "3.9%" vs the real 4.2% May
 * print; PPI 6/11 "9.7%" ≈ April-on-April), the priorYear lookup matched
 * 11 months back instead of 12, and release 46 pointed at PPIACO (all
 * commodities) instead of the PPIFIS Final Demand headline. Scope is now
 * EVERY mapped fred:* row — recompute-and-compare makes that safe: rows
 * that already match are left untouched.
 *
 * This script re-runs enrichment formatting for every affected fred:* row
 * using the fixed RELEASE_ID_TO_SERIES config (units verified against the
 * FRED /series endpoint 2026-06-11) and overwrites actual_value. Only
 * actual_value is touched — consensus, reaction_snapshot, enriched_at are
 * preserved. Idempotent: a re-run recomputes the same strings.
 *
 * Usage:
 *   npx tsx scripts/repair-macro-actual-scale.ts            # dry-run (default)
 *   npx tsx scripts/repair-macro-actual-scale.ts --apply    # write changes
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import path from "path";
import Database from "better-sqlite3";
import {
  parseSourceKey,
  fetchFredVintageForEvent,
  formatFredValue,
  RELEASE_ID_TO_SERIES,
} from "../lib/calendar/enrich-actuals";

const DB_PATH = process.env.VANGUARD_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

// Every mapped release id. The first wave (2026-06-11) limited this to the
// unit-scale formats on the assumption pct_* rows were correct — they were
// not (prior-month YoY + 11-month base + PPIACO). Recompute-and-compare
// keeps a full sweep safe and idempotent.
const AFFECTED_RELEASE_IDS = new Set(Object.keys(RELEASE_ID_TO_SERIES).map(Number));

interface EventRow {
  id: number;
  event_date: string;
  title: string;
  source_key: string;
  actual_value: string;
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.FRED_API_KEY) {
    console.error("FRED_API_KEY missing (load .env.local) — aborting.");
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");

  const rows = db
    .prepare(
      `SELECT id, event_date, title, source_key, actual_value
       FROM calendar_events
       WHERE source_key LIKE 'fred:%' AND actual_value IS NOT NULL
       ORDER BY event_date`,
    )
    .all() as EventRow[];

  const update = db.prepare(`UPDATE calendar_events SET actual_value = ? WHERE id = ?`);

  let examined = 0, changed = 0, unchanged = 0, failed = 0;

  for (const row of rows) {
    const parsed = parseSourceKey(row.source_key);
    if (parsed.kind !== "fred" || !AFFECTED_RELEASE_IDS.has(parsed.releaseId)) continue;
    examined++;

    const cfg = RELEASE_ID_TO_SERIES[parsed.releaseId];
    // Vintage pinned to event_date — the release-day first print. Without
    // it, repairing an April event today would pick up the May observation
    // (dated the 1st, published weeks later) plus every revision since.
    // Series without ALFRED vintages fall back to prior-month-end capping.
    const obs = await fetchFredVintageForEvent(cfg.seriesId, row.event_date);
    const fresh = obs ? formatFredValue(obs, cfg) : null;

    if (fresh == null) {
      // Better no value than a wrong one — but don't blank rows on a
      // transient fetch failure; report and leave for a re-run.
      failed++;
      console.log(`  ✗ #${row.id} ${row.event_date} [${cfg.seriesId}] — could not recompute (kept "${row.actual_value}")`);
      continue;
    }

    if (fresh === row.actual_value) {
      unchanged++;
      continue;
    }

    changed++;
    console.log(`  ${apply ? "✓" : "→"} #${row.id} ${row.event_date} [${cfg.seriesId}] "${row.actual_value}" → "${fresh}"  (${row.title.slice(0, 50)})`);
    if (apply) update.run(fresh, row.id);

    await new Promise((r) => setTimeout(r, 600)); // FRED rate-limit courtesy
  }

  console.log(
    `\n${apply ? "APPLIED" : "DRY-RUN"}: ${examined} examined, ${changed} ${apply ? "repaired" : "would change"}, ${unchanged} already correct, ${failed} fetch failures.`,
  );
  if (!apply && changed > 0) console.log("Re-run with --apply to write.");
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
