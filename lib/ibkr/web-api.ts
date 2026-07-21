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

/**
 * IBKR allows exactly ONE brokerage session per username. compete:"false"
 * means TWS wins the session when it's holding one — the Web API yields
 * instead of evicting the desktop login, and must surface that yield
 * observably (IbkrSessionYieldError) rather than silently degrading.
 */
export class IbkrSessionYieldError extends Error {
  constructor(
    message = "ibkr-session-yield: brokerage session yielded to an existing TWS session",
  ) {
    super(message);
    this.name = "IbkrSessionYieldError";
  }
}

/**
 * Yield-detection predicate, keyed EXACTLY on the 2026-07-21 live probe
 * (scripts/probe-ibkr-compete.ts — see its header for the full run log).
 * With a live TWS session held, `ssodh/init {compete:"false",publish:"true"}`
 * returned HTTP 200 with body
 * `{"passed":false,"authenticated":false,"connected":true,"competing":false}`.
 * The yield predicate is therefore: response.ok AND a parsed object body AND
 * `body.authenticated === false` — NOT `competing:true`, which is the shape
 * IBKR's docs suggest but the probe disproved. A missing/unparseable body,
 * or a body missing the `authenticated` field, is NOT treated as a yield
 * (lenient by design). Adjust this predicate ONLY from a fresh run of that
 * probe script, never from docs alone.
 */
export function isSessionYield(status: number, ok: boolean, body: unknown): boolean {
  if (!ok) return false;
  if (body == null || typeof body !== "object") return false;
  return (body as { authenticated?: unknown }).authenticated === false;
}

/** Mint an LST and open the brokerage session (required before /iserver + some /portfolio reads). */
export async function openSession(
  cfg: IbkrOAuthConfig,
  deps: {
    request?: typeof signedRequest;
    getLst?: typeof getLiveSessionToken;
  } = {},
): Promise<LiveSessionToken> {
  const request = deps.request ?? signedRequest;
  const getLst = deps.getLst ?? getLiveSessionToken;

  const lst = await getLst(cfg);
  const res = await request(cfg, lst.token, "POST", "/iserver/auth/ssodh/init", {
    compete: "false",
    publish: "true",
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null; // no/unparseable body — lenient, not a yield signal
  }

  if (isSessionYield(res.status, res.ok, body)) {
    throw new IbkrSessionYieldError();
  }
  if (!res.ok) {
    // Preserve today's lenient behavior for any other non-2xx: warn, but
    // still hand back the LST (init failures here have historically been
    // transient and the caller's downstream reads self-heal).
    console.warn(
      `[ibkr] ssodh/init returned HTTP ${res.status} (non-yield) — proceeding with LST anyway`,
      body,
    );
  }

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
