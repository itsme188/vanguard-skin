/**
 * Daily closes from Yahoo's unofficial chart endpoint — same endpoint family
 * and risk posture as lib/benchmark/yahoo-benchmarks.ts (graceful [] on any
 * breakage). Dates are ET-anchored (the exchange's trading day).
 */

export interface DailyClose { date: string; close: number }

const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

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
