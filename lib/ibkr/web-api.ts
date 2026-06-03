/**
 * IBKR Web API read layer (Tier 2). Thin signed-GET wrappers over the
 * portfolio/iserver endpoints + a session opener. All read-only.
 */

import {
  getLiveSessionToken,
  signedRequest,
  type IbkrOAuthConfig,
  type LiveSessionToken,
} from "./oauth-client";

export interface IbkrPortfolioAccount {
  id: string;
  accountId: string;
  accountTitle?: string;
  currency?: string;
  type?: string;
}

/** Raw position row from /portfolio/{acct}/positions/{page} (fields vary). */
export type RawPosition = Record<string, unknown>;

/** Mint an LST and open the brokerage session (required before /iserver + some /portfolio reads). */
export async function openSession(cfg: IbkrOAuthConfig): Promise<LiveSessionToken> {
  const lst = await getLiveSessionToken(cfg);
  await signedRequest(cfg, lst.token, "POST", "/iserver/auth/ssodh/init", {
    compete: "true",
    publish: "true",
  });
  return lst;
}

export async function getPortfolioAccounts(
  cfg: IbkrOAuthConfig,
  lst: string,
): Promise<IbkrPortfolioAccount[]> {
  const res = await signedRequest(cfg, lst, "GET", "/portfolio/accounts");
  if (!res.ok) throw new Error(`portfolio/accounts HTTP ${res.status}`);
  return (await res.json()) as IbkrPortfolioAccount[];
}

/** All positions for an account, paginating until a short/empty page. */
export async function getPositions(
  cfg: IbkrOAuthConfig,
  lst: string,
  accountId: string,
): Promise<RawPosition[]> {
  const all: RawPosition[] = [];
  for (let page = 0; page < 50; page++) {
    const res = await signedRequest(
      cfg,
      lst,
      "GET",
      `/portfolio/${accountId}/positions/${page}`,
    );
    if (!res.ok) {
      if (page === 0) throw new Error(`positions HTTP ${res.status}`);
      break;
    }
    const batch = (await res.json()) as RawPosition[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 30) break; // IBKR pages positions ~30/page
  }
  return all;
}

/** Account summary (net liquidation, cash, etc.) — shape is a key→{amount} map. */
export async function getAccountSummary(
  cfg: IbkrOAuthConfig,
  lst: string,
  accountId: string,
): Promise<Record<string, unknown>> {
  const res = await signedRequest(cfg, lst, "GET", `/portfolio/${accountId}/summary`);
  if (!res.ok) throw new Error(`summary HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Cash + net liquidation per currency from the ledger. */
export async function getLedger(
  cfg: IbkrOAuthConfig,
  lst: string,
  accountId: string,
): Promise<Record<string, unknown>> {
  const res = await signedRequest(cfg, lst, "GET", `/portfolio/${accountId}/ledger`);
  if (!res.ok) throw new Error(`ledger HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}
