/**
 * Reaction-only follow-up for MACRO rows on the Worker (2026-10-08).
 *
 * A macro payload is single-shot and is written minutes after the release,
 * before the reaction can be measured (release + 120 minutes). The macro
 * candidate window closes at that same instant, so with the Mac down the row
 * never got a reaction. The follow-up comes back for it between release + 120
 * and release + 150 minutes and writes ONLY the reaction.
 *
 * Mirror of the Mac's runReactionFollowUp
 * (lib/calendar/enrichment-runner.ts, tests/calendar/enrichment-runner-reaction-window.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EnrichRunEnv } from "../src/calendar-enrich";
import type { Snapshot } from "../src/state";

vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});

vi.mock("../src/enrich-actuals", () => ({
  fetchActualForEventCloud: vi.fn(),
}));

vi.mock("../src/yahoo", () => ({
  captureReactionFromYahoo: vi.fn(),
}));

vi.mock("../src/pushover", () => ({
  sendPushover: vi.fn(async () => ({ sent: true, requestId: "req-1" })),
}));

import { runCloudFallback } from "../src/calendar-enrich";
import { loadLatestSnapshot } from "../src/state";
import { fetchActualForEventCloud } from "../src/enrich-actuals";
import { composeReleaseInstant } from "../src/reaction-matcher";
import { captureReactionFromYahoo } from "../src/yahoo";
import { sendPushover } from "../src/pushover";
import { cloudEnrichedKey } from "../src/cloud-enriched";

function makeEnv(): EnrichRunEnv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    CRON_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    CRON_SHARED_SECRET: "secret",
    MESH_HOSTNAME: "http://mesh.local",
    CLOUD_ENRICH_ENABLED: "true",
    FRED_API_KEY: "fred-key",
    FINNHUB_API_KEY: "finnhub-key",
  };
}

const EVENT_DATE = "2026-06-15";
const RELEASE_TIME = "10:00";
const MIN = 60_000;

function macroEvent(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source_key: `fred:${id}`,
    event_type: "cpi",
    event_date: EVENT_DATE,
    release_time: RELEASE_TIME,
    symbol: null,
    consensus_estimate: null,
    security_id: null,
    actual_value: null,
    enriched_at: null,
    reaction_snapshot: null,
    ...overrides,
  };
}

function earningsEvent(id: number) {
  return {
    id,
    source_key: "finnhub:ZZA:2026-06-15",
    event_type: "earnings",
    event_date: EVENT_DATE,
    release_time: RELEASE_TIME,
    symbol: "ZZA",
    consensus_estimate: "EPS 1.50 · Rev 90B",
    security_id: null,
    actual_value: null,
    enriched_at: null,
    reaction_snapshot: null,
  };
}

function snapshotOf(events: unknown[]): Snapshot {
  return {
    schemaVersion: 3,
    snapshotDate: EVENT_DATE,
    generatedAt: new Date().toISOString(),
    heldSymbols: [],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: events,
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
  } as unknown as Snapshot;
}

const release = () => composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
const at = (minutes: number) => release().getTime() + minutes * MIN;

/** The payload the main pass writes for a macro row a few minutes after release. */
function earlyMacroPayload(id: number, overrides: Record<string, unknown> = {}) {
  return {
    eventId: id,
    source_key: `fred:${id}`,
    actual: "3.2%",
    consensus: "3.1%",
    source: "fred",
    reason: "kept-as-written",
    reaction: null,
    fetchedAt: new Date(at(5)).toISOString(),
    ...overrides,
  };
}

async function seed(env: EnrichRunEnv, id: number, payload: Record<string, unknown>) {
  await env.CRON_KV.put(cloudEnrichedKey(id), JSON.stringify(payload));
}

function stored(env: ReturnType<typeof makeEnv>, id: number): Record<string, unknown> {
  return JSON.parse(env.store.get(cloudEnrichedKey(id))!) as Record<string, unknown>;
}

const YAHOO_REACTION = {
  t0_utc: "2026-06-15T14:00:00.000Z",
  window_min: 120,
  source: "yahoo",
  spy: { t_pre: 500, t_post: 505, delta_pct: 1 },
};

