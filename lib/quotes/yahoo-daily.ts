/**
 * Daily closes from Yahoo's unofficial chart endpoint — same endpoint family
 * and risk posture as lib/benchmark/yahoo-benchmarks.ts (graceful [] on any
 * breakage). Dates are ET-anchored (the exchange's trading day).
 */

export interface DailyClose { date: string; close: number }

const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/**
 * Rolling 24h percent change from hourly bars — for 24/7 assets (BTC-USD)
 * where a "daily close" pair measures only the partial UTC day at digest
 * time (the 7/20 "Bitcoin −0.1%" vs VK's "dipped 75bp" mismatch). Latest
 * valid hourly bar vs the bar closest to 24h earlier; null when the series
 * has no bar within 3h of that target, or on any breakage (graceful-null,
 * same risk posture as fetchYahooDailyCloses).
 */
export async function fetchYahooRolling24hPct(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1h&range=2d`;
    const resp = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const r = json.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    const points: { t: number; c: number }[] = [];
    for (let i = 0; i < Math.min(ts.length, closes.length); i++) {
      const c = closes[i];
      if (typeof c !== "number" || !Number.isFinite(c)) continue;
      points.push({ t: ts[i], c });
    }
    if (points.length < 2) return null;

    const last = points[points.length - 1];
    const target = last.t - 24 * 3600;
    let prior = points[0];
    let bestDiff = Math.abs(points[0].t - target);
    for (const p of points) {
      const diff = Math.abs(p.t - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        prior = p;
      }
    }
    if (bestDiff > 3 * 3600) return null; // series too sparse to call it "24h"
    if (prior.t === last.t || prior.c === 0) return null;
    return (last.c / prior.c - 1) * 100;
  } catch {
    return null;
  }
}

export async function fetchYahooDailyCloses(
  symbol: string,
  fromDate: string, // YYYY-MM-DD inclusive
  toDate: string,   // YYYY-MM-DD inclusive
  fetchImpl: typeof fetch = fetch,
): Promise<DailyClose[]> {
  try {
    const p1 = Math.floor(Date.parse(`${fromDate}T00:00:00-05:00`) / 1000);
    const p2 = Math.floor(Date.parse(`${toDate}T23:59:59-05:00`) / 1000);
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&period1=${p1}&period2=${p2}`;
    const resp = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return [];
    const json = (await resp.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const r = json.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    const out: DailyClose[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c !== "number" || !Number.isFinite(c)) continue;
      out.push({ date: ET_DATE.format(new Date(ts[i] * 1000)), close: c });
    }
    return out;
  } catch {
    return [];
  }
}
