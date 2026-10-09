/**
 * The line a macro card prints when its actual was refused (follow-up to
 * migration 097, calendar_events.actual_refused_reason).
 *
 * The size check (macroActualProblem in ./macro-figure) stores no actual and
 * a reason when the fetched figure is more than ten times both the consensus
 * and the previous reading. Without a line on the card such a row looked like
 * any row with no actual. The card says so in plain words; the stored reason
 * (which names the figures) is offered as the hover title.
 *
 * Plain module on purpose: no React, no database, no clock, so a server
 * component and a client component can both import it.
 */

/** What the card prints. No figure of its own: the reason carries those. */
export const REFUSED_ACTUAL_TEXT =
  "Actual not shown: the fetched figure was on a different scale from the estimates.";

export interface RefusedActualNote {
  /** The quiet line under the title. */
  text: string;
  /** The stored reason, for the element's `title`. */
  title: string;
}

/**
 * The note for a row, or null when there is nothing to say: the row holds an
 * actual, or carries no reason, or is an earnings row (those never store one).
 * A reason is only ever written beside an empty actual (recordMacroBasis), so
 * the empty-actual check is a second guard, not the main one.
 */
export function refusedActualNote(event: {
  event_type?: string | null;
  actual_value?: string | null;
  actual_refused_reason?: string | null;
}): RefusedActualNote | null {
  if (event.event_type === "earnings") return null;
  if (typeof event.actual_value === "string" && event.actual_value.trim() !== "") return null;
  const reason =
    typeof event.actual_refused_reason === "string" ? event.actual_refused_reason.trim() : "";
  if (reason === "") return null;
  return { text: REFUSED_ACTUAL_TEXT, title: reason };
}
