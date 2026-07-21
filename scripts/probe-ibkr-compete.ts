#!/usr/bin/env tsx
/**
 * Probe: /iserver/auth/ssodh/init with compete:"false" vs "true" — what does
 * IBKR actually return in each TWS-open/closed combination, and do
 * session-free /portfolio reads work regardless?
 *
 * Read-only. Never places orders, never writes to the DB.
 *
 *   npx tsx scripts/probe-ibkr-compete.ts             # compete=false (the probe)
 *   npx tsx scripts/probe-ibkr-compete.ts --compete   # compete=true control run
 *
 * Run matrix:
 *   (a) TWS logged in  → expect a yield-shaped init body AND TWS stays logged in
 *   (b) TWS closed     → expect authenticated success + working portfolio reads
 *
 * PROBE FINDINGS (record here after each run — the yield-detection predicates in
 * lib/ibkr/web-api.ts::isSessionYield and workers/cron/src/ibkr-positions.ts key
 * on this; adjust them ONLY from a fresh probe, never from docs alone):
 *
 * 2026-07-21 — FINAL FOUR-ROW VERDICT (this consumer key, all scenarios probed):
 *
 * | Scenario                      | compete | ssodh/init result                                                                 |
 * |--------------------------------|---------|------------------------------------------------------------------------------------|
 * | TWS logged in                  | "false" | 200 {"passed":false,"authenticated":false,"connected":true,"competing":false} — refused, TWS untouched |
 * | TWS closed 10+ min              | "false" | IDENTICAL refusal — this consumer key can NEVER authenticate with compete:"false"  |
 * | TWS closed                     | "true"  | 200 {"passed":true,"authenticated":true,...}; /iserver/accounts 200 with full payload |
 * | ANY (no brokerage session at all) | —    | /portfolio/accounts 200, /portfolio/{acct}/positions/0 200, /portfolio/{acct}/ledger 200 — session-free |
 *
 * CAPABILITY CONCLUSION: `auth/status` after a compete:"false" init returns
 * `fail:"Force compete capability must be used together with compete flag"`
 * in BOTH the TWS-open AND TWS-closed runs — this key is provisioned with the
 * force-compete capability and IBKR mandates the flag be "true" for it.
 * compete:"false" is therefore DEAD for this key, permanently, not just while
 * TWS holds the session — there is no polite variant available.
 *
 * SHIPPED DESIGN (2026-07-21 pivot, supersedes the original compete:"false"
 * design): holdings reads (Mac fetchIbkrPortfolio, Worker
 * fetchLiveIbkrPositions) go SESSIONLESS — /portfolio/* needs no ssodh/init at
 * all (row 4 above), so they never open a session and can never evict
 * anything, in every scenario. Only /iserver-needing consumers (earnings-intel
 * Web API road, quote enrichment) call openSession, and openSession now uses
 * compete:"true" (the only value this key accepts) gated behind a check of
 * whether TWS is listening on the local API port — if it is, yield
 * immediately without calling IBKR at all; if TWS is confirmed absent
 * locally, compete:"true" has nothing to evict. See lib/ibkr/web-api.ts
 * (openSession, isTwsListeningLocally) for the implementation.
 *
 * Earlier partial run (2026-07-21 ~15:44 ET, scenario (a) TWS logged in,
 * compete=false) for reference — superseded by the four-row table above:
 *   - ssodh/init: HTTP 200 {"passed":false,"authenticated":false,"connected":true,"competing":false}
 *   - auth/status after init: fail:"Force compete capability must be used together
 *     with compete flag".
 *   - /iserver/* after yield: 401 "not authenticated" — loud, fast, clean degrade.
 *   - /portfolio/accounts + /portfolio/{acct}/positions/0 returned HTTP 200 with
 *     full data EVEN when yielded (no brokerage session) — this surprise is what
 *     motivated the scenario-b run and the sessionless pivot above.
 */

import fs from "node:fs";
import path from "node:path";
import {
  getLiveSessionToken,
  signedRequest,
  type IbkrOAuthConfig,
} from "@/lib/ibkr/oauth-client";

const DIR = path.join(process.cwd(), "data", "ibkr-oauth");

function loadConfig(): IbkrOAuthConfig {
  const c = JSON.parse(fs.readFileSync(path.join(DIR, "credentials.json"), "utf8"));
  if (!c.prepend) throw new Error("prepend missing — run the prepend precompute first");
  return {
    consumerKey: c.consumerKey,
    accessToken: c.accessToken,
    prepend: c.prepend,
    dhPrimeHex: c.dhPrimeHex,
    dhGenerator: c.dhGenerator,
    signaturePrivatePem: fs.readFileSync(path.join(DIR, "private_signature.pem"), "utf8"),
    baseUrl: c.baseUrl,
    realm: c.realm ?? "limited_poa",
  };
}

async function readJson(res: Response): Promise<unknown> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t.slice(0, 300);
  }
}

async function show(label: string, res: Response): Promise<unknown> {
  const body = await readJson(res);
  console.log(`  ${label}: HTTP ${res.status}`);
  console.log(`    body: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const compete = process.argv.includes("--compete") ? "true" : "false";
  const cfg = loadConfig();

  console.log(`→ probe run with compete=${compete}`);
  console.log("→ minting Live Session Token …");
  const lst = await getLiveSessionToken(cfg);
  console.log(`  ✓ LST valid, expires ${new Date(lst.expirationMs).toISOString()}`);

  console.log("→ 1. auth/status BEFORE init");
  await show(
    "auth/status",
    await signedRequest(cfg, lst.token, "POST", "/iserver/auth/status"),
  );

  console.log(`→ 2. ssodh/init { compete: "${compete}", publish: "true" }`);
  await show(
    "ssodh/init",
    await signedRequest(cfg, lst.token, "POST", "/iserver/auth/ssodh/init", {
      compete,
      publish: "true",
    }),
  );

  console.log("→ 3. auth/status AFTER init");
  await show(
    "auth/status",
    await signedRequest(cfg, lst.token, "POST", "/iserver/auth/status"),
  );

  console.log("→ 4. GET /iserver/accounts");
  await show(
    "iserver/accounts",
    await signedRequest(cfg, lst.token, "GET", "/iserver/accounts"),
  );

  console.log("→ 5. GET /portfolio/accounts");
  const pa = await signedRequest(cfg, lst.token, "GET", "/portfolio/accounts");
  const paBody = await readJson(pa);
  console.log(`  portfolio/accounts: HTTP ${pa.status}`);
  const accts = Array.isArray(paBody) ? (paBody as Array<{ accountId?: string }>) : [];
  console.log(`    accounts returned: ${accts.length}`);

  if (accts[0]?.accountId) {
    console.log("→ 6. GET /portfolio/{acct}/positions/0");
    const pos = await signedRequest(
      cfg,
      lst.token,
      "GET",
      `/portfolio/${accts[0].accountId}/positions/0`,
    );
    const posBody = await readJson(pos);
    console.log(
      `  positions/0: HTTP ${pos.status} — rows: ${Array.isArray(posBody) ? posBody.length : `(non-array) ${JSON.stringify(posBody).slice(0, 200)}`}`,
    );
  } else {
    console.log("→ 6. positions read skipped (no portfolio account listed)");
  }

  console.log("\nDone. Check whether TWS is still logged in, then record findings in the header.");
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
