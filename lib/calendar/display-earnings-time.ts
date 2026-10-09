/**
 * What a SCREEN shows as an earnings row's time — display only.
 *
 * User ruling 2026-10-06 ("Option A, display only"). Some vendor rows arrive
 * with no before-open / after-close slot. For those the sync stores the 16:15
 * default (`earningsHourToReleaseTime(null)`), and every screen printed
 * "4:15 PM" as if a source had confirmed it — even for a company whose own
 * history says it reports before the open.
 *
 * The stored time cannot simply be changed: for a slot-less row it also drives
 * automation (the pre-print accept floor, the enrichment window, the recap
 * floor), and storing NULL makes seven pipeline readers skip the row. So the
 * STORED time and every gate stay exactly as they are, and only the label a
 * person reads is corrected:
 *
 *   - a row with a real slot, a clock time a source supplied, or a manual row
 *     → the stored time, exactly as before (kind "stored");
 *   - a slot-less row whose stored time is merely the default → the company's
 *     own usual time when there is trustworthy history, marked as an estimate
 *     (kind "usual"), else "time unknown" (kind "unknown").
 *
 * NEVER import this module from a gate, a cron, an email composer or the
 * Worker: an estimate is not evidence that a print has happened.
 * tests/repo/display-earnings-time-consumers.test.ts fails on a new importer
 * outside app/** and lib/queries/calendar.ts.
 */

import type Database from "better-sqlite3";
import {
  UNKNOWN_RELEASE_TIME_LABEL,
  earningsHourToReleaseTime,
  earningsTimeLabel,
  formatClockTime12,
} from "@/lib/calendar/release-times";
import { addDays } from "@/lib/calendar/date-utils";
import { deriveEarningsSlot, type EarningsSlot } from "@/lib/earnings/earnings-slot";
import { OBSERVATION_LOOKBACK_DAYS, resolveSymbolReleaseTime } from "@/lib/earnings/wire-times";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export interface EarningsDisplayTime {
  /** The text to show. null only for a time-less macro row (unlabelled, as before). */
  label: string | null;
  /**
   * "stored"  — the stored time, shown as-is.
   * "usual"   — an estimate from the company's own history; not exact.
   * "unknown" — a defaulted time with no history behind it.
   */
  kind: "stored" | "usual" | "unknown";
}

export interface DisplayEarningsTimeRow {
  event_type: string;
  event_date: string;
  event_time: string | null;
  release_time: string | null;
  raw_json: string | null;
  source: string;
  symbol: string | null;
}

/** Past reported prints must number at least this many, and all agree. */
export const MIN_AGREEING_PRINTS = 2;

export const USUAL_SLOT_LABELS: Record<EarningsSlot, string> = {
  bmo: "Before the open (usual)",
  amc: "After the close (usual)",
};

/** "07:00" → "~7:00 AM (usual time)". */
export function usualClockLabel(hhmm: string): string | null {
  const clock = formatClockTime12(hhmm);
  return clock ? `~${clock} (usual time)` : null;
}

/**
 * True when the row's stored time is only the fallback the sync writes for a
 * vendor row with no slot — nothing a source actually said.
 *
 * All four must hold; when in doubt the answer is false, so a real time is
 * never hidden:
 *   1. a vendor earnings row (manual rows are the user's own statement);
 *   2. event_time carries nothing — no BMO/AMC/TAS marker, no clock time;
 *   3. no slot can be derived (`deriveEarningsSlot` is null: the vendor hour
 *      in raw_json is absent, null, "unknown" or "dmh");
 *   4. the stored release_time is empty or exactly the generic default. Any
 *      other value came from a per-symbol constant or the wire-time cascade.
 */
export function isDefaultedEarningsTime(row: DisplayEarningsTimeRow): boolean {
  if (row.event_type !== "earnings") return false;
  if (row.source === "manual") return false;
  if (!row.symbol?.trim()) return false;
  const marker = row.event_time?.trim().toLowerCase() ?? "";
  if (marker !== "" && marker !== "unknown") return false;
  if (deriveEarningsSlot({ event_time: row.event_time, raw_json: row.raw_json }) !== null) {
    return false;
  }
  return row.release_time == null || row.release_time === earningsHourToReleaseTime(null);
}

/**
 * The side of the session this company's past REPORTED prints landed on, or
 * null without enough agreement. Vendor-sourced rows only, one vote per print
 * date, inside the same 400-day window the wire-time cascade uses.
 */
