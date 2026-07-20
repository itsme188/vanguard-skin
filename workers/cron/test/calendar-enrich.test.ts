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

vi.mock("../src/pushover", () => ({
  sendPushover: vi.fn(async () => ({ sent: true, requestId: "req-1" })),
}));

import {
  runCloudFallback,
  isBenignEnrichOutcome,
  shouldRunCalendarEnrich,
  shouldRunEarningsFallback,
} from "../src/calendar-enrich";
import { loadLatestSnapshot } from "../src/state";
import { fetchActualForEventCloud } from "../src/enrich-actuals";
import { composeReleaseInstant } from "../src/reaction-matcher";
import { captureReactionFromYahoo } from "../src/yahoo";
import { sendPushover } from "../src/pushover";
import { readPrintPushMarker } from "../src/earnings-markers";
import { cloudEnrichedKey } from "../src/cloud-enriched";

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

  it("skips superseded sibling rows (never a candidate, even in-window)", async () => {
    // One print = two calendar rows (finnhub + nasdaq); the Mac marks the
    // non-canonical row superseded=1. A superseded row can never complete
    // (its canonical sibling owns enrichment), so processing it every tick
    // just burns subrequest budget — mirror of the ba1b39f fallback-earnings
    // skip.
    const env = makeEnv();
    const snapshot = makeEnrichSnapshot();
    (snapshot.calendarEvents as Array<Record<string, unknown>>)[0].superseded = 1;
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot);

    const summary = await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(summary.kind).toBe("no_candidates");
    expect(fetchActualForEventCloud).not.toHaveBeenCalled();
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

// ── Push-at-print hook (Wave 1 §2) ──────────────────────────────────────────

describe("runCloudFallback push-at-print hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Snapshot with earnings gates configurable per test. v8 by default (has watchlistSymbols). */
  function makePushSnapshot(overrides: {
    heldSymbols?: string[];
    watchlistSymbols?: string[] | undefined; // undefined → omit the field entirely (pre-v8 snapshot)
    mutedSymbols?: string[];
    enabled?: boolean;
    schemaVersion?: Snapshot["schemaVersion"];
    readThroughPairs?: Snapshot["readThroughPairs"]; // undefined → omit (pre-v10 snapshot)
  } = {}): Snapshot {
    const snap: Snapshot = {
      schemaVersion: overrides.schemaVersion ?? 8,
      snapshotDate: EVENT_DATE,
      generatedAt: new Date().toISOString(),
      heldSymbols: overrides.heldSymbols ?? [],
      settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
      calendarEvents: [
        {
          id: 1,
          source_key: "finnhub:AAPL:2026-06-15",
          event_type: "earnings",
          event_date: EVENT_DATE,
          release_time: RELEASE_TIME,
          symbol: "AAPL",
          consensus_estimate: "EPS 1.50",
          security_id: null,
          actual_value: null,
          enriched_at: null,
          reaction_snapshot: null,
        },
      ],
      researchSources: [],
      recentArticlesMeta: [],
      deepReadArticles: [],
      earningsSettings: {
        enabled: overrides.enabled ?? true,
        mutedSymbols: overrides.mutedSymbols ?? [],
      },
    } as unknown as Snapshot;
    if (overrides.watchlistSymbols !== undefined) {
      (snap as unknown as { watchlistSymbols: string[] }).watchlistSymbols = overrides.watchlistSymbols;
    }
    if (overrides.readThroughPairs !== undefined) {
      snap.readThroughPairs = overrides.readThroughPairs;
    }
    return snap;
  }

  function mockCleanActual() {
    (fetchActualForEventCloud as ReturnType<typeof vi.fn>).mockResolvedValue({
      actual: "EPS 1.55",
      consensus: "EPS 1.50",
      source: "finnhub",
      deferred: false,
      reason: null,
    });
  }

  it("pushes and writes the marker when the symbol is held", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({ heldSymbols: ["AAPL"] }),
    );
    mockCleanActual();

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(sendPushover).toHaveBeenCalledTimes(1);
    const [, msg] = (sendPushover as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg.title).toBe("AAPL reported");
    expect(await readPrintPushMarker(env.CRON_KV, 1)).toBe(true);
  });

  it("does not push again when the print-push marker is already present", async () => {
    const env = makeEnv();
    await env.CRON_KV.put("print-push-1", new Date().toISOString());
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({ heldSymbols: ["AAPL"] }),
    );
    mockCleanActual();

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(sendPushover).not.toHaveBeenCalled();
  });

  it("pushes when the symbol is only on the watchlist (not held)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({ heldSymbols: [], watchlistSymbols: ["AAPL"] }),
    );
    mockCleanActual();

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(sendPushover).toHaveBeenCalledTimes(1);
  });

  it("pushes for a NON-held reporter with a live read-through pair (#13), title flagged", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({
        heldSymbols: ["PRTO"], // target held; the AAPL reporter itself is not
        watchlistSymbols: [],
        readThroughPairs: [
          { reporter: "AAPL", target: "PRTO", weight: 1.0, hypothesis: "same cycle" },
        ],
      }),
    );
    mockCleanActual();

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(sendPushover).toHaveBeenCalledTimes(1);
    const [, msg] = (sendPushover as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg.title).toBe("AAPL reported — read-through");
    expect(msg.message).toContain("→ PRTO (held): same cycle");
  });

  it("does NOT push when the pair's target is neither held nor watchlisted (#13 gate stays narrow)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({
        heldSymbols: [],
        watchlistSymbols: [],
        readThroughPairs: [
          { reporter: "AAPL", target: "GONE", weight: 1.0, hypothesis: "stale" },
        ],
      }),
    );
    mockCleanActual();

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(sendPushover).not.toHaveBeenCalled();
  });

  it("a held reporter's push carries read-through lines with the normal title", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({
        heldSymbols: ["AAPL", "TGT"],
        readThroughPairs: [{ reporter: "AAPL", target: "TGT", weight: 1.0, hypothesis: "why" }],
      }),
    );
    mockCleanActual();

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    const [, msg] = (sendPushover as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg.title).toBe("AAPL reported");
    expect(msg.message).toContain("→ TGT (held): why");
  });

  it("does not push when the symbol is in neither held nor watchlist", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({ heldSymbols: [], watchlistSymbols: [] }),
    );
    mockCleanActual();

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(sendPushover).not.toHaveBeenCalled();
  });

  it("does not push a muted symbol even though it is held", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({ heldSymbols: ["AAPL"], mutedSymbols: ["AAPL"] }),
    );
    mockCleanActual();

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(sendPushover).not.toHaveBeenCalled();
  });

  it("does not push a deferred actual (no real actual captured yet)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({ heldSymbols: ["AAPL"] }),
    );
    (fetchActualForEventCloud as ReturnType<typeof vi.fn>).mockResolvedValue({
      actual: null,
      consensus: "EPS 1.50",
      source: "finnhub",
      deferred: true,
      reason: "claude_nonfred_deferred",
    });

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(sendPushover).not.toHaveBeenCalled();
  });

  it("degrades to held-only coverage on a pre-v8 snapshot lacking watchlistSymbols (no crash)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({ heldSymbols: [], watchlistSymbols: undefined, schemaVersion: 7 }),
    );
    mockCleanActual();

    const summary = await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(summary.kind).toBe("success");
    expect(summary.failures).toBe(0);
    expect(sendPushover).not.toHaveBeenCalled(); // not held, no watchlist field present
  });

  it("v7-snapshot held symbol still pushes (watchlistSymbols absence doesn't block held coverage)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makePushSnapshot({ heldSymbols: ["AAPL"], watchlistSymbols: undefined, schemaVersion: 7 }),
    );
    mockCleanActual();

    await runCloudFallback(env, { nowMs: candidateWindowNowMs(), pacingMs: 0 });

    expect(sendPushover).toHaveBeenCalledTimes(1);
  });
});

