#!/usr/bin/env tsx
/**
 * IBKR OAuth 1.0a live smoke test (Tier 2 verification).
 *
 * Run AFTER the consumer key has activated (IBKR propagates registration
 * overnight; a fresh registration returns 401 "invalid consumer" until then):
 *
 *   npx tsx scripts/ibkr-oauth-test.ts             # compete=false (polite yield to TWS)
 *   npx tsx scripts/ibkr-oauth-test.ts --compete    # compete=true (old takeover behavior)
 *
 * Does the full headless handshake (no TWS, no Gateway, no browser):
 *   1. POST /oauth/live_session_token  → mint + validate the Live Session Token
 *   2. POST /iserver/auth/ssodh/init   → open the brokerage session
 *   3. GET  /iserver/accounts          → confirm the session
 *   4. GET  /portfolio/accounts        → list portfolio accounts
 *   5. GET  /portfolio/{acctId}/positions → first page of live positions
 *
 * Reads gitignored creds from data/ibkr-oauth/. Read-only; never places orders.
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

async function main() {
  const compete = process.argv.includes("--compete") ? "true" : "false";
  const cfg = loadConfig();

  console.log("→ minting Live Session Token …");
  const lst = await getLiveSessionToken(cfg);
  console.log(`  ✓ LST valid, expires ${new Date(lst.expirationMs).toISOString()}`);

  console.log(`→ opening brokerage session (ssodh/init) { compete: "${compete}" } …`);
  const init = await signedRequest(cfg, lst.token, "POST", "/iserver/auth/ssodh/init", {
    compete,
    publish: "true",
  });
  console.log("  ssodh/init:", init.status, JSON.stringify(await readJson(init)).slice(0, 200));

  console.log("→ GET /iserver/accounts …");
  const accts = await signedRequest(cfg, lst.token, "GET", "/iserver/accounts");
  console.log("  iserver/accounts:", accts.status);

  console.log("→ GET /portfolio/accounts …");
  const portfolio = await signedRequest(cfg, lst.token, "GET", "/portfolio/accounts");
  const portfolioJson = (await readJson(portfolio)) as Array<{ accountId?: string; id?: string }>;
  console.log("  portfolio/accounts:", portfolio.status, JSON.stringify(portfolioJson).slice(0, 300));

  const acctId = Array.isArray(portfolioJson)
    ? portfolioJson[0]?.accountId ?? portfolioJson[0]?.id
    : undefined;
  if (acctId) {
    console.log(`→ GET /portfolio/${acctId}/positions/0 …`);
    const pos = await signedRequest(cfg, lst.token, "GET", `/portfolio/${acctId}/positions/0`);
    const posJson = (await readJson(pos)) as Array<{ contractDesc?: string; position?: number; mktValue?: number }>;
    console.log("  positions:", pos.status, "count:", Array.isArray(posJson) ? posJson.length : "n/a");
    if (Array.isArray(posJson)) {
      for (const p of posJson.slice(0, 8)) {
        console.log(`    ${p.contractDesc ?? "?"}: qty ${p.position ?? "?"}  mktVal ${p.mktValue ?? "?"}`);
      }
    }
  }

  console.log("\n✓ IBKR OAuth 1.0a headless path is LIVE — Tier 2 unblocked.");
}

main().catch((e) => {
  console.error("\n✗ FAILED:", e?.message ?? e);
  if (String(e?.message).includes("invalid consumer")) {
    console.error("  → Consumer key not active yet. IBKR propagates registration overnight; retry later.");
  }
  process.exit(1);
});
