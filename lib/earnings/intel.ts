/**
 * Orchestrator for the earnings intelligence tier (audit §4C #9/#10).
 * Best-effort by contract: NEVER throws to a caller — a failed straddle or a
 * rate-limited AV call degrades to cached/absent data, and the preview send
 * path (claim mutex, marker dance) proceeds untouched.
 */
import type Database from "better-sqlite3";
import { loadIbkrConfig } from "@/lib/ibkr/config";
import { openSession } from "@/lib/ibkr/web-api";
import { resolveAtmContracts } from "@/lib/ibkr/option-chain";
import { getMarketDataSnapshot, SNAPSHOT_FIELDS } from "@/lib/ibkr/market-data";
import {
  straddleImpliedMovePct, ivApproxMovePct, computeMid, defaultExpiryFriday,
  IMPLIED_MOVE_CORRUPT_CEILING_PCT,
} from "@/lib/earnings/implied-move";
import { refreshReportHistory } from "@/lib/earnings/report-history";
import { isHistoryStale } from "@/lib/queries/earnings-intel";
import { upsertEarningsIntel } from "@/lib/mutations/earnings-intel";
import { getSecurityIdForSymbolWithSiblings } from "@/lib/queries/briefing-symbols";
import { getSecurityQuote } from "@/lib/queries/security-quotes";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export interface IntelEvent {
  id: number;
  symbol: string;
  event_date: string;
  event_time: string | null; // 'BMO' | 'AMC' | other/null
}

export const INTEL_TTL_MS = 30 * 60 * 1000;
export const AV_FETCH_CAP_PER_RUN = 5;

// In-process TTL so 60s cockpit polling costs at most one OAuth roundtrip per
// event per 30 min (macro-themes limiter pattern). forceFresh bypasses.
const lastComputedAt = new Map<number, number>();
// In-flight claims: the TTL stamps only AFTER a compute finishes, so a poll
// arriving during a slow first compute would pass the TTL check and duplicate
// the IBKR/AV work. Claim before the awaits, release in finally; the skipped
// caller decorates from cache and self-heals on its next poll. forceFresh
// (preview composer) bypasses the event claim — its freshness guarantee wins
// over the rare duplicate.
const inFlightEvents = new Set<number>();
const inFlightFamilies = new Set<string>();
export function __resetIntelTtlForTests(): void {
  lastComputedAt.clear();
  inFlightEvents.clear();
  inFlightFamilies.clear();
}

interface IntelDeps {
  loadConfig: typeof loadIbkrConfig;
  openSession: (cfg: ReturnType<typeof loadIbkrConfig>) => Promise<unknown>;
  resolveChain: typeof resolveAtmContracts;
  snapshot: typeof getMarketDataSnapshot;
  refreshHistory: typeof refreshReportHistory;
  historyStale: typeof isHistoryStale;
  now: () => number;
}

const defaultDeps: IntelDeps = {
  loadConfig: loadIbkrConfig,
  openSession: openSession as unknown as IntelDeps["openSession"],
  resolveChain: resolveAtmContracts,
  snapshot: getMarketDataSnapshot,
  refreshHistory: refreshReportHistory,
  historyStale: isHistoryStale,
  now: Date.now,
};

function normalizeEventTime(t: string | null): "BMO" | "AMC" | null {
  return t === "BMO" || t === "AMC" ? t : null;
}

// A days-old close makes the straddle denominator (and pickAtmStrike input)
// fiction — same 4-calendar-day tolerance as findCrossedLevels' stale-price
// guard (Fri→Mon + long-weekend Mondays pass; longer gaps mean prices are
// suspect). Stale → null → the straddle road is skipped, iv_approx still runs.
const SPOT_MAX_AGE_DAYS = 4;

function latestSpot(db: Database.Database, securityId: number, nowMs: number): number | null {
  const row = db.prepare(
    "SELECT close_price AS p, date AS d FROM prices WHERE security_id = ? ORDER BY date DESC LIMIT 1"
  ).get(securityId) as { p: number; d: string } | undefined;
  if (!row) return null;
  const ageDays = Math.floor((nowMs - Date.parse(`${row.d}T00:00:00Z`)) / 86400_000);
  if (!Number.isFinite(ageDays) || ageDays > SPOT_MAX_AGE_DAYS) return null;
  return row.p;
}

function conidFor(db: Database.Database, securityId: number): number | null {
  const row = db.prepare("SELECT ib_con_id AS c FROM securities WHERE id = ?")
    .get(securityId) as { c: number | null } | undefined;
  return row?.c ?? null;
}

function dteDays(fromMs: number, expiryIso: string): number {
  return Math.max(1, Math.round((Date.parse(`${expiryIso}T16:00:00Z`) - fromMs) / 86400_000));
}

/** Extract the LST string from whatever shape openSession returned (prod: {token,...}; tests: plain string). */
function extractToken(sess: unknown): string | null {
  if (typeof sess === "string") return sess;
  if (sess && typeof sess === "object" && typeof (sess as { token?: unknown }).token === "string") {
    return (sess as { token: string }).token;
  }
  return null;
}

