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

const ET = "America/New_York";

/** "Aug 27, 2026" in ET. */
function etDateLabel(instant: Date): string {
  return instant.toLocaleString("en-US", { timeZone: ET, dateStyle: "medium" });
}

/**
 * The refusal message, worded for the basis that produced it — a slot floor
 * and a release-time floor are different claims and must not be described
 * with the same sentence.
 */
function prePrintMessage(
  eventDate: string,
  prePrint: ReturnType<typeof checkPrePrintFloor>,
): string {
  if (prePrint.basis === "slot" && prePrint.floor) {
    const nowEtDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: ET,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    // Name the day too whenever "now" is not the print date, so a save two
    // days early cannot read as "any minute now".
    const nowLabel = new Date().toLocaleString("en-US", {
      timeZone: ET,
      ...(nowEtDate === eventDate
        ? { timeStyle: "short" as const }
        : { dateStyle: "medium" as const, timeStyle: "short" as const }),
    });
    return prePrint.slot === "amc"
      ? `This is an after-close print — actuals can be accepted from 4:00 PM ET on ${etDateLabel(prePrint.floor)} (now ${nowLabel} ET). Confirm to save anyway.`
      : `This is a before-open print — actuals can be accepted from 7:00 AM ET on ${etDateLabel(prePrint.floor)} (now ${nowLabel} ET). Confirm to save anyway.`;
  }
  if (prePrint.release) {
    const releaseEt = prePrint.release.toLocaleString("en-US", {
      timeZone: ET,
      dateStyle: "medium",
      timeStyle: "short",
    });
    return `This event's release time (${releaseEt} ET) is still in the future — saving actuals now would record a print that hasn't happened. Confirm to save anyway.`;
  }
  // Unreachable while the caller gates on an anchor, but a refusal must never
  // depend on a "!" to have a sentence.
  return `This print does not look to have happened yet — saving actuals now would record a print that hasn't happened. Confirm to save anyway.`;
}

/**
 * Save (merge) a manual actuals entry onto a calendar_events row — the
 * BogeysEditModal "Save actuals" override for when enrichment misses or the
 * desk wants to lock in a number by hand.
 *
 * Pre-print floor (QA finding
 * today-bogeys-actuals--future-print-actuals-accepted-no-guard): refuses
 * (409, code 'pre_print') when checkPrePrintFloor finds the print cannot have
 * happened yet, UNLESS opts.force is true — so a manual actuals typo two days
 * ahead of the real print can no longer stamp enriched_at and arm the
 * recap-send gate, cockpit "act" chip, and Today releases list against a
 * print that hasn't happened.
 *
 * This road (and the print-watch accept route, which reaches the floor ONLY
 * through this function) uses the SLOT floor — 16:00 ET after-close, 07:00 ET
 * before-open — rather than the recorded release_time. A human saving a
 * number is holding the release; the stored release_time for an AMC name is
 * very often the 5 PM CALL time, and refusing a genuine 16:12 ET accept
 * against that fiction was the live 2026-08-26/27 defect. The background
 * reporter-recap road (lib/earnings/reporter-recap.ts) keeps the
 * release_time basis — it is asking a different question ("has the scheduled
 * moment passed") and has no human holding evidence.
 */
export function saveManualActuals(
  db: Database.Database,
  input: SaveManualActualsInput,
): SaveManualActualsResult {
  const event = db
    .prepare(
      `SELECT id, event_date, release_time, event_time, raw_json, actual_value
         FROM calendar_events WHERE id = ?`,
    )
    .get(input.eventId) as
    | Pick<
        CalendarEvent,
        "id" | "event_date" | "release_time" | "event_time" | "raw_json" | "actual_value"
      >
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
    const prePrint = checkPrePrintFloor(event, new Date(), { useSlotFloor: true });
    const anchor = prePrint.floor ?? prePrint.release;
    if (prePrint.isPrePrint && anchor) {
      return {
        ok: false,
        status: 409,
        code: "pre_print",
        error: prePrintMessage(event.event_date, prePrint),
        release: anchor.toISOString(),
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

  // Stamps THIS row only, deliberately. Fanning the stamp out to the print's
  // other twins here would mark rows the user never saw — a twin can carry a
  // different vendor actual_value, and stamping it would hand a scrape a
  // human's authority (and make it clearable through clearManualActuals).
  // The acceptance still survives a canonical twin flip: reads resolve the
  // stamp across the cluster keyed on the accepted FIGURE
  // (lib/queries/manual-actuals-cluster.ts), and reconcileEarningsDates
  // carries it forward with the figure it describes.
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
