/**
 * The filing summary's durable 60-second tick (spec R12, Hardening 10).
 *
 * One tick:
 *  1. once per process, sweeps pushes left `sending` by a crash to
 *     `delivery_unknown` (R16);
 *  2. cancels every event whose worksheet flag is gone: `poll_state =
 *     'cancelled'`, its pending sections `failed` / `cancelled` (a section
 *     already running finishes; nothing new starts);
 *  3. re-arm handling for every armed event whose state is `cancelled`,
 *     whatever its date (armed again before 20:00 on its date → `waiting`, an
 *     existing run kept and no new run started; later → `manual_only`);
 *  4. `pollEvent` for every armed earnings event dated today or yesterday
 *     (Eastern), plus every armed LATE arm (armed after 20:00 on its date or
 *     on a later day) whose one discovery pass has not completed, whatever
 *     its date (late-arm ruling, C1);
 *  5. retries an automatic start that found no model (`ensureAutoRun`);
 *  6. starts the next section of every event that has work and none in
 *     flight in this process (`runNextSection`, Task 10's runner). A
 *     cancelled event starts nothing new.
 *
 * Polling (1-5) and section running (6) never hold each other up: polling has
 * its own in-process latch, and a section run marks only its own event as in
 * flight, so a ten-minute model call never stops the next minute's poll. Paid
 * work is guarded by the section claims in the store, not by these latches.
 * Everything is on the Eastern clock. The interval is unref'd and inert under
 * VITEST unless a test opts in, like the first-pass read scheduler.
 *
 * The runner is reached only through seams. Production loads `./runner`
 * lazily at tick time; if it cannot be loaded the tick is skipped (polling
 * without a runner would insert filings whose "accepted" callback is lost),
 * the error is logged loudly, and every armed event's detail says so
 * (`RUNNER_LOAD_FAILED_DETAIL`) until a later tick loads it.
 */
