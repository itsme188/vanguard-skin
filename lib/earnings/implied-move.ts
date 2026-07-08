/**
 * Pure implied-move math for the earnings intelligence tier (audit §4C #9).
 * ZERO imports by design (plausibility.ts pattern) — trivially testable and
 * safe to mirror if the Worker ever needs it.
 *
 * Percent-unit convention: all *Pct returns are PERCENT (4.8 = ±4.8%).
 */

/** Straddle quotes above this are corrupt-quote territory, not event pricing. */
export const IMPLIED_MOVE_CORRUPT_CEILING_PCT = 60;

/** Expiries further than this past the print overstate the event move. */
const EXPIRY_CEILING_DAYS = 21;

const DAY_MS = 24 * 60 * 60 * 1000;

function fin(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function straddleImpliedMovePct(
  callMid: number | null, putMid: number | null, spot: number | null,
): number | null {
  if (!fin(callMid) || !fin(putMid) || !fin(spot)) return null;
  if (callMid <= 0 || putMid <= 0 || spot <= 0) return null;
  return ((callMid + putMid) / spot) * 100;
}

export function ivApproxMovePct(iv: number | null, dteDays: number | null): number | null {
  if (!fin(iv) || !fin(dteDays) || iv <= 0 || dteDays <= 0) return null;
  return iv * Math.sqrt(dteDays / 365) * 100;
}

export function pickPostPrintExpiry(
  expirations: string[], eventDate: string, eventTime: "BMO" | "AMC" | null,
): string | null {
  const evMs = Date.parse(`${eventDate}T00:00:00Z`);
  if (!Number.isFinite(evMs)) return null;
  const eligible = expirations
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .filter((e) => {
      const ms = Date.parse(`${e}T00:00:00Z`);
      const sameDayOk = eventTime === "BMO";
      return sameDayOk ? ms >= evMs : ms > evMs;
    })
    .sort();
  const first = eligible[0];
  if (!first) return null;
  const dte = (Date.parse(`${first}T00:00:00Z`) - evMs) / DAY_MS;
  return dte <= EXPIRY_CEILING_DAYS ? first : null;
}

export function pickAtmStrike(strikes: number[], spot: number): number | null {
  if (!fin(spot) || strikes.length === 0) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const s of strikes) {
    if (!fin(s)) continue;
    const d = Math.abs(s - spot);
    if (d < bestDist) { best = s; bestDist = d; }
  }
  return best;
}

export function computeMid(
  bid: number | null, ask: number | null, last: number | null,
): number | null {
  if (fin(bid) && fin(ask) && bid > 0 && ask >= bid) {
    const mid = (bid + ask) / 2;
    if (ask - bid <= 0.5 * mid) return mid; // spread sanity
  }
  if (fin(last) && last > 0) return last;
  return null;
}

/** First Friday on/after eventDate — DTE assumption when no chain resolved. */
export function defaultExpiryFriday(eventDate: string): string {
  const ms = Date.parse(`${eventDate}T00:00:00Z`);
  const d = new Date(ms);
  const dow = d.getUTCDay(); // Fri = 5
  const add = (5 - dow + 7) % 7;
  const out = new Date(ms + add * DAY_MS);
  return out.toISOString().slice(0, 10);
}
