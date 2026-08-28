/**
 * Pre-print floor — shared trigger condition (QA finding
 * today-bogeys-actuals--future-print-actuals-accepted-no-guard, 2026-08-19;
 * slot floor added 2026-08-28).
 *
 * Refuses to treat a calendar_events row as "already printed" when the print
 * cannot plausibly have happened yet. A manual actuals entry made ahead of
 * the real print, or a wrong vendor value posted early, must not be accepted
 * as if the company had already reported: stamping enriched_at on a future
 * print arms the recap-send gate, flips the cockpit "act check" chip beside
 * its own countdown, and lets the recap composer assert a post-release
 * reaction window that hasn't happened yet.
 *
 * TWO bases, chosen by the caller:
 *
 *  - 'release_time' (default) — the recorded release instant (event_date +
 *    release_time, composed ET wall-clock via composeReleaseInstant, the same
 *    helper the reaction snapshot, enrichment runner, and worksheet pipelines
 *    all use). Right for background roads that are simply asking "has the
 *    scheduled moment passed".
 *
 *  - 'slot' (opts.useSlotFloor, plus a resolvable BMO/AMC slot) — the START
 *    of the slot's window: 16:00 ET for an after-close print, 07:00 ET for a
 *    before-open one. Right for a HUMAN accepting a number they are holding.
 *    Owner report, live 2026-08-26/27: accepting a print-watch line at 16:12
 *    ET was refused because the stored release_time said 17:00 — but for an
 *    AMC name that stored time is very often the CALL time, not the print
 *    (the CRWD/RBRK trap; both printed ~16:05). The slot floor asks the only
 *    question that is actually knowable ahead of the wire — has the window
 *    opened at all — instead of trusting a number we know to be unreliable.
 *    `release` still carries the composed release_time instant for messaging.
 *
 * Unknown floors pass through as NOT pre-print (basis 'none') — the
 * date-windowed row is otherwise trusted, same assumption the reporter-recap
 * road and the IMAX already-reported guard both make.
 *
 * Single source of truth for this condition: the reporter-recap send path
 * (lib/earnings/reporter-recap.ts, release_time basis) and the manual-actuals
 * save path (lib/earnings/actuals.ts, slot basis — which the print-watch
 * accept route inherits through saveManualActuals) both call this so the
 * roads can never disagree about what counts as "before the print." Never
 * fork this condition inline — extend this helper instead.
 */

import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { deriveEarningsSlot, type EarningsSlot } from "@/lib/earnings/earnings-slot";

/** Start of the after-close window, ET wall clock. */
export const AMC_FLOOR_ET = "16:00";
/** Start of the before-open window, ET wall clock. */
export const BMO_FLOOR_ET = "07:00";

export interface PrePrintFloorEvent {
  event_date: string;
  release_time: string | null;
  event_time?: string | null;
  raw_json?: string | null;
}

export interface PrePrintFloorOptions {
  /** Floor on the BMO/AMC slot window instead of the recorded release_time. */
  useSlotFloor?: boolean;
}

export interface PrePrintFloorResult {
  /** True when the print cannot plausibly have happened yet. */
  isPrePrint: boolean;
  /** The recorded release instant, or null when it could not be composed. */
  release: Date | null;
  /** The slot-window floor, when the slot basis was used; null otherwise. */
  floor: Date | null;
  /** Which rule produced `isPrePrint`. */
  basis: "slot" | "release_time" | "none";
  /** The resolved BMO/AMC slot, reported whether or not it was used. */
  slot: EarningsSlot | null;
}

export function checkPrePrintFloor(
  event: PrePrintFloorEvent,
  now: Date = new Date(),
  opts: PrePrintFloorOptions = {},
): PrePrintFloorResult {
  // release_time is NEVER slot evidence here — it is the value the slot floor
  // exists to distrust.
  const slot = deriveEarningsSlot({
    event_time: event.event_time ?? null,
    raw_json: event.raw_json ?? null,
  });

  const release = event.release_time
    ? composeReleaseInstant(event.event_date, event.release_time)
    : null;

  if (opts.useSlotFloor && slot) {
    const floor = composeReleaseInstant(
      event.event_date,
      slot === "amc" ? AMC_FLOOR_ET : BMO_FLOOR_ET,
    );
    if (floor) {
      return {
        isPrePrint: floor.getTime() > now.getTime(),
        release,
        floor,
        basis: "slot",
        slot,
      };
    }
    // Unparseable event_date — fall through to the release_time basis, which
    // will fail to compose too and land on 'none'.
  }

  if (!release) {
    return { isPrePrint: false, release: null, floor: null, basis: "none", slot };
  }
  return {
    isPrePrint: release.getTime() > now.getTime(),
    release,
    floor: null,
    basis: "release_time",
    slot,
  };
}

// ── Refusal copy ───────────────────────────────────────────────────────
//
// The floor SENTENCE lives with the floor: a slot floor and a release-time
// floor are different claims and must never be described with the same
// words. Callers append their own action clause ("Confirm to save anyway.",
// "Enrichment and the recap stay locked until then.") so one floor reads
// correctly on both the save road and the generate road.
//
// Sibling: lib/earnings/actuals.ts::prePrintMessage carries its own copy of
// this wording for the manual-actuals save path (it predates this helper).
// Collapse that one onto this function when that file is next touched — the
// two must keep saying the same thing about the same floor.

const ET_TZ = "America/New_York";

/** "Aug 27, 2026" in ET. */
function etDateLabel(instant: Date): string {
  return instant.toLocaleString("en-US", { timeZone: ET_TZ, dateStyle: "medium" });
}

/**
 * A basis-aware description of why the print cannot have happened yet.
 * Carries no trailing action clause — the caller owns that sentence.
 */
export function describePrePrintFloor(
  eventDate: string,
  result: PrePrintFloorResult,
  now: Date = new Date(),
): string {
  if (result.basis === "slot" && result.floor) {
    const nowEtDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: ET_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    // Name the day too whenever "now" is not the print date, so a click two
    // days early cannot read as "any minute now".
    const nowLabel = now.toLocaleString("en-US", {
      timeZone: ET_TZ,
      ...(nowEtDate === eventDate
        ? { timeStyle: "short" as const }
        : { dateStyle: "medium" as const, timeStyle: "short" as const }),
    });
    return result.slot === "amc"
      ? `This is an after-close print — the window opens at 4:00 PM ET on ${etDateLabel(result.floor)} (now ${nowLabel} ET).`
      : `This is a before-open print — the window opens at 7:00 AM ET on ${etDateLabel(result.floor)} (now ${nowLabel} ET).`;
  }
  if (result.release) {
    const releaseEt = result.release.toLocaleString("en-US", {
      timeZone: ET_TZ,
      dateStyle: "medium",
      timeStyle: "short",
    });
    return `This event's release time (${releaseEt} ET) is still in the future.`;
  }
  return "This print does not look to have happened yet.";
}
