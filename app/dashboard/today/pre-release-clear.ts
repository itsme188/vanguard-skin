/**
 * When does a pre-release actual stop being pre-release? (display-only timer)
 *
 * `isPreReleaseActual` answers for one instant, so a chip rendered at 3:59 PM
 * stays "pre-release" until something re-renders the page. A client chip can
 * set one timer for the moment the print window opens. Same floor as
 * `isPreReleaseActual` (slot start 07:00 / 16:00 ET on the event date; an
 * explicit HH:MM release_time only with no derivable slot);
 * tests/dashboard/pre-release-clear.test.ts pins parity with it.
 *
 * Client-safe: same imports as pre-release-actual.ts.
 */

import { nowET, todayET } from "@/lib/calendar/date-utils";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { isPreReleaseActual, type PreReleaseActualInput } from "@/lib/calendar/pre-release-actual";

/** Pad so the timer fires just after the floor, never a tick before it. */
const PAD_MS = 500;

/**
 * Epoch ms at which the row's pre-release state ends, or null when the row is
 * not pre-release now or ends on a later day (a re-render covers that).
 */
export function preReleaseClearsAtMs(row: PreReleaseActualInput, now: Date = new Date()): number | null {
  if (!isPreReleaseActual(row, now)) return null;
  if (row.event_date !== todayET(now)) return null; // a later date clears on a later day
  const slot = deriveEarningsSlot({ event_time: row.event_time, raw_json: row.raw_json });
  const floor =
    slot === "amc"
      ? "16:00"
      : slot === "bmo"
        ? "07:00"
        : row.release_time && /^\d{2}:\d{2}$/.test(row.release_time)
          ? row.release_time
          : null;
  if (!floor) return null;
  const [fh, fm] = floor.split(":").map(Number);
  const [nh, nm] = nowET(now).split(":").map(Number);
  const minutesLeft = fh * 60 + fm - (nh * 60 + nm);
  if (minutesLeft <= 0) return null; // an event_date in the future: clears on a later day
  const intoMinuteMs = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  return now.getTime() + minutesLeft * 60_000 - intoMinuteMs + PAD_MS;
}
