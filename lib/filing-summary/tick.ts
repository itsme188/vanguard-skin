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
import { addDays, parseDbTimestamp, todayET } from "@/lib/calendar/date-utils";
import { getArmedWorksheetEvents } from "@/lib/queries/earnings-worksheet-flags";
import { resolveCik } from "@/lib/print-watch/edgar-adapter";
import { acquisitionScheduler } from "@/lib/print-watch/scheduler";
import {
  eventsWithLiveFilings,
  issuerNameForEvent,
  MANUAL_ONLY_DETAIL,
  pollEvent,
  pollPhase,
  revalidateStoredFilings,
  type PollSeams,
} from "./poller";
import { failPendingSections } from "./run-status";
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
  /** Events where revalidation rejected at least one stored filing. */
  revalidated: number[];
}

// ---------------------------------------------------------------- cancel / re-arm

/**
 * Disarmed events dated today or later (Eastern): state → cancelled, pending
 * sections → failed/cancelled. An older print disarmed later keeps its state
 * and its sections as they are (ruling 8).
 */
function cancelDisarmed(db: Database.Database, today: string): number[] {
  const ids = (
    db
      .prepare(
        `SELECT e.event_id FROM filing_summary_events e
           JOIN calendar_events ce ON ce.id = e.event_id
          WHERE e.poll_state <> 'cancelled'
            AND ce.event_date >= ?
            AND NOT EXISTS (SELECT 1 FROM earnings_worksheet_flags f WHERE f.event_id = e.event_id)
          ORDER BY e.event_id`,
      )
      .all(today) as Array<{ event_id: number }>
  ).map((r) => r.event_id);
  const cancelOne = db.transaction((eventId: number) => {
    upsertEventState(db, eventId, { pollState: "cancelled", pollDetail: DISARMED_DETAIL });
    failPendingSections(db, "event", eventId, "disarmed");
  });
  for (const id of ids) cancelOne(id);
  return ids;
}

/**
 * Armed again after a disarm (ruling 7): armed on the event date before 20:00
 * → `waiting` (an existing run is kept, none starts); armed later →
 * `manual_only`. The arm time is the new flag's `created_at`, the same rule
 * as a first arm.
 */
function rearm(db: Database.Database, eventId: number, eventDate: string, nowMs: number): void {
  const flag = db
    .prepare(`SELECT created_at FROM earnings_worksheet_flags WHERE event_id = ?`)
    .get(eventId) as { created_at: string } | undefined;
  const armedAtMs = flag ? (parseDbTimestamp(flag.created_at)?.getTime() ?? nowMs) : nowMs;
  if (pollPhase(eventDate, armedAtMs) === "after_cutoff") {
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

/**
 * Process-wide tick state, kept on globalThis so a dev hot reload (which
 * re-evaluates this module) finds the running timer and latch instead of
 * starting a second 60-second timer.
 */
interface FilingSummaryTickGlobal {
  handle: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  sendingSwept: boolean;
  optedIn: boolean;
}
const globalKey = "__filingSummaryTick";
function tickState(): FilingSummaryTickGlobal {
  const g = globalThis as typeof globalThis & { [globalKey]?: FilingSummaryTickGlobal };
  g[globalKey] ??= { handle: null, ticking: false, sendingSwept: false, optedIn: false };
  return g[globalKey];
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export async function runTick(
  db: Database.Database,
  nowMs: number,
  seams: TickSeams,
): Promise<TickOutcome> {
  const out: TickOutcome = {
    skipped: false,
    cancelled: [],
    rearmed: [],
    polled: [],
    ran: [],
    revalidated: [],
  };
  const st = tickState();
  if (st.ticking) return { ...out, skipped: true };
  st.ticking = true;
  try {
    if (!st.sendingSwept) {
      markSendingAsUnknown(db);
      st.sendingSwept = true;
    }

    const today = todayET(new Date(nowMs));
    out.cancelled = cancelDisarmed(db, today);

    // Hardening 2: a date correction or merge may have moved stored filings
    // under a new date or issuer. Checked for every event with a live filing,
    // whatever its date, before any poll decides the event is finished.
    for (const eventId of eventsWithLiveFilings(db)) {
      try {
        const r = revalidateStoredFilings(db, eventId, seams);
        if (r.rejected.length > 0) out.revalidated.push(eventId);
      } catch {
        console.warn(`[filing-summary] revalidation for event ${eventId} failed`);
      }
    }

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
    st.ticking = false;
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
  // `./runner` (Task 10) must export exactly these three:
  //   onEarningsAccepted(db, eventId): void
  //   onCompanionAccepted(db, eventId, filingId): void
  //   runNextSection(db, eventId, seams?): Promise<unknown>
  // The `as string` only keeps the type checker from resolving the module
  // while it is built in parallel (Task 10 drops it); the emitted import is
  // the plain literal.
  return import("./runner") as Promise<RunnerModule>;
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
      issuerName: issuerNameForEvent,
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

/** Tests opt in; production is always on. */
export function enableFilingSummaryTick(): void {
  tickState().optedIn = true;
}
export function disableFilingSummaryTick(): void {
  tickState().optedIn = false;
}
function tickEnabled(): boolean {
  return !process.env.VITEST || tickState().optedIn;
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
  const st = tickState();
  if (!tickEnabled() || st.handle !== null) return false;
  const fire = (): void => {
    tick(db).catch(() => console.warn("[filing-summary] tick failed"));
  };
  st.handle = setInterval(fire, FILING_SUMMARY_TICK_MS);
  (st.handle as { unref?: () => void }).unref?.();
  const first = setTimeout(fire, 0);
  (first as { unref?: () => void }).unref?.();
  return true;
}

export function __resetFilingSummaryTickForTests(): void {
  const st = tickState();
  if (st.handle !== null) clearInterval(st.handle);
  st.handle = null;
  st.ticking = false;
  st.sendingSwept = false;
  st.optedIn = false;
}
