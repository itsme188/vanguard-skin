/**
 * The filing summary's in-app actions (spec §1, §8, §11, Late arms,
 * Hardening 9): the logic behind `POST /api/filing-summary`, kept here so the
 * route stays a thin wrapper.
 *
 *   set_choice → stores the per-print choice; refused once a run locked it.
 *   run        → Run summary: only with an accepted earnings filing (or an
 *                untimed one whose document gate passed) and no run yet
 *                (armed after 9 pm, a past print, or an untimed filing).
 *   rerun      → a new run with the given choice; its filing list is rebuilt
 *                from the event's current filings (a companion found since
 *                the last run is included, a filing rejected since is not).
 *   retry      → every failed section of one run goes back to pending.
 *
 * Every paid action (run, rerun, retry) needs a request key and is
 * idempotent on it: the same key never creates a second run. After a paid
 * action the work is kicked without waiting (the section runner is
 * claim-guarded, so a kick racing the 60-second tick is safe), and the tick's
 * timer is made sure to be running.
 *
 * Results carry an HTTP status and a plain sentence; the route only maps them
 * to the response envelope.
 */
import type Database from "better-sqlite3";
import { getCachedModelCatalog } from "@/lib/ai/catalog-source";
import { isSummaryChoice } from "./choice";
import { retryRunWithReason, runNextSection, startRun, type StartRunResult } from "./runner";
import { getEventState, listRuns, setChoice } from "./store";
import { startFilingSummaryTick } from "./tick";
import { runSummaryAvailable } from "./view";
import type { SummaryChoice } from "./types";

export type FilingSummaryAction = "set_choice" | "run" | "rerun" | "retry";

export type ActionResult =
  | { ok: true; data: { eventId: number; runId?: number; created?: boolean; choice?: SummaryChoice } }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

export const NO_FILINGS_TEXT = "No earnings filing has been found for this print yet.";
export const NO_MODEL_TEXT = "No model in that family is available right now.";
export const KEY_CONFLICT_TEXT = "That request was already used for another print.";
export const DISARMED_TEXT = "This print was disarmed; re-arm it to retry.";
export const RUN_NOT_AVAILABLE_TEXT =
  "Run summary is only offered when the earnings filing has been found and no summary has run yet.";
export const NO_RUN_TO_RERUN_TEXT = "There is no summary to re-run yet; use Run summary.";
export const NOTHING_TO_RETRY_TEXT = "That run has nothing to retry.";
export const RUN_NOT_FOUND_TEXT = "That run does not belong to this print.";

/** What a kick runs; replaced in tests so no model call is ever made there. */
export interface ActionSeams {
  kick(db: Database.Database, eventId: number): void;
  catalogIds(): string[];
}

function defaultKick(db: Database.Database, eventId: number): void {
  startFilingSummaryTick(db);
  // The error's class name only: a message can quote filing content.
  void runNextSection(db, eventId).catch((err: unknown) =>
    console.warn(
      `[filing-summary] kicked section run for event ${eventId} failed: ${err instanceof Error ? err.name : typeof err}`,
    ),
  );
}

export const defaultActionSeams: ActionSeams = {
  kick: defaultKick,
  catalogIds: () => getCachedModelCatalog(),
};

const MAX_KEY_LEN = 200;

function validKey(k: unknown): k is string {
  return typeof k === "string" && k.trim().length > 0 && k.length <= MAX_KEY_LEN;
}

function fromStart(res: StartRunResult, eventId: number): ActionResult {
  if (res.ok) return { ok: true, data: { eventId, runId: res.runId, created: res.created } };
  switch (res.reason) {
    case "no_filings":
      return { ok: false, status: 409, error: NO_FILINGS_TEXT };
    case "no_model":
      return { ok: false, status: 503, error: NO_MODEL_TEXT };
    case "request_key_conflict":
      return { ok: false, status: 409, error: KEY_CONFLICT_TEXT };
    case "not_found":
      return { ok: false, status: 404, error: `Event ${eventId} not found` };
  }
}

/**
 * Checks the event the way the worksheet route does: an integer id (400), an
 * existing row (404), a symbol-bearing earnings event (400).
 */
function checkEvent(db: Database.Database, eventId: unknown): ActionResult | null {
  if (typeof eventId !== "number" || !Number.isInteger(eventId)) {
    return { ok: false, status: 400, error: "eventId must be an integer" };
  }
  const row = db
    .prepare("SELECT event_type, symbol FROM calendar_events WHERE id = ?")
    .get(eventId) as { event_type: string; symbol: string | null } | undefined;
  if (!row) return { ok: false, status: 404, error: `Event ${eventId} not found` };
  if (row.event_type !== "earnings" || !row.symbol) {
    return {
      ok: false,
      status: 400,
      error: "Filing summaries are only available for symbol-bearing earnings events.",
    };
  }
  return null;
}

