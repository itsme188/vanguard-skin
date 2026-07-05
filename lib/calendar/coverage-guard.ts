/**
 * Earnings coverage guard — the residual-alert half of the Wave 1 design
 * (docs/superpowers/specs/2026-07-05-earnings-wave1-design.md §1).
 *
 * The auto-fix half is the briefing pipeline's 4-week sync reach; this module
 * answers "which held/watchlist names have a report DUE with no source
 * covering it" — the failure mode that produced the July 2026 bank-week hole.
 * Pure DB reads; runs Sunday inside sendBriefingEmail (best-effort).
 */

import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// A report is "due" when the last one is older than this. 75d + the 45d
// look-ahead brackets the quarterly cycle: a name that reported 60d ago has
// its next print ~30d out and typically already scheduled.
const DUE_AFTER_DAYS = 75;
const LOOKAHEAD_DAYS = 45;
const IGNORED_KEY = "coverage_guard_ignored_symbols";

export interface CoverageGap {
  symbol: string;
  kind: "due_no_event" | "no_history";
  lastEventDate: string | null;
  daysSinceLast: number | null;
}

/** Hand-editable escape valve for known-uncoverable names (e.g. foreign
 *  listings Finnhub never returns). JSON array in the settings table; no UI. */
export function getCoverageGuardIgnoredSymbols(db: Database.Database): string[] {
  try {
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(IGNORED_KEY) as { value: string } | undefined;
    if (!row?.value?.trim()) return [];
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? parsed.map((s) => String(s).toUpperCase()) : [];
  } catch {
    return []; // settings table absent (minimal test DBs) or malformed JSON
  }
}

export function findEarningsCoverageGaps(
  db: Database.Database,
  opts: { today?: string } = {},
): CoverageGap[] {
  const today = opts.today ?? todayET();
  const horizon = addDays(today, LOOKAHEAD_DAYS);
  const dueCutoff = addDays(today, -DUE_AFTER_DAYS);
  const ignored = new Set(getCoverageGuardIgnoredSymbols(db));

  // Held stock-like names, quantity != 0 (a short into a print matters),
  // latest row per (account, security) — same shape as getSymbolStatus's
  // held check, widened to shorts.
  const heldRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE h.quantity != 0
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')
          AND s.symbol IS NOT NULL AND s.symbol != ''
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )`,
    )
    .all() as { symbol: string }[];

  const watchlistRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM watchlist w
         JOIN securities s ON s.id = w.security_id
        WHERE w.is_active = 1
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')`,
    )
    .all() as { symbol: string }[];

  const candidates = Array.from(
    new Set([...heldRows, ...watchlistRows].map((r) => r.symbol)),
  )
    .filter((sym) => !ignored.has(sym))
    .sort();

  const gaps: CoverageGap[] = [];
  for (const symbol of candidates) {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const placeholders = family.map(() => "?").join(",");

    const future = db
      .prepare(
        `SELECT 1 FROM calendar_events
          WHERE event_type = 'earnings'
            AND COALESCE(superseded, 0) = 0
            AND event_date BETWEEN ? AND ?
            AND UPPER(symbol) IN (${placeholders})
          LIMIT 1`,
      )
      .get(today, horizon, ...family);
    if (future) continue;

    // Any past event (superseded included) is evidence a source covers the name.
    const last = db
      .prepare(
        `SELECT MAX(event_date) AS d FROM calendar_events
          WHERE event_type = 'earnings'
            AND event_date <= ?
            AND UPPER(symbol) IN (${placeholders})`,
      )
      .get(today, ...family) as { d: string | null };

    if (!last.d) {
      gaps.push({ symbol, kind: "no_history", lastEventDate: null, daysSinceLast: null });
      continue;
    }
    if (last.d < dueCutoff) {
      const daysSinceLast = Math.round(
        (Date.parse(today + "T00:00:00Z") - Date.parse(last.d + "T00:00:00Z")) / 86_400_000,
      );
      gaps.push({ symbol, kind: "due_no_event", lastEventDate: last.d, daysSinceLast });
    }
  }

  // due_no_event first (actionable), then no_history; alpha within each.
  return gaps.sort((a, b) =>
    a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind === "due_no_event" ? -1 : 1,
  );
}

/** Deterministic markdown block appended to the Sunday briefing by code
 *  (never via the AI prompt). Empty string when there is nothing to say. */
export function renderCoverageGapsBlock(gaps: CoverageGap[]): string {
  if (gaps.length === 0) return "";
  const lines = gaps.map((g) =>
    g.kind === "due_no_event"
      ? `- **${g.symbol}** — last report ${g.lastEventDate} (${g.daysSinceLast}d ago); nothing scheduled in the next ${LOOKAHEAD_DAYS} days`
      : `- **${g.symbol}** — no earnings history in the calendar; verify coverage`,
  );
  return `## Earnings coverage gaps\n\n${lines.join("\n")}`;
}
