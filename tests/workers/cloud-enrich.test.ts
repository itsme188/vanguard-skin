/**
 * Phase 9b — Worker cloud-fallback path tests.
 *
 * Exercises `runCloudFallback` + the primary-failure dispatch in
 * `runCalendarEnrich`. Covers: flag off (no-op), flag on + snapshot +
 * candidates → KV writes, idempotency across ticks, deferred nonfred
 * events, TWS-always-wins-not-our-concern-here (that's reconcile's job).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runCalendarEnrich,
  runCloudFallback,
  cloudEnrichedKey,
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
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(opts?: { prefix?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
      const prefix = opts?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function gzipStream(obj: unknown): ReadableStream {
  const text = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(text);
  const src = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  // CompressionStream's lib.dom type declares writable: WritableStream<BufferSource>,
  // which doesn't unify with Uint8Array under strict generic variance. Cast
  // through the expected pair shape — at runtime the types match.
  return src.pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

function makeArchive(snapshot: unknown): R2Bucket {
  return {
    async list() {
      return { objects: [{ key: "state/vanguard-state-2026-04-24.json.gz", uploaded: new Date() }] };
    },
    async get() {
      return {
        key: "state/vanguard-state-2026-04-24.json.gz",
        uploaded: new Date(),
        body: gzipStream(snapshot),
      };
    },
  } as unknown as R2Bucket;
}

// Helper: a FRED CPI event released 90 minutes before "now" (within window).
function makeFredCandidate(id: number, nowMs: number) {
  const release = new Date(nowMs - 90 * 60 * 1000);
  // Compose ET wall-clock for the event: convert release UTC → ET string
  // reverse of composeReleaseInstant. For simplicity, use release_time from
  // the known-UTC-ish instant. Since tests run with fakeTimers at
  // 2026-04-24T18:30:00Z = 14:30 ET, release at T-90min is 13:00 ET.
  // We feed back the correct release_time to match.
  const etHour = release.getUTCHours() - 4; // EDT in April
  const release_time = `${String(etHour).padStart(2, "0")}:${String(release.getUTCMinutes()).padStart(2, "0")}`;
  return {
    id,
    source_key: "fred:10:2026-04-24",
    event_type: "cpi",
    event_date: "2026-04-24",
    release_time,
    symbol: null,
    consensus_estimate: "3.2%",
    security_id: null,
    enriched_at: null,
    reaction_snapshot: null,
  };
}

function makeFinnhubCandidate(id: number, nowMs: number, symbol: string) {
  const release = new Date(nowMs - 60 * 60 * 1000);
  const etHour = release.getUTCHours() - 4;
  const release_time = `${String(etHour).padStart(2, "0")}:${String(release.getUTCMinutes()).padStart(2, "0")}`;
  return {
    id,
    source_key: `finnhub:${symbol}:2026-04-24`,
    event_type: "earnings",
    event_date: "2026-04-24",
    release_time,
    symbol,
    consensus_estimate: "EPS 1.25",
    security_id: 99,
    enriched_at: null,
    reaction_snapshot: null,
  };
}

function makeNonfredCandidate(id: number, nowMs: number) {
  const release = new Date(nowMs - 60 * 60 * 1000);
  const etHour = release.getUTCHours() - 4;
  const release_time = `${String(etHour).padStart(2, "0")}:${String(release.getUTCMinutes()).padStart(2, "0")}`;
  return {
    id,
    source_key: "nonfred:ism_manufacturing:2026-04-24",
    event_type: "ism_manufacturing",
    event_date: "2026-04-24",
    release_time,
    symbol: null,
    consensus_estimate: "52.0",
    security_id: null,
    enriched_at: null,
    reaction_snapshot: null,
  };
}

describe("runCloudFallback", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T18:30:00Z")); // Fri 14:30 ET
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns cloud_enrich_disabled when flag is unset", async () => {
    const env = {
      CRON_KV: makeKv(),
      CRON_SHARED_SECRET: "test",
      MESH_HOSTNAME: "http://localhost:3099",
      PRIMARY_TIMEOUT_MS: "5000",
    } as Parameters<typeof runCloudFallback>[0];
    const result = await runCloudFallback(env);
    expect(result.kind).toBe("error");
    expect(result.error).toBe("cloud_enrich_disabled");
  });

  it("returns archive_binding_missing when flag on but no R2", async () => {
    const env = {
      CRON_KV: makeKv(),
      CRON_SHARED_SECRET: "test",
      MESH_HOSTNAME: "http://localhost:3099",
      PRIMARY_TIMEOUT_MS: "5000",
      CLOUD_ENRICH_ENABLED: "true",
    } as Parameters<typeof runCloudFallback>[0];
    const result = await runCloudFallback(env);
    expect(result.kind).toBe("error");
    expect(result.error).toBe("archive_binding_missing");
  });

  it("returns snapshot_missing when R2 has no objects", async () => {
    const emptyArchive = {
      async list() {
        return { objects: [] };
      },
      async get() {
        return null;
      },
    } as unknown as R2Bucket;
    const env = {
      CRON_KV: makeKv(),
      ARCHIVE: emptyArchive,
      CRON_SHARED_SECRET: "test",
      MESH_HOSTNAME: "http://localhost:3099",
      PRIMARY_TIMEOUT_MS: "5000",
      CLOUD_ENRICH_ENABLED: "true",
    } as Parameters<typeof runCloudFallback>[0];
    const result = await runCloudFallback(env);
    expect(result.kind).toBe("snapshot_missing");
  });

  it("writes cloud-enriched payloads for in-window FRED + Finnhub candidates", async () => {
    const nowMs = Date.now();
    const snapshot = {
      schemaVersion: 1,
      snapshotDate: "2026-04-24",
      generatedAt: new Date().toISOString(),
      heldSymbols: ["AAPL"],
      settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
      calendarEvents: [
        makeFredCandidate(100, nowMs),
        makeFinnhubCandidate(101, nowMs, "AAPL"),
      ],
      researchSources: [],
      recentArticlesMeta: [],
      deepReadArticles: [],
    };

    // Mock FRED + Finnhub + Yahoo responses.
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes("api.stlouisfed.org")) {
        return {
          ok: true,
          async json() {
            return {
              observations: [
                { date: "2026-04-24", value: "321.5" },
                { date: "2025-04-24", value: "311.0" },
              ],
            };
          },
        };
      }
      if (url.includes("finnhub.io")) {
        return {
          ok: true,
          async json() {
            return {
              earningsCalendar: [
                {
                  symbol: "AAPL",
                  date: "2026-04-24",
                  epsActual: 1.47,
                  epsEstimate: 1.25,
                  revenueActual: 95000000000,
                  revenueEstimate: 90000000000,
                },
              ],
            };
          },
        };
      }
      if (url.includes("finance.yahoo.com")) {
        const release = nowMs - 90 * 60 * 1000;
        // Yahoo returns timestamps in seconds; 3 bars straddling release.
        const ts = [
          Math.floor((release - 5 * 60 * 1000) / 1000),
          Math.floor(release / 1000),
          Math.floor((release + 120 * 60 * 1000) / 1000),
        ];
        return {
          ok: true,
          async json() {
            return {
              chart: {
                result: [
                  {
                    timestamp: ts,
                    indicators: { quote: [{ close: [500, 502, 506] }] },
                  },
                ],
              },
            };
          },
        };
      }
      return { ok: false, status: 500 };
    });

    const kv = makeKv();
    const env = {
      CRON_KV: kv,
      ARCHIVE: makeArchive(snapshot),
      CRON_SHARED_SECRET: "test",
      MESH_HOSTNAME: "http://localhost:3099",
      PRIMARY_TIMEOUT_MS: "5000",
      CLOUD_ENRICH_ENABLED: "true",
      FRED_API_KEY: "fred-key",
      FINNHUB_API_KEY: "finnhub-key",
    } as Parameters<typeof runCloudFallback>[0];

    const result = await runCloudFallback(env, { nowMs, pacingMs: 0 });
    expect(result.kind).toBe("success");
    expect(result.candidatesProcessed).toBe(2);
    expect(result.failures).toBe(0);

    const store = (kv as unknown as { store: Map<string, string> }).store;
    expect(store.has(cloudEnrichedKey(100))).toBe(true);
    expect(store.has(cloudEnrichedKey(101))).toBe(true);

    const fredPayload = JSON.parse(store.get(cloudEnrichedKey(100))!);
    expect(fredPayload.source).toBe("fred");
    expect(fredPayload.actual).toMatch(/%/);
    expect(fredPayload.reaction?.source).toBe("yahoo");
  });

  it("defers claude nonfred events — writes deferred payload with reaction captured via Yahoo", async () => {
    const nowMs = Date.now();
    const snapshot = {
      schemaVersion: 1,
      snapshotDate: "2026-04-24",
      generatedAt: new Date().toISOString(),
      heldSymbols: [],
      settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
      calendarEvents: [makeNonfredCandidate(200, nowMs)],
      researchSources: [],
      recentArticlesMeta: [],
      deepReadArticles: [],
    };

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes("finance.yahoo.com")) {
        const release = nowMs - 60 * 60 * 1000;
        const ts = [
          Math.floor((release - 5 * 60 * 1000) / 1000),
          Math.floor((release + 120 * 60 * 1000) / 1000),
        ];
        return {
          ok: true,
          async json() {
            return {
              chart: {
                result: [
                  {
                    timestamp: ts,
                    indicators: { quote: [{ close: [500, 510] }] },
                  },
                ],
              },
            };
          },
        };
      }
      return { ok: false, status: 500 };
    });

    const kv = makeKv();
    const env = {
      CRON_KV: kv,
      ARCHIVE: makeArchive(snapshot),
      CRON_SHARED_SECRET: "test",
      MESH_HOSTNAME: "http://localhost:3099",
      PRIMARY_TIMEOUT_MS: "5000",
      CLOUD_ENRICH_ENABLED: "true",
      FRED_API_KEY: "fred-key",
      FINNHUB_API_KEY: "finnhub-key",
    } as Parameters<typeof runCloudFallback>[0];

    const result = await runCloudFallback(env, { nowMs, pacingMs: 0 });
    expect(result.kind).toBe("success");
    expect(result.deferred).toBe(1);

    const store = (kv as unknown as { store: Map<string, string> }).store;
    const payload = JSON.parse(store.get(cloudEnrichedKey(200))!);
    expect(payload.source).toBe("claude_nonfred_deferred");
    expect(payload.actual).toBeNull();
    expect(payload.deferred).toBe(true);
    // Yahoo reaction still captured (it's orthogonal to actual value)
    expect(payload.reaction?.source).toBe("yahoo");
  });

  it("is idempotent — pre-seeded cloud-enriched KV marker short-circuits FRED + Yahoo", async () => {
    const nowMs = Date.now();
    const snapshot = {
      schemaVersion: 1,
      snapshotDate: "2026-04-24",
      generatedAt: new Date().toISOString(),
      heldSymbols: [],
      settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
      calendarEvents: [makeFredCandidate(300, nowMs)],
      researchSources: [],
      recentArticlesMeta: [],
      deepReadArticles: [],
    };

    // Any fetch call at all fails the idempotency check.
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return { ok: false, status: 599, async json() { return {}; } };
    });

    const kv = makeKv();
    // Pre-seed the cloud-enriched marker so the KV check short-circuits the
    // FRED + Yahoo fetches for this candidate.
    await kv.put(
      cloudEnrichedKey(300),
      JSON.stringify({ eventId: 300, actual: "3.4%", source: "fred" }),
    );

    const env = {
      CRON_KV: kv,
      ARCHIVE: makeArchive(snapshot),
      CRON_SHARED_SECRET: "test",
      MESH_HOSTNAME: "http://localhost:3099",
      PRIMARY_TIMEOUT_MS: "5000",
      CLOUD_ENRICH_ENABLED: "true",
      FRED_API_KEY: "fred-key",
      FINNHUB_API_KEY: "finnhub-key",
    } as Parameters<typeof runCloudFallback>[0];

    const result = await runCloudFallback(env, { nowMs, pacingMs: 0 });
    expect(result.kind).toBe("success");
    // 0 fetch calls confirms FRED + Yahoo were skipped via the KV check.
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

// 2026-08-14 (#35 Phase D, Task 25): the Mac-primary POST is retired — there
// is no primary call left to fail, so runCalendarEnrich goes straight to
// cloud enrichment. The mock's "/api/calendar/enrich" branch below is dead
// (no code path ever requests that URL anymore) but harmless; left in place
// as evidence nothing new started hitting it.
describe("runCalendarEnrich → cloud success (no primary call attempted)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T18:30:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("writes cloud-sent marker + deletes fail marker when cloud path succeeds", async () => {
    const nowMs = Date.now();
    const snapshot = {
      schemaVersion: 1,
      snapshotDate: "2026-04-24",
      generatedAt: new Date().toISOString(),
      heldSymbols: [],
      settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
      calendarEvents: [makeFredCandidate(400, nowMs)],
      researchSources: [],
      recentArticlesMeta: [],
      deepReadArticles: [],
    };

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      // Primary Mac call → 500
      if (url.includes("/api/calendar/enrich")) {
        return {
          ok: false,
          status: 500,
          async text() {
            return "mac down";
          },
        };
      }
      if (url.includes("stlouisfed.org")) {
        return {
          ok: true,
          async json() {
            return {
              observations: [
                { date: "2026-04-24", value: "321.5" },
                { date: "2025-04-24", value: "311.0" },
              ],
            };
          },
        };
      }
      if (url.includes("finance.yahoo.com")) {
        const release = nowMs - 90 * 60 * 1000;
        const ts = [
          Math.floor((release - 5 * 60 * 1000) / 1000),
          Math.floor((release + 120 * 60 * 1000) / 1000),
        ];
        return {
          ok: true,
          async json() {
            return {
              chart: {
                result: [
                  {
                    timestamp: ts,
                    indicators: { quote: [{ close: [500, 506] }] },
                  },
                ],
              },
            };
          },
        };
      }
      return { ok: false, status: 500 };
    });

    const kv = makeKv();
    const env = {
      CRON_KV: kv,
      ARCHIVE: makeArchive(snapshot),
      CRON_SHARED_SECRET: "test",
      MESH_HOSTNAME: "http://localhost:3099",
      PRIMARY_TIMEOUT_MS: "5000",
      CLOUD_ENRICH_ENABLED: "true",
      FRED_API_KEY: "fred-key",
      FINNHUB_API_KEY: "finnhub-key",
    } as Parameters<typeof runCalendarEnrich>[0];

    const result = await runCalendarEnrich(env, { pacingMs: 0 });
    expect(result.sentBy).toBe("cloud");
    expect(result.fallback?.kind).toBe("success");
    expect(result.fallback?.candidatesProcessed).toBe(1);

    // No call ever reaches the dead "/api/calendar/enrich" mock branch above.
    const fetchedUrls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[0]),
    );
    expect(fetchedUrls.some((u) => u.includes("/api/calendar/enrich"))).toBe(false);

    const store = (kv as unknown as { store: Map<string, string> }).store;
    const keys = Array.from(store.keys());
    expect(keys.some((k) => k.startsWith("cloud-sent-enrich-"))).toBe(true);
    // Fail marker was deleted post-success
    expect(keys.some((k) => k.startsWith("enrich-fail-"))).toBe(false);
    // Cloud-enriched payload key present
    expect(store.has(cloudEnrichedKey(400))).toBe(true);
  });
});
