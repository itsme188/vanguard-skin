/**
 * IBKR Web API read layer (Tier 2). Thin signed-GET wrappers over the
 * portfolio/iserver endpoints + a session opener. All read-only.
 */

import net from "node:net";
import { getTwsStatus } from "@/lib/tws/client";
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
 * IBKR allows exactly ONE brokerage session per username, and this consumer
 * key is provisioned with the "force-compete" capability — probe-verified
 * 2026-07-21 (scripts/probe-ibkr-compete.ts, full four-row run log in that
 * script's header): `compete:"false"` is REJECTED for this key in every
 * scenario (TWS open OR closed — `auth/status` after init: `fail:"Force
 * compete capability must be used together with compete flag"`), so it can
 * never be used to open a session. `compete:"true"` DOES authenticate, and
 * is safe here specifically because `openSession` gates it on a LOCAL TWS
 * port check first — see `isTwsListeningLocally` below. When that gate
 * fires (TWS is alive locally), the Web API yields (IbkrSessionYieldError)
 * WITHOUT ever calling IBKR, so compete:"true" only reaches IBKR when TWS is
 * confirmed absent and there is nothing to evict.
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
 * (lenient by design). Post-pivot (compete:"true" gated on the local TWS
 * check) this predicate is a DEFENSIVE backstop only — the local gate is now
 * the primary yield-detection mechanism. Adjust this predicate ONLY from a
 * fresh run of the probe script, never from docs alone.
 */
export function isSessionYield(status: number, ok: boolean, body: unknown): boolean {
  if (!ok) return false;
  if (body == null || typeof body !== "object") return false;
  return (body as { authenticated?: unknown }).authenticated === false;
}

/**
 * Probe whether something is listening on the local TWS API port (default
 * 127.0.0.1:7496) via a raw TCP connect — resolves true on connect, false on
 * any error or timeout. Always destroys the socket. This is the primary
 * yield-detection mechanism for `openSession`: it answers "is TWS alive on
 * this machine right now" independent of whether THIS process happens to
 * hold an IBApiNext connection to it (a fresh process / a TWS started after
 * this Node process booted would otherwise look falsely "closed").
 *
 * Single-machine assumption: this only sees TWS instances running on the
 * SAME Mac as the Node process. A TWS running on a different machine (not
 * this app's supported topology) would be invisible to this check.
 */
export function isTwsListeningLocally(
  host: string,
  port: number,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function defaultIsTwsListening(): Promise<boolean> {
  const { host, port } = getTwsStatus();
  return isTwsListeningLocally(host, port);
}

/**
 * Open the brokerage session (required before /iserver reads; NOT required
 * for /portfolio reads — see fetchIbkrPortfolio, which is sessionless).
 *
 * Order matters:
 *   1. Local-TWS gate FIRST — if anything is listening on the local TWS API
 *      port, throw IbkrSessionYieldError immediately. No LST mint, no IBKR
 *      network call at all. This is the primary yield path post-pivot.
 *   2. Otherwise mint an LST and POST ssodh/init with `compete:"true"` — safe
 *      because step 1 already confirmed TWS is not running locally, so
 *      compete:"true" has nothing to evict.
 *   3. isSessionYield is kept as a defensive backstop: with compete:"true"
 *      and no local TWS, init should return authenticated:true; if the body
 *      is yield-shaped anyway, still throw (the session is unusable — any
 *      /iserver call would 401) and warn loudly, since that would mean the
 *      local gate and IBKR's own view disagree.
 */
export async function openSession(
  cfg: IbkrOAuthConfig,
  deps: {
    request?: typeof signedRequest;
    getLst?: typeof getLiveSessionToken;
    isTwsListening?: () => Promise<boolean>;
  } = {},
): Promise<LiveSessionToken> {
  const request = deps.request ?? signedRequest;
  const getLst = deps.getLst ?? getLiveSessionToken;
  const isTwsListening = deps.isTwsListening ?? defaultIsTwsListening;

  if (await isTwsListening()) {
    throw new IbkrSessionYieldError();
  }

  const lst = await getLst(cfg);
  const res = await request(cfg, lst.token, "POST", "/iserver/auth/ssodh/init", {
    compete: "true",
    publish: "true",
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null; // no/unparseable body — lenient, not a yield signal
  }

  if (isSessionYield(res.status, res.ok, body)) {
    // Should not happen post-pivot (the local gate already confirmed TWS is
    // absent) — loud warning because it means the local check and IBKR's own
    // view disagree, which is worth investigating rather than silently
    // swallowing.
    console.warn(
      "[ibkr] ssodh/init returned a yield-shaped body even though the local TWS gate found nothing listening — treating as a session yield defensively",
      body,
    );
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
