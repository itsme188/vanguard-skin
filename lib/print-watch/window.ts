/**
 * The ONE definition of when a print is live (spec §4.3 "Effective window,
 * one definition"). Every consumer — desiredState, ensurePrintWatch, the
 * acquisition pass, the DJ query bounds, the EDGAR window — reads this, so a
 * go press or an extension changes every one of them at once.
 *
 *   start = min(release − pre, forced_open_at − FORCED_PRE_MS)
 *           pre = WINDOW_PRE_MS, or SLOT_DEFAULT_PRE_MS[release] for a slot-default stamp
 *   end   = max(release + WINDOW_POST_MS, forced_open_at + FORCED_POST_MS, window_extended_until)
 *
 * pooled over whichever terms are present. The 60-minute forced lookback
 * exists to catch a wire item that printed before the user pressed go,
 * whatever the schedule said — so a late press can legitimately reach
 * further back than the schedule alone, and a late-arriving forced term is
 * never clamped to the scheduled term's own (narrower) start.
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

/**
 * The two stamps a release time takes when nothing better is known: the slot
 * defaults of `earningsHourToReleaseTime` (lib/calendar/release-times.ts) and
 * of the watcher's own last-resort fallback (`buildArmedEventDto`). They are
 * conventions, not predictions: before-open companies commonly print 06:00 to
 * 07:30 and after-close ones 16:00 to 16:10, so ten minutes before the stamp
 * (07:50, 16:05) opened the window after the release for a name with no
 * release-time history. The wire road then dropped the headline as earlier than
 * the window and EDGAR's 15-minute lookback did not reach it (bug audit
 * 2026-10-20). For these two stamps the window opens at 06:00 and 15:55
 * instead. The end is unchanged, so an 08:00 or 16:15 print is still covered;
 * a resolved time that happens to equal a stamp only costs earlier polling.
 */
export const SLOT_DEFAULT_PRE_MS: Readonly<Record<string, number>> = {
  "08:00": 2 * 60 * 60_000,
  "16:15": 20 * 60_000,
};

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

/** start = min(release − 10m (more for a slot-default stamp), forced − 60m); end = max(release + 45m, forced + 90m, extended_until); each term only when its input is present; null when none is. */
export function effectiveWindow(p: WindowInputs): EffectiveWindow | null {
  const composed = p.release_time_et ? composeReleaseInstant(p.event_date, p.release_time_et) : null;
  const composedMs = composed ? composed.getTime() : null;
  const scheduledMs = composedMs === null || Number.isNaN(composedMs) ? null : composedMs;
  const forcedMs = parseIso(p.forced_open_at);
  const extendedUntilMs = parseIso(p.window_extended_until);

  const starts: number[] = [];
  const ends: number[] = [];
  if (scheduledMs !== null) {
    const pre = (p.release_time_et && SLOT_DEFAULT_PRE_MS[p.release_time_et]) || WINDOW_PRE_MS;
    starts.push(scheduledMs - pre);
    ends.push(scheduledMs + WINDOW_POST_MS);
  }
  if (forcedMs !== null) {
    starts.push(forcedMs - FORCED_PRE_MS);
    ends.push(forcedMs + FORCED_POST_MS);
  }
  if (starts.length === 0) return null;
  if (extendedUntilMs !== null) ends.push(extendedUntilMs);
  return { startMs: Math.min(...starts), endMs: Math.max(...ends), scheduledMs, forcedMs, extendedUntilMs };
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