function usualSlotFromPastPrints(
  db: Database.Database,
  symbol: string,
  eventDate: string,
): EarningsSlot | null {
  const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
  const ph = family.map(() => "?").join(",");
  let rows: { event_date: string; event_time: string | null; raw_json: string | null }[];
  try {
    rows = db
      .prepare(
        `SELECT event_date, event_time, raw_json
           FROM calendar_events
          WHERE event_type = 'earnings'
            AND UPPER(symbol) IN (${ph})
            AND source != 'manual'
            AND actual_value IS NOT NULL
            AND COALESCE(superseded, 0) = 0
            AND event_date < ?
            AND event_date >= ?`,
      )
      .all(...family, eventDate, addDays(eventDate, -OBSERVATION_LOOKBACK_DAYS)) as typeof rows;
  } catch {
    return null;
  }

  // One vote per print date; a date whose own source rows disagree is a
  // disagreement, not two votes.
  const byDate = new Map<string, Set<EarningsSlot>>();
  for (const r of rows) {
    const slot = deriveEarningsSlot({ event_time: r.event_time, raw_json: r.raw_json });
    if (!slot) continue;
    const set = byDate.get(r.event_date) ?? new Set<EarningsSlot>();
    set.add(slot);
    byDate.set(r.event_date, set);
  }
  // earnings_report_history votes too (report_time pre/post-market). It shares
  // the per-date map, so a date seen in both sources is still ONE vote, and a
  // date whose sources disagree is a disagreement.
  try {
    const hist = db
      .prepare(
        `SELECT reported_date, report_time
           FROM earnings_report_history
          WHERE UPPER(symbol) IN (${ph})
            AND report_time IN ('pre-market', 'post-market')
            AND reported_date < ?
            AND reported_date >= ?`,
      )
      .all(...family, eventDate, addDays(eventDate, -OBSERVATION_LOOKBACK_DAYS)) as {
      reported_date: string;
      report_time: "pre-market" | "post-market";
    }[];
    for (const h of hist) {
      const set = byDate.get(h.reported_date) ?? new Set<EarningsSlot>();
      set.add(h.report_time === "pre-market" ? "bmo" : "amc");
      byDate.set(h.reported_date, set);
    }
  } catch {
    // history table unavailable: calendar evidence alone
  }
  if (byDate.size < MIN_AGREEING_PRINTS) return null;
  const sides = new Set<EarningsSlot>();
  for (const set of byDate.values()) for (const s of set) sides.add(s);
  if (sides.size !== 1) return null;
  return [...sides][0];
}

/**
 * Tie-breaker only: the explicit slot of a SUPERSEDED same-family, same-date
 * twin of this row. A twin carrying only the default time has no slot and says
 * nothing. Display only; never stored.
 */
function twinSlot(
  db: Database.Database,
  symbol: string,
  eventDate: string,
): EarningsSlot | null {
  const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
  const ph = family.map(() => "?").join(",");
  let rows: { event_time: string | null; raw_json: string | null }[];
  try {
    rows = db
      .prepare(
        `SELECT event_time, raw_json
           FROM calendar_events
          WHERE event_type = 'earnings'
            AND UPPER(symbol) IN (${ph})
            AND source != 'manual'
            AND COALESCE(superseded, 0) = 1
            AND event_date = ?`,
      )
      .all(...family, eventDate) as typeof rows;
  } catch {
    return null;
  }
  const sides = new Set<EarningsSlot>();
  for (const r of rows) {
    const slot = deriveEarningsSlot({ event_time: r.event_time, raw_json: r.raw_json });
    if (slot) sides.add(slot);
  }
  return sides.size === 1 ? [...sides][0] : null;
}

export function displayEarningsTime(
  db: Database.Database,
  row: DisplayEarningsTimeRow,
): EarningsDisplayTime {
  const stored: EarningsDisplayTime = { label: earningsTimeLabel(row), kind: "stored" };
  if (!isDefaultedEarningsTime(row)) return stored;
  const symbol = row.symbol!.trim().toUpperCase();

  // 1. The company's known clock time: the wire-time cascade's own lookups
  //    (user → web_verified → observed), then the per-symbol constant table.
  //    A known time equal to the stored one means the stored value IS that
  //    source's answer — show it plainly.
  let known: string | null = null;
  try {
    known = resolveSymbolReleaseTime(db, symbol, null)?.time ?? null;
  } catch {
    known = null;
  }
  if (!known) {
    const constant = earningsHourToReleaseTime(null, symbol);
    if (constant !== earningsHourToReleaseTime(null)) known = constant;
  }
  if (known) {
    if (known === row.release_time) return stored;
    const label = usualClockLabel(known);
    if (label) return { label, kind: "usual" };
  }

  // 2. The side of the session its past reported prints agree on — a slot,
  //    never an invented clock time.
  const slot =
    usualSlotFromPastPrints(db, symbol, row.event_date) ??
    twinSlot(db, symbol, row.event_date);
  if (slot) return { label: USUAL_SLOT_LABELS[slot], kind: "usual" };

  return { label: UNKNOWN_RELEASE_TIME_LABEL, kind: "unknown" };
}

export type WithDisplayTime<T> = T & { display_time: EarningsDisplayTime };

/**
 * Attach `display_time` to each row. Pure post-process: same rows, same
 * order, nothing stored is touched.
 */
export function withDisplayTimes<T extends DisplayEarningsTimeRow>(
  db: Database.Database,
  rows: T[],
): WithDisplayTime<T>[] {
  return rows.map((r) => ({ ...r, display_time: displayEarningsTime(db, r) }));
}
