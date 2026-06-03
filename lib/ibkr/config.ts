/**
 * Loads the gitignored IBKR OAuth 1.0a config from data/ibkr-oauth/.
 * Returns null when not configured (so callers degrade gracefully, like the
 * TWS/R2 paths do when their env is absent).
 */

import fs from "node:fs";
import path from "node:path";
import type { IbkrOAuthConfig } from "./oauth-client";

export function ibkrOAuthDir(): string {
  return process.env.IBKR_OAUTH_DIR || path.join(process.cwd(), "data", "ibkr-oauth");
}

export function loadIbkrConfig(dir = ibkrOAuthDir()): IbkrOAuthConfig | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, "credentials.json"), "utf8"));
    if (!c.prepend || !c.consumerKey || !c.accessToken || !c.dhPrimeHex) return null;
    return {
      consumerKey: c.consumerKey,
      accessToken: c.accessToken,
      prepend: c.prepend,
      dhPrimeHex: c.dhPrimeHex,
      dhGenerator: c.dhGenerator ?? "2",
      signaturePrivatePem: fs.readFileSync(path.join(dir, "private_signature.pem"), "utf8"),
      baseUrl: c.baseUrl ?? "https://api.ibkr.com/v1/api",
      realm: c.realm ?? "limited_poa",
    };
  } catch {
    return null;
  }
}
