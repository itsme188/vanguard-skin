/**
 * probe-ibkr-dividend-yield.ts — read-only live probe (2026-06-09).
 *
 * Goal: find where the IBKR Web API exposes dividend yield on the headless
 * OAuth session, per the deferred follow-up from the 2026-06-08 market-data
 * ship. Candidates:
 *   A. /iserver/marketdata/snapshot dividend-ish field codes (7286-7292)
 *   B. /iserver/secdef/info?conid=
 *   C. /trsrv/secdef?conids=
 *   D. /iserver/fundamentals/{conid}/summary
 *
 * Prints raw responses; never writes anything. Data-integrity rule: field
 * meanings must be verified against this live output, never guessed.
 *
 * Usage: npx tsx scripts/probe-ibkr-dividend-yield.ts [conid]
 */

import { loadIbkrConfig } from "../lib/ibkr/config";
import { openSession } from "../lib/ibkr/web-api";
import { signedRequest } from "../lib/ibkr/oauth-client";

const AAPL_CONID = 265598;

async function main() {
  const conid = parseInt(process.argv[2] ?? String(AAPL_CONID), 10);
  const cfg = loadIbkrConfig();
  if (!cfg) {
    console.error("IBKR OAuth not configured");
    process.exit(1);
  }
  const lst = await openSession(cfg);
  console.log("Session open.\n");

  // ── A: snapshot dividend-candidate field codes ──────────────────────
  const fields = ["31", "7286", "7287", "7288", "7289", "7290", "7291", "7292"];
  const path = `/iserver/marketdata/snapshot?conids=${conid}&fields=${fields.join(",")}`;
  for (let poll = 0; poll < 3; poll++) {
    const res = await signedRequest(cfg, lst.token, "GET", path);
    const body = await res.text();
    console.log(`A. snapshot poll ${poll + 1} (HTTP ${res.status}):`, body.slice(0, 600));
    await new Promise((r) => setTimeout(r, 1300));
  }

  // ── B: secdef/info ──────────────────────────────────────────────────
  const b = await signedRequest(cfg, lst.token, "GET", `/iserver/secdef/info?conid=${conid}`);
  console.log(`\nB. secdef/info (HTTP ${b.status}):`, (await b.text()).slice(0, 600));

  // ── C: trsrv/secdef ─────────────────────────────────────────────────
  const c = await signedRequest(cfg, lst.token, "GET", `/trsrv/secdef?conids=${conid}`);
  console.log(`\nC. trsrv/secdef (HTTP ${c.status}):`, (await c.text()).slice(0, 800));

  // ── D: fundamentals summary ─────────────────────────────────────────
  const d = await signedRequest(cfg, lst.token, "GET", `/iserver/fundamentals/${conid}/summary`);
  console.log(`\nD. fundamentals/summary (HTTP ${d.status}):`, (await d.text()).slice(0, 1200));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
