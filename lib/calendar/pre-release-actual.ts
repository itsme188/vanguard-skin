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
 * The one place this differs from the save floor (decision taken on
 * recommendation 2026-10-08, display only, the same shape as the 2026-10-06
 * slot-less ruling): a vendor row with no slot stores the 16:15 default, so a
 * figure typed in after a before-the-open print stayed "pre-release" all day.
 * When the screen has attached the company's usual side to such a row
 * (`display_time.slot`, an estimate made for the time label), the chip clears
 * at that side's window. A real slot on the row always wins. The save floor
 * has no such input and keeps reading the stored time; the estimate is never
 * stored and never reaches a gate.
 *
 * Never use this as a send, recap, enrichment or write gate — those stay on
 * checkPrePrintFloor.
 */

import { todayET, nowET } from "@/lib/calendar/date-utils";
import { deriveEarningsSlot, type EarningsSlot } from "@/lib/earnings/earnings-slot";

const AMC_FLOOR_ET = "16:00";
const BMO_FLOOR_ET = "07:00";

export interface PreReleaseActualInput {
  event_type?: string | null;
  event_date: string;
  event_time: string | null;
  release_time: string | null;
  raw_json: string | null;
  actual_value: string | null;
  /**
   * The time label the page attached to the row, when it did. Only its `slot`
   * is read: the company's usual side for a slot-less vendor row. An estimate,
   * for display only. Declared structurally so this file imports nothing from
   * the label module.
   */
  display_time?: { slot?: EarningsSlot | null } | null;
}

/**
 * The ET wall-clock time ("HH:MM") at which a row's print window opens, or
 * null when nothing on the row says. Shared by the chip and its timer
 * (app/dashboard/today/pre-release-clear.ts) so the two cannot disagree.
 *
 * Order: the row's own slot; else the usual side the screen attached; else an
 * explicit stored HH:MM. release_time is NEVER slot evidence (same rule as
 * the accept gate).
 */
export function preReleaseFloorET(
  row: Pick<PreReleaseActualInput, "event_time" | "release_time" | "raw_json" | "display_time">,
): string | null {
  const slot =
    deriveEarningsSlot({ event_time: row.event_time, raw_json: row.raw_json }) ??
    usualSide(row.display_time?.slot);
  if (slot === "amc") return AMC_FLOOR_ET;
  if (slot === "bmo") return BMO_FLOOR_ET;
  return row.release_time && /^\d{2}:\d{2}$/.test(row.release_time) ? row.release_time : null;
}

/** Only the two known sides count; anything else on the wire is ignored. */
function usualSide(slot: unknown): EarningsSlot | null {
  return slot === "bmo" || slot === "amc" ? slot : null;
}

/** True when the row carries an actual and its print window is still ahead (ET). */
export function isPreReleaseActual(row: PreReleaseActualInput, now: Date = new Date()): boolean {
  if (!row.actual_value) return false;
  if (row.event_type != null && row.event_type !== "earnings") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.event_date)) return false;

  const today = todayET(now);
  if (row.event_date > today) return true;
  if (row.event_date < today) return false;

  const floor = preReleaseFloorET(row);
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
