/**
 * Overnight block — numbers-only Worker mirror of lib/digest/overnight.ts
 * (spec: docs/superpowers/specs/2026-07-15-overnight-digest-block-design.md).
 *
 * ONE Yahoo spark request covers all four symbols (digest subrequest budget:
 * 48 → 49 of the free-tier 50). Parses `timestamp` + `close` itself instead
 * of reusing fallback-evening's fetchLast2ClosesBatch, which drops timestamps
 * — the holiday guard needs the latest close's DATE to avoid presenting a
 * days-old move as "overnight". The VK-Dawn commentary extract is
 * deliberately Mac-only (cost/divergence; Dawn's summary already appears in
 * the cloud digest body). Never throws — Yahoo breakage degrades to "no
 * overnight block", never a failed email (the 2026-05-20 lesson).
 */

export interface OvernightInstrument {
  symbol: string;
  label: string;
}

/** Fixed display order per user spec: Korea → bitcoin → Japan → China.
 *  Mirror of lib/digest/overnight.ts::OVERNIGHT_INSTRUMENTS. */
export const OVERNIGHT_INSTRUMENTS: OvernightInstrument[] = [
  { symbol: "^KS11", label: "KOSPI" },
  { symbol: "BTC-USD", label: "Bitcoin" },
  { symbol: "^N225", label: "Nikkei" },
  { symbol: "^HSI", label: "Hang Seng" },
];

export type OvernightMove =
  | { label: string; pct: number; closed?: undefined }
  | { label: string; closed: true };

/** Same threshold as the Mac module: a latest close more than 3 calendar
 *  days old means the market didn't trade overnight (their holiday). */
const HOLIDAY_STALE_DAYS = 3;

const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

function calendarDaysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T12:00:00Z`);
  const db = Date.parse(`${b}T12:00:00Z`);
  return Math.abs(Math.round((db - da) / 86_400_000));
}

interface SparkSeries {
  timestamp?: number[];
  close?: Array<number | null>;
}

/**
 * Fetch last-vs-prior close moves for the four overnight instruments in a
 * single spark request. `today` is the ET date the digest is composed for.
 */
export async function fetchOvernightMovesWorker(today: string): Promise<OvernightMove[]> {
  let data: Record<string, SparkSeries | undefined>;
  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/spark` +
      `?symbols=${OVERNIGHT_INSTRUMENTS.map((i) => encodeURIComponent(i.symbol)).join(",")}` +
      `&range=7d&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    data = (await res.json()) as Record<string, SparkSeries | undefined>;
  } catch (err) {
    console.warn("[overnight] Yahoo spark failed:", err);
    return [];
  }

  const moves: OvernightMove[] = [];
  for (const inst of OVERNIGHT_INSTRUMENTS) {
    const series = data[inst.symbol];
    const ts = series?.timestamp ?? [];
    const closes = series?.close ?? [];

    // Pair each close with its timestamp, dropping nulls (Yahoo interleaves
    // them on partial sessions) so prior/last always refer to real closes.
    const points: { date: string; close: number }[] = [];
    for (let i = 0; i < Math.min(ts.length, closes.length); i++) {
      const c = closes[i];
      if (typeof c !== "number" || !Number.isFinite(c)) continue;
      points.push({ date: ET_DATE.format(new Date(ts[i] * 1000)), close: c });
    }
    if (points.length < 2) continue; // omitted symbol / not enough history → drop the line

    const last = points[points.length - 1];
    const prior = points[points.length - 2];
    if (calendarDaysBetween(last.date, today) > HOLIDAY_STALE_DAYS) {
      moves.push({ label: inst.label, closed: true });
      continue;
    }
    if (prior.close === 0) continue;
    moves.push({ label: inst.label, pct: (last.close / prior.close - 1) * 100 });
  }
  return moves;
}

/** +0.8% / −2.1% — real minus sign (U+2212), matching the Mac renderer. */
function fmtPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "−";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Numbers-only render — same block shape as the Mac minus the VK quote. */
export function renderOvernightLines(moves: OvernightMove[]): string | null {
  if (moves.length === 0) return null;
  const scoreboard = moves
    .map((m) => (m.closed ? `${m.label} closed` : `${m.label} ${fmtPct(m.pct)}`))
    .join(" · ");
  return ["## Overnight", "", scoreboard].join("\n");
}
