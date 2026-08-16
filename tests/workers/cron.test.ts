import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks for the fallback modules ─────────────────────────────
// Both fallback modules reach real external APIs (Gmail REST, Claude via
// AI Gateway). We stub them at the module level so the Worker's index
// imports a predictable surface.

const fallbackMocks = vi.hoisted(() => ({
  runFallbackBriefing: vi.fn(async () => ({ kind: "success" as const, sentTo: "test@example.com" })),
  runFallbackDigest: vi.fn(async () => ({ kind: "success" as const, sentTo: "test@example.com", processed: 0 })),
}));

vi.mock("../../workers/cron/src/fallback-briefing", () => ({
  runFallbackBriefing: fallbackMocks.runFallbackBriefing,
}));
vi.mock("../../workers/cron/src/fallback-digest", () => ({
  runFallbackDigest: fallbackMocks.runFallbackDigest,
}));

// ── Imports from the Worker (types are erased, so KVNamespace/R2Bucket/
// ScheduledController references compile fine under the main project) ──

import worker from "../../workers/cron/src/index";
import {
  readMarkers,
  writeMarker,
  getMarkerStatus,
} from "../../workers/cron/src/dedup";
import {
  getCurrentETHour,
  todayET,
  getCurrentETDayOfWeek,
} from "../../workers/cron/src/dst";

// ── Map-backed KVNamespace fake ─────────────────────────────────

interface KvValue {
  value: string;
  expiresAt?: number;
}

