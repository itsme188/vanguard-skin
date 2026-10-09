/**
 * Mac-side glue for the macro size check and the reference period (owner
 * rulings 2026-10-08, migration 097). The rule itself is the pure
 * `macroActualProblem` in ./macro-figure (mirrored on the Worker); this file
 * only reads the row's yardsticks and writes the two columns.
 *
 * Used by the two places a macro actual is stored on the Mac:
 *   - lib/calendar/enrichment-runner.ts (FRED and non-FRED rows);
 *   - lib/calendar/cloud-reconcile.ts (a cloud actual is re-checked before it
 *     fills a local NULL).
 * Earnings rows never come through here.
 *
 * The weekly sync never writes either column (upsertCalendarEvents's conflict
 * clause does not list them), so a title or raw_json rewrite cannot undo a
 * result recorded here.
 */

import type Database from "better-sqlite3";
import { isReferencePeriod, macroActualProblem } from "./macro-figure";

export interface MacroYardsticks {
  consensus_estimate: string | null;
  previous_value: string | null;
}

/** The sync-time consensus and previous reading the actual is judged against. */
export function readMacroYardsticks(db: Database.Database, eventId: number): MacroYardsticks {
  const row = db
    .prepare(`SELECT consensus_estimate, previous_value FROM calendar_events WHERE id = ?`)
    .get(eventId) as MacroYardsticks | undefined;
  return row ?? { consensus_estimate: null, previous_value: null };
}

export interface GatedMacroActual {
  /** The actual that may be stored: the input, or null when it was refused. */
  actual: string | null;
  /** Why the actual was refused; null when it stands (or there was none). */
  refusedReason: string | null;
}

/** Apply the size check to an actual that is about to be stored. */
export function gateMacroActual(
  actual: string | null,
  yardsticks: MacroYardsticks,
): GatedMacroActual {
  if (actual == null) return { actual: null, refusedReason: null };
  const refusedReason = macroActualProblem(
    actual,
    yardsticks.consensus_estimate,
    yardsticks.previous_value,
  );
  return refusedReason ? { actual: null, refusedReason } : { actual, refusedReason: null };
}

/**
 * Record the outcome on the row. Run AFTER the pass's own write to
 * actual_value, because the reason is settled against what the row now holds:
 *
 *   - the row has an actual  -> the reason is cleared (a later valid actual
 *     clears an earlier refusal; a reason never sits beside a stored actual);
 *   - the row has no actual  -> a new reason is stored, and with no new reason
 *     an earlier one is kept (a pass that fetched nothing proves nothing).
 *
 * reference_period only ever fills or updates from a well-formed period; a
 * null or malformed one leaves the stored value alone.
 */
export function recordMacroBasis(
  db: Database.Database,
  eventId: number,
  outcome: { refusedReason?: string | null; referencePeriod?: string | null },
): void {
  const period = isReferencePeriod(outcome.referencePeriod) ? outcome.referencePeriod : null;
  db.prepare(
    `UPDATE calendar_events
     SET actual_refused_reason = CASE
           WHEN actual_value IS NOT NULL THEN NULL
           ELSE COALESCE(?, actual_refused_reason)
         END,
         reference_period = COALESCE(?, reference_period)
     WHERE id = ?`,
  ).run(outcome.refusedReason ?? null, period, eventId);
}
