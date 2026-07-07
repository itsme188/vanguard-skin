/**
 * IBKR Web API market-data snapshot — quote enrichment (IV / HV / 52-week range).
 *
 * The raw /iserver/marketdata/snapshot endpoint returns numeric-coded fields.
 * The code→meaning map below was VERIFIED via a live probe on 2026-06-08
 * (AAPL conid 265598) and cross-checked against the connector's named fields:
 *
 *   31   = last price            "302.94"
 *   7283 = implied vol % (under) "24.279%"  (÷100 → 0.24279 fraction)
 *   7284 = historic vol % (30d)  "23.216%"  (÷100 → 0.23216 fraction)
 *   7293 = 52-week high          "316.94"
 *   7294 = 52-week low           "194.47"
 *
 * Cross-check: 7084 (IV/HV ratio) = 104.6% = 24.279/23.216 ✓; connector
 * implied-vol-underlying.annual_iv = 0.244, historical-vol.annual_pct = 0.232,
 * misc-statistics.high_52w = 316.94 — all agree.
 *
 * Dividend yield is intentionally absent: the raw snapshot doesn't expose it
 * (probe-confirmed across 3 warm-up polls); it lives on a separate fundamentals
 * endpoint and is deferred. See docs/superpowers/specs/2026-06-08-ibkr-market-data-snapshot-design.md.
 */

import { signedRequest, type IbkrOAuthConfig } from "./oauth-client";

export const SNAPSHOT_FIELDS = {
  LAST: "31",
  IV: "7283",
  HV: "7284",
  WK52_HIGH: "7293",
  WK52_LOW: "7294",
} as const;

/** Field codes we request (verified set; no dividend yield in the raw snapshot). */
export const SNAPSHOT_FIELD_CODES: string[] = [
  SNAPSHOT_FIELDS.LAST,
  SNAPSHOT_FIELDS.IV,
  SNAPSHOT_FIELDS.HV,
  SNAPSHOT_FIELDS.WK52_HIGH,
  SNAPSHOT_FIELDS.WK52_LOW,
];

export interface ParsedQuote {
  conid: number | null;
  last: number | null;
  ivUnderlying: number | null; // annualized fraction (0.24 = 24%)
  hv30d: number | null; // annualized fraction
  week52High: number | null;
  week52Low: number | null;
}

/** Parse "24.279%" → 0.24279 (fraction). Null on missing/garbage. */
function parsePercentFraction(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/%$/, ""));
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/** Parse a plain price string "316.94" → 316.94. Null on missing/garbage. */
function parsePlainNumber(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!s) return null;
  // Reject values carrying a magnitude suffix (e.g. "45.0M") — those aren't the
  // plain price/52wk fields we map here, and parseFloat would silently truncate.
  if (/[a-zA-Z%]/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Field 31 (last) ONLY: IBKR prefixes the value with "C" (prior close — the
 * instrument hasn't traded this session) or "H" (halted). Live-probed
 * 2026-07-07 on OPT/BOND conids ("C8.01" for an untraded option premium);
 * documented IBKR convention. The prefixed value is still a real price —
 * strip the marker, then apply the same strict numeric parse. Other fields
 * (52wk hi/lo) never carry prefixes and stay on parsePlainNumber.
 */
function parseLastPrice(v: unknown): number | null {
  if (typeof v === "string") {
    return parsePlainNumber(v.trim().replace(/^[CH]/, ""));
  }
  return parsePlainNumber(v);
}

/** Map one raw snapshot row (numeric-coded fields) → a typed quote. Pure. */
export function parseSnapshotRow(row: Record<string, unknown>): ParsedQuote {
  const conid = typeof row.conid === "number" ? row.conid : null;
  return {
    conid,
    last: parseLastPrice(row[SNAPSHOT_FIELDS.LAST]),
    ivUnderlying: parsePercentFraction(row[SNAPSHOT_FIELDS.IV]),
    hv30d: parsePercentFraction(row[SNAPSHOT_FIELDS.HV]),
    week52High: parsePlainNumber(row[SNAPSHOT_FIELDS.WK52_HIGH]),
    week52Low: parsePlainNumber(row[SNAPSHOT_FIELDS.WK52_LOW]),
  };
}

/**
 * Fetch market-data snapshots for a batch of conids. IBKR "warms up" a conid on
 * the first request (sparse row); the target fields populate on a later poll.
 * We poll up to `maxPolls` times (~1s apart) and merge rows by conid, keeping the
 * most-populated values seen. Returns parsed quotes keyed by conid.
 */
export async function getMarketDataSnapshot(
  cfg: IbkrOAuthConfig,
  lst: string,
  conids: number[],
  opts: { fields?: string[]; maxPolls?: number; pollDelayMs?: number } = {},
): Promise<ParsedQuote[]> {
  if (conids.length === 0) return [];
  const fields = opts.fields ?? SNAPSHOT_FIELD_CODES;
  const maxPolls = opts.maxPolls ?? 3;
  const pollDelayMs = opts.pollDelayMs ?? 1200;
  const path = `/iserver/marketdata/snapshot?conids=${conids.join(",")}&fields=${fields.join(",")}`;

  const merged = new Map<number, ParsedQuote>();
  for (let poll = 0; poll < maxPolls; poll++) {
    let rows: Array<Record<string, unknown>> = [];
    try {
      const res = await signedRequest(cfg, lst, "GET", path);
      if (res.ok) {
        const body = (await res.json()) as unknown;
        if (Array.isArray(body)) rows = body as Array<Record<string, unknown>>;
      }
    } catch {
      // transient — try the next poll
    }
    for (const raw of rows) {
      const q = parseSnapshotRow(raw);
      if (q.conid == null) continue;
      const prev = merged.get(q.conid);
      merged.set(q.conid, prev ? mergeQuote(prev, q) : q);
    }
    // Stop early once every requested conid has its core metrics.
    if (conids.every((c) => isPopulated(merged.get(c)))) break;
    if (poll < maxPolls - 1) await new Promise((r) => setTimeout(r, pollDelayMs));
  }
  return [...merged.values()];
}

function isPopulated(q: ParsedQuote | undefined): boolean {
  return !!q && q.week52High != null && q.last != null;
}

/** Keep the non-null value from either poll (later polls fill warm-up gaps). */
function mergeQuote(a: ParsedQuote, b: ParsedQuote): ParsedQuote {
  return {
    conid: a.conid ?? b.conid,
    last: b.last ?? a.last,
    ivUnderlying: b.ivUnderlying ?? a.ivUnderlying,
    hv30d: b.hv30d ?? a.hv30d,
    week52High: b.week52High ?? a.week52High,
    week52Low: b.week52Low ?? a.week52Low,
  };
}
