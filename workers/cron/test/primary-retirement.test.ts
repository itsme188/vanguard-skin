/**
 * Tests for the 2026-08-14 (#35 Phase D, Task 25) retirement of the
 * Worker→Mac primary calls.
 *
 * Two call sites were removed:
 *   - workers/cron/src/index.ts's `runJob` (briefing/digest/evening) used to
 *     call workers/cron/src/primary.ts's `callPrimary` before falling back.
 *     primary.ts is now deleted entirely.
 *   - workers/cron/src/calendar-enrich.ts's `runCalendarEnrich` used its own
 *     local `callEnrichPrimary` (NOT `callPrimary` — that function lived only
 *     in primary.ts and was never shared with calendar-enrich.ts). That local
 *     helper is now deleted too.
 *
 * Both paths must now (a) NEVER attempt a fetch to MESH_HOSTNAME/the Mac
 * origin, and (b) still honor the marker-based dedup that guards against a
 * duplicate send racing the Mac's own launchd-triggered runs. This file
 * proves both properties for each path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Env } from "../src/index";
import type { EnrichRunEnv } from "../src/calendar-enrich";

// ── Dependency mocks ─────────────────────────────────────────────────────────
// Mock all three fallback composers so runJob's fallback branch is fast,
// deterministic, and never touches Gmail/AI/Resend.
vi.mock("../src/fallback-briefing", () => ({
  runFallbackBriefing: vi.fn(async () => ({ kind: "success" })),
}));
vi.mock("../src/fallback-digest", () => ({
  runFallbackDigest: vi.fn(async () => ({ kind: "success" })),
}));
vi.mock("../src/fallback-evening", () => ({
  runFallbackEvening: vi.fn(async () => ({ kind: "success" })),
}));

// Spy on global fetch — the whole point of this file is proving it's never
// called with anything pointed at MESH_HOSTNAME (in fact, never called at
// all, now that both primary-call sites are gone).
global.fetch = vi.fn();

import { runJob } from "../src/index";
import { runFallbackDigest } from "../src/fallback-digest";
import { writeMarker, setRunningMarker, setAttemptingMarker } from "../src/dedup";
import { todayET } from "../src/dst";
import { runCalendarEnrich } from "../src/calendar-enrich";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [] })),
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CRON_KV: makeKv(),
    ARCHIVE: {} as R2Bucket,
    EXPECTED_HOUR_BRIEFING: "16",
    EXPECTED_HOUR_DIGEST: "8",
    EXPECTED_HOUR_EVENING_MON_THU: "19",
    EXPECTED_HOUR_EVENING_FRI: "17",
    EXPECTED_MINUTE_EVENING_FRI: "30",
    PRIMARY_TIMEOUT_MS: "300000",
    CRON_SHARED_SECRET: "secret",
    // Retained on Env even though runJob no longer reads it — see the report
    // for why (Pushover deep-link base fallback elsewhere).
    MESH_HOSTNAME: "http://mesh.local",
    ...overrides,
  } as Env;
}

// ── runJob (briefing/digest/evening) ────────────────────────────────────────

describe("runJob — Mac-primary retirement (2026-08-14, #35 Phase D)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("goes straight to fallback with no fetch attempted (no markers set)", async () => {
    const env = makeEnv();

    const result = await runJob("digest", env, { force: true });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(runFallbackDigest).toHaveBeenCalledTimes(1);
    expect(result.sentBy).toBe("cloud");
    expect(result.skipped).toBeUndefined();
  });

  it("marker dedup preserved: skips when mac-sent is already present (Mac's own launchd run beat this tick)", async () => {
    const env = makeEnv();
    await writeMarker(env.CRON_KV, "mac", "digest", todayET());

    const result = await runJob("digest", env, { force: true });

    expect(result.skipped).toBe("already_sent");
    expect(result.sentBy).toBe("mac");
    expect(runFallbackDigest).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("marker dedup preserved: skips when cloud-sent is already present", async () => {
    const env = makeEnv();
    await writeMarker(env.CRON_KV, "cloud", "digest", todayET());

    const result = await runJob("digest", env, { force: true });

    expect(result.skipped).toBe("already_sent_by_cloud");
    expect(runFallbackDigest).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("marker dedup preserved: skips when a concurrent fallback is already attempting", async () => {
    const env = makeEnv();
    await setAttemptingMarker(env.CRON_KV, "digest", todayET());

    const result = await runJob("digest", env, { force: true });

    expect(result.skipped).toBe("cloud_attempt_in_flight");
    expect(runFallbackDigest).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // This is the specific guard the 2026-04-27 post-primary re-check added
  // (closing the 8:45→8:57 race): with the primary POST gone there's no
  // separate "re-check" step anymore, but mac-running must still be part of
  // the single marker check that replaced it.
  it("marker dedup preserved: skips when the Mac's own launchd-triggered run is still in flight (mac-running)", async () => {
    const env = makeEnv();
    await setRunningMarker(env.CRON_KV, "digest", todayET());

    const result = await runJob("digest", env, { force: true });

    expect(result.skipped).toBe("mac_still_running");
    expect(runFallbackDigest).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("dryRun bypasses the marker gate (test/smoke mode) but still never calls fetch", async () => {
    const env = makeEnv();
    await writeMarker(env.CRON_KV, "mac", "digest", todayET());

    const result = await runJob("digest", env, { force: true, dryRun: true });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(runFallbackDigest).toHaveBeenCalledTimes(1);
    expect(result.sentBy).toBe("cloud");
  });
});

// ── runCalendarEnrich ────────────────────────────────────────────────────────

describe("runCalendarEnrich — Mac-primary retirement (2026-08-14, #35 Phase D)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Tuesday 2026-06-16 14:00:00 UTC = 10:00 ET (EDT, UTC-4) — inside the
    // 09:30-18:59 ET weekday market-hours gate (shouldRunCalendarEnrich).
    vi.setSystemTime(new Date("2026-06-16T14:00:00Z"));
    (global.fetch as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeEnrichEnv(overrides: Partial<EnrichRunEnv> = {}): EnrichRunEnv {
    return {
      CRON_KV: makeKv(),
      CRON_SHARED_SECRET: "secret",
      MESH_HOSTNAME: "http://mesh.local",
      PRIMARY_TIMEOUT_MS: "300000",
      CLOUD_ENRICH_ENABLED: "false",
      ...overrides,
    };
  }

  it("goes straight to fallback with no fetch attempted", async () => {
    const env = makeEnrichEnv();

    const result = await runCalendarEnrich(env);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.skipped).toBeUndefined();
    expect(result.sentBy).toBe("none");
    expect(result.fallback).toEqual({ kind: "error", error: "cloud_enrich_disabled" });
  });

  it("marker dedup preserved: skips when the enrich-sent-{slot} marker is already present", async () => {
    const env = makeEnrichEnv();
    // Mirrors slotKey()'s format in calendar-enrich.ts: enrich-sent-{date}-
    // {HH}{MM floored to 15}. 2026-06-16T14:00:00Z = 2026-06-16 10:00 ET.
    await env.CRON_KV.put("enrich-sent-2026-06-16-1000", new Date().toISOString());

    const result = await runCalendarEnrich(env);

    expect(result.skipped).toBe("already_sent_this_slot");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("off-hours gate still short-circuits before anything else (weekend)", async () => {
    // Saturday — shouldRunCalendarEnrich is Mon-Fri only.
    vi.setSystemTime(new Date("2026-06-20T14:00:00Z"));
    const env = makeEnrichEnv();

    const result = await runCalendarEnrich(env);

    expect(result).toEqual({ skipped: "off_hours" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