describe("shouldRunCalendarEnrich gate (B8: 18:59 upper bound for AMC reactions)", () => {
  it("runs through 18:59 ET on a weekday", () => {
    expect(shouldRunCalendarEnrich({ hour: 18, minute: 30, dow: 3 })).toBe(true);
    expect(shouldRunCalendarEnrich({ hour: 18, minute: 59, dow: 3 })).toBe(true);
  });
  it("stops at 19:00 ET and stays weekday-only", () => {
    expect(shouldRunCalendarEnrich({ hour: 19, minute: 0, dow: 3 })).toBe(false);
    expect(shouldRunCalendarEnrich({ hour: 18, minute: 30, dow: 6 })).toBe(false);
  });
});

describe("shouldRunEarningsFallback gate (#17 T4: 20:59 upper bound for AMC wrap deadline)", () => {
  it("runs at 20:30 ET on a weekday (the 20:00 AMC wrap deadline tick must be inside the gate)", () => {
    expect(shouldRunEarningsFallback({ hour: 20, minute: 30, dow: 2 })).toBe(true);
  });
  it("runs at 20:00 and 20:59 ET on a weekday", () => {
    expect(shouldRunEarningsFallback({ hour: 20, minute: 0, dow: 2 })).toBe(true);
    expect(shouldRunEarningsFallback({ hour: 20, minute: 59, dow: 2 })).toBe(true);
  });
  it("does NOT run at 21:15 ET, and stays weekday-only", () => {
    expect(shouldRunEarningsFallback({ hour: 21, minute: 15, dow: 2 })).toBe(false);
    expect(shouldRunEarningsFallback({ hour: 20, minute: 30, dow: 6 })).toBe(false);
    expect(shouldRunEarningsFallback({ hour: 20, minute: 30, dow: 0 })).toBe(false);
  });
  it("still gates the lower bound at 05:00 ET", () => {
    expect(shouldRunEarningsFallback({ hour: 4, minute: 59, dow: 2 })).toBe(false);
    expect(shouldRunEarningsFallback({ hour: 5, minute: 0, dow: 2 })).toBe(true);
  });
});

