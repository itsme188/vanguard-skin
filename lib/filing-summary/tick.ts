/**
 * The filing summary's durable 60-second tick (spec R12, Hardening 10).
 *
 * One tick:
 *  1. once per process, sweeps pushes left `sending` by a crash to
 *     `delivery_unknown` (R16);
 *  2. cancels every event whose worksheet flag is gone: `poll_state =
 *     'cancelled'`, its pending sections `failed` / `cancelled` (a section
 *     already running finishes; nothing new starts);
 *  3. for every armed earnings event dated today or yesterday (Eastern):
 *     re-arm handling (a `cancelled` event armed again before 20:00 on its
 *     date goes back to `waiting`; an existing run is kept and no new run
 *     starts), then `pollEvent`;
 *  4. runs one section per event that has work (`runNextSection`, Task 10's
 *     runner), sequentially. A cancelled event starts nothing new.
 *
 * A tick never overlaps itself (in-process latch); paid work is guarded by the
 * section claims in the store, not by this latch. Everything is on the
 * Eastern clock. The interval is unref'd and inert under VITEST unless a test
 * opts in, like the first-pass read scheduler.
 *
 * The runner is reached only through seams. Production loads `./runner`
 * lazily at tick time; if it cannot be loaded the tick is skipped (polling
 * without a runner would insert filings whose "accepted" callback is lost).
 */
import type Database from "better-sqlite3";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { getArmedWorksheetEvents } from "@/lib/queries/earnings-worksheet-flags";
import { resolveCik } from "@/lib/print-watch/edgar-adapter";
import { acquisitionScheduler } from "@/lib/print-watch/scheduler";
import { MANUAL_ONLY_DETAIL, pollEvent, pollPhase, type PollSeams } from "./poller";
import {
  getEventState,
  listEventsWithPendingSections,
  markSendingAsUnknown,
  upsertEventState,
} from "./store";

export const FILING_SUMMARY_TICK_MS = 60_000;
/** Every SEC request a tick makes is aborted after this long. */
export const FILING_SUMMARY_TICK_FETCH_DEADLINE_MS = 4 * 60_000;
export const DISARMED_DETAIL = "disarmed — nothing new starts";

export interface TickSeams extends PollSeams {
  /** Task 10: claim and run the event's next section. */
  runNextSection(db: Database.Database, eventId: number): Promise<unknown>;
}

export interface TickOutcome {
  /** True when another tick was still running (nothing done). */
  skipped: boolean;
  cancelled: number[];
  rearmed: number[];
  polled: number[];
  ran: number[];
}

// ---------------------------------------------------------------- cancel / re-arm

/** Disarmed events: state → cancelled, pending sections → failed/cancelled. */
function cancelDisarmed(db: Database.Database): number[] {
  const ids = (
    db
      .prepare(
        `SELECT e.event_id FROM filing_summary_events e
          WHERE e.poll_state <> 'cancelled'
            AND NOT EXISTS (SELECT 1 FROM earnings_worksheet_flags f WHERE f.event_id = e.event_id)
          ORDER BY e.event_id`,
      )
      .all() as Array<{ event_id: number }>
  ).map((r) => r.event_id);
  const cancelOne = db.transaction((eventId: number) => {
    upsertEventState(db, eventId, { pollState: "cancelled", pollDetail: DISARMED_DETAIL });
    const runIds = (
      db
        .prepare(
          `SELECT DISTINCT s.run_id FROM filing_summary_sections s
             JOIN filing_summary_runs r ON r.id = s.run_id
            WHERE r.event_id = ? AND s.status = 'pending'`,
        )
        .all(eventId) as Array<{ run_id: number }>
    ).map((r) => r.run_id);
    db.prepare(
      `UPDATE filing_summary_sections
          SET status = 'failed', error_class = 'cancelled', error_text = 'disarmed',
              claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL,
              finished_at = datetime('now')
        WHERE status = 'pending'
          AND run_id IN (SELECT id FROM filing_summary_runs WHERE event_id = ?)`,
    ).run(eventId);
    // The run status rule the store applies on finalize: all done → done; any
    // failed with nothing open → failed; otherwise running.
    const recompute = db.prepare(
      `UPDATE filing_summary_runs
          SET status = CASE
                WHEN (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id) > 0
                 AND (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id AND status <> 'done') = 0
                  THEN 'done'
                WHEN (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id AND status = 'failed') > 0
                 AND (SELECT COUNT(*) FROM filing_summary_sections WHERE run_id = :id AND status IN ('pending','running')) = 0
                  THEN 'failed'
                ELSE 'running' END
        WHERE id = :id`,
    );
    const stampFinished = db.prepare(
      `UPDATE filing_summary_runs SET finished_at = COALESCE(finished_at, datetime('now'))
        WHERE id = ? AND status <> 'running'`,
    );
    for (const runId of runIds) {
      recompute.run({ id: runId });
      stampFinished.run(runId);
    }
  });
  for (const id of ids) cancelOne(id);
  return ids;
}

/**
 * Armed again after a disarm (ruling 7): on the event date before 20:00 →
 * `waiting` (an existing run is kept, none starts); later → `manual_only`.
 */
