/**
 * Unit tests for the Worker calendar-enrich path.
 *
 * Exercises the business-hours gate, per-slot KV dedup, and primary-
 * success / primary-failure-without-fallback flows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runCalendarEnrich,
  shouldRunCalendarEnrich,
} from "../../workers/cron/src/calendar-enrich";

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

describe("shouldRunCalendarEnrich", () => {
  it("returns false on weekends", () => {
    expect(
      shouldRunCalendarEnrich({ hour: 12, minute: 0, dow: 0 }), // Sunday
    ).toBe(false);
    expect(
      shouldRunCalendarEnrich({ hour: 12, minute: 0, dow: 6 }), // Saturday
    ).toBe(false);
  });

  it("returns false before 09:30 ET on weekdays", () => {
    expect(
      shouldRunCalendarEnrich({ hour: 9, minute: 15, dow: 2 }),
    ).toBe(false);
    expect(
      shouldRunCalendarEnrich({ hour: 7, minute: 0, dow: 2 }),
    ).toBe(false);
  });

  it("returns true at exactly 09:30 ET", () => {
    expect(
      shouldRunCalendarEnrich({ hour: 9, minute: 30, dow: 2 }),
    ).toBe(true);
  });

  it("returns true at 18:59 ET (last covered minute, B8: extended for AMC reactions)", () => {
    expect(
      shouldRunCalendarEnrich({ hour: 18, minute: 59, dow: 3 }),
    ).toBe(true);
  });

  it("returns false at 19:00 ET and later", () => {
    expect(
      shouldRunCalendarEnrich({ hour: 19, minute: 0, dow: 3 }),
    ).toBe(false);
    expect(
      shouldRunCalendarEnrich({ hour: 22, minute: 0, dow: 3 }),
    ).toBe(false);
  });

  it("returns true mid-day on any weekday", () => {
    for (const dow of [1, 2, 3, 4, 5]) {
      expect(
        shouldRunCalendarEnrich({ hour: 12, minute: 30, dow }),
      ).toBe(true);
    }
  });
});

describe("runCalendarEnrich", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    // Force a deterministic in-window clock for runs below. The helper
    // pulls from ET time via Intl — we stub Date to an ET business hour.
    // (Fri 2026-04-24 14:30 ET = Fri 2026-04-24 18:30 UTC)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T18:30:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function baseEnv(overrides: Partial<{ mesh: string; secret: string }> = {}) {
    return {
      CRON_KV: makeKv(),
      CRON_SHARED_SECRET: overrides.secret ?? "test-secret",
      MESH_HOSTNAME: overrides.mesh ?? "http://localhost:3099",
      PRIMARY_TIMEOUT_MS: "5000",
    };
  }

  it("skips off-hours ticks", async () => {
    // 23:05 UTC on a Friday = 19:05 ET (EDT, UTC-4) — past the B8 18:59
    // upper bound, so this is genuinely off-hours.
    vi.setSystemTime(new Date("2026-04-24T23:05:00Z"));
    const env = baseEnv();
    const result = await runCalendarEnrich(env);
    expect(result.skipped).toBe("off_hours");
  });

  // 2026-08-14 (#35 Phase D, Task 25): the Mac-primary POST is retired — the
  // Worker never attempts to reach MESH_HOSTNAME anymore. runCalendarEnrich
  // goes straight from the (still-present) enrich-sent-{slot} dedup check to
  // the fallback path. See workers/cron/test/primary-retirement.test.ts for
  // dedicated no-fetch-attempted coverage across both retired call sites;
  // this file keeps the business-hours-gate + dedup + fallback-trigger
  // behavior.
  it("goes straight to the fallback path — no fetch is attempted", async () => {
    const env = baseEnv();
    const result = await runCalendarEnrich(env);

    expect(result.fallback?.kind).toBe("error");
    expect(result.fallback?.error).toBe("cloud_enrich_disabled");
    expect(result.sentBy).toBe("none");
    expect(global.fetch).not.toHaveBeenCalled();

    // No enrich-sent success marker written (nothing writes it anymore — the
    // only writer was the retired primary-success branch). The enrich-fail
    // journal WAS written for observability — unchanged behavior, since the
    // Mac primary always fast-failed with CF 1016 from the Cloudflare edge
    // on every tick even before this retirement.
    const keys = Array.from(
      (env.CRON_KV as unknown as { store: Map<string, string> }).store.keys(),
    );
    expect(keys.some((k) => k.startsWith("enrich-sent-"))).toBe(false);
    expect(keys.some((k) => k.startsWith("enrich-fail-"))).toBe(true);
  });

  it("dedups within a 15-min slot when the enrich-sent-{slot} marker is present (retained insurance check)", async () => {
    const env = baseEnv();
    // Fri 2026-04-24 18:30 UTC = 14:30 ET (EDT, UTC-4) → slot floors to 14:30.
    const store = (env.CRON_KV as unknown as { store: Map<string, string> }).store;
    store.set("enrich-sent-2026-04-24-1430", new Date().toISOString());

    const result = await runCalendarEnrich(env);

    expect(result.skipped).toBe("already_sent_this_slot");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
