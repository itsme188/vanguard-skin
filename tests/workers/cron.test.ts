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
import { callPrimary } from "../../workers/cron/src/primary";

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
    FROM_EMAIL: "from@test",
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
  it("readMarkers returns both false when KV is empty", async () => {
    const kv = makeKv();
    const result = await readMarkers(kv, "briefing", "2026-04-23");
    expect(result).toEqual({ mac: false, cloud: false });
  });

  it("writeMarker + readMarkers round-trips", async () => {
    const kv = makeKv();
    await writeMarker(kv, "mac", "digest", "2026-04-23");
    const result = await readMarkers(kv, "digest", "2026-04-23");
    expect(result).toEqual({ mac: true, cloud: false });
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

// ── callPrimary (HTTP to Mac) ───────────────────────────────────

describe("cron worker — callPrimary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns success when Mac responds 200 with non-skip body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    );
    const result = await callPrimary({
      meshHostname: "http://mac.test",
      cronSecret: "s",
      type: "briefing",
      timeoutMs: 500,
    });
    expect(result.kind).toBe("success");
  });

  it("returns skipped_by_mac when Mac replies with skipped:true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ skipped: true, reason: "cloud already sent" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const result = await callPrimary({
      meshHostname: "http://mac.test",
      cronSecret: "s",
      type: "briefing",
      timeoutMs: 500,
    });
    expect(result.kind).toBe("skipped_by_mac");
  });

  it("returns server_error on 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 503 })),
    );
    const result = await callPrimary({
      meshHostname: "http://mac.test",
      cronSecret: "s",
      type: "digest",
      timeoutMs: 500,
    });
    expect(result.kind).toBe("server_error");
  });

  it("returns network_error on fetch rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await callPrimary({
      meshHostname: "http://mac.test",
      cronSecret: "s",
      type: "digest",
      timeoutMs: 500,
    });
    expect(result.kind).toBe("network_error");
    if (result.kind === "network_error") {
      expect(result.message).toContain("ECONNREFUSED");
    }
  });
});

// ── fetch handler: /internal/marker + /internal/trigger + auth ──

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

  it("/internal/trigger runs primary → mac marker on success (dry run)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const env = makeEnv();

    const res = await worker.fetch(
      new Request("http://w/internal/trigger?type=digest", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sentBy?: string; primary?: { kind: string } };
    expect(body.sentBy).toBe("mac");
    expect(body.primary?.kind).toBe("success");

    // Marker WAS written (dryRun flag wasn't set in this test → writeMarker fires).
    const markers = await readMarkers(env.CRON_KV, "digest", todayET());
    expect(markers.mac).toBe(true);
    expect(markers.cloud).toBe(false);
  });

  it("/internal/trigger skips when mac marker already exists", async () => {
    const env = makeEnv();
    await writeMarker(env.CRON_KV, "mac", "digest", todayET());

    const res = await worker.fetch(
      new Request("http://w/internal/trigger?type=digest", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );
    const body = (await res.json()) as { skipped?: string };
    expect(body.skipped).toBe("already_sent");
    expect(fallbackMocks.runFallbackDigest).not.toHaveBeenCalled();
  });

  it("/internal/trigger: primary failure → fallback runs → cloud marker", async () => {
    // Mac returns 5xx → primary fails → fallback fires.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream dead", { status: 502 })),
    );
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
    const body = (await res.json()) as { sentBy?: string; primary?: { kind: string } };
    expect(body.primary?.kind).toBe("server_error");
    expect(body.sentBy).toBe("cloud");
    expect(fallbackMocks.runFallbackDigest).toHaveBeenCalledTimes(1);

    const markers = await readMarkers(env.CRON_KV, "digest", todayET());
    expect(markers.mac).toBe(false);
    expect(markers.cloud).toBe(true);
  });

  it("/internal/trigger with fallbackOnly=true skips primary entirely", async () => {
    const macSpy = vi.fn(async () => new Response("should not be called", { status: 200 }));
    vi.stubGlobal("fetch", macSpy);

    fallbackMocks.runFallbackBriefing.mockResolvedValueOnce({
      kind: "success",
      sentTo: "me@test",
    });

    const env = makeEnv();
    await worker.fetch(
      new Request("http://w/internal/trigger?type=briefing&fallbackOnly=true", {
        method: "POST",
        headers: { "X-Cron-Secret": "test-secret" },
      }),
      env,
    );

    expect(macSpy).not.toHaveBeenCalled();
    expect(fallbackMocks.runFallbackBriefing).toHaveBeenCalledTimes(1);
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
