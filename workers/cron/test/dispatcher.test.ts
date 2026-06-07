/**
 * Tests for parseJobFromClock — evening dispatch + existing briefing/digest cases.
 *
 * Strategy: mock Date so getCurrentETHour/getCurrentETDayOfWeek/getCurrentETMinute
 * return deterministic values. We use vi.setSystemTime to freeze time to a known
 * UTC moment, then assert that parseJobFromClock returns the right job type.
 *
 * Time reference (ET = UTC-4 summer EDT / UTC-5 winter EST):
 *   Mon 19:00 ET summer = Mon 23:00 UTC (cron "0 23 * * MON-THU")
 *   Mon 19:00 ET winter = Tue 00:00 UTC (cron "0 0 * * TUE-FRI")
 *   Fri 17:30 ET summer = Fri 21:30 UTC (cron "30 21 * * FRI")
 *   Fri 17:30 ET winter = Fri 22:30 UTC (cron "30 22 * * FRI")
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test parseJobFromClock by importing the module and controlling Date.
// Because parseJobFromClock is not exported, we replicate its logic using the
// exported DST helpers — this is the clean TDD approach: test through the
// public surface.
//
// We actually export parseJobFromClock from index.ts for testability. If it's
// not exported yet, the tests below will fail at compile time and serve as the
// failing-test phase of TDD.
import { parseJobFromClock, catchUpCandidates } from "../src/index";

// Minimal mock env
function makeEnv(overrides: Record<string, string> = {}): any {
  return {
    EXPECTED_HOUR_BRIEFING: "16",
    EXPECTED_MINUTE_BRIEFING: "30",
    EXPECTED_HOUR_DIGEST: "8",
    EXPECTED_MINUTE_DIGEST: "45",
    EXPECTED_HOUR_EVENING_MON_THU: "19",
    EXPECTED_HOUR_EVENING_FRI: "17",
    EXPECTED_MINUTE_EVENING_FRI: "30",
    PRIMARY_TIMEOUT_MS: "300000",
    ...overrides,
  };
}

describe("parseJobFromClock — existing jobs", () => {
  afterEach(() => vi.useRealTimers());

  it("Sunday 4:30pm ET → briefing", () => {
    // Sunday 2026-05-10 16:30 ET (EDT, UTC-4) = 2026-05-10 20:30 UTC
    vi.setSystemTime(new Date("2026-05-10T20:30:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("briefing");
    expect(job?.expectedHour).toBe(16);
  });

  // Minute-gate regression: with the briefing moved to 16:30 ET, the Worker
  // must NOT fire at the top of the 16 o'clock hour. Pre-move the gate was
  // hour-only (harmless at 15:00); an hour-only gate at 16:30 would ship the
  // fallback at 16:00 — ~30 min early — while the Mac is asleep traveling.
  it("Sunday 4:00pm ET → null (must wait for the 16:30 tick)", () => {
    // 2026-05-10 16:00 ET (EDT) = 20:00 UTC
    vi.setSystemTime(new Date("2026-05-10T20:00:00Z"));
    expect(parseJobFromClock(makeEnv())).toBeNull();
  });

  it("Sunday 4:15pm ET → null", () => {
    vi.setSystemTime(new Date("2026-05-10T20:15:00Z"));
    expect(parseJobFromClock(makeEnv())).toBeNull();
  });

  it("Monday 8:45am ET → digest", () => {
    // Monday 2026-05-11 08:45 ET (EDT) = 2026-05-11 12:45 UTC
    vi.setSystemTime(new Date("2026-05-11T12:45:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("digest");
    expect(job?.expectedHour).toBe(8);
  });

  // Minute-gate regression: the Worker must NOT fire the digest at the top of
  // the 8 o'clock hour. Pre-fix it gated on hour only, so while the Mac was
  // asleep (traveling) the fallback shipped at 8:00 — ~45 min early.
  it("Monday 8:00am ET → null (must wait for the 8:45 tick)", () => {
    // 2026-05-11 08:00 ET (EDT) = 12:00 UTC
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    expect(parseJobFromClock(makeEnv())).toBeNull();
  });

  it("Monday 8:15am ET → null", () => {
    vi.setSystemTime(new Date("2026-05-11T12:15:00Z"));
    expect(parseJobFromClock(makeEnv())).toBeNull();
  });

  it("Monday 8:30am ET → null", () => {
    vi.setSystemTime(new Date("2026-05-11T12:30:00Z"));
    expect(parseJobFromClock(makeEnv())).toBeNull();
  });

  it("Saturday → null (no weekend digest)", () => {
    // Saturday 2026-05-09 08:45 ET (EDT) = 2026-05-09 12:45 UTC
    vi.setSystemTime(new Date("2026-05-09T12:45:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).toBeNull();
  });

  it("Sunday 8am ET → null (briefing only at 4:30pm)", () => {
    vi.setSystemTime(new Date("2026-05-10T12:45:00Z")); // 8:45am ET
    const job = parseJobFromClock(makeEnv());
    expect(job).toBeNull();
  });

  // Briefing now also fires at 15:00 ET on Monday, so runJob's holiday-shift
  // gate can defer the Sunday briefing onto a holiday Monday. parseJobFromClock
  // is the time-slot detector; the send-day decision lives in runJob.
  it("Monday 4:30pm ET → briefing slot (holiday-shift candidate)", () => {
    // Memorial Day Monday 2026-05-25 16:30 ET (EDT) = 20:30 UTC
    vi.setSystemTime(new Date("2026-05-25T20:30:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job?.type).toBe("briefing");
  });
});

describe("parseJobFromClock — evening dispatch", () => {
  afterEach(() => vi.useRealTimers());

  // ─────────────────────────────────────────────────────────────────────────
  // Mon-Thu 19:00 ET (summer EDT, UTC-4) — cron fires at 23:00 UTC same day
  // ─────────────────────────────────────────────────────────────────────────
  it("Monday 19:00 ET (summer) → evening", () => {
    // Mon 2026-05-11 19:00 ET (EDT) = Mon 2026-05-11 23:00 UTC
    vi.setSystemTime(new Date("2026-05-11T23:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("evening");
    expect(job?.expectedHour).toBe(19);
  });

  it("Thursday 19:00 ET (summer) → evening", () => {
    // Thu 2026-05-14 19:00 ET (EDT) = Thu 2026-05-14 23:00 UTC
    vi.setSystemTime(new Date("2026-05-14T23:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("evening");
    expect(job?.expectedHour).toBe(19);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Mon-Thu 19:00 ET (winter EST, UTC-5) — cron fires at 00:00 UTC NEXT day
  // e.g. Monday 19:00 EST = Tuesday 00:00 UTC — the dispatcher reads ET hour
  // from the frozen UTC moment, so ET hour = 19, ET dow = Monday (1) — correct.
  // ─────────────────────────────────────────────────────────────────────────
  it("Monday 19:00 ET (winter) → evening [UTC Tuesday 00:00]", () => {
    // Mon 2026-01-05 19:00 ET (EST) = Tue 2026-01-06 00:00 UTC
    vi.setSystemTime(new Date("2026-01-06T00:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("evening");
    expect(job?.expectedHour).toBe(19);
  });

  it("Thursday 19:00 ET (winter) → evening [UTC Friday 00:00]", () => {
    // Thu 2026-01-08 19:00 ET (EST) = Fri 2026-01-09 00:00 UTC
    vi.setSystemTime(new Date("2026-01-09T00:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("evening");
    expect(job?.expectedHour).toBe(19);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Friday 17:30 ET (summer EDT, UTC-4) — cron fires at 21:30 UTC
  // ─────────────────────────────────────────────────────────────────────────
  it("Friday 17:30 ET (summer) → evening", () => {
    // Fri 2026-05-08 17:30 ET (EDT) = Fri 2026-05-08 21:30 UTC
    vi.setSystemTime(new Date("2026-05-08T21:30:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("evening");
    expect(job?.expectedHour).toBe(17);
  });

  it("Friday 17:30 ET (winter) → evening", () => {
    // Fri 2026-01-09 17:30 ET (EST) = Fri 2026-01-09 22:30 UTC
    vi.setSystemTime(new Date("2026-01-09T22:30:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("evening");
    expect(job?.expectedHour).toBe(17);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Negative cases for Friday
  // ─────────────────────────────────────────────────────────────────────────
  it("Friday 17:00 ET → null (wrong minute — need :30)", () => {
    // Fri 2026-05-08 17:00 ET (EDT) = Fri 2026-05-08 21:00 UTC
    vi.setSystemTime(new Date("2026-05-08T21:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).toBeNull();
  });

  it("Friday 19:00 ET → null (wrong hour for Fri)", () => {
    // Fri 2026-05-08 19:00 ET (EDT) = Fri 2026-05-08 23:00 UTC
    vi.setSystemTime(new Date("2026-05-08T23:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Weekend / other hours — no evening on Sat/Sun
  // ─────────────────────────────────────────────────────────────────────────
  it("Saturday 19:00 ET → null", () => {
    // Sat 2026-05-09 19:00 ET (EDT) = Sat 2026-05-09 23:00 UTC
    vi.setSystemTime(new Date("2026-05-09T23:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).toBeNull();
  });

  it("Sunday 19:00 ET → null (not Mon-Thu)", () => {
    // Sun 2026-05-10 19:00 ET (EDT) = Sun 2026-05-10 23:00 UTC
    vi.setSystemTime(new Date("2026-05-10T23:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    // 19:00 ET on Sunday — briefing only at 15:00, so null
    expect(job).toBeNull();
  });

  it("Wednesday 19:00 ET → evening", () => {
    // Wed 2026-05-13 19:00 ET (EDT) = Wed 2026-05-13 23:00 UTC
    vi.setSystemTime(new Date("2026-05-13T23:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("evening");
  });
});

describe("parseJobFromClock — env var override", () => {
  afterEach(() => vi.useRealTimers());

  it("respects EXPECTED_HOUR_EVENING_MON_THU override", () => {
    // If someone changes the hour to 20, Mon 20:00 ET should fire
    vi.setSystemTime(new Date("2026-05-11T23:00:00Z")); // 19:00 ET
    const job = parseJobFromClock(makeEnv({ EXPECTED_HOUR_EVENING_MON_THU: "20" }));
    // 19 !== 20 → should NOT match
    expect(job).toBeNull();
  });
});

// ── Catch-up sweep candidates (2026-05-14) ────────────────────────────────
//
// The catch-up table is a pure data structure. We only verify its shape +
// non-overlap with the normal dispatch windows. The KV-and-marker integration
// of runCatchUp() itself is covered by the runJob unit tests.

describe("catchUpCandidates — declarative table", () => {
  it("digest catch-up runs Mon-Fri only", () => {
    const digest = catchUpCandidates().find((c) => c.type === "digest");
    expect(digest).toBeDefined();
    expect(digest!.dows).toEqual([1, 2, 3, 4, 5]);
  });

  it("digest catch-up starts AFTER the digest dispatch window (8:45 ET)", () => {
    const digest = catchUpCandidates().find((c) => c.type === "digest");
    // Dispatch fires at hour=8. Catch-up must start at hour >= 9.
    expect(digest!.afterHour).toBeGreaterThan(8);
  });

  it("digest catch-up ends before evening (so an unsent morning doesn't fire at 5pm)", () => {
    const digest = catchUpCandidates().find((c) => c.type === "digest");
    expect(digest!.beforeHour).toBeLessThanOrEqual(13);
  });

  it("evening catch-up Mon-Thu starts after 19:00 ET dispatch window", () => {
    const monThu = catchUpCandidates().find(
      (c) => c.type === "evening" && c.dows.includes(1) && !c.dows.includes(5),
    );
    expect(monThu).toBeDefined();
    expect(monThu!.afterHour).toBeGreaterThan(19);
  });

  it("evening catch-up Fri starts after 17:30 ET dispatch window", () => {
    const fri = catchUpCandidates().find(
      (c) => c.type === "evening" && c.dows.includes(5) && !c.dows.includes(1),
    );
    expect(fri).toBeDefined();
    expect(fri!.afterHour).toBeGreaterThanOrEqual(18);
  });

  it("briefing catch-up runs Sunday AND Monday after 16:30 ET (Monday = holiday-shift)", () => {
    const briefing = catchUpCandidates().find((c) => c.type === "briefing");
    expect(briefing).toBeDefined();
    expect(briefing!.dows).toEqual([0, 1]);
    expect(briefing!.afterHour).toBeGreaterThan(16);
  });

  it("all catch-up windows have afterHour < beforeHour (non-empty range)", () => {
    for (const cand of catchUpCandidates()) {
      expect(cand.afterHour).toBeLessThan(cand.beforeHour);
    }
  });
});