describe("per-type candidate window (B8: earnings 12h, macro 2h)", () => {
  beforeEach(() => {
    vi.mocked(loadLatestSnapshot).mockReset();
    vi.mocked(fetchActualForEventCloud).mockReset();
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({
      actual: "EPS 1.60 · Rev 91,000,000,000",
      consensus: "EPS 1.50 · Rev 90,000,000,000",
      source: "finnhub",
    });
  });

  it("keeps an earnings row alive 5h post-release", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
    const res = await runCloudFallback(makeEnv(), { nowMs: release.getTime() + 5 * 3600_000, pacingMs: 0 });
    expect(res.kind).toBe("success");
    expect(res.candidatesProcessed).toBe(1);
  });

  it("drops a MACRO row 5h post-release (2h window unchanged)", async () => {
    const snap = makeEnrichSnapshot();
    const ev = snap.calendarEvents[0] as Record<string, unknown>;
    ev.event_type = "cpi";
    ev.source_key = "fred:10";
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snap);
    const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
    const res = await runCloudFallback(makeEnv(), { nowMs: release.getTime() + 5 * 3600_000, pacingMs: 0 });
    expect(res.kind).toBe("no_candidates");
  });

  it("drops an earnings row past 12h", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
    const res = await runCloudFallback(makeEnv(), { nowMs: release.getTime() + 13 * 3600_000, pacingMs: 0 });
    expect(res.kind).toBe("no_candidates");
  });
});

