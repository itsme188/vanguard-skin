/**
 * Recap readiness (recap-quality review, owner-approved 2026-11-03).
 *
 * Two facts about a print decide whether an AUTOMATIC recap may go out yet:
 *
 *  1. ACTUALS (fix 2). A recap whose actuals are unconfirmed placeholders
 *     ("Data Gap Notice", every Actual cell "Not yet confirmed") is worse than
 *     none. The scoreboard withholds an actual the plausibility gate flags
 *     (lib/earnings/actuals-display.ts); with that actual withheld the model
 *     has nothing to report and writes the gap into the email. So an auto
 *     recap whose recorded actual is withheld WAITS, the way the pre-print
 *     floor makes the modal wait. A desk-stamped actual (manual_actuals_at) is
 *     the override and is never withheld.
 *
 *  2. REACTION (fix 3). The market reaction lands in the T+2h snapshot. The
 *     simpler of the two designs is used, HOLD-UNTIL-SNAPSHOT on the existing
 *     sweep cadence, not a two-stage send: the recap window is already
 *     "enriched_at + 4h" and the sweep ticks every 15 minutes, so a held recap
 *     simply tries again on the next tick and no second email (and no second
 *     claim row) is needed. The hold is BOUNDED: in the last
 *     REACTION_HOLD_RELEASE_BEFORE_END_MS of the window it lets go, because a
 *     candidate that ages out of the window is never sent at all, and "no
 *     recap" is worse than a recap that says plainly it has no reaction.
 *     Anything that sends without a measured stock reaction says so in its
 *     subject and its first line (lib/digest/send-earnings-email.ts).
 *
 * Held means nothing is claimed, composed or written: the hold costs no retry
 * and lifts the moment the data arrives. A human (the Send recap now nudge, the
 * manual route) is never held; they are told instead.
 *
 * Pure of the db singleton: takes `db`, reads the healed event row.
 */
import type Database from "better-sqlite3";
import { getEventById } from "@/lib/queries/calendar";
import { actualsAreImplausible } from "@/lib/earnings/actuals-display";
import { readReactionLegs } from "@/lib/calendar/reaction-validity";

/** Must equal the candidate window's length in lib/calendar/enrichment-runner.ts (RECAP_WINDOW_MAX_MS). */
export const RECAP_WINDOW_MS = 4 * 60 * 60 * 1000;
/** The hold lets go this long before the window closes. */
export const REACTION_HOLD_RELEASE_BEFORE_END_MS = 30 * 60 * 1000;

export type RecapReadinessHold =
  | { held: false }
  | { held: true; kind: "actuals_unconfirmed" | "reaction_pending"; reason: string };

/** True when the stock's own reaction leg is a real measurement. */
export function hasMeasuredStockReaction(
  reactionSnapshot: string | null | undefined,
  enrichedAt: string | null | undefined,
  eventDate?: string | null,
): boolean {
  const read = readReactionLegs(reactionSnapshot ?? null, {
    rowEnrichedAt: enrichedAt ?? null,
    eventDate: eventDate ?? null,
  });
  return !!read && read.measured.symbol !== undefined;
}

function parseDbInstantMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export const ACTUALS_UNCONFIRMED_REASON =
  "Auto-recap held: the recorded actuals are flagged implausible against consensus, so the scoreboard would be blank. It retries on the next tick; save the actuals (or send by hand) to release it.";
export const REACTION_PENDING_REASON =
  "Auto-recap held: the market reaction snapshot is not captured yet. It retries on the next tick and sends without the reaction, saying so, only near the end of its window.";

export function getRecapReadinessHold(
  db: Database.Database,
  eventId: number,
  now: Date = new Date(),
  opts: {
    /**
     * Never let the reaction hold lapse by age. The sweep's recap lets go near the end of
     * its window so a recap is not silently lost (and then says so); the morning debrief
     * has a content bar that REQUIRES a measured reaction, so it asks for the strict form.
     * One gate, one implementation: the debrief admission calls this same function.
     */
    strictReaction?: boolean;
  } = {},
): RecapReadinessHold {
  const event = getEventById(db, eventId);
  if (!event) return { held: false };

  if (
    event.actual_value &&
    actualsAreImplausible(
      event.consensus_value ?? event.consensus_estimate,
      event.actual_value,
      event.manual_actuals_at,
    )
  ) {
    return { held: true, kind: "actuals_unconfirmed", reason: ACTUALS_UNCONFIRMED_REASON };
  }

  if (!hasMeasuredStockReaction(event.reaction_snapshot, event.enriched_at, event.event_date)) {
    const enrichedMs = parseDbInstantMs(event.enriched_at);
    if (opts.strictReaction) {
      return { held: true, kind: "reaction_pending", reason: REACTION_PENDING_REASON };
    }
    // No enrichment stamp: the finder would not have offered it; nothing to wait on.
    if (enrichedMs !== null) {
      const releaseAt = enrichedMs + RECAP_WINDOW_MS - REACTION_HOLD_RELEASE_BEFORE_END_MS;
      if (now.getTime() < releaseAt) {
        return { held: true, kind: "reaction_pending", reason: REACTION_PENDING_REASON };
      }
    }
  }
  return { held: false };
}

/** Markers of a recap that reports a data gap instead of the print. Matched on the model's body. */
const PLACEHOLDER_MARKERS: readonly RegExp[] = [
  /data gap notice/i,
  /not yet confirmed/i,
  /not yet captured\b(?!.*reaction)/i,
];

/**
 * True when the composed recap body is a placeholder for missing actuals (the
 * 2026-11-02 AAPL and HUN shapes). The reaction line ("Reaction not yet
 * captured.") is NOT a placeholder: a missing reaction is handled by the
 * reaction gate and its disclosure.
 */
export function isPlaceholderRecap(aiMarkdown: string): boolean {
  const withoutReactionLines = aiMarkdown
    .split("\n")
    .filter((l) => !/reaction/i.test(l))
    .join("\n");
  return PLACEHOLDER_MARKERS.some((re) => re.test(withoutReactionLines));
}

/** A recap body must hold ONE recap. Two "Line-by-line" tables, or a digest header, means a stitched or foreign body. */
export function recapBodyProblem(aiMarkdown: string): string | null {
  const tables = (aiMarkdown.match(/^##\s+Line-by-line/gim) ?? []).length;
  if (tables > 1) return `the body holds ${tables} recaps stitched together`;
  if (/^#\s+What changed overnight/im.test(aiMarkdown)) return "the body is the overnight digest, not a recap";
  return null;
}
