import {
  MarketDataType,
  OptionType,
  SecType,
  IBApiTickType,
  type Contract,
  type IBApiNext,
} from "@stoqey/ib";
import { getIbApi } from "./client";
import { pickPostPrintExpiry, pickAtmStrike } from "@/lib/earnings/implied-move";

/**
 * TWS road for the earnings-intel implied move (Task 4 of the IBKR
 * session-yield plan). Fetches the ATM straddle — call + put quotes at the
 * nearest post-print expiry and nearest-to-spot strike — through the
 * already-connected TWS desktop socket. This is preferred over the IBKR Web
 * API road (lib/ibkr/option-chain.ts) because it rides the user's existing
 * TWS session and can never evict or conflict with it (see Tasks 1-3, which
 * made the Web API road yield instead of competing for that session).
 *
 * Merged-strikes edge: `getSecDefOptParams` returns strikes MERGED across
 * every expiration advertised by each per-exchange def, so the ATM strike
 * chosen here is not guaranteed to actually exist for the chosen expiry. In
 * that case the market data snapshot for one or both legs simply returns no
 * ticks — both legs end up all-null and this function returns null, falling
 * through to the next road. This is a deliberate simplification: no
 * per-expiry strike-existence validation round-trip.
 *
 * DELAYED_FROZEN staleness is accepted by design — same rationale as
 * lib/tws/snapshot.ts (a frozen quote beats no quote at all, and the
 * earnings-intel pipeline already tolerates staleness elsewhere).
 *
 * NOT RateLimiter-gated: market data snapshots aren't subject to the
 * 55-requests/10-min HISTORICAL data window (see lib/tws/snapshot.ts's
 * BATCH_SIZE comment) — this call uses one secdef request plus two market
 * data lines, far under IB's ~100 concurrent market-data-line limit.
 */

/** Per-request timeout — same value/idiom as lib/tws/snapshot.ts. */
const SNAPSHOT_TIMEOUT_MS = 15_000;

export interface OptionLegQuote {
  bid: number | null;
  ask: number | null;
  last: number | null;
}

export interface TwsAtmStraddle {
  expiry: string; // YYYY-MM-DD
  strike: number;
  call: OptionLegQuote;
  put: OptionLegQuote;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms / 1000}s`)), ms),
    ),
  ]);
}

/**
 * Local tick-value extractor — same convention as lib/tws/streaming.ts's
 * (unexported) extractTickValue: IB uses -1 (or any non-positive value) as
 * the "no quote" sentinel, so only a strictly-positive finite value counts.
 */
function extractTick(
  ticks: ReadonlyMap<number, { value?: number }>,
  ...tickTypes: number[]
): number | null {
  for (const t of tickTypes) {
    const entry = ticks.get(t);
    if (entry?.value != null && entry.value > 0) return entry.value;
  }
  return null;
}

const EMPTY_LEG: OptionLegQuote = { bid: null, ask: null, last: null };

async function fetchLegQuote(
  api: IBApiNext,
  contract: Contract,
  legLabel: string,
): Promise<OptionLegQuote> {
  try {
    const snapshot = await withTimeout(
      api.getMarketDataSnapshot(contract, "", false),
      SNAPSHOT_TIMEOUT_MS,
      `${legLabel} leg snapshot`,
    );
    return {
      bid: extractTick(snapshot, IBApiTickType.BID, IBApiTickType.DELAYED_BID),
      ask: extractTick(snapshot, IBApiTickType.ASK, IBApiTickType.DELAYED_ASK),
      last: extractTick(snapshot, IBApiTickType.LAST, IBApiTickType.DELAYED_LAST),
    };
  } catch (err) {
    console.warn(
      `[tws-straddle] ${legLabel} leg snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...EMPTY_LEG };
  }
}

/**
 * Fetch the earnings ATM straddle via TWS. Never throws — any failure
 * (not connected, chain lookup failure/timeout, no eligible expiry/strike,
 * or both legs unpriced) resolves to null so the caller can fall through to
 * the next data road.
 */
export async function fetchTwsAtmStraddle(args: {
  symbol: string;
  conid: number;
  eventDate: string;
  eventTime: "BMO" | "AMC" | null;
  spot: number;
}): Promise<TwsAtmStraddle | null> {
  const api = getIbApi();
  if (!api) return null;

  const symbol = args.symbol.toUpperCase();

  let expirations: string[] = [];
  let strikes: number[] = [];
  try {
    const chainDefs = await withTimeout(
      api.getSecDefOptParams(symbol, "", SecType.STK, args.conid),
      SNAPSHOT_TIMEOUT_MS,
      "getSecDefOptParams",
    );

    // Merge expirations + strikes across every per-exchange def, deduping,
    // and reformatting YYYYMMDD -> YYYY-MM-DD (same pattern as
    // app/api/tws/option-chain/route.ts).
    const expirationSet = new Set<string>();
    const strikeSet = new Set<number>();
    for (const def of chainDefs ?? []) {
      for (const exp of def.expirations ?? []) {
        const formatted =
          exp.length === 8 ? `${exp.slice(0, 4)}-${exp.slice(4, 6)}-${exp.slice(6, 8)}` : exp;
        expirationSet.add(formatted);
      }
      for (const strike of def.strikes ?? []) {
        strikeSet.add(strike);
      }
    }
    expirations = Array.from(expirationSet).sort();
    strikes = Array.from(strikeSet).sort((a, b) => a - b);
  } catch (err) {
    console.warn(
      `[tws-straddle] getSecDefOptParams failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const expiry = pickPostPrintExpiry(expirations, args.eventDate, args.eventTime);
  if (!expiry) return null;

  const strike = pickAtmStrike(strikes, args.spot);
  if (strike == null) return null;

  const lastTradeDateOrContractMonth = expiry.replace(/-/g, "");
  const callContract: Contract = {
    symbol,
    secType: SecType.OPT,
    exchange: "SMART",
    currency: "USD",
    lastTradeDateOrContractMonth,
    strike,
    right: OptionType.Call,
  };
  const putContract: Contract = {
    symbol,
    secType: SecType.OPT,
    exchange: "SMART",
    currency: "USD",
    lastTradeDateOrContractMonth,
    strike,
    right: OptionType.Put,
  };

  let call: OptionLegQuote = { ...EMPTY_LEG };
  let put: OptionLegQuote = { ...EMPTY_LEG };
  try {
    api.setMarketDataType(MarketDataType.DELAYED_FROZEN);
    [call, put] = await Promise.all([
      fetchLegQuote(api, callContract, "call"),
      fetchLegQuote(api, putContract, "put"),
    ]);
  } catch (err) {
    console.warn(
      `[tws-straddle] quote fetch failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      api.setMarketDataType(MarketDataType.REALTIME);
    } catch {
      // Non-critical, best-effort reset.
    }
  }

  const callEmpty = call.bid == null && call.ask == null && call.last == null;
  const putEmpty = put.bid == null && put.ask == null && put.last == null;
  if (callEmpty && putEmpty) return null;

  return { expiry, strike, call, put };
}
