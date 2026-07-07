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

  it("calls the Mac primary and writes a slot marker on success", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, enriched: 2, failed: 0 }),
    });
    const env = baseEnv();
    const result = await runCalendarEnrich(env);

    expect(result.sentBy).toBe("mac");
    expect(result.primary?.kind).toBe("success");
    // Verify a slot marker was recorded
    const keys = Array.from(
      (env.CRON_KV as unknown as { store: Map<string, string> }).store.keys(),
    );
    expect(keys.some((k) => k.startsWith("enrich-sent-"))).toBe(true);
  });

  it("deduplicates within a 15-min slot", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, enriched: 0 }),
    });
    const env = baseEnv();
    await runCalendarEnrich(env);

    const second = await runCalendarEnrich(env);
    expect(second.skipped).toBe("already_sent_this_slot");
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("returns fallback=cloud_enrich_disabled when flag unset and primary fails", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    const env = baseEnv();
    const result = await runCalendarEnrich(env);
    expect(result.fallback?.kind).toBe("error");
    expect(result.fallback?.error).toBe("cloud_enrich_disabled");
    expect(result.sentBy).toBe("none");
    expect(result.primary?.kind).toBe("server_error");

    // No success marker written — next slot should retry
    const keys = Array.from(
      (env.CRON_KV as unknown as { store: Map<string, string> }).store.keys(),
    );
    expect(keys.some((k) => k.startsWith("enrich-sent-"))).toBe(false);
    // Fail record WAS written for observability
    expect(keys.some((k) => k.startsWith("enrich-fail-"))).toBe(true);
  });

  it("sends X-Cron-Secret header", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    const env = baseEnv({ secret: "magic-token" });
    await runCalendarEnrich(env);

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-Cron-Secret"]).toBe("magic-token");
  });
});
