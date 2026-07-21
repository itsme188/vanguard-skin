#!/usr/bin/env tsx
/**
 * IBKR Tier 2 — TWS-independent holdings refresh via the headless Web API.
 *
 *   npx tsx scripts/ibkr-refresh-holdings.ts            # DRY: preview only
 *   npx tsx scripts/ibkr-refresh-holdings.ts --commit   # write to the DB
 *
 * Reads live positions + cost basis + account values over OAuth 1.0a (no TWS,
 * no Gateway). The write mirrors the TWS sync (source='tws') so downstream
 * queries/upserts need zero changes — see lib/ibkr/refresh.ts. Writes today's
 * (ET) snapshot; prior dates untouched.
 *
 * Session note (2026-07-21): running this while TWS desktop is logged in no
 * longer evicts TWS's session — it now fails loudly with the
 * `ibkr-session-yield` sentinel (compete:"false") because open TWS owns the
 * brokerage session.
 */

import { db } from "@/lib/db";
import { loadIbkrConfig } from "@/lib/ibkr/config";
import { fetchIbkrPortfolio, writeIbkrHoldings } from "@/lib/ibkr/refresh";
import { todayET } from "@/lib/calendar/date-utils";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const cfg = loadIbkrConfig();
  if (!cfg) {
    console.error("IBKR OAuth not configured (data/ibkr-oauth/credentials.json missing or incomplete).");
    process.exit(1);
  }

  console.log("→ opening IBKR session (headless OAuth 1.0a, no TWS)…");
  const snap = await fetchIbkrPortfolio(cfg);
  const nonzero = snap.positions.filter((m) => m.quantity !== 0);
  const today = todayET();

  const existing = new Set(
    (db.prepare("SELECT symbol FROM securities").all() as { symbol: string }[]).map((r) => r.symbol),
  );

  console.log(`\n=== LIVE IBKR POSITIONS — ${nonzero.length} nonzero / ${snap.positions.length} total — as of ${today} ===`);
  let newSecs = 0;
  for (const m of [...nonzero].sort((a, b) => Math.abs(b.mktValue ?? 0) - Math.abs(a.mktValue ?? 0))) {
    const isNew = !existing.has(m.symbol);
    if (isNew) newSecs++;
    const cb = m.costBasis != null ? m.costBasis.toFixed(0) : "?";
    console.log(
      `  ${m.symbol.padEnd(22)} ${String(m.quantity).padStart(6)} @ ${(m.mktPrice ?? 0).toFixed(2).padStart(9)}` +
        `  mktVal ${(m.mktValue ?? 0).toFixed(0).padStart(10)}  cost ${cb.padStart(9)}  [${m.securityType}]${isNew ? "  ⚠ NEW security" : ""}`,
    );
  }
  console.log(`\n  Net liquidation: ${snap.netLiq}   Cash: ${snap.cash}`);
  console.log(
    `  Securities already in DB: ${nonzero.length - newSecs}/${nonzero.length}` +
      (newSecs ? `  (${newSecs} would be NEW — verify these aren't OCC dupes)` : "  (all match existing — no dupes)"),
  );

  if (!COMMIT) {
    console.log("\n[DRY RUN] no writes. Re-run with --commit to write (source='tws', mirrors the TWS sync).");
    return;
  }

  const res = writeIbkrHoldings(db, snap, { asOfDate: today });
  console.log(
    `\n✓ COMMITTED ${res.positionsWritten} positions + ${res.pricesWritten} prices + account snapshot (netLiq ${res.netLiq}) as of ${res.asOfDate}, source='tws'. Valuations recomputed.`,
  );
}

main().catch((e) => {
  console.error("FAILED:", (e as Error)?.message ?? e);
  process.exit(1);
});