import type Database from "better-sqlite3";
import { addDays, parseDbTimestamp, todayET } from "@/lib/calendar/date-utils";
import { getArmedWorksheetEvents } from "@/lib/queries/earnings-worksheet-flags";
import { resolveCik } from "@/lib/print-watch/edgar-adapter";
import { acquisitionScheduler } from "@/lib/print-watch/scheduler";
import { RUNNER_LOAD_FAILED_DETAIL } from "./labels";
import {
  eventsWithLiveFilings,
  issuerNameForEvent,
  MANUAL_DISCOVERY_PENDING_DETAIL,
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
/** Late-arm discovery passes started per tick (bounds SEC traffic after a backlog). */
export const MAX_DISCOVERY_PER_TICK = 5;

export interface TickSeams extends PollSeams {
  /** Task 10: claim and run the event's next section. */
  runNextSection(db: Database.Database, eventId: number): Promise<unknown>;
  /**
   * Retries the automatic start for an event whose earnings filing was
   * accepted but whose run never started (no model at the time). Optional:
   * production wires the runner's `ensureAutoRun`.
   */
  ensureAutoRun?(db: Database.Database, eventId: number): void;
}

export interface TickOutcome {
  /** True when another tick was still polling (no polling done by this one). */
  skipped: boolean;
  cancelled: number[];
  rearmed: number[];
  polled: number[];
  /** Events whose section run this tick started (and awaited). */
  ran: number[];
  /** Events whose section run was already in flight (not started again). */
  inFlight: number[];
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
 * `manual_only`, with the one discovery pass still owed only when the event
 * has no stored filing yet (a print already looked up is not looked up
 * again). The arm time is the new flag's `created_at`, the same rule as a
 * first arm.
 */
function rearm(db: Database.Database, eventId: number, eventDate: string, nowMs: number): void {
  const flag = db
    .prepare(`SELECT created_at FROM earnings_worksheet_flags WHERE event_id = ?`)
    .get(eventId) as { created_at: string } | undefined;
  const armedAtMs = flag ? (parseDbTimestamp(flag.created_at)?.getTime() ?? nowMs) : nowMs;
  if (pollPhase(eventDate, armedAtMs) === "after_cutoff") {
    const hasFilings = !!db
      .prepare(`SELECT 1 FROM filing_summary_filings WHERE event_id = ? LIMIT 1`)
      .get(eventId);
    upsertEventState(db, eventId, {
      pollState: "manual_only",
      pollDetail: hasFilings ? MANUAL_ONLY_DETAIL : MANUAL_DISCOVERY_PENDING_DETAIL,
      catchupDone: hasFilings,
    });
    return;
  }
  upsertEventState(db, eventId, { pollState: "waiting", pollDetail: null, catchupDone: false });
}

interface ArmedRow {
  eventId: number;
  event_date: string;
  created_at: string;
}

/** Armed earnings events (not superseded, with a symbol), any date. */
function armedEventsAnyDate(db: Database.Database): ArmedRow[] {
  return db
    .prepare(
      `SELECT f.event_id AS eventId, ce.event_date AS event_date, f.created_at AS created_at
         FROM earnings_worksheet_flags f
         JOIN calendar_events ce ON ce.id = f.event_id
        WHERE COALESCE(ce.superseded, 0) = 0
          AND ce.event_type = 'earnings'
          AND ce.symbol IS NOT NULL
        ORDER BY ce.event_date, f.event_id`,
    )
    .all() as ArmedRow[];
}

/**
 * Armed events outside today/yesterday that the poll must still visit: a
 * late arm (armed at or after 20:00 on its date, or on a later day) with no
 * state yet or reset to a never-polled `waiting` by revalidation, and a
 * `manual_only` event whose one discovery pass has not completed (C1).
 */
function lateArmsOwedDiscovery(db: Database.Database, armed: ArmedRow[], window: Set<string>, nowMs: number): number[] {
  const out: number[] = [];
  for (const a of armed) {
    if (window.has(a.event_date)) continue;
    const st = getEventState(db, a.eventId);
    if (st?.pollState === "manual_only") {
      if (!st.catchupDone) out.push(a.eventId);
      continue;
    }
    const neverPolled = !st || (st.pollState === "waiting" && st.lastPolledAt === null && !st.catchupDone);
    if (!neverPolled) continue;
    const armedAtMs = parseDbTimestamp(a.created_at)?.getTime() ?? nowMs;
    if (pollPhase(a.event_date, armedAtMs) === "after_cutoff") out.push(a.eventId);
  }
  return out;
}

// ---------------------------------------------------------------- the tick

/**
 * Process-wide tick state, kept on globalThis so a dev hot reload (which
 * re-evaluates this module) finds the running timer and latch instead of
 * starting a second 60-second timer.
 */
interface FilingSummaryTickGlobal {
  handle: ReturnType<typeof setInterval> | null;
  /** The poll latch: one tick polls at a time. */
  ticking: boolean;
  /** Events whose section run is in flight in this process (the run latch). */
  running: Set<number>;
  sendingSwept: boolean;
  optedIn: boolean;
}
const globalKey = "__filingSummaryTick";
function tickState(): FilingSummaryTickGlobal {
  const g = globalThis as typeof globalThis & { [globalKey]?: FilingSummaryTickGlobal };
  g[globalKey] ??= { handle: null, ticking: false, running: new Set(), sendingSwept: false, optedIn: false };
  // A state object from an older build of this module may lack the run set.
  g[globalKey].running ??= new Set();
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
    inFlight: [],
    revalidated: [],
  };
  const st = tickState();
  if (st.ticking) {
    out.skipped = true;
  } else {
    st.ticking = true;
    try {
      await pollPart(db, nowMs, seams, st, out);
    } finally {
      st.ticking = false;
    }
  }
  await runPart(db, seams, st, out);
  return out;
}

/** Steps 1-5: sweep, cancel, revalidate, re-arm, poll, auto-start retry. */
async function pollPart(
  db: Database.Database,
  nowMs: number,
  seams: TickSeams,
  st: FilingSummaryTickGlobal,
  out: TickOutcome,
): Promise<void> {
  if (!st.sendingSwept) {
    markSendingAsUnknown(db);
    st.sendingSwept = true;
  }

  const today = todayET(new Date(nowMs));
  out.cancelled = cancelDisarmed(db, today);

  // Hardening 2: a date correction or merge may have moved stored filings
  // under a new date or issuer. Checked for every recent event with a live
  // filing before any poll decides the event is finished.
  for (const eventId of eventsWithLiveFilings(db, today)) {
    try {
      const r = revalidateStoredFilings(db, eventId, seams);
      if (r.rejected.length > 0) out.revalidated.push(eventId);
    } catch {
      console.warn(`[filing-summary] revalidation for event ${eventId} failed`);
    }
  }

  // Re-arm: any armed event left cancelled by an earlier disarm, any date.
  const armedAll = armedEventsAnyDate(db);
  for (const a of armedAll) {
    if (getEventState(db, a.eventId)?.pollState === "cancelled") {
      rearm(db, a.eventId, a.event_date, nowMs);
      out.rearmed.push(a.eventId);
    }
  }

  const windowDates = [addDays(today, -1), today];
  const inWindow = getArmedWorksheetEvents(db, windowDates).map((ev) => ev.eventId);
  const late = lateArmsOwedDiscovery(db, armedAll, new Set(windowDates), nowMs).slice(0, MAX_DISCOVERY_PER_TICK);
  for (const eventId of [...inWindow, ...late]) {
    try {
      const res = await pollEvent(db, eventId, nowMs, seams);
      if (res.action === "polled" || res.action === "sec_unreachable") out.polled.push(eventId);
    } catch (err) {
      // Ids only: never the error text, which can quote filing content.
      console.warn(`[filing-summary] poll for event ${eventId} ${isAbort(err) ? "was aborted" : "failed"}`);
    }
  }

  if (seams.ensureAutoRun) {
    for (const eventId of inWindow) {
      try {
        seams.ensureAutoRun(db, eventId);
      } catch {
        console.warn(`[filing-summary] auto start retry for event ${eventId} failed`);
      }
    }
  }
}

/**
 * Step 6: one section per event with work, every event not already in
 * flight started now and awaited together. An event whose run is still in
 * flight from an earlier tick is skipped; the store's claims stay the only
 * guard on money.
 */
async function runPart(
  db: Database.Database,
  seams: TickSeams,
  st: FilingSummaryTickGlobal,
  out: TickOutcome,
): Promise<void> {
  const started: Array<Promise<void>> = [];
  for (const eventId of listEventsWithPendingSections(db)) {
    if (getEventState(db, eventId)?.pollState === "cancelled") continue;
    if (st.running.has(eventId)) {
      out.inFlight.push(eventId);
      continue;
    }
    st.running.add(eventId);
    out.ran.push(eventId);
    started.push(
      (async () => {
        try {
          await seams.runNextSection(db, eventId);
        } catch {
          console.warn(`[filing-summary] section run for event ${eventId} failed`);
        } finally {
          st.running.delete(eventId);
        }
      })(),
    );
  }
  await Promise.all(started);
}

// ---------------------------------------------------------------- production seams

/** What the tick needs from `./runner` (Task 10). */
interface RunnerModule {
  onEarningsAccepted(db: Database.Database, eventId: number): void;
  onCompanionAccepted(db: Database.Database, eventId: number, filingId: number): void;
  runNextSection(db: Database.Database, eventId: number, seams?: unknown): Promise<unknown>;
  ensureAutoRun(db: Database.Database, eventId: number): void;
}

/** Lazy, so loading the tick never drags the model call chain into memory. */
function loadRunner(): Promise<RunnerModule> {
  // `./runner` (Task 10) must export exactly these:
  //   onEarningsAccepted(db, eventId): void
  //   onCompanionAccepted(db, eventId, filingId): void
  //   runNextSection(db, eventId, seams?): Promise<unknown>
  //   ensureAutoRun(db, eventId): void
  // The import is type-checked against RunnerModule.
  return import("./runner") as Promise<RunnerModule>;
}

/**
 * The runner module failed to load (a packaging fault: every summary would
 * silently stop). Loud in the log, and visible on the panel: every armed
 * event of today and yesterday, and every event already showing the fault,
 * carries `RUNNER_LOAD_FAILED_DETAIL` until a tick loads the runner again.
 */
export function markRunnerLoadFailed(db: Database.Database, nowMs: number): void {
  const today = todayET(new Date(nowMs));
  for (const ev of getArmedWorksheetEvents(db, [addDays(today, -1), today])) {
    upsertEventState(db, ev.eventId, { pollDetail: RUNNER_LOAD_FAILED_DETAIL });
  }
}

/** Clears the fault detail once the runner loads again (the next poll rewrites the detail). */
export function clearRunnerLoadFailed(db: Database.Database): void {
  db.prepare(
    `UPDATE filing_summary_events SET poll_detail = NULL, updated_at = datetime('now') WHERE poll_detail = ?`,
  ).run(RUNNER_LOAD_FAILED_DETAIL);
}

/**
 * Loads the runner; on failure logs loudly, marks the panel and returns null.
 * `load` is a seam for tests.
 */
export async function loadRunnerOrReport(
  db: Database.Database,
  nowMs: number,
  load: () => Promise<RunnerModule> = loadRunner,
): Promise<RunnerModule | null> {
  try {
    const runner = await load();
    clearRunnerLoadFailed(db);
    return runner;
  } catch (err) {
    console.error(
      `[filing-summary] SUMMARY RUNNER FAILED TO LOAD — no summary can run until this is fixed (${
        err instanceof Error ? err.name : "error"
      })`,
    );
    try {
      markRunnerLoadFailed(db, nowMs);
    } catch {
      console.error("[filing-summary] could not record the runner load failure on the panel");
    }
    return null;
  }
}

async function productionTick(db: Database.Database): Promise<void> {
  const runner = await loadRunnerOrReport(db, Date.now());
  if (!runner) return;
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
      ensureAutoRun: (d, eventId) => runner.ensureAutoRun(d, eventId),
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
  st.running.clear();
  st.sendingSwept = false;
  st.optedIn = false;
}
