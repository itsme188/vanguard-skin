/**
 * When an armed Hub row's live-print expansion opens by itself (spec §4.6:
 * "Auto-expansion is transition-based (into window_open, acquired, forced, or a
 * new go request); parsed does not auto-expand on load; a manual toggle
 * overrides, remembered per print in localStorage").
 *
 * Everything here is pure. `prev === null` means FIRST LOAD, and a first load
 * never auto-opens — otherwise a page refresh at 16:20 would blow every
 * finished print open at once.
 */
import type { PrintWatchStateWire } from "./types";

export interface ExpansionSnapshot {
  printId: number;
  state: PrintWatchStateWire;
  forcedOpenAt: string | null;
  goRequestId: number | null;
}

export type ManualToggle = { printId: number; open: boolean } | null;

/** The states whose ARRIVAL means "this print is happening now". */
const OPENING_STATES: ReadonlySet<PrintWatchStateWire> = new Set(["window_open", "acquired"]);

export function snapshotOf(entry: {
  printId: number;
  state: PrintWatchStateWire;
  forcedOpenAt?: string | null;
  goRequest?: { id: number } | null;
}): ExpansionSnapshot {
  return {
    printId: entry.printId,
    state: entry.state,
    forcedOpenAt: entry.forcedOpenAt ?? null,
    goRequestId: entry.goRequest?.id ?? null,
  };
}

export function deriveExpansion(
  prev: ExpansionSnapshot | null,
  next: ExpansionSnapshot,
  manual: ManualToggle,
): boolean {
  // A manual choice is only ever about the print it was made on. When a date
  // correction re-homes the row onto a DIFFERENT print, the old preference does
  // not follow it — the desk never expressed one about this print.
  if (manual && manual.printId === next.printId) return manual.open;

  // A different print id is a new subject, not a transition.
  if (!prev || prev.printId !== next.printId) return false;

  if (OPENING_STATES.has(next.state) && next.state !== prev.state) return true;
  if (next.forcedOpenAt !== null && prev.forcedOpenAt === null) return true;
  if (next.goRequestId !== null && next.goRequestId !== prev.goRequestId) return true;
  return false;
}

/**
 * The whole open/closed decision for one row, as data (Codex round 1 #8 /
 * F-S1). `deriveExpansion` answers "did something just happen that should open
 * this?"; this answers "so is it open?", which also has to respect what the row
 * was doing a moment ago — and must NOT carry that across a change of subject.
 *
 * `prevPrintId` is the id the row was showing BEFORE this payload, captured
 * before the caller overwrites its ref. When it differs from `next.printId`,
 * a date correction (or a merge) re-homed the row onto a different print: the
 * previous open state belonged to a different subject and is dropped, so only
 * a fresh decision can open the new one.
 *
 * Pure, so the correction case is testable without a DOM. This repo has no
 * jsdom and no React Testing Library, and none may be added — which is why
 * there is no mounted integration test for the wiring, only this reducer plus
 * a source pin in Task 9.
 */
export function nextOpenState(args: {
  was: boolean;
  decided: boolean;
  prevPrintId: number | null;
  next: ExpansionSnapshot;
  manual: ManualToggle;
}): boolean {
  const { was, decided, prevPrintId, next, manual } = args;
  if (manual && manual.printId === next.printId) return manual.open;
  if (prevPrintId !== next.printId) return decided;
  return decided || was;
}

export const EXPANDED_KEY_PREFIX = "vgs:print-expanded:";

/** null = the desk has expressed no preference for this print. Every access is
 *  wrapped: a private window, cleared site data or a blocked-storage browser
 *  throws on the accessor itself. */
export function readManual(printId: number, storage?: Pick<Storage, "getItem">): boolean | null {
  try {
    const s = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    if (!s) return null;
    const raw = s.getItem(`${EXPANDED_KEY_PREFIX}${printId}`);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

export function writeManual(printId: number, open: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    const s = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    s?.setItem(`${EXPANDED_KEY_PREFIX}${printId}`, open ? "1" : "0");
  } catch {
    /* a per-viewer convenience, never load-bearing — a blocked store is fine */
  }
}
