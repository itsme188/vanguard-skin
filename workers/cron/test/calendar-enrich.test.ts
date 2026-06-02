/**
 * Tests for workers/cron/src/calendar-enrich.ts::runCloudFallback
 *
 * Focus: the observability guard added 2026-05-31 — a candidate whose
 * actual-fetch throws must increment `failures` AND populate `lastError` so a
 * partial/total failure is diagnosable, not just a count. Note the function
 * intentionally still returns kind:"success" whenever any candidate processed
 * (partial progress is real); the failure surfaces via failures + lastError.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EnrichRunEnv } from "../src/calendar-enrich";
import type { Snapshot } from "../src/state";

// ── Dependency mocks ─────────────────────────────────────────────────────────

vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});

vi.mock("../src/enrich-actuals", () => ({
  fetchActualForEventCloud: vi.fn(),
}));

vi.mock("../src/yahoo", () => ({
  captureReactionFromYahoo: vi.fn(async () => ({ source: "yahoo" })),
}));

import { runCloudFallback, isBenignEnrichOutcome } from "../src/calendar-enrich";
import { loadLatestSnapshot } from "../src/state";
import { fetchActualForEventCloud } from "../src/enrich-actuals";
import { composeReleaseInstant } from "../src/reaction-matcher";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<EnrichRunEnv> = {}): EnrichRunEnv {
  const store = new Map<string, string>();
  return {
    CRON_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    CRON_SHARED_SECRET: "secret",
    MESH_HOSTNAME: "http://mesh.local",
    PRIMARY_TIMEOUT_MS: "300000",
    CLOUD_ENRICH_ENABLED: "true",
    FRED_API_KEY: "fred-key",
    FINNHUB_API_KEY: "finnhub-key",
    ...overrides,
  };
}

const EVENT_DATE = "2026-06-15";
const RELEASE_TIME = "10:00";

function makeEnrichSnapshot(): Snapshot {
  return {
    schemaVersion: 3,
    snapshotDate: EVENT_DATE,
    generatedAt: new Date().toISOString(),
    heldSymbols: ["AAPL"],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: [
      {
        id: 1,
        source_key: "finnhub:AAPL:2026-06-15",
        event_type: "earnings",
        event_date: EVENT_DATE,
        release_time: RELEASE_TIME,
        symbol: "AAPL",
        consensus_estimate: "EPS 1.50 · Rev 90B",
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

/** nowMs placed inside the candidate window (5 min – 2 h AFTER release). */
function candidateWindowNowMs(): number {
  const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME);
  if (!release) throw new Error("composeReleaseInstant returned null in test setup");
  return release.getTime() + 30 * 60 * 1000;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runCloudFallback observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("populates lastError and counts the failure when a candidate's actual-fetch throws", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEnrichSnapshot(),
    );
    (fetchActualForEventCloud as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("FRED 500"),
    );

    const summary = await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    // kind stays "success" (any candidate processed) — the masking is intentional,
    // but the failure is now visible via failures + lastError.
    expect(summary.kind).toBe("success");
    expect(summary.candidatesProcessed).toBe(1);
    expect(summary.failures).toBe(1);
    expect(summary.lastError).toMatch(/FRED 500/);
  });

  it("leaves lastError undefined when the candidate enriches cleanly", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEnrichSnapshot(),
    );
    (fetchActualForEventCloud as ReturnType<typeof vi.fn>).mockResolvedValue({
      actual: "EPS 1.55",
      consensus: "EPS 1.50",
      source: "finnhub",
      deferred: false,
      reason: null,
    });

    const summary = await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(summary.kind).toBe("success");
    expect(summary.candidatesProcessed).toBe(1);
    expect(summary.failures).toBe(0);
    expect(summary.lastError).toBeUndefined();
  });

  it("returns no_candidates when nowMs is outside every candidate window", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEnrichSnapshot(),
    );

    const summary = await runCloudFallback(env, {
      nowMs: Date.parse("2026-01-01T00:00:00Z"),
      pacingMs: 0,
    });

    expect(summary.kind).toBe("no_candidates");
  });
});

describe("isBenignEnrichOutcome (enrich-fail de-noise)", () => {
  // The Mac primary is unreachable from Cloudflare's edge on EVERY tick (Mesh
  // CGNAT IP → CF error 1016), so a primary failure alone is the normal idle
  // state, not a real problem. The enrich-fail journal marker should only
  // persist when the cloud fallback ALSO couldn't make clean progress.

  it("treats no_candidates as benign (nothing in the window → not a failure)", () => {
    expect(isBenignEnrichOutcome({ kind: "no_candidates" })).toBe(true);
  });

  it("treats a clean success (candidates processed, no failures) as benign", () => {
    expect(
      isBenignEnrichOutcome({ kind: "success", candidatesProcessed: 1, failures: 0 }),
    ).toBe(true);
  });

  it("treats a success WITH candidate failures as a real failure", () => {
    expect(
      isBenignEnrichOutcome({
        kind: "success",
        candidatesProcessed: 2,
        failures: 1,
        lastError: "FRED 500",
      }),
    ).toBe(false);
  });

  it("treats snapshot_missing as a real failure", () => {
    expect(isBenignEnrichOutcome({ kind: "snapshot_missing" })).toBe(false);
  });

  it("treats error as a real failure", () => {
    expect(isBenignEnrichOutcome({ kind: "error", error: "archive_binding_missing" })).toBe(false);
  });
});
