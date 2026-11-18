/**
 * Worker side of the prior-period check (Mac twin in
 * lib/calendar/enrichment-runner.ts; the rule is the mirrored
 * isPriorPeriodObservation in ../src/macro-figure). When FRED still shows the
 * PREVIOUS period, the Worker writes no payload, so the next tick in the
 * window asks again (a macro payload is single-shot on this road). Synthetic
 * index levels only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { EnrichRunEnv } from "../src/calendar-enrich";
import type { Snapshot } from "../src/state";

vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});
vi.mock("../src/yahoo", () => ({
  captureReactionFromYahoo: vi.fn(async () => ({ source: "yahoo" })),
}));
vi.mock("../src/pushover", () => ({
  sendPushover: vi.fn(async () => ({ sent: true, requestId: "req-1" })),
}));

import { runCloudFallback } from "../src/calendar-enrich";
import { loadLatestSnapshot } from "../src/state";
import { composeReleaseInstant } from "../src/reaction-matcher";
import { cloudEnrichedKey, type CloudEnrichedPayload } from "../src/cloud-enriched";

// A PPI release on 2026-10-15 reports September.
const EVENT_DATE = "2026-10-15";
const RELEASE_TIME = "08:30";
const FRESH = [
  { date: "2026-09-01", value: "110.0" },
  { date: "2026-08-01", value: "105.0" },
  { date: "2025-09-01", value: "100.0" },
  { date: "2025-08-01", value: "100.0" },
];
const STALE = FRESH.slice(1);

function stubFred(rows: Array<{ date: string; value: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.stlouisfed.org") {
        return { ok: true, json: async () => ({ observations: rows }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

function makeEnv(): { env: EnrichRunEnv; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env: EnrichRunEnv = {
    CRON_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    CRON_SHARED_SECRET: "secret",
    MESH_HOSTNAME: "http://mesh.local",
    PRIMARY_TIMEOUT_MS: "300000",
    CLOUD_ENRICH_ENABLED: "true",
    FRED_API_KEY: "fred-key",
    FINNHUB_API_KEY: "finnhub-key",
  };
  return { env, store };
}

function snapshot(sourceKey: string): Snapshot {
  return {
    schemaVersion: 3,
    snapshotDate: EVENT_DATE,
    generatedAt: new Date().toISOString(),
    heldSymbols: [],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: [
      {
        id: 7,
        source_key: sourceKey,
        event_type: "cpi",
        event_date: EVENT_DATE,
        release_time: RELEASE_TIME,
        symbol: null,
        security_id: null,
        actual_value: null,
        enriched_at: null,
        reaction_snapshot: null,
      },
    ],
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
  } as unknown as Snapshot;
}

function minutesAfterRelease(min: number): number {
  const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME);
  if (!release) throw new Error("composeReleaseInstant returned null in test setup");
  return release.getTime() + min * 60 * 1000;
}

describe("runCloudFallback: prior-period check before the payload is written", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("an observation for the expected period is written", async () => {
    stubFred(FRESH);
    const { env, store } = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot(`fred:46:${EVENT_DATE}`));
    await runCloudFallback(env, { nowMs: minutesAfterRelease(15), pacingMs: 0 });
    const payload = JSON.parse(store.get(cloudEnrichedKey(7))!) as CloudEnrichedPayload;
    expect(payload.actual).toBe("10.0%");
    expect(payload.referencePeriod).toBe("2026-09");
  });

  it("an observation one period earlier writes nothing; the next tick writes the new print", async () => {
    stubFred(STALE);
    const { env, store } = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot(`fred:46:${EVENT_DATE}`));
    const first = await runCloudFallback(env, { nowMs: minutesAfterRelease(15), pacingMs: 0 });
    expect(first.failures).toBe(0);
    expect(store.has(cloudEnrichedKey(7))).toBe(false);

    stubFred(FRESH);
    await runCloudFallback(env, { nowMs: minutesAfterRelease(30), pacingMs: 0 });
    const payload = JSON.parse(store.get(cloudEnrichedKey(7))!) as CloudEnrichedPayload;
    expect(payload.actual).toBe("10.0%");
    expect(payload.referencePeriod).toBe("2026-09");
  });

  it("a release whose period cannot be derived keeps today's behaviour", async () => {
    stubFred(STALE);
    const { env, store } = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot(`fred:95:${EVENT_DATE}`));
    await runCloudFallback(env, { nowMs: minutesAfterRelease(15), pacingMs: 0 });
    const payload = JSON.parse(store.get(cloudEnrichedKey(7))!) as CloudEnrichedPayload;
    expect(payload.actual).not.toBeNull();
    expect(payload.referencePeriod).toBe("2026-08");
  });
});