export async function ensureIntelForEvents(
  db: Database.Database,
  events: IntelEvent[],
  opts: { forceFresh?: boolean } = {},
  deps: IntelDeps = defaultDeps,
): Promise<void> {
  if (events.length === 0) return;
  const nowMs = (() => { try { return deps.now(); } catch { return Date.now(); } })();

  // ── History refresh (family-deduped, AV-capped) ──────────────────────────
  try {
    const seenFamilies = new Set<string>();
    let avFetches = 0;
    for (const ev of events) {
      if (avFetches >= AV_FETCH_CAP_PER_RUN) break;
      const famKey = issuerSiblings(ev.symbol).map((s) => s.toUpperCase()).sort().join("|");
      if (seenFamilies.has(famKey)) continue;
      seenFamilies.add(famKey);
      if (inFlightFamilies.has(famKey)) continue; // another overlapping call is fetching this family
      try {
        if (deps.historyStale(db, ev.symbol)) {
          avFetches++;
          inFlightFamilies.add(famKey);
          try {
            await deps.refreshHistory(db, ev.symbol);
          } finally {
            inFlightFamilies.delete(famKey);
          }
        }
      } catch (e) {
        console.warn(`[earnings-intel] history refresh errored for ${ev.symbol}:`, e);
      }
    }
  } catch (e) {
    console.warn("[earnings-intel] history phase failed:", e);
  }

  // ── Implied move per event ───────────────────────────────────────────────
  let lst: string | null = null;
  let sessionTried = false;
  const cfg = (() => { try { return deps.loadConfig(); } catch { return null; } })();

  for (const ev of events) {
    if (!opts.forceFresh) {
      const last = lastComputedAt.get(ev.id);
      if (last != null && nowMs - last < INTEL_TTL_MS) continue;
      if (inFlightEvents.has(ev.id)) continue; // an overlapping poll is computing this event
    }
    inFlightEvents.add(ev.id);
    try {
      const securityId = getSecurityIdForSymbolWithSiblings(db, ev.symbol);
      const spot = securityId != null ? latestSpot(db, securityId, nowMs) : null;
      const eventTime = normalizeEventTime(ev.event_time);

      let impliedMovePct: number | null = null;
      let impliedMethod: "straddle" | "iv_approx" | null = null;
      let expiryUsed: string | null = null;
      let straddleMid: number | null = null;

      // Road 1: straddle via headless chain.
      const conid = securityId != null ? conidFor(db, securityId) : null;
      if (cfg && conid != null && spot != null) {
        try {
          if (lst == null && !sessionTried) {
            sessionTried = true;
            const sess = await deps.openSession(cfg);
            lst = extractToken(sess);
          }
          if (lst != null) {
            const chain = await deps.resolveChain(cfg, lst, {
              conid, symbol: ev.symbol, eventDate: ev.event_date, eventTime, spot,
            });
            if (chain) {
              const quotes = await deps.snapshot(cfg, lst, [chain.callConid, chain.putConid], {
                fields: [SNAPSHOT_FIELDS.LAST, SNAPSHOT_FIELDS.BID, SNAPSHOT_FIELDS.ASK],
              });
              const call = quotes.find((q) => q.conid === chain.callConid);
              const put = quotes.find((q) => q.conid === chain.putConid);
              const callMid = computeMid(call?.bid ?? null, call?.ask ?? null, call?.last ?? null);
              const putMid = computeMid(put?.bid ?? null, put?.ask ?? null, put?.last ?? null);
              const pct = straddleImpliedMovePct(callMid, putMid, spot);
              if (pct != null && pct <= IMPLIED_MOVE_CORRUPT_CEILING_PCT) {
                impliedMovePct = pct;
                impliedMethod = "straddle";
                expiryUsed = chain.expiry;
                straddleMid = (callMid ?? 0) + (putMid ?? 0);
              }
            }
          }
        } catch (e) {
          console.warn(`[earnings-intel] straddle road failed for ${ev.symbol}:`, e);
        }
      }

      // Road 2: IV approximation.
      if (impliedMethod == null && securityId != null) {
        const quote = getSecurityQuote(db, securityId);
        const iv = quote?.iv_underlying ?? null;
        const expiry = defaultExpiryFriday(ev.event_date);
        const pct = ivApproxMovePct(iv, dteDays(nowMs, expiry));
        if (pct != null) {
          impliedMovePct = pct;
          impliedMethod = "iv_approx";
          expiryUsed = expiry;
        }
      }

      upsertEarningsIntel(db, {
        eventId: ev.id, impliedMovePct, impliedMethod, expiryUsed, straddleMid, spot,
        computedAt: new Date(nowMs).toISOString().replace("T", " ").slice(0, 19),
      });
      lastComputedAt.set(ev.id, nowMs);
    } catch (e) {
      console.warn(`[earnings-intel] intel failed for event ${ev.id} (${ev.symbol}):`, e);
    } finally {
      inFlightEvents.delete(ev.id);
    }
  }
}
