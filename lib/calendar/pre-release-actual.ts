/**
 * Pre-release actual — DISPLAY-ONLY gate (QA finding, HIGH, owner ruling
 * 2026-10-06 Option 1).
 *
 * The manual-actuals save path deliberately lets the desk store a figure ahead
 * of the print (it asks for confirmation first — lib/earnings/actuals.ts).
 * Before this helper, every Today surface then rendered that figure as plain
 * fact hours before the release it belongs to. This answers one question for
 * the renderers: "is this row's actual sitting on a print whose window has not
 * opened yet?" A true answer gets a "pre-release" chip and muted styling; once
 * the window opens the row renders as normal fact with no code change.
 *
 * Same floor as the human-accept gate (checkPrePrintFloor with useSlotFloor,
 * lib/earnings/pre-print-floor.ts): the START of the BMO/AMC slot window
 * (07:00 / 16:00 ET on event_date), slot from deriveEarningsSlot and never
 * from release_time — an AMC row's release_time is often the CALL time. With
 * no derivable slot it falls back to an explicit HH:MM release_time; with
 * neither it trusts the row on its own date (the floor's 'none' pass-through).
 * One addition for display: an event_date after today (ET) is always
 * pre-release. tests/calendar/pre-release-actual.test.ts pins parity with the
 * floor on the event's own date.
 *
 * Client-safe on purpose: pre-print-floor.ts value-imports
 * lib/calendar/reaction-snapshot (which pulls @stoqey/ib), so a 'use client'
 * renderer cannot import it. This compares ET wall-clock strings instead of
 * composing an instant — exact at minute granularity, no DST arithmetic.
 *
 * Never use this as a send, recap, enrichment or write gate — those stay on
 * checkPrePrintFloor.
 */

import { todayET, nowET } from "@/lib/calendar/date-utils";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";

const AMC_FLOOR_ET = "16:00";
const BMO_FLOOR_ET = "07:00";

export interface PreReleaseActualInput {
  event_type?: string | null;
  event_date: string;
  event_time: string | null;
  release_time: string | null;
  raw_json: string | null;
  actual_value: string | null;
}

/** True when the row carries an actual and its print window is still ahead (ET). */
export function isPreReleaseActual(row: PreReleaseActualInput, now: Date = new Date()): boolean {
  if (!row.actual_value) return false;
  if (row.event_type != null && row.event_type !== "earnings") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.event_date)) return false;

  const today = todayET(now);
  if (row.event_date > today) return true;
  if (row.event_date < today) return false;

  // release_time is NEVER slot evidence here (same rule as the accept gate).
  const slot = deriveEarningsSlot({ event_time: row.event_time, raw_json: row.raw_json });
  const floor =
    slot === "amc"
      ? AMC_FLOOR_ET
      : slot === "bmo"
        ? BMO_FLOOR_ET
        : row.release_time && /^\d{2}:\d{2}$/.test(row.release_time)
          ? row.release_time
          : null;
  if (!floor) return false;
  // Both HH:MM, zero-padded 24-hour — lexical compare is chronological.
  return nowET(now) < floor;
}

/** The chip text — "entered manually" only when the actual really was a manual save. */
export function preReleaseActualChipText(manualActualsAt: string | null | undefined): string {
  return manualActualsAt ? "pre-release · entered manually" : "pre-release";
}

/** Tooltip shared by every surface that shows the chip. */
export const PRE_RELEASE_ACTUAL_TITLE =
  "This figure was saved before the release window opened (7:00 AM ET before-open, 4:00 PM ET after-close). It is not a reported result yet.";