function makeKv() {
  const store = new Map<string, KvValue>();
  const kv = {
    async get(key: string): Promise<string | null> {
      const v = store.get(key);
      if (!v) return null;
      if (v.expiresAt && v.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return v.value;
    },
    async put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> {
      const expiresAt = opts?.expirationTtl
        ? Date.now() + opts.expirationTtl * 1000
        : undefined;
      store.set(key, { value, expiresAt });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    _store: store,
  };
  // Cast through unknown — the mock only needs the methods runJob uses.
  return kv as unknown as KVNamespace;
}

// ── Env factory ─────────────────────────────────────────────────

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    CRON_KV: makeKv(),
    ARCHIVE: {} as unknown as R2Bucket,
    EXPECTED_HOUR_BRIEFING: "15",
    EXPECTED_HOUR_DIGEST: "9",
    PRIMARY_TIMEOUT_MS: "1000",
    CRON_SHARED_SECRET: "test-secret",
    MESH_HOSTNAME: "http://mac.test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CLOUDFLARE_ACCOUNT_ID: "cf-account",
    CLOUDFLARE_GATEWAY_ID: "cf-gw",
    WORKER_GMAIL_CLIENT_ID: "gmail-client",
    WORKER_GMAIL_CLIENT_SECRET: "gmail-secret",
    WORKER_GMAIL_REFRESH_TOKEN: "gmail-refresh",
    BRIEFING_EMAIL_TO: "to@test",
    RESEND_API_KEY: "re_test",
    RESEND_FROM_DOMAIN: "test.example.com",
    ...overrides,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

// ── DST / date helpers ──────────────────────────────────────────

describe("cron worker — dst helpers", () => {
  it("getCurrentETHour returns 0-23 for a UTC Date", () => {
    // 2026-06-15 17:30 UTC = 13:30 ET (EDT, UTC-4) → hour 13
    const summer = new Date(Date.UTC(2026, 5, 15, 17, 30));
    expect(getCurrentETHour(summer)).toBe(13);
    // 2026-01-15 17:30 UTC = 12:30 ET (EST, UTC-5) → hour 12
    const winter = new Date(Date.UTC(2026, 0, 15, 17, 30));
    expect(getCurrentETHour(winter)).toBe(12);
  });

  it("todayET returns YYYY-MM-DD in ET", () => {
    // 2026-01-15 02:00 UTC = 2026-01-14 21:00 ET (previous day)
    const lateUtc = new Date(Date.UTC(2026, 0, 15, 2, 0));
    expect(todayET(lateUtc)).toBe("2026-01-14");
  });

  it("getCurrentETDayOfWeek returns 0=Sun ... 6=Sat in ET", () => {
    // 2026-03-01 is a Sunday. 14:00 UTC = 09:00 ET.
    const sun = new Date(Date.UTC(2026, 2, 1, 14, 0));
    expect(getCurrentETDayOfWeek(sun)).toBe(0);
    // 2026-03-02 is a Monday.
    const mon = new Date(Date.UTC(2026, 2, 2, 14, 0));
    expect(getCurrentETDayOfWeek(mon)).toBe(1);
  });
});

// ── Dedup / KV marker layer ─────────────────────────────────────

describe("cron worker — marker dedup", () => {
  it("readMarkers returns all false when KV is empty", async () => {
    const kv = makeKv();
    const result = await readMarkers(kv, "briefing", "2026-04-23");
    expect(result).toEqual({ mac: false, cloud: false, macRunning: false, cloudAttempting: false });
  });

  it("writeMarker + readMarkers round-trips", async () => {
    const kv = makeKv();
    await writeMarker(kv, "mac", "digest", "2026-04-23");
    const result = await readMarkers(kv, "digest", "2026-04-23");
    expect(result).toEqual({ mac: true, cloud: false, macRunning: false, cloudAttempting: false });
  });

  it("getMarkerStatus prefers cloud over mac when both are set", async () => {
    const kv = makeKv();
    await writeMarker(kv, "mac", "digest", "2026-04-23");
    await writeMarker(kv, "cloud", "digest", "2026-04-23");
    const status = await getMarkerStatus(kv, "digest", "2026-04-23");
    expect(status.sentBy).toBe("cloud");
  });

  it("getMarkerStatus returns null sentBy when neither marker exists", async () => {
    const kv = makeKv();
    const status = await getMarkerStatus(kv, "briefing", "2026-04-23");
    expect(status.sentBy).toBeNull();
  });
});

// ── fetch handler: /internal/marker + /internal/trigger + auth ──
//
// callPrimary (the HTTP-to-Mac helper that used to live here) was retired
// 2026-08-14 (#35 Phase D, Task 25) along with its call site in runJob —
// workers/cron/src/primary.ts is deleted. See
// workers/cron/test/primary-retirement.test.ts for dedicated coverage of the
// retirement itself (no fetch attempted, marker dedup preserved).

describe("cron worker — /internal/* handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects /internal/marker without the cron secret", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("http://w/internal/marker?type=briefing"),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("/internal/marker returns cloud when cloud marker present", async () => {
    const env = makeEnv();
    await writeMarker(env.CRON_KV, "cloud", "briefing", todayET());

    const res = await worker.fetch(
      new Request("http://w/internal/marker?type=briefing", {
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sentBy: string | null };
    expect(body.sentBy).toBe("cloud");
  });

  // 2026-08-14 (#35 Phase D, Task 25): the Mac-primary POST is retired —
  // /internal/trigger now goes straight from the marker dedup check to the
  // fallback composer for every request. No fetch to MESH_HOSTNAME is ever
  // attempted, so "mac" sentBy is only reachable via a pre-existing mac-sent
  // marker (the Mac's own launchd-triggered send), never via a Worker→Mac
  // call succeeding.
  it("/internal/trigger goes straight to fallback with no fetch attempted", async () => {
    vi.stubGlobal("fetch", vi.fn());
    fallbackMocks.runFallbackDigest.mockResolvedValueOnce({
      kind: "success",
      sentTo: "me@test",
      processed: 3,
    });

    const env = makeEnv();
    const res = await worker.fetch(
      new Request("http://w/internal/trigger?type=digest", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sentBy?: string };
    expect(body.sentBy).toBe("cloud");
    expect(fallbackMocks.runFallbackDigest).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();

    const markers = await readMarkers(env.CRON_KV, "digest", todayET());
    expect(markers.mac).toBe(false);
    expect(markers.cloud).toBe(true);
  });

  it("/internal/trigger skips when mac marker already exists (dedup preserved, sentBy=mac)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const env = makeEnv();
    await writeMarker(env.CRON_KV, "mac", "digest", todayET());

    const res = await worker.fetch(
      new Request("http://w/internal/trigger?type=digest", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    const body = (await res.json()) as { skipped?: string; sentBy?: string };
    expect(body.skipped).toBe("already_sent");
    expect(body.sentBy).toBe("mac");
    expect(fallbackMocks.runFallbackDigest).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("/health returns ok without authentication", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("http://w/health"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects bad type param on /internal/trigger", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("http://w/internal/trigger?type=spam", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

// ── B3: running-marker race fix ─────────────────────────────────
//
// Originally closed the 8:45 → 8:57 race observed 2026-04-27 where Mac
// succeeded during the Worker's primary timeout window, Worker fired
// fallback anyway, and the user got a thinned-out duplicate email — the
// mac-running check was added to the post-primary marker re-read.
//
// 2026-08-14 (#35 Phase D, Task 25): the primary POST itself is retired, so
// there's no timeout window left to race — but the guarantee (mac-running
// must still block fallback) is preserved by folding it into the single
// marker check runJob does before claiming fallback. The tests below now
// prove that guarantee by seeding markers directly rather than simulating a
// blocking Mac fetch mid-timeout.

describe("cron worker — mac-running marker", () => {
  it("/internal/running-marker?action=set writes the mac-running KV key", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("http://w/internal/running-marker?type=digest&action=set", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const markers = await readMarkers(env.CRON_KV, "digest", todayET());
    expect(markers.macRunning).toBe(true);
  });

  it("/internal/running-marker?action=clear deletes the marker", async () => {
    const env = makeEnv();
    // Pre-set
    await worker.fetch(
      new Request("http://w/internal/running-marker?type=digest&action=set", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    expect((await readMarkers(env.CRON_KV, "digest", todayET())).macRunning).toBe(true);

    await worker.fetch(
      new Request("http://w/internal/running-marker?type=digest&action=clear", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    expect((await readMarkers(env.CRON_KV, "digest", todayET())).macRunning).toBe(false);
  });

  it("rejects bad action param", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("http://w/internal/running-marker?type=digest&action=poke", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated calls", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("http://w/internal/running-marker?type=digest&action=set", {
        method: "POST",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("Worker's marker check skips fallback when mac-running is set (Mac's own launchd run is mid-flight)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const env = makeEnv();
    await env.CRON_KV.put("mac-running-digest-" + todayET(), "now", {
      expirationTtl: 600,
    });

    fallbackMocks.runFallbackDigest.mockClear();

    const res = await worker.fetch(
      new Request("http://w/internal/trigger?type=digest", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe("mac_still_running");
    expect(fallbackMocks.runFallbackDigest).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("Worker's marker check returns sentBy=mac and skips fallback when mac-sent is already present", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const env = makeEnv();
    await env.CRON_KV.put("mac-sent-digest-" + todayET(), "now", {
      expirationTtl: 30 * 3600,
    });

    fallbackMocks.runFallbackDigest.mockClear();

    const res = await worker.fetch(
      new Request("http://w/internal/trigger?type=digest", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: string; sentBy?: string };
    expect(body.sentBy).toBe("mac");
    expect(fallbackMocks.runFallbackDigest).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("Worker fires fallback immediately when no markers are present (no primary call to wait on)", async () => {
    // Sanity check: with the primary POST retired, an unmarked tick must
    // still fall back — there's no "Mac might still respond" window anymore,
    // so this should be immediate rather than needing a timeout to elapse.
    vi.stubGlobal("fetch", vi.fn());
    const env = makeEnv();

    fallbackMocks.runFallbackDigest.mockClear();
    fallbackMocks.runFallbackDigest.mockResolvedValueOnce({
      kind: "success",
      sentTo: "to@test",
      processed: 0,
    });

    const res = await worker.fetch(
      new Request("http://w/internal/trigger?type=digest", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sentBy?: string };
    expect(body.sentBy).toBe("cloud");
    expect(fallbackMocks.runFallbackDigest).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
