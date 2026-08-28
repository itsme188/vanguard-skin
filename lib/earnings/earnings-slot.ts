/**
 * The BMO/AMC slot of an earnings row — ONE resolver, shared.
 *
 * Three roads used to derive this independently and disagree at the edges:
 * the wire-time cascade's side-of-noon guard (lib/earnings/wire-times.ts),
 * the date-verification candidate slot (lib/calendar/verify-earnings-dates.ts),
 * and — as of the 2026-08-28 slot floor — the pre-print floor
 * (lib/earnings/pre-print-floor.ts). They now all call this.
 *
 * Evidence order, strongest first:
 *   1. a literal "BMO"/"AMC" marker on event_time (curated/manual rows carry
 *      it directly; case-insensitive)
 *   2. an explicit "HH:MM" event_time — the caller stating a known clock time
 *      for THIS print; before 12:00 ET is before-open, else after-close
 *   3. a literal "TAS" event_time — "during trading" is a DISTINCT category,
 *      not a gap: it resolves to null and deliberately stops here rather than
 *      letting a stale raw_json hour invent a side of noon
 *   4. raw_json.entry.hour — the DOMINANT vendor shape. Finnhub
 *      (lib/calendar/finnhub.ts) and Nasdaq (lib/calendar/nasdaq.ts) both
 *      write event_time: null and encode the slot here. "dmh"/"unknown"/
 *      absent → null: there genuinely is no side of noon to claim.
 *
 * release_time is NOT evidence by default, and that is the point. The 2026-08
 * call-time trap (CRWD/RBRK) is exactly a release_time that says 17:00 when
 * the print lands at 16:05 — deriving the slot floor from the number we
 * distrust would defeat the floor. Callers whose purpose is "which half of
 * the day did the vendor mean" (date verification's candidate slot) opt in
 * with allowReleaseTimeFallback; the pre-print floor never does.
 */

import { normalizeEarningsHour } from "@/lib/calendar/release-times";

export type EarningsSlot = "bmo" | "amc";

export interface EarningsSlotInput {
  event_time: string | null;
  raw_json: string | null;
  /** Only consulted with allowReleaseTimeFallback — see the header. */
  release_time?: string | null;
}

export interface DeriveEarningsSlotOptions {
  /**
   * Last-resort: read the slot off release_time's clock hour. For callers
   * asking "which half of the day is this row about", never for callers
   * deciding whether a print can have happened yet.
   */
  allowReleaseTimeFallback?: boolean;
}

function slotFromClock(hhmm: string | null | undefined): EarningsSlot | null {
  if (!hhmm || !/^\d{2}:\d{2}/.test(hhmm)) return null;
  const hour = parseInt(hhmm.slice(0, 2), 10);
  if (Number.isNaN(hour)) return null;
  return hour < 12 ? "bmo" : "amc";
}

export function deriveEarningsSlot(
  row: EarningsSlotInput,
  opts: DeriveEarningsSlotOptions = {},
): EarningsSlot | null {
  const et = row.event_time?.trim().toUpperCase();

  if (et === "BMO") return "bmo";
  if (et === "AMC") return "amc";

  const fromEventTime = slotFromClock(et);
  if (fromEventTime) return fromEventTime;

  // "TAS" — an explicit during-trading marker. No slot, and no guessing from
  // raw_json (which may still carry a stale BMO/AMC hour from the vendor).
  if (et === "TAS") {
    return opts.allowReleaseTimeFallback ? slotFromClock(row.release_time) : null;
  }

  if (row.raw_json) {
    try {
      const parsed = JSON.parse(row.raw_json) as { entry?: { hour?: unknown } };
      const hour = normalizeEarningsHour(parsed.entry?.hour);
      if (hour === "bmo" || hour === "amc") return hour;
    } catch {
      // malformed vendor payload — fall through
    }
  }

  return opts.allowReleaseTimeFallback ? slotFromClock(row.release_time) : null;
}