describe("macro reaction-only follow-up (Mac down)", () => {
  beforeEach(() => {
    vi.mocked(loadLatestSnapshot).mockReset();
    vi.mocked(fetchActualForEventCloud).mockReset();
    vi.mocked(captureReactionFromYahoo).mockReset();
    vi.mocked(captureReactionFromYahoo).mockResolvedValue(YAHOO_REACTION as never);
    vi.mocked(sendPushover).mockClear();
  });

  it("writes nothing before release + 120 minutes", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1));
    const before = env.store.get(cloudEnrichedKey(1));

    await runCloudFallback(env, { nowMs: at(119), pacingMs: 0 });

    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
    expect(env.store.get(cloudEnrichedKey(1))).toBe(before);
  });

  it("captures the reaction once inside the window and stamps the capture time", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1));

    const res = await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(vi.mocked(captureReactionFromYahoo)).toHaveBeenCalledTimes(1);
    // Macro: no event symbol, no prior-close anchor.
    const [instant, , captureOpts] = vi.mocked(captureReactionFromYahoo).mock.calls[0];
    expect((instant as Date).getTime()).toBe(release().getTime());
    expect(captureOpts).toMatchObject({ pacingMs: 0, eventSymbol: null, earningsCloseMs: null });
    expect(stored(env, 1).reaction).toEqual({
      ...YAHOO_REACTION,
      captured_at: new Date(at(135)).toISOString(),
    });
    expect(res.kind).toBe("success");
    expect(res.reactionFollowUps).toBe(1);
    expect(res.failures).toBe(0);
  });

  it("also runs at exactly release + 120 minutes (the main pass skips an existing macro payload)", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1));

    await runCloudFallback(env, { nowMs: at(120), pacingMs: 0 });

    expect(vi.mocked(captureReactionFromYahoo)).toHaveBeenCalledTimes(1);
    expect((stored(env, 1).reaction as Record<string, unknown>).captured_at).toBe(
      new Date(at(120)).toISOString(),
    );
  });

  it("leaves every other field of the payload byte-identical, and fetches no actual", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();
    const seeded = earlyMacroPayload(1);
    await seed(env, 1, seeded);

    await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(vi.mocked(fetchActualForEventCloud)).not.toHaveBeenCalled();
    const after = stored(env, 1);
    // Same keys in the same order; only `reaction` differs.
    expect(Object.keys(after)).toEqual(Object.keys(seeded));
    expect(JSON.stringify({ ...after, reaction: null })).toBe(JSON.stringify(seeded));
    expect(after.fetchedAt).toBe(seeded.fetchedAt);
    expect(sendPushover).not.toHaveBeenCalled();
  });

  it("a deferred payload (actual left for the Mac) gets its reaction too, still deferred", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([macroEvent(1, { source_key: "nonfred:ism", event_type: "ism" })]),
    );
    const env = makeEnv();
    const seeded = earlyMacroPayload(1, {
      source_key: "nonfred:ism",
      actual: null,
      consensus: null,
      source: "claude",
      deferred: true,
      reason: "claude_deferred_to_mac",
    });
    await seed(env, 1, seeded);

    await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    const after = stored(env, 1);
    expect(after.deferred).toBe(true);
    expect(after.actual).toBeNull();
    expect(after.reason).toBe("claude_deferred_to_mac");
    expect((after.reaction as Record<string, unknown>).source).toBe("yahoo");
  });

  it("does not come back on the next tick once the reaction is stored", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1));

    await runCloudFallback(env, { nowMs: at(120), pacingMs: 0 });
    const afterFirst = env.store.get(cloudEnrichedKey(1));
    await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(vi.mocked(captureReactionFromYahoo)).toHaveBeenCalledTimes(1);
    expect(env.store.get(cloudEnrichedKey(1))).toBe(afterFirst);
  });

  it("an empty capture writes nothing; the next tick in the window tries once more", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1));
    const before = env.store.get(cloudEnrichedKey(1));
    vi.mocked(captureReactionFromYahoo).mockResolvedValueOnce(null as never);

    await runCloudFallback(env, { nowMs: at(120), pacingMs: 0 });
    expect(env.store.get(cloudEnrichedKey(1))).toBe(before);

    await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });
    expect(vi.mocked(captureReactionFromYahoo)).toHaveBeenCalledTimes(2);
    expect((stored(env, 1).reaction as Record<string, unknown>).captured_at).toBe(
      new Date(at(135)).toISOString(),
    );
  });

  it("stops at release + 150 minutes: no capture, no write, no retry", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1));
    const before = env.store.get(cloudEnrichedKey(1));

    for (const minutes of [150, 151, 165, 300]) {
      const res = await runCloudFallback(env, { nowMs: at(minutes), pacingMs: 0 });
      expect(res.kind).toBe("no_candidates");
    }

    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
    expect(env.store.get(cloudEnrichedKey(1))).toBe(before);
  });

  it("no payload in KV (the Mac consumed it, or none was written): nothing is created", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();

    const res = await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchActualForEventCloud)).not.toHaveBeenCalled();
    expect(env.store.has(cloudEnrichedKey(1))).toBe(false);
    expect(res.kind).toBe("no_candidates");
  });

  it("a payload with neither an actual nor a deferral is left alone", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1, { actual: null, consensus: null, reason: "fred_error" }));
    const before = env.store.get(cloudEnrichedKey(1));

    await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
    expect(env.store.get(cloudEnrichedKey(1))).toBe(before);
  });

  it("never touches a payload that already holds a reaction", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1, { reaction: { source: "yahoo", captured_at: "2026-06-15T16:00:00.000Z" } }));
    const before = env.store.get(cloudEnrichedKey(1));

    await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
    expect(env.store.get(cloudEnrichedKey(1))).toBe(before);
  });

  it("skips a superseded row and a row the snapshot already shows enriched", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([
        macroEvent(1, { superseded: 1 }),
        macroEvent(2, { enriched_at: "2026-06-15 14:05:00" }),
      ]),
    );
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1));
    await seed(env, 2, earlyMacroPayload(2));

    await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(vi.mocked(captureReactionFromYahoo)).not.toHaveBeenCalled();
  });

  it("earnings rows are unaffected: the follow-up never picks one up", async () => {
    // Complete-by-actual earnings payload with no reaction, in the 120-150 band.
    // The earnings road (retry-until-complete) owns it; with the capture empty
    // the payload must be re-written by THAT road only (fetchedAt refreshed),
    // never by a reaction-only write.
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([earningsEvent(7)]));
    vi.mocked(captureReactionFromYahoo).mockResolvedValue(null as never);
    const env = makeEnv();
    await seed(env, 7, {
      eventId: 7,
      source_key: "finnhub:ZZA:2026-06-15",
      actual: "EPS 1.60",
      consensus: "EPS 1.50",
      source: "finnhub",
      reaction: null,
      fetchedAt: new Date(at(30)).toISOString(),
    });

    const res = await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    // One capture attempt — the earnings road's own, with its earnings options.
    expect(vi.mocked(captureReactionFromYahoo)).toHaveBeenCalledTimes(1);
    const [, , captureOpts] = vi.mocked(captureReactionFromYahoo).mock.calls[0];
    expect(captureOpts).toMatchObject({ eventSymbol: "ZZA" });
    expect((captureOpts as { earningsCloseMs: number | null }).earningsCloseMs).not.toBeNull();
    expect(res.candidatesProcessed).toBe(1);
    expect(res.reactionFollowUps ?? 0).toBe(0);
  });

  it("shares the per-tick candidate limit with the main pass", async () => {
    // Ten earnings rows fill the main pass; the macro follow-up waits a tick.
    const earnings = Array.from({ length: 10 }, (_, i) => ({
      ...earningsEvent(100 + i),
      source_key: `finnhub:ZZ${i}:2026-06-15`,
      symbol: `ZZ${i}`,
    }));
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([...earnings, macroEvent(1)]));
    vi.mocked(fetchActualForEventCloud).mockResolvedValue({ actual: null, consensus: null, source: "finnhub", reason: "no_actual_yet" });
    vi.mocked(captureReactionFromYahoo).mockResolvedValue(null as never);
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1));
    const before = env.store.get(cloudEnrichedKey(1));

    const res = await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(res.candidatesProcessed).toBe(10);
    expect(env.store.get(cloudEnrichedKey(1))).toBe(before);
    expect(vi.mocked(captureReactionFromYahoo)).toHaveBeenCalledTimes(10);
  });

  it("caps the follow-up itself at the per-tick limit", async () => {
    const macros = Array.from({ length: 12 }, (_, i) => macroEvent(i + 1));
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(macros));
    const env = makeEnv();
    for (const m of macros) await seed(env, m.id, earlyMacroPayload(m.id));

    const res = await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(vi.mocked(captureReactionFromYahoo)).toHaveBeenCalledTimes(10);
    expect(res.reactionFollowUps).toBe(10);
  });

  it("a capture that throws is counted as a failure and leaves the payload as it was", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([macroEvent(1)]));
    vi.mocked(captureReactionFromYahoo).mockRejectedValue(new Error("yahoo 503"));
    const env = makeEnv();
    await seed(env, 1, earlyMacroPayload(1));
    const before = env.store.get(cloudEnrichedKey(1));

    const res = await runCloudFallback(env, { nowMs: at(135), pacingMs: 0 });

    expect(res.failures).toBe(1);
    expect(res.lastError).toMatch(/yahoo 503/);
    expect(env.store.get(cloudEnrichedKey(1))).toBe(before);
  });
});