describe("retry-until-complete (B8: earnings only, Mac migration-062 mirror)", () => {
  const release = () => composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;

  beforeEach(() => {
    vi.mocked(loadLatestSnapshot).mockReset();
    vi.mocked(fetchActualForEventCloud).mockReset();
    vi.mocked(captureReactionFromYahoo).mockReset();
    vi.mocked(captureReactionFromYahoo).mockResolvedValue({ source: "yahoo" } as never);
  });

  async function seedPayload(env: ReturnType<typeof makeEnv>, payload: Record<string, unknown>) {
    await env.CRON_KV.put(cloudEnrichedKey(1), JSON.stringify(payload));
  }

  it("re-attempts an earnings payload whose actual is missing", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({
      actual: "EPS 1.60 · Rev 91,000,000,000", consensus: "EPS 1.50 · Rev 90,000,000,000", source: "finnhub",
    });
    const env = makeEnv();
    await seedPayload(env, { eventId: 1, source_key: "finnhub:AAPL:2026-06-15", actual: null, consensus: null, source: "finnhub", reaction: null, fetchedAt: new Date(release().getTime() + 10 * 60_000).toISOString() });
    const res = await runCloudFallback(env, { nowMs: release().getTime() + 3 * 3600_000, pacingMs: 0 });
    expect(res.candidatesProcessed).toBe(1);
    expect(vi.mocked(fetchActualForEventCloud)).toHaveBeenCalledTimes(1);
    const stored = JSON.parse((await env.CRON_KV.get(cloudEnrichedKey(1)))!) as Record<string, unknown>;
    expect(stored.actual).toBe("EPS 1.60 · Rev 91,000,000,000");
  });

  it("skips an earnings payload that is already complete", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    const env = makeEnv();
    await seedPayload(env, { eventId: 1, source_key: "finnhub:AAPL:2026-06-15", actual: "EPS 1.60", consensus: null, source: "finnhub", reaction: { source: "yahoo" }, fetchedAt: new Date().toISOString() });
    await runCloudFallback(env, { nowMs: release().getTime() + 3 * 3600_000, pacingMs: 0 });
    expect(vi.mocked(fetchActualForEventCloud)).not.toHaveBeenCalled();
    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
  });

  it("keeps MACRO single-shot: existing payload → untouched even if incomplete", async () => {
    const snap = makeEnrichSnapshot();
    const ev = snap.calendarEvents[0] as Record<string, unknown>;
    ev.event_type = "cpi";
    ev.source_key = "fred:10";
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snap);
    const env = makeEnv();
    await seedPayload(env, { eventId: 1, source_key: "fred:10", actual: null, consensus: null, source: "fred", reaction: null, fetchedAt: new Date().toISOString() });
    await runCloudFallback(env, { nowMs: release().getTime() + 60 * 60_000, pacingMs: 0 });
    expect(vi.mocked(fetchActualForEventCloud)).not.toHaveBeenCalled();
  });

  it("does not fetch Yahoo for an earnings row before T+115 (actual-only tick)", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({ actual: "EPS 1.60", consensus: null, source: "finnhub" });
    const env = makeEnv();
    await runCloudFallback(env, { nowMs: release().getTime() + 30 * 60_000, pacingMs: 0 });
    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
    const stored = JSON.parse((await env.CRON_KV.get(cloudEnrichedKey(1)))!) as Record<string, unknown>;
    expect(stored.actual).toBe("EPS 1.60");
    expect(stored.reaction).toBeNull();
  });

  it("still fetches Yahoo immediately for a macro row (never gated)", async () => {
    const snap = makeEnrichSnapshot();
    const ev = snap.calendarEvents[0] as Record<string, unknown>;
    ev.event_type = "cpi";
    ev.source_key = "fred:10";
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snap);
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({ actual: "3.2%", consensus: null, source: "fred" });
    const env = makeEnv();
    await runCloudFallback(env, { nowMs: release().getTime() + 30 * 60_000, pacingMs: 0 });
    expect(vi.mocked(captureReactionFromYahoo)).toHaveBeenCalledTimes(1);
  });

  it("COALESCEs on overwrite: a captured actual survives a null re-fetch", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEnrichSnapshot());
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({ actual: null, consensus: null, source: "finnhub", reason: "no_actual_yet" });
    const env = makeEnv();
    // actual present but reaction missing and settle not reached → incomplete → retried
    await seedPayload(env, { eventId: 1, source_key: "finnhub:AAPL:2026-06-15", actual: "EPS 1.60", consensus: "EPS 1.50", source: "finnhub", reaction: null, fetchedAt: new Date().toISOString() });
    vi.mocked(captureReactionFromYahoo).mockResolvedValue(null as never);
    await runCloudFallback(env, { nowMs: release().getTime() + 2 * 3600_000, pacingMs: 0 });
    const stored = JSON.parse((await env.CRON_KV.get(cloudEnrichedKey(1)))!) as Record<string, unknown>;
    expect(stored.actual).toBe("EPS 1.60"); // not erased
    expect(stored.consensus).toBe("EPS 1.50");
    // existing actual present → Finnhub fetch skipped (fetch-only-what's-missing)
    expect(vi.mocked(fetchActualForEventCloud)).not.toHaveBeenCalled();
  });
});
