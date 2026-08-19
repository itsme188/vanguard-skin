/**
 * Pre-print floor — shared trigger condition (QA finding
 * today-bogeys-actuals--future-print-actuals-accepted-no-guard, 2026-08-19).
 *
 * Refuses to treat a calendar_events row as "already printed" when its
 * recorded release instant (event_date + release_time, composed ET
 * wall-clock via composeReleaseInstant — the same helper the reaction
 * snapshot, enrichment runner, and worksheet pipelines all use) is still in
 * the future. A manual actuals entry made ahead of the real print, or a
 * wrong vendor value posted early, must not be accepted as if the company
 * had already reported: stamping enriched_at on a future print arms the
 * recap-send gate, flips the cockpit "act check" chip beside its own
 * countdown, and lets the recap composer assert a post-release reaction
 * window that hasn't happened yet.
 *
 * Unknown release instants (no release_time, or an unparseable
 * event_date/release_time pair) pass through as NOT pre-print — the
 * date-windowed row is otherwise trusted, same assumption the reporter-recap
 * road and the IMAX already-reported guard both make.
 *
 * Single source of truth for this condition: the reporter-recap send path
 * (lib/earnings/reporter-recap.ts) and the manual-actuals save path
 * (lib/earnings/actuals.ts) both call this so the two roads can never
 * disagree about what counts as "before the print." Never fork this
 * condition inline — extend this helper instead.
 */

import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import type { CalendarEvent } from "@/lib/types";

export interface PrePrintFloorResult {
  /** True when the event's recorded release instant is still in the future. */
  isPrePrint: boolean;
  /** The resolved release instant, or null when it could not be composed. */
  release: Date | null;
}

export function checkPrePrintFloor(
  event: Pick<CalendarEvent, "event_date" | "release_time">,
  now: Date = new Date(),
): PrePrintFloorResult {
  if (!event.release_time) return { isPrePrint: false, release: null };
  const release = composeReleaseInstant(event.event_date, event.release_time);
  if (!release) return { isPrePrint: false, release: null };
  return { isPrePrint: release.getTime() > now.getTime(), release };
}
