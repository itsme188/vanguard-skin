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
import { parseJobFromClock } from "../src/index";

// Minimal mock env
function makeEnv(overrides: Record<string, string> = {}): any {
  return {
    EXPECTED_HOUR_BRIEFING: "15",
    EXPECTED_HOUR_DIGEST: "8",
    EXPECTED_HOUR_EVENING_MON_THU: "19",
    EXPECTED_HOUR_EVENING_FRI: "17",
    EXPECTED_MINUTE_EVENING_FRI: "30",
    PRIMARY_TIMEOUT_MS: "300000",
    ...overrides,
  };
}

describe("parseJobFromClock — existing jobs", () => {
  afterEach(() => vi.useRealTimers());

  it("Sunday 3pm ET → briefing", () => {
    // Sunday 2026-05-10 15:00 ET (EDT, UTC-4) = 2026-05-10 19:00 UTC
    vi.setSystemTime(new Date("2026-05-10T19:00:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("briefing");
    expect(job?.expectedHour).toBe(15);
  });

  it("Monday 8am ET → digest", () => {
    // Monday 2026-05-11 08:45 ET (EDT) = 2026-05-11 12:45 UTC
    vi.setSystemTime(new Date("2026-05-11T12:45:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).not.toBeNull();
    expect(job?.type).toBe("digest");
    expect(job?.expectedHour).toBe(8);
  });

  it("Saturday → null (no weekend digest)", () => {
    // Saturday 2026-05-09 08:45 ET (EDT) = 2026-05-09 12:45 UTC
    vi.setSystemTime(new Date("2026-05-09T12:45:00Z"));
    const job = parseJobFromClock(makeEnv());
    expect(job).toBeNull();
  });

  it("Sunday 8am ET → null (briefing only at 3pm)", () => {
    vi.setSystemTime(new Date("2026-05-10T12:45:00Z")); // 8:45am ET
    const job = parseJobFromClock(makeEnv());
    expect(job).toBeNull();
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
