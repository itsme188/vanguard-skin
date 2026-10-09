/**
 * Worker side of the macro size check and the reference period (owner rulings
 * 2026-10-08). The Worker also produces macro actuals, so the check runs
 * before it writes the cloud payload: a refused actual goes out as
 * `actual: null` with the payload's `reason`, and the FRED observation's
 * period rides along as `referencePeriod`.
 *
 * The real fetchActualForEventCloud runs here against a stubbed FRED answer.
 * Synthetic index levels only.
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
import { fetchActualForEventCloud } from "../src/enrich-actuals";
import { ACTUAL_REFUSED_PREFIX, refusedReasonFromPayload } from "../src/macro-figure";

const EVENT_DATE = "2026-09-10";
const RELEASE_TIME = "08:30";

// 103.0 now, 102.8 a month earlier, 100.0 a year earlier: 3.0% year over year.
const PRICE_INDEX = [
  { date: "2026-08-01", value: "103.0" },
  { date: "2026-07-01", value: "102.8" },
  { date: "2025-08-01", value: "100.0" },
];

function stubFred(bySeries: Record<string, Array<{ date: string; value: string }>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.stlouisfed.org") {
        const series = url.searchParams.get("series_id") ?? "";
        return { ok: true, json: async () => ({ observations: bySeries[series] ?? [] }) };
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

function macroSnapshot(fields: Record<string, unknown>): Snapshot {
  return {
    schemaVersion: 3,
    snapshotDate: EVENT_DATE,
    generatedAt: new Date().toISOString(),
    heldSymbols: [],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: [
      {
        id: 7,
        source_key: `fred:46:${EVENT_DATE}`,
        event_type: "cpi",
        event_date: EVENT_DATE,
        release_time: RELEASE_TIME,
        symbol: null,
        security_id: null,
        actual_value: null,
        enriched_at: null,
        reaction_snapshot: null,
        ...fields,
      },
    ],
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
  } as unknown as Snapshot;
}

function nowInWindow(): number {
  const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME);
  if (!release) throw new Error("composeReleaseInstant returned null in test setup");
  return release.getTime() + 30 * 60 * 1000;
}

async function runFor(fields: Record<string, unknown>): Promise<CloudEnrichedPayload> {
  const { env, store } = makeEnv();
  (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(macroSnapshot(fields));
  const summary = await runCloudFallback(env, { nowMs: nowInWindow(), pacingMs: 0 });
  expect(summary.kind).toBe("success");
  expect(summary.failures).toBe(0);
  const raw = store.get(cloudEnrichedKey(7));
  expect(raw).toBeTruthy();
  return JSON.parse(raw!) as CloudEnrichedPayload;
}

describe("runCloudFallback: macro size check before the payload is written", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFred({ PPIFIS: PRICE_INDEX });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("PPI: a year-over-year actual beside month-over-month figures goes out as actual null with the reason", async () => {
    const payload = await runFor({ consensus_estimate: "0.2%", previous_value: "0.2%" });
    expect(payload.actual).toBeNull();
    expect(payload.reason?.startsWith(ACTUAL_REFUSED_PREFIX)).toBe(true);
    const reason = refusedReasonFromPayload(payload.reason);
    expect(reason).toContain("3.0%");
    expect(reason).toContain("0.2%");
    // The observation's period still rides along.
    expect(payload.referencePeriod).toBe("2026-08");
  });

  it("PPI: the same actual beside same-basis figures is written, with its reference month", async () => {
    const payload = await runFor({ consensus_estimate: "2.9%", previous_value: "2.7%" });
    expect(payload.actual).toBe("3.0%");
    expect(refusedReasonFromPayload(payload.reason)).toBeNull();
    expect(payload.referencePeriod).toBe("2026-08");
  });

  it("PPI: more than ten times the previous but not the consensus is written", async () => {
    const payload = await runFor({ consensus_estimate: "0.3%", previous_value: "0.2%" });
    expect(payload.actual).toBe("3.0%");
    expect(refusedReasonFromPayload(payload.reason)).toBeNull();
  });

  it("a zero consensus is not comparable: the actual is written", async () => {
    const payload = await runFor({ consensus_estimate: "0.0%", previous_value: "0.2%" });
    expect(payload.actual).toBe("3.0%");
  });

  it("no previous in the snapshot: no guess, the actual is written", async () => {
    const payload = await runFor({ consensus_estimate: "0.2%" });
    expect(payload.actual).toBe("3.0%");
    expect(refusedReasonFromPayload(payload.reason)).toBeNull();
  });

  it("mixed units never trip the check", async () => {
    const payload = await runFor({ consensus_estimate: "229K", previous_value: "231K" });
    expect(payload.actual).toBe("3.0%");
  });
});

describe("fetchActualForEventCloud: the reference period from the observation date", () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = { FRED_API_KEY: "fred-key" };

  it("monthly series: YYYY-MM", async () => {
    stubFred({ PPIFIS: PRICE_INDEX });
    const r = await fetchActualForEventCloud(
      { source_key: `fred:46:${EVENT_DATE}`, event_date: EVENT_DATE, consensus_estimate: null },
      env,
    );
    expect(r.actual).toBe("3.0%");
    expect(r.referencePeriod).toBe("2026-08");
  });

  it("quarterly GDP: YYYY-Qn", async () => {
    stubFred({
      GDPC1: [
        { date: "2026-04-01", value: "101.0" },
        { date: "2026-01-01", value: "100.0" },
      ],
    });
    const r = await fetchActualForEventCloud(
      { source_key: "fred:53:2026-07-30", event_date: "2026-07-30", consensus_estimate: null },
      env,
    );
    expect(r.actual).toBe("4.1%");
    expect(r.referencePeriod).toBe("2026-Q2");
  });

  it("weekly claims: the observation's own week-ending date", async () => {
    stubFred({
      ICSA: [
        { date: "2026-09-05", value: "229000" },
        { date: "2026-08-29", value: "231000" },
      ],
    });
    const r = await fetchActualForEventCloud(
      { source_key: `fred:180:${EVENT_DATE}`, event_date: EVENT_DATE, consensus_estimate: null },
      env,
    );
    expect(r.actual).toBe("229K");
    expect(r.referencePeriod).toBe("2026-09-05");
  });

  it("the FOMC rate carries no reference period", async () => {
    stubFred({ DFEDTARU: [{ date: "2026-09-16", value: "4.25" }] });
    const r = await fetchActualForEventCloud(
      { source_key: "fomc:2026-09-16", event_date: "2026-09-16", consensus_estimate: null },
      env,
    );
    expect(r.actual).toBe("4.25%");
    expect(r.referencePeriod ?? null).toBeNull();
  });
});
