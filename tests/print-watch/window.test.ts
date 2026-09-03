import { describe, it, expect } from "vitest";
import {
  effectiveWindow, extendedUntil, windowToIso, composeReleaseInstant,
  WINDOW_PRE_MS, WINDOW_POST_MS, FORCED_PRE_MS, FORCED_POST_MS, EXTEND_MS,
} from "@/lib/print-watch/window";

const RELEASE = composeReleaseInstant("2026-09-03", "16:05")!.getTime(); // 20:05Z (EDT); the helper returns Date | null

describe("effectiveWindow", () => {
  it("scheduled term only: [release − 10m, release + 45m]", () => {
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: null })!;
    expect(w.startMs).toBe(RELEASE - WINDOW_PRE_MS);
    expect(w.endMs).toBe(RELEASE + WINDOW_POST_MS);
    expect(w.scheduledMs).toBe(RELEASE);
    expect(w.forcedMs).toBeNull();
  });

  it("unresolved TAS row with no press → null (no term at all)", () => {
    expect(effectiveWindow({ event_date: "2026-09-03", release_time_et: null, forced_open_at: null, window_extended_until: null })).toBeNull();
  });

  it("forced term only (TAS row that was pressed): [press − 60m, press + 90m]", () => {
    const press = "2026-09-03T21:00:00.000Z";
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: null, forced_open_at: press, window_extended_until: null })!;
    expect(w.startMs).toBe(Date.parse(press) - FORCED_PRE_MS);
    expect(w.endMs).toBe(Date.parse(press) + FORCED_POST_MS);
    expect(w.scheduledMs).toBeNull();
    expect(w.forcedMs).toBe(Date.parse(press));
  });

  it("both terms: start is the MIN of the starts, end the MAX of the ends", () => {
    const early = new Date(RELEASE - 2 * 60 * 60_000).toISOString(); // pressed 2h before the release
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: early, window_extended_until: null })!;
    expect(w.startMs).toBe(Date.parse(early) - FORCED_PRE_MS);
    expect(w.endMs).toBe(RELEASE + WINDOW_POST_MS);
    const late = new Date(RELEASE + 40 * 60_000).toISOString(); // pressed 40m after the release
    const w2 = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: late, window_extended_until: null })!;
    expect(w2.startMs).toBe(Date.parse(late) - FORCED_PRE_MS); // pooled MIN: the forced lookback reaches 10m further back than the schedule
    expect(w2.endMs).toBe(Date.parse(late) + FORCED_POST_MS);
  });

  it("an extension only ever raises the end", () => {
    const until = new Date(RELEASE + 3 * 60 * 60_000).toISOString();
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: until })!;
    expect(w.endMs).toBe(Date.parse(until));
    const earlierUntil = new Date(RELEASE).toISOString(); // an extension that ends before the scheduled end is inert
    const w2 = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: earlierUntil })!;
    expect(w2.endMs).toBe(RELEASE + WINDOW_POST_MS);
  });

  it("an unparseable stamp is ignored, not thrown", () => {
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: "not-a-date", window_extended_until: "nope" })!;
    expect(w.startMs).toBe(RELEASE - WINDOW_PRE_MS);
    expect(w.endMs).toBe(RELEASE + WINDOW_POST_MS);
  });
});

describe("extendedUntil", () => {
  it("stacks: max(now, current end) + 30m", () => {
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: null });
    const beforeEnd = RELEASE; // now inside the window → current end + 30m
    expect(Date.parse(extendedUntil(w, beforeEnd))).toBe(RELEASE + WINDOW_POST_MS + EXTEND_MS);
    const afterEnd = RELEASE + 2 * 60 * 60_000; // now past the window → now + 30m
    expect(Date.parse(extendedUntil(w, afterEnd))).toBe(afterEnd + EXTEND_MS);
    const second = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: extendedUntil(w, beforeEnd) });
    expect(Date.parse(extendedUntil(second, beforeEnd))).toBe(RELEASE + WINDOW_POST_MS + 2 * EXTEND_MS);
  });
  it("with no window at all, now + 30m", () => {
    expect(Date.parse(extendedUntil(null, 1_000_000))).toBe(1_000_000 + EXTEND_MS);
  });
});

describe("windowToIso", () => {
  it("serialises both bounds as ISO UTC and passes null through", () => {
    expect(windowToIso(null)).toBeNull();
    const w = effectiveWindow({ event_date: "2026-09-03", release_time_et: "16:05", forced_open_at: null, window_extended_until: null });
    expect(windowToIso(w)).toEqual({ start: new Date(RELEASE - WINDOW_PRE_MS).toISOString(), end: new Date(RELEASE + WINDOW_POST_MS).toISOString() });
  });
});
