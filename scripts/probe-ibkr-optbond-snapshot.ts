/**
 * probe-ibkr-optbond-snapshot.ts — read-only live probe (2026-07-07, R1b).
 *
 * Verified that /iserver/marketdata/snapshot serves OPTION and BOND conids on
 * the headless OAuth session, and in what unit convention. Findings (kept for
 * provenance — the price-only quote-candidate tier is built on them):
 *   - Bonds: field 31 is PAR-BASED (72.53 / 95.37 / 98.78 vs same-day DB rows
 *     73.09 / 96.11 / 99.04) — matches the prices-table convention that
 *     adjustedMarketValueSQL's ÷100 relies on.
 *   - Options: field 31 is the per-share premium, and carries a "C" prefix
 *     (prior close) when the contract hasn't traded this session ("C8.01") —
 *     parseLastPrice in lib/ibkr/market-data.ts strips C/H before parsing.
 *
 * Prints raw responses next to the DB's latest price for the same security;
 * never writes anything. Data-integrity rule: field meanings must be verified
 * against live output, never guessed.
 *
 * Usage: npx tsx scripts/probe-ibkr-optbond-snapshot.ts
 */

import Database from "better-sqlite3";
import path from "path";
import { loadIbkrConfig } from "../lib/ibkr/config";
import { openSession } from "../lib/ibkr/web-api";
import { signedRequest } from "../lib/ibkr/oauth-client";

interface Row {
  id: number;
  symbol: string;
  t: string;
  conid: number;
  last_px: number | null;
}

async function main() {
  const cfg = loadIbkrConfig();
  if (!cfg) {
    console.error("IBKR OAuth not configured");
    process.exit(1);
  }

  const db = new Database(
    process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "vanguard.db"),
    { readonly: true },
  );
  const rows = db
    .prepare(
      `SELECT s.id, s.symbol, LOWER(s.security_type) t, s.ib_con_id conid,
              (SELECT p.close_price FROM prices p WHERE p.security_id=s.id ORDER BY p.date DESC LIMIT 1) last_px
         FROM securities s
        WHERE s.ib_con_id IS NOT NULL
          AND LOWER(s.security_type) IN ('option','bond')
          AND s.id IN (
            SELECT h.security_id FROM holdings h
            JOIN (SELECT account_id, security_id, MAX(as_of_date) d FROM holdings GROUP BY 1,2) l
              ON l.account_id=h.account_id AND l.security_id=h.security_id AND l.d=h.as_of_date
            WHERE h.quantity != 0
          )
        ORDER BY t, s.symbol`,
    )
    .all() as Row[];
  db.close();

  const bonds = rows.filter((r) => r.t === "bond").slice(0, 3);
  const options = rows.filter((r) => r.t === "option").slice(0, 4);
  const sample = [...bonds, ...options];
  console.log("Probing", sample.map((r) => `${r.symbol}(${r.t}:${r.conid})`).join(", "), "\n");

  const lst = await openSession(cfg);
  console.log("Session open.\n");

  // Field 31 = last (verified for equities 2026-06-08); 84/86 = bid/ask
  // candidates, printed raw for context only.
  const conids = sample.map((r) => r.conid).join(",");
  const probePath = `/iserver/marketdata/snapshot?conids=${conids}&fields=31,84,86`;
  for (let poll = 0; poll < 3; poll++) {
    const res = await signedRequest(cfg, lst.token, "GET", probePath);
    const body = await res.text();
    console.log(`snapshot poll ${poll + 1} (HTTP ${res.status}):\n${body}\n`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("DB reference prices (latest `prices` row per security):");
  for (const r of sample) {
    console.log(`  ${r.symbol.padEnd(24)} ${r.t.padEnd(6)} conid=${r.conid}  db_last=${r.last_px}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