function rearm(db: Database.Database, eventId: number, eventDate: string, nowMs: number): void {
  if (pollPhase(eventDate, nowMs) === "after_cutoff") {
    upsertEventState(db, eventId, {
      pollState: "manual_only",
      pollDetail: MANUAL_ONLY_DETAIL,
      catchupDone: true,
    });
    return;
  }
  upsertEventState(db, eventId, { pollState: "waiting", pollDetail: null, catchupDone: false });
}

// ---------------------------------------------------------------- the tick

let ticking = false;
let sendingSwept = false;

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export async function runTick(
  db: Database.Database,
  nowMs: number,
  seams: TickSeams,
): Promise<TickOutcome> {
  const out: TickOutcome = { skipped: false, cancelled: [], rearmed: [], polled: [], ran: [] };
  if (ticking) return { ...out, skipped: true };
  ticking = true;
  try {
    if (!sendingSwept) {
      markSendingAsUnknown(db);
      sendingSwept = true;
    }

    out.cancelled = cancelDisarmed(db);

    const today = todayET(new Date(nowMs));
    const armed = getArmedWorksheetEvents(db, [addDays(today, -1), today]);
    for (const ev of armed) {
      if (getEventState(db, ev.eventId)?.pollState === "cancelled") {
        rearm(db, ev.eventId, ev.event_date, nowMs);
        out.rearmed.push(ev.eventId);
      }
      try {
        const res = await pollEvent(db, ev.eventId, nowMs, seams);
        if (res.action === "polled" || res.action === "sec_unreachable") out.polled.push(ev.eventId);
      } catch (err) {
        // Ids only: never the error text, which can quote filing content.
        console.warn(
          `[filing-summary] poll for event ${ev.eventId} ${isAbort(err) ? "was aborted" : "failed"}`,
        );
      }
    }

    for (const eventId of listEventsWithPendingSections(db)) {
      if (getEventState(db, eventId)?.pollState === "cancelled") continue;
      try {
        await seams.runNextSection(db, eventId);
        out.ran.push(eventId);
      } catch {
        console.warn(`[filing-summary] section run for event ${eventId} failed`);
      }
    }
    return out;
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------- production seams

/** What the tick needs from `./runner` (Task 10). */
interface RunnerModule {
  onEarningsAccepted(db: Database.Database, eventId: number): void;
  onCompanionAccepted(db: Database.Database, eventId: number, filingId: number): void;
  runNextSection(db: Database.Database, eventId: number, seams?: unknown): Promise<unknown>;
}

/** Lazy, so loading the tick never drags the model call chain into memory. */
function loadRunner(): Promise<RunnerModule> {
  // The `as string` only keeps the type checker from resolving the module
  // (it is built in parallel); the emitted import is the plain literal.
  return import("./runner" as string) as Promise<RunnerModule>;
}

function issuerNameFor(db: Database.Database, symbol: string): string | null {
  const row = db
    .prepare(`SELECT name FROM securities WHERE UPPER(symbol) = UPPER(?) LIMIT 1`)
    .get(symbol) as { name: string | null } | undefined;
  return row?.name ?? null;
}

async function productionTick(db: Database.Database): Promise<void> {
  let runner: RunnerModule;
  try {
    runner = await loadRunner();
  } catch {
    console.warn("[filing-summary] runner could not be loaded; tick skipped");
    return;
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), FILING_SUMMARY_TICK_FETCH_DEADLINE_MS);
  (deadline as { unref?: () => void }).unref?.();
  try {
    await runTick(db, Date.now(), {
      fetchFn: acquisitionScheduler.fetchFor(controller.signal, undefined, { priority: "low" }),
      resolveCik: (symbol, fetchFn) => resolveCik(symbol, fetchFn),
      now: () => Date.now(),
      issuerName: issuerNameFor,
      onEarningsAccepted: (d, eventId) => runner.onEarningsAccepted(d, eventId),
      onCompanionAccepted: (d, eventId, filingId) => runner.onCompanionAccepted(d, eventId, filingId),
      runNextSection: (d, eventId) => runner.runNextSection(d, eventId),
    });
  } finally {
    clearTimeout(deadline);
    // Cut off any straggler request still holding a scheduler slot.
    controller.abort();
  }
}

// ---------------------------------------------------------------- timer

let optedIn = false;
let handle: ReturnType<typeof setInterval> | null = null;

/** Tests opt in; production is always on. */
export function enableFilingSummaryTick(): void {
  optedIn = true;
}
export function disableFilingSummaryTick(): void {
  optedIn = false;
}
function tickEnabled(): boolean {
  return !process.env.VITEST || optedIn;
}

/**
 * Starts the 60-second tick (and one immediate tick). Idempotent, unref'd so
 * it never holds the process open; inert under VITEST unless enabled.
 * Returns true when this call started it.
 */
export function startFilingSummaryTick(
  db: Database.Database,
  tick: (db: Database.Database) => Promise<void> = productionTick,
): boolean {
  if (!tickEnabled() || handle !== null) return false;
  const fire = (): void => {
    tick(db).catch(() => console.warn("[filing-summary] tick failed"));
  };
  handle = setInterval(fire, FILING_SUMMARY_TICK_MS);
  (handle as { unref?: () => void }).unref?.();
  const first = setTimeout(fire, 0);
  (first as { unref?: () => void }).unref?.();
  return true;
}

export function __resetFilingSummaryTickForTests(): void {
  if (handle !== null) clearInterval(handle);
  handle = null;
  ticking = false;
  sendingSwept = false;
  optedIn = false;
}
