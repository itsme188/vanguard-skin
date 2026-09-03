/**
 * The ONE definition of when a print is live (spec §4.3 "Effective window,
 * one definition"). Every consumer — desiredState, ensurePrintWatch, the
 * acquisition pass, the DJ query bounds, the EDGAR window — reads this, so a
 * go press or an extension changes every one of them at once.
 *
 * Two possible anchors: the scheduled release instant (composed from
 * event_date + release_time_et) and the forced/press instant
 * (forced_open_at). Each anchor carries its OWN pre/post buffer (10m/45m for
 * the scheduled anchor, 60m/90m for the forced anchor — forcing implies more
 * uncertainty, hence the wider buffer). When both anchors are present:
 *
 *   start = (whichever anchor is chronologically EARLIER) minus ITS OWN pre-buffer
 *   end   = (whichever anchor is chronologically LATER)   plus  ITS OWN post-buffer
 *
 * This is deliberately NOT "min/max pooled over both terms' independently
 * computed start/end values" — a forced press that lands AFTER an already-
 * known scheduled release must not drag the start earlier just because the
 * forced term's buffer (60m) is larger than the scheduled term's (10m); the
 * earlier anchor (the schedule) still governs the start with its own 10m
 * buffer. Symmetrically, an early forced press governs the start with its
 * own 60m buffer while a later scheduled release governs the end with its
 * own 45m buffer. `window_extended_until` only ever raises the end further.
 *
 * Each term is present only when its input is; an unresolved TAS row that was
 * never pressed has no window at all (null) and is drop-zone only. Stamps are
 * ISO-8601 UTC strings read with Date.parse; an unparseable stamp is ignored
 * rather than thrown (a corrupt column must not take the watcher down).
 */

import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
export { composeReleaseInstant };

export const WINDOW_PRE_MS = 10 * 60_000;
export const WINDOW_POST_MS = 45 * 60_000;
export const FORCED_PRE_MS = 60 * 60_000;
export const FORCED_POST_MS = 90 * 60_000;
export const EXTEND_MS = 30 * 60_000;

export interface WindowInputs {
  event_date: string;
  release_time_et: string | null;
  forced_open_at: string | null;
  window_extended_until: string | null;
}

export interface EffectiveWindow {
  startMs: number;
  endMs: number;
  /** The release instant when the scheduled term is present, else null (unresolved TAS). */
  scheduledMs: number | null;
  forcedMs: number | null;
  extendedUntilMs: number | null;
}

function parseIso(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

interface Anchor {
  ms: number;
  preMs: number;
  postMs: number;
}

/**
 * start = the earlier anchor's own instant minus its own pre-buffer;
 * end = the later anchor's own instant plus its own post-buffer, then raised
 * by window_extended_until if that's later still. Each term (scheduled,
 * forced) only contributes an anchor when its input is present; null when
 * neither is (no window at all).
 */
export function effectiveWindow(p: WindowInputs): EffectiveWindow | null {
  const composed = p.release_time_et ? composeReleaseInstant(p.event_date, p.release_time_et) : null;
  const composedMs = composed ? composed.getTime() : null;
  const scheduledMs = composedMs === null || Number.isNaN(composedMs) ? null : composedMs;
  const forcedMs = parseIso(p.forced_open_at);
  const extendedUntilMs = parseIso(p.window_extended_until);

  const anchors: Anchor[] = [];
  if (scheduledMs !== null) anchors.push({ ms: scheduledMs, preMs: WINDOW_PRE_MS, postMs: WINDOW_POST_MS });
  if (forcedMs !== null) anchors.push({ ms: forcedMs, preMs: FORCED_PRE_MS, postMs: FORCED_POST_MS });
  if (anchors.length === 0) return null;

  const earliest = anchors.reduce((a, b) => (b.ms < a.ms ? b : a));
  const latest = anchors.reduce((a, b) => (b.ms > a.ms ? b : a));

  let endMs = latest.ms + latest.postMs;
  if (extendedUntilMs !== null) endMs = Math.max(endMs, extendedUntilMs);

  return { startMs: earliest.ms - earliest.preMs, endMs, scheduledMs, forcedMs, extendedUntilMs };
}

/** ISO UTC of max(now, current end) + 30m — what "Extend 30 min" writes; presses stack. */
export function extendedUntil(current: EffectiveWindow | null, nowMs: number): string {
  const base = current ? Math.max(nowMs, current.endMs) : nowMs;
  return new Date(base + EXTEND_MS).toISOString();
}

export function windowToIso(w: EffectiveWindow | null): { start: string; end: string } | null {
  if (!w) return null;
  return { start: new Date(w.startMs).toISOString(), end: new Date(w.endMs).toISOString() };
}
