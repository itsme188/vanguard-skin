#!/usr/bin/env tsx
/**
 * Probe: /iserver/auth/ssodh/init with compete:"false" — what does IBKR
 * actually return when another session (TWS desktop) holds the username?
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
 * 2026-07-21 ~15:44 ET, scenario (a) TWS logged in, compete=false:
 *   - ssodh/init: HTTP 200 {"passed":false,"authenticated":false,"connected":true,"competing":false}
 *     → the YIELD SHAPE is authenticated:false (+ passed:false) on a 2xx init.
 *     NOT competing:true as IBKR docs suggest — key the predicate on authenticated.
 *   - auth/status after init: fail:"Force compete capability must be used together
 *     with compete flag" — confirms refusal because another session held the user.
 *     The probe could NOT take the session (TWS survives by construction).
 *   - /iserver/* after yield: 401 "not authenticated" — loud, fast, clean degrade.
 *   - SURPRISE: /portfolio/accounts + /portfolio/{acct}/positions/0 return HTTP 200
 *     with full data EVEN when yielded (no brokerage session). Future opportunity:
 *     position reads could proceed on yield (freshness unverified — not relied on).
 *
 * Scenario (b) TWS closed: [pending — run before merge; expect authenticated:true
 * and working reads, proving compete:false does not break the away-from-desk path]
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
