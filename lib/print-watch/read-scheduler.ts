// The first-pass read's triggers (spec §4.4; plan M-D1; Codex round 1 #16/#25).
//
// Fast path: a 5-second debounce per print, armed from the watcher's
// parse-completion point. A burst of documents re-arms the same timer, so one
// settled sheet produces ONE read rather than one read per document.
//
// Durable path: `reconcilePendingReads`, ticked every 60 s from registration,
// schedules every live parsed print whose CURRENT fingerprint has no
// done/live-generating row and is not inside a retry backoff — so a crash
// during the debounce, a merge, a bogey edit or a late document all converge
// on a read without depending on any process-local state surviving.
//
// Under VITEST the whole module is inert unless a test opts in, so no suite
// that merely exercises the watcher can leak a five-second timer.
import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import { runFirstPassRead } from "./read";
import { buildFirstPassPrompt } from "./first-pass-prompt";
import { canScheduleRead } from "./read-store";

export const READ_DEBOUNCE_MS = 5_000;
export const READ_RECONCILE_EVERY_MS = 60_000;
export const READ_RECONCILE_LOOKBACK_DAYS = 14;

export interface SchedulerSeams {
  runner: (db: Database.Database, printId: number) => Promise<unknown>;
  fingerprintFor: (db: Database.Database, printId: number) => Promise<string | null>;
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

// The timer defaults resolve the global at CALL time rather than capturing it
// at import time: a caller that installs its own timers (fake timers in a test,
// a spy on globalThis) after this module loaded must still see its own. The
// casts are only there because the timer globals are overloaded — the wrappers
// forward their arguments unchanged.
const DEFAULT_SEAMS: SchedulerSeams = {
  runner: (db, printId) => runFirstPassRead(db, printId),
  fingerprintFor: async (db, printId) => (await buildFirstPassPrompt(db, printId))?.fingerprint ?? null,
  now: () => Date.now(),
  setTimeout: ((fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms)) as unknown as typeof setTimeout,
  clearTimeout: ((handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle)) as unknown as typeof clearTimeout,
  setInterval: ((fn: () => void, ms?: number) => globalThis.setInterval(fn, ms)) as unknown as typeof setInterval,
  clearInterval: ((handle: ReturnType<typeof setInterval>) =>
    globalThis.clearInterval(handle)) as unknown as typeof clearInterval,
};
let seams: SchedulerSeams = { ...DEFAULT_SEAMS };
export function _setSchedulerSeams(overrides: Partial<SchedulerSeams> | null): void {
  seams = overrides ? { ...seams, ...overrides } : { ...DEFAULT_SEAMS };
}

let optedIn = false;
/** Tests opt in; production is always on. */
export function enableFirstPassScheduler(): void {
  optedIn = true;
}
export function disableFirstPassScheduler(): void {
  optedIn = false;
}
export function schedulerEnabled(): boolean {
  return !process.env.VITEST || optedIn;
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();
let reconcileHandle: ReturnType<typeof setInterval> | null = null;

/**
 * What the reconcile has already ASKED for, per print: the fingerprint it last
 * dispatched a read for. The store is the real gate — this only stops the 60 s
 * tick from asking again for inputs it has already asked about while that ask
 * is still on its way to a row. The entry is dropped the moment the store says
 * the print is no longer schedulable (a read landed, is generating, or failed
 * into a backoff) and whenever a dispatched run rejects, so a retry after a
 * backoff is never lost.
 */
const askedFingerprint = new Map<number, string>();

/** Arms/re-arms the per-print debounce. Never throws. */
export function scheduleFirstPassRead(db: Database.Database, printId: number): void {
  if (!schedulerEnabled()) return;
  const existing = timers.get(printId);
  if (existing !== undefined) seams.clearTimeout(existing);
  const handle = seams.setTimeout(() => {
    timers.delete(printId);
    seams.runner(db, printId).catch(() => {
      // The ask never reached a row: let the next reconcile tick ask again.
      askedFingerprint.delete(printId);
      // Ids only — never the error text, which can quote document snippets.
      console.warn(`[print-watch] first-pass read for print ${printId} failed`);
    });
  }, READ_DEBOUNCE_MS);
  timers.set(printId, handle);
}

/**
 * #16: every parsed print inside the lookback whose CURRENT fingerprint is
 * schedulable gets a read. This is what makes the read durable — the debounce
 * lives in one process's memory, this reads the store.
 */
export async function reconcilePendingReads(
  db: Database.Database,
  nowMs: number = seams.now(),
): Promise<{ scheduled: number[]; checked: number }> {
  const scheduled: number[] = [];
  if (!schedulerEnabled()) return { scheduled, checked: 0 };
  // ET wall-clock day, then plain date arithmetic on the date STRING — never a
  // UTC slice of `nowMs`, which is the previous day for an AMC print.
  const today = todayET(new Date(nowMs));
  const floor = new Date(Date.parse(`${today}T00:00:00Z`) - READ_RECONCILE_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const prints = db
    .prepare(`SELECT id FROM print_watch_prints WHERE state = 'parsed' AND event_date >= ? ORDER BY id`)
    .all(floor) as Array<{ id: number }>;
  for (const { id } of prints) {
    if (timers.has(id)) continue;
    let fp: string | null = null;
    try {
      fp = await seams.fingerprintFor(db, id);
    } catch {
      continue; // a sheet we cannot describe is a sheet we cannot read
    }
    if (!fp) continue;
    if (!canScheduleRead(db, id, fp, nowMs)) {
      askedFingerprint.delete(id);
      continue;
    }
    if (askedFingerprint.get(id) === fp) continue;
    askedFingerprint.set(id, fp);
    scheduleFirstPassRead(db, id);
    scheduled.push(id);
  }
  return { scheduled, checked: prints.length };
}

/** Idempotent; unref'd so it never holds the process open; off while disabled. */
export function armReconcileTimer(db: Database.Database): void {
  if (!schedulerEnabled() || reconcileHandle !== null) return;
  reconcileHandle = seams.setInterval(() => {
    reconcilePendingReads(db).catch(() => {
      console.warn("[print-watch] first-pass reconcile tick failed");
    });
  }, READ_RECONCILE_EVERY_MS);
  // Fake-timer handles are plain numbers; the optional call covers both.
  (reconcileHandle as { unref?: () => void }).unref?.();
}

export function __pendingReadTimers(): number[] {
  return [...timers.keys()];
}

export function __resetSchedulerForTests(): void {
  for (const h of timers.values()) seams.clearTimeout(h);
  timers.clear();
  askedFingerprint.clear();
  if (reconcileHandle !== null) {
    seams.clearInterval(reconcileHandle);
    reconcileHandle = null;
  }
}
