import type Database from "better-sqlite3";
import type { CalendarEventInput } from "@/lib/mutations/calendar";
import { getSecurityIdForSymbol } from "@/lib/queries/briefing-symbols";

// Finnhub free-tier rate limit is 60 req/min. 550ms pacing leaves a margin.
const PACING_MS = 550;
// Per-request network timeout.
const FETCH_TIMEOUT_MS = 15_000;

// ── Finnhub response types ──────────────────────────────────────────

interface EarningsCalendarEntry {
  symbol: string;
  date: string;                 // YYYY-MM-DD
  hour?: "bmo" | "amc" | "dmh"; // before-market-open / after-market-close / during-market-hours
  quarter?: number;
  year?: number;
  epsActual?: number | null;
  epsEstimate?: number | null;
  revenueActual?: number | null;
  revenueEstimate?: number | null;
}

interface EarningsCalendarResponse {
  earningsCalendar?: EarningsCalendarEntry[];
}

export interface EarningsSurpriseEntry {
  symbol: string;
  period: string;     // report period YYYY-MM-DD
  quarter: number;
  year: number;
  actual: number | null;
  estimate: number | null;
  surprise: number | null;
  surprisePercent: number | null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Finnhub ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function formatHour(h: EarningsCalendarEntry["hour"]): string | null {
  if (!h) return null;
  if (h === "bmo") return "Before Market Open";
  if (h === "amc") return "After Market Close";
  if (h === "dmh") return "During Market Hours";
  return null;
}

function formatCount(n: number | null | undefined): string | null {
  if (n == null) return null;
  // Thousands separator for readability; revenue in raw dollars.
  return n.toLocaleString("en-US");
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Fetch upcoming-earnings hits for each symbol against Finnhub's calendar
 * endpoint, then attach last-4-quarters surprise history for any hit.
 *
 * Rate-limited to stay inside the 60 req/min free tier. A scan of ~125
 * symbols takes ~70 seconds; the history pass runs only on symbols that
 * actually reported a hit, so it adds 5–15s at most.
 */
export async function fetchFinnhubEarningsForSymbols(
  db: Database.Database,
  symbols: string[],
  startDate: string,
  endDate: string,
  weekOf: string,
  onProgress?: (done: number, total: number) => void
): Promise<CalendarEventInput[]> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    throw new Error("FINNHUB_API_KEY not set");
  }
  if (symbols.length === 0) return [];

  // Each hit retains the QUERIED symbol — the symbol the user holds and the
  // app reasons about — alongside the Finnhub response. Pre-fix we trusted
  // entry.symbol, which Finnhub sometimes returns with a foreign-exchange
  // suffix (e.g. asking for "GFL" returns "GFL.TO" — the Toronto listing).
  // The .TO row then never surfaces in the EarningsHub as held because
  // getSymbolStatus matches on the user's "GFL" and we stored "GFL.TO".
  // Using the queried symbol throughout keeps everything consistent without
  // a brittle suffix-stripping heuristic that could fold genuine foreign
  // holdings into US listings.
  interface HitWithQuery {
    queried: string;
    entry: EarningsCalendarEntry;
  }
  const hits: HitWithQuery[] = [];

  // Phase A: calendar sweep — 1 req per symbol
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const url =
      `https://finnhub.io/api/v1/calendar/earnings` +
      `?from=${startDate}&to=${endDate}&symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
    try {
      const data = await fetchJson<EarningsCalendarResponse>(url);
      if (data.earningsCalendar && data.earningsCalendar.length > 0) {
        for (const entry of data.earningsCalendar) {
          hits.push({ queried: symbol, entry });
        }
      }
    } catch (err) {
      // One symbol's failure shouldn't abort the whole scan.
      console.warn(
        `[finnhub] calendar fetch failed for ${symbol}: ${err instanceof Error ? err.message : err}`
      );
    }
    onProgress?.(i + 1, symbols.length);
    await sleep(PACING_MS);
  }

  // Phase B: surprise history for each hit. Keyed by the QUERIED symbol so
  // that Finnhub's foreign-exchange suffix doesn't fragment the lookup.
  const historyMap = new Map<string, EarningsSurpriseEntry[]>();
  for (const hit of hits) {
    const url =
      `https://finnhub.io/api/v1/stock/earnings` +
      `?symbol=${encodeURIComponent(hit.queried)}&limit=4&token=${apiKey}`;
    try {
      const rows = await fetchJson<EarningsSurpriseEntry[]>(url);
      if (Array.isArray(rows)) historyMap.set(hit.queried, rows);
    } catch (err) {
      console.warn(
        `[finnhub] history fetch failed for ${hit.queried}: ${err instanceof Error ? err.message : err}`
      );
    }
    await sleep(PACING_MS);
  }

  // Assemble CalendarEventInput[] with rich raw_json for the briefing prompt.
  return hits.map(({ queried, entry }) => {
    // Use the queried symbol as the canonical identifier. The original
    // Finnhub-returned symbol is preserved in raw_json for debugging.
    const symbol = queried;
    const history = historyMap.get(symbol) ?? [];
    const securityId = getSecurityIdForSymbol(db, symbol);

    const hourLabel = formatHour(entry.hour);
    const consensusParts: string[] = [];
    if (entry.epsEstimate != null) {
      consensusParts.push(`EPS ${entry.epsEstimate.toFixed(2)}`);
    }
    if (entry.revenueEstimate != null) {
      consensusParts.push(`Rev ${formatCount(entry.revenueEstimate)}`);
    }
    const consensus = consensusParts.join(" · ") || null;

    const title = hourLabel
      ? `${symbol} earnings (${hourLabel})`
      : `${symbol} earnings`;

    const descriptionLines: string[] = [];
    if (entry.quarter && entry.year) {
      descriptionLines.push(`Q${entry.quarter} ${entry.year} report.`);
    }
    if (history.length > 0) {
      const histLines = history
        .slice(0, 4)
        .map((h) => {
          const pct = h.surprisePercent != null ? `${h.surprisePercent.toFixed(1)}%` : "n/a";
          const act = h.actual != null ? h.actual.toFixed(2) : "n/a";
          const est = h.estimate != null ? h.estimate.toFixed(2) : "n/a";
          return `  - Q${h.quarter} ${h.year}: actual ${act} vs est ${est} (surprise ${pct})`;
        })
        .join("\n");
      descriptionLines.push(`Last 4 quarters (EPS):\n${histLines}`);
    }
    const description = descriptionLines.join("\n\n") || null;

    return {
      source: "finnhub" as const,
      event_type: "earnings",
      event_date: entry.date,
      event_time: null, // Finnhub only gives bmo/amc/dmh, encoded in title/hourLabel
      title,
      description,
      security_id: securityId,
      symbol,
      expected_impact: securityId ? "high" : "medium", // held → high for the user
      consensus_estimate: consensus,
      previous_value: null,
      // raw_json keeps the original Finnhub-returned symbol for debugging
      // (useful when a foreign-suffix divergence ever surfaces again).
      raw_json: JSON.stringify({ entry, history, finnhub_symbol: entry.symbol }),
      source_key: `finnhub:${symbol}:${entry.date}`,
      week_of: weekOf,
    };
  });
}
