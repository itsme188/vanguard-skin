import type Database from "better-sqlite3";
import type { CalendarEvent } from "@/lib/types";
import { mergeFinnhubActual } from "@/lib/format/finnhub-figure";
import { checkPrePrintFloor } from "@/lib/earnings/pre-print-floor";

export interface SaveManualActualsInput {
  eventId: number;
  epsActual?: number | null;
  revenueActualUsd?: number | null;
  /** Bypass the pre-print floor (user confirmed the future-dated release). */
  force?: boolean;
}

export type SaveManualActualsResult =
  | { ok: true; actualValue: string }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 409; error: string; code: "pre_print"; release: string };

export interface ClearManualActualsInput {
  eventId: number;
}

export type ClearManualActualsResult =
  | { ok: true }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 409; error: string; code: "not_manual" };

/**
 * Save (merge) a manual actuals entry onto a calendar_events row — the
 * BogeysEditModal "Save actuals" override for when enrichment misses or the
 * desk wants to lock in a number by hand.
 *
 * Pre-print floor (QA finding
 * today-bogeys-actuals--future-print-actuals-accepted-no-guard): refuses
 * (409, code 'pre_print') when checkPrePrintFloor finds the event's release
 * instant still in the future, UNLESS opts.force is true. This mirrors the
 * reporter-recap road's pre-print guard (lib/earnings/reporter-recap.ts) —
 * same helper, same condition — so a manual actuals typo two days ahead of
 * the real print can no longer stamp enriched_at and arm the recap-send
 * gate, cockpit "act" chip, and Today releases list against a print that
 * hasn't happened.
 */
export function saveManualActuals(
  db: Database.Database,
  input: SaveManualActualsInput,
): SaveManualActualsResult {
  const event = db
    .prepare(
      `SELECT id, event_date, release_time, actual_value FROM calendar_events WHERE id = ?`,
    )
    .get(input.eventId) as
    | Pick<CalendarEvent, "id" | "event_date" | "release_time" | "actual_value">
    | undefined;
  if (!event) {
    return { ok: false, status: 404, error: `Event ${input.eventId} not found.` };
  }

  if (input.epsActual == null && input.revenueActualUsd == null) {
    return {
      ok: false,
      status: 400,
      error: "Provide at least one of eps_actual or revenue_actual_usd.",
    };
  }

  if (!input.force) {
    const prePrint = checkPrePrintFloor(event);
    if (prePrint.isPrePrint && prePrint.release) {
      const releaseEt = prePrint.release.toLocaleString("en-US", {
        timeZone: "America/New_York",
        dateStyle: "medium",
        timeStyle: "short",
      });
      return {
        ok: false,
        status: 409,
        code: "pre_print",
        error: `This event's release time (${releaseEt} ET) is still in the future — saving actuals now would record a print that hasn't happened. Confirm to save anyway.`,
        release: prePrint.release.toISOString(),
      };
    }
  }

  // MERGE into the stored Finnhub-shaped value — an EPS-only save must not
  // wipe a previously-captured revenue (audit B18). Output stays
  // "EPS X.XX · Rev NNNNNN" so all downstream readers work unchanged.
  const formatted = mergeFinnhubActual(event.actual_value, {
    eps: input.epsActual,
    revenue: input.revenueActualUsd,
  });
  if (!formatted) {
    return {
      ok: false,
      status: 400,
      error: "Provide at least one of eps_actual or revenue_actual_usd.",
    };
  }

  db.prepare(
    `UPDATE calendar_events
        SET actual_value = ?,
            enriched_at = COALESCE(enriched_at, datetime('now')),
            manual_actuals_at = datetime('now')
      WHERE id = ?`,
  ).run(formatted, input.eventId);

  return { ok: true, actualValue: formatted };
}

/**
 * Clear a manually-saved actuals override — the BogeysEditModal "Clear
 * actuals" control (QA finding
 * today-earningshub-bogeys--save-actuals-empty-silent-noop-cannot-clear,
 * decided 2026-08-03; re-confirmed 2026-08-20, DECISIONS-PENDING Option 2).
 *
 * Guarded on calendar_events.manual_actuals_at (migration 084): only rows a
 * human explicitly saved through saveManualActuals can be cleared. A row
 * whose actual_value came from the enrichment pipeline (Finnhub/FRED/Claude)
 * has manual_actuals_at NULL and refuses with 409 — sync-owned actuals stay
 * protected from an accidental wipe.
 *
 * Nulls four columns in one transaction so the pipeline fully re-arms:
 *  - actual_value / enriched_at — the retry-until-complete enrichment road
 *    (lib/calendar/enrichment-runner.ts, `WHERE enriched_at IS NULL`)
 *    re-fetches the next tick while the event is still inside its window.
 *  - manual_actuals_at — clears the clearability stamp itself.
 *  - actual_missing_alerted_at — re-arms alertBlockedRecaps so the
 *    blocked-recap Pushover can fire again if enrichment doesn't land.
 * Deliberately leaves consensus_value, reaction_snapshot, wire_probe_empty_at,
 * and bogeys untouched — none of those are actuals.
 */
export function clearManualActuals(
  db: Database.Database,
  input: ClearManualActualsInput,
): ClearManualActualsResult {
  const event = db
    .prepare(`SELECT id, manual_actuals_at FROM calendar_events WHERE id = ?`)
    .get(input.eventId) as { id: number; manual_actuals_at: string | null } | undefined;
  if (!event) {
    return { ok: false, status: 404, error: `Event ${input.eventId} not found.` };
  }

  if (event.manual_actuals_at == null) {
    return {
      ok: false,
      status: 409,
      code: "not_manual",
      error:
        "This event's actuals weren't entered as a manual override — only manual overrides can be cleared. Sync-owned actuals (Finnhub/FRED enrichment) stay protected.",
    };
  }

  db.prepare(
    `UPDATE calendar_events
        SET actual_value = NULL,
            enriched_at = NULL,
            manual_actuals_at = NULL,
            actual_missing_alerted_at = NULL
      WHERE id = ?`,
  ).run(input.eventId);

  return { ok: true };
}
