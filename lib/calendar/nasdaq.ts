import type Database from "better-sqlite3";
import type { CalendarEventInput } from "@/lib/mutations/calendar";
import { getSecurityIdForSymbol } from "@/lib/queries/briefing-symbols";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { mondayOf } from "@/lib/calendar/date-utils";

// ── Nasdaq earnings-calendar API ────────────────────────────────────
//
// GET https://api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD
// Free, no auth, US-listed only (which structurally avoids the GFL→GFL.TO
// foreign-suffix drift that bites Finnhub). One request per trading day
// returns every company reporting that day, so a held-set intersection is a
// cheap filter over ~5 requests/week.

const FETCH_TIMEOUT_MS = 15_000;

/** Raw row subset from the Nasdaq calendar response (`data.rows[]`). */
export interface NasdaqApiRow {
  symbol?: string;
  time?: string; // time-pre-market | time-after-hours | time-not-supplied
  epsForecast?: string; // consensus EPS, e.g. "($0.44)" or "$0.12"
  eps?: string; // reported actual EPS once out, same format, "" until then
}

/** Injectable per-day fetcher (the DI boundary; real adapter below). */
export type NasdaqDayFetcher = (date: string) => Promise<NasdaqApiRow[] | null>;

/** Parse Nasdaq's money string: "($0.44)" → -0.44, "$0.12" → 0.12, "" → null. */
export function parseNasdaqEps(raw: string | undefined): number | null {
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw.trim());
  const cleaned = raw.replace(/[(),$\s]/g, "");
  if (cleaned === "" || !/^\d*\.?\d+$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

/** Map Nasdaq's `time` token to the bmo/amc/null convention used everywhere. */
export function mapNasdaqTime(time: string | undefined): "bmo" | "amc" | null {
  if (time === "time-pre-market") return "bmo";
  if (time === "time-after-hours") return "amc";
  return null;
}

function hourLabel(hour: "bmo" | "amc" | null): string | null {
  if (hour === "bmo") return "Before Market Open";
  if (hour === "amc") return "After Market Close";
  return null;
}

/** Weekday dates (YYYY-MM-DD) in [start, end] inclusive — skips Sat/Sun. */
function tradingDaysInWindow(start: string, end: string): string[] {
  const out: string[] = [];
  const e = new Date(end + "T00:00:00Z");
  for (
    let d = new Date(start + "T00:00:00Z");
    d <= e;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Real network adapter — one Nasdaq calendar request for a single date. */
export const fetchNasdaqDay: NasdaqDayFetcher = async (date) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.nasdaq.com/api/calendar/earnings?date=${date}`,
      {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { rows?: NasdaqApiRow[] | null } | null;
    };
    return json?.data?.rows ?? [];
  } catch {
    return null; // graceful degrade — reconcile falls back to Finnhub-only
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Fetch earnings from Nasdaq's calendar over [startDate, endDate], filtered to
 * the held/watchlist symbol set (matched via `issuerSiblings` so a GOOGL report
 * counts when the user holds GOOG). Returns `CalendarEventInput[]` shaped exactly
 * like the Finnhub path, with the bmo/amc hour stashed in `raw_json.entry.hour`
 * so `resolveReleaseTime` derives the release time the same way. Per-day fetch
 * failures are skipped; a fully-failed window simply yields fewer rows.
 */
export async function fetchNasdaqEarningsForSymbols(
  db: Database.Database,
  symbols: string[],
  startDate: string,
  endDate: string,
  weekOf: string,
  opts?: { fetchDay?: NasdaqDayFetcher },
): Promise<CalendarEventInput[]> {
  if (symbols.length === 0) return [];
  const fetchDay = opts?.fetchDay ?? fetchNasdaqDay;

  // Expand the held/watchlist set across dual-class siblings, upper-cased.
  const matchSet = new Set<string>();
  for (const sym of symbols) {
    for (const sib of issuerSiblings(sym)) matchSet.add(sib.toUpperCase());
  }

  const events: CalendarEventInput[] = [];
  for (const date of tradingDaysInWindow(startDate, endDate)) {
    const rows = await fetchDay(date);
    if (!rows) continue; // failed day
    for (const row of rows) {
      const symbol = row.symbol?.toUpperCase();
      if (!symbol || !matchSet.has(symbol)) continue;

      const hour = mapNasdaqTime(row.time);
      const epsForecast = parseNasdaqEps(row.epsForecast);
      const epsActual = parseNasdaqEps(row.eps);
      const securityId = getSecurityIdForSymbol(db, symbol);
      const label = hourLabel(hour);

      events.push({
        source: "nasdaq",
        event_type: "earnings",
        event_date: date,
        event_time: null,
        title: label ? `${symbol} earnings (${label})` : `${symbol} earnings`,
        description: null,
        security_id: securityId,
        symbol,
        expected_impact: securityId ? "high" : "medium",
        consensus_estimate: epsForecast != null ? `EPS ${epsForecast.toFixed(2)}` : null,
        previous_value: null,
        raw_json: JSON.stringify({
          entry: { hour, epsForecast, epsActual },
          nasdaq_symbol: row.symbol,
        }),
        source_key: `nasdaq:${symbol}:${date}`,
        // Each row's week_of follows its OWN event_date (not the sync week) —
        // the back-reach window can place a corrected past date in a prior week,
        // and week_of drives the per-week Hub query.
        week_of: mondayOf(date),
      });
    }
  }
  return events;
}
