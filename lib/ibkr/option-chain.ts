/**
 * Headless option-chain resolution for the earnings straddle (audit §4C #9).
 * Endpoint params pinned by scripts/probe-ibkr-option-chain.ts (2026-07-08) —
 * adjust here ONLY from a fresh probe, never from docs alone.
 *
 * Probe findings incorporated:
 *   - /iserver/secdef/strikes has a cold-cache warm-up quirk (first call for a
 *     given (conid, month) can return {"call":[],"put":[]}, HTTP 200, even
 *     though the month is valid) — bounded poll-with-delay, mirroring
 *     getMarketDataSnapshot's warm-up pattern for the equivalent snapshot quirk.
 *   - /iserver/secdef/info returns an ARRAY of every expiry (incl. weeklies)
 *     in the named month for the given strike+right, NOT one contract —
 *     index [0] can silently be a same-day 0DTE row. We build a
 *     maturityDate → conid map per right and pick via pickPostPrintExpiry.
 *   - bid/ask (SNAPSHOT_FIELDS.BID/ASK) never carry field 31's C/H prefix —
 *     parsed with the plain numeric parser (see market-data.ts).
 */
import { signedRequest, type IbkrOAuthConfig } from "./oauth-client";
import { pickPostPrintExpiry, pickAtmStrike } from "@/lib/earnings/implied-move";

export interface AtmContracts {
  callConid: number;
  putConid: number;
  expiry: string; // YYYY-MM-DD
  strike: number;
}

interface ResolveArgs {
  conid: number;
  /** Underlying ticker — required by the /iserver/secdef/search cache warm-up. */
  symbol: string;
  eventDate: string;
  eventTime: "BMO" | "AMC" | null;
  spot: number;
}

interface ResolveDeps {
  request?: typeof signedRequest;
  /** Delay between strikes-endpoint retries (ms). Defaults small in prod; pass 0 in tests. */
  delayMs?: number;
  /** Bounded retry count for the cold-cache empty-strikes quirk. */
  maxStrikesRetries?: number;
}

const DEFAULT_STRIKES_RETRY_DELAY_MS = 1200;
const DEFAULT_MAX_STRIKES_RETRIES = 3;

/** "20260718" → "2026-07-18"; null on anything else. */
function isoFromMaturity(m: unknown): string | null {
  if (typeof m !== "string" || !/^\d{8}$/.test(m)) return null;
  return `${m.slice(0, 4)}-${m.slice(4, 6)}-${m.slice(6, 8)}`;
}

/** IBKR month token for a date: "JUL26". */
function monthToken(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const mon = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  return `${mon}${String(d.getUTCFullYear()).slice(2)}`;
}

/** Months to scan: the event's month, plus the next month when the print is in the last week. */
function candidateMonths(eventDate: string): string[] {
  const months = [monthToken(eventDate)];
  const d = new Date(`${eventDate}T12:00:00Z`);
  const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  if (d.getUTCDate() > lastDay - 7) months.push(monthToken(nextMonth.toISOString().slice(0, 10)));
  return months;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch strikes for (conid, month), retrying a bounded number of times on the
 * probe-documented cold-cache empty response ({"call":[],"put":[]} at HTTP
 * 200). Returns null if every attempt comes back empty/errored.
 */
async function fetchStrikesWithRetry(
  request: typeof signedRequest,
  cfg: IbkrOAuthConfig,
  lst: string,
  conid: number,
  month: string,
  maxRetries: number,
  delayMs: number,
): Promise<{ call?: number[]; put?: number[] } | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await request(cfg, lst, "GET", "/iserver/secdef/strikes", {
      conid: String(conid), sectype: "OPT", month, exchange: "SMART",
    });
    if (resp.ok) {
      const json = (await resp.json()) as { call?: number[]; put?: number[] };
      if ((json.call?.length ?? 0) > 0) return json;
    }
    if (attempt < maxRetries - 1) await sleep(delayMs);
  }
  return null;
}

export async function resolveAtmContracts(
  cfg: IbkrOAuthConfig,
  lst: string,
  args: ResolveArgs,
  deps: ResolveDeps = {},
): Promise<AtmContracts | null> {
  const request = deps.request ?? signedRequest;
  const delayMs = deps.delayMs ?? DEFAULT_STRIKES_RETRY_DELAY_MS;
  const maxStrikesRetries = deps.maxStrikesRetries ?? DEFAULT_MAX_STRIKES_RETRIES;
  try {
    // Live-probed 2026-07-20 (RTH): /iserver/secdef/strikes can return the
    // empty cold-cache shape indefinitely (9+ polls across two months) unless
    // a /iserver/secdef/search for the underlying ran first — one search call
    // makes strikes populate on the FIRST poll. The 7/8 probe's "retry warms
    // it" observation held only because that session's own search calls had
    // already primed the cache. Best-effort: a search failure must not kill
    // the resolve (the retry loop below remains as defense).
    try {
      await request(cfg, lst, "GET", "/iserver/secdef/search", {
        symbol: args.symbol, secType: "STK",
      });
    } catch (e) {
      console.warn(`[earnings-intel] chain warm-up search failed for ${args.symbol}:`, e);
    }

    for (const month of candidateMonths(args.eventDate)) {
      const strikesJson = await fetchStrikesWithRetry(
        request, cfg, lst, args.conid, month, maxStrikesRetries, delayMs,
      );
      if (!strikesJson) continue;
      const strike = pickAtmStrike(strikesJson.call ?? [], args.spot);
      if (strike == null) continue;

      const byRight: Record<"C" | "P", Map<string, number>> = { C: new Map(), P: new Map() };
      await Promise.all((["C", "P"] as const).map(async (right) => {
        const infoResp = await request(cfg, lst, "GET", "/iserver/secdef/info", {
          conid: String(args.conid), sectype: "OPT", month, strike: String(strike), right, exchange: "SMART",
        });
        if (!infoResp.ok) return;
        const info = (await infoResp.json()) as Array<{ conid?: unknown; maturityDate?: unknown }>;
        if (!Array.isArray(info)) return;
        for (const c of info) {
          const iso = isoFromMaturity(c.maturityDate);
          const cid = typeof c.conid === "number" ? c.conid : Number(c.conid);
          if (iso && Number.isFinite(cid)) byRight[right].set(iso, cid);
        }
      }));
      const shared = [...byRight.C.keys()].filter((e) => byRight.P.has(e));
      const expiry = pickPostPrintExpiry(shared, args.eventDate, args.eventTime);
      if (!expiry) continue;
      return {
        callConid: byRight.C.get(expiry)!,
        putConid: byRight.P.get(expiry)!,
        expiry,
        strike,
      };
    }
    return null;
  } catch (e) {
    console.warn(`[earnings-intel] chain resolve failed for conid ${args.conid}:`, e);
    return null;
  }
}