function bodyChoice(body: Record<string, unknown>): SummaryChoice | null | "invalid" {
  if (body.family === undefined && body.effort === undefined) return null;
  const c = { family: body.family, effort: body.effort };
  return isSummaryChoice(c) ? { family: c.family, effort: c.effort } : "invalid";
}

const INVALID_CHOICE: ActionResult = {
  ok: false,
  status: 400,
  error: "Choose one of the five model choices.",
};

export function applyFilingSummaryAction(
  db: Database.Database,
  body: unknown,
  seams: ActionSeams = defaultActionSeams,
): ActionResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const bad = checkEvent(db, b.eventId);
  if (bad) return bad;
  const eventId = b.eventId as number;
  const action = b.action;

  if (action === "set_choice") {
    const choice = bodyChoice(b);
    if (choice === null || choice === "invalid") return INVALID_CHOICE;
    const res = setChoice(db, eventId, choice);
    if (!res.ok) return { ok: false, status: 409, error: "locked" };
    return { ok: true, data: { eventId, choice } };
  }

  if (action !== "run" && action !== "rerun" && action !== "retry") {
    return {
      ok: false,
      status: 400,
      error: 'action must be "set_choice", "run", "rerun" or "retry"',
    };
  }
  if (!validKey(b.requestKey)) {
    return { ok: false, status: 400, error: "requestKey must be a non-empty string" };
  }
  const requestKey = b.requestKey;
  const choice = bodyChoice(b);
  if (choice === "invalid") return INVALID_CHOICE;

  let result: ActionResult;
  if (action === "retry") {
    if (typeof b.runId !== "number" || !Number.isInteger(b.runId)) {
      return { ok: false, status: 400, error: "runId must be an integer" };
    }
    const runId = b.runId;
    if (!listRuns(db, eventId).some((r) => r.id === runId)) {
      return { ok: false, status: 404, error: RUN_NOT_FOUND_TEXT };
    }
    const res = retryRunWithReason(db, runId, requestKey);
    if (!res.ok) {
      if (res.reason === "event_cancelled") return { ok: false, status: 409, error: DISARMED_TEXT };
      if (res.reason === "not_found") return { ok: false, status: 404, error: RUN_NOT_FOUND_TEXT };
      return { ok: false, status: 409, error: NOTHING_TO_RETRY_TEXT };
    }
    result = { ok: true, data: { eventId, runId } };
  } else {
    // A repeated request with the same key answers with the run it created,
    // before any other check (a later disarm does not turn a replay into a refusal).
    if (action === "rerun" && choice === null) return INVALID_CHOICE;
    const replay = startRunReplay(db, eventId, requestKey);
    if (replay) return replay;
    // A disarmed print starts nothing new (the tick would cancel it anyway).
    if (getEventState(db, eventId)?.pollState === "cancelled") {
      return { ok: false, status: 409, error: DISARMED_TEXT };
    }
    if (action === "run") {
      if (!runSummaryAvailable(db, eventId)) {
        return { ok: false, status: 409, error: RUN_NOT_AVAILABLE_TEXT };
      }
      result = fromStart(
        startRun(db, eventId, "manual_run", {
          choice: choice ?? undefined,
          requestKey,
          catalogIds: seams.catalogIds(),
        }),
        eventId,
      );
    } else {
      if (choice === null) return INVALID_CHOICE;
      if (listRuns(db, eventId).length === 0) {
        return { ok: false, status: 409, error: NO_RUN_TO_RERUN_TEXT };
      }
      result = fromStart(
        startRun(db, eventId, "rerun", { choice, requestKey, catalogIds: seams.catalogIds() }),
        eventId,
      );
    }
  }

  if (result.ok) {
    try {
      seams.kick(db, eventId);
    } catch {
      console.warn(`[filing-summary] kick for event ${eventId} failed`);
    }
  }
  return result;
}

/** The run an earlier request with this key created, or a conflict when it was another print's. */
function startRunReplay(db: Database.Database, eventId: number, requestKey: string): ActionResult | null {
  const row = db
    .prepare("SELECT id, event_id FROM filing_summary_runs WHERE request_key = ?")
    .get(requestKey) as { id: number; event_id: number } | undefined;
  if (!row) return null;
  if (row.event_id !== eventId) return { ok: false, status: 409, error: KEY_CONFLICT_TEXT };
  return { ok: true, data: { eventId, runId: row.id, created: false } };
}
