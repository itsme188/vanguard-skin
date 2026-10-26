/**
 * Loads the gitignored IBKR OAuth 1.0a config from data/ibkr-oauth/.
 * Returns null when not configured (so callers degrade gracefully, like the
 * TWS/R2 paths do when their env is absent).
 */

import fs from "node:fs";
import path from "node:path";
import type { IbkrOAuthConfig } from "./oauth-client";
import type { EnvLike } from "@/lib/db/db-path";

/**
 * Where the OAuth credentials folder lives. Precedence: IBKR_OAUTH_DIR, then
 * <VANGUARD_DB_DIR>/ibkr-oauth, then <cwd>/data/ibkr-oauth.
 *
 * Why VANGUARD_DB_DIR: in the packaged Electron app the server's cwd is
 * .../Resources/standalone, which has no data/ folder, so a cwd-anchored path
 * silently found no credentials. Electron injects VANGUARD_DB_DIR (the real
 * data folder).
 *
 * Deliberately NOT resolveDbDir / DATABASE_PATH: a sandbox that points
 * DATABASE_PATH at a copied database must not pick up the live broker
 * credentials that sit beside the original.
 */
export function ibkrOAuthDir(
  env: EnvLike = process.env,
  cwd: string = process.cwd(),
): string {
  return (
    env.IBKR_OAUTH_DIR ||
    path.join(env.VANGUARD_DB_DIR || path.join(cwd, "data"), "ibkr-oauth")
  );
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
