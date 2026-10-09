/**
 * Worker email finder — "this phase is already handled on a sibling row".
 *
 * Mirror of the Mac's phaseHandledOnSibling
 * (lib/calendar/enrichment-runner.ts, tests/calendar/findEmailCandidates-sibling-handled.test.ts).
 *
 * One print can carry two calendar rows that are BOTH showing: a Nasdaq row
 * with a before-open slot and its Finnhub twin on the hour-unknown afternoon
 * default. Each sits in its own preview window, hours apart, and each checked
 * only its own (event, phase) audit key — so the print could get two previews.
 * A candidate is now dropped when another earnings row of the same issuer
 * family on the same event_date, showing or hidden, already has that phase
 * handled: by the Mac (snapshot earnings-email rows, or its KV markers) or by
 * the Worker itself (its cloud-sent marker).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FallbackEnv } from "../src/fallback-earnings";
import type { Snapshot } from "../src/state";

vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});

vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));

vi.mock("../src/ibkr-positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ibkr-positions")>();
  return { ...actual, fetchLiveIbkrPositionsCached: vi.fn(async () => []) };
});

import { runEarningsFallback } from "../src/fallback-earnings";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import { composeReleaseInstant } from "../src/reaction-matcher";
import { cloudEnrichedKey } from "../src/cloud-enriched";
import {
  earningsMarkerKey,
  earningsRunningKey,
} from "../src/earnings-markers";

function makeEnv(): FallbackEnv {
  const store = new Map<string, string>();
  return {
    CRON_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    BRIEFING_EMAIL_TO: "user@example.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_DOMAIN: "example.com",
  };
}

const EVENT_DATE = "2026-06-15";
const NEXT_DATE = "2026-06-16";
const MIN = 60_000;

interface RowOpts {
  id: number;
  symbol: string;
  source?: "finnhub" | "nasdaq";
  event_date?: string;
  release_time?: string;
  event_time?: string;
  superseded?: number;
  enriched_at?: string | null;
  actual_value?: string | null;
}

function row(o: RowOpts): Record<string, unknown> {
  const source = o.source ?? "finnhub";
  const date = o.event_date ?? EVENT_DATE;
  return {
    id: o.id,
    week_of: EVENT_DATE,
    event_date: date,
    event_type: "earnings",
    title: `${o.symbol} earnings`,
    description: null,
    symbol: o.symbol,
    event_time: o.event_time ?? null,
    release_time: o.release_time ?? "16:15",
    expected_impact: "high",
    source,
    source_key: `${source}:${o.symbol}:${date}`,
    raw_json: {},
    superseded: o.superseded ?? 0,
    enriched_at: o.enriched_at ?? null,
    consensus_estimate: "EPS 1.50 · Rev 90000000000",
    consensus_value: null,
    actual_value: o.actual_value ?? null,
    previous_value: null,
    reaction_snapshot: null,
  };
}

function snapshotOf(
  events: Record<string, unknown>[],
  held: string[],
  earningsEmails: Array<{ event_id: number; phase: "preview" | "recap"; error: string | null }> = [],
): Snapshot {
  return {
    schemaVersion: 2,
    snapshotDate: EVENT_DATE,
    generatedAt: new Date().toISOString(),
    heldSymbols: held,
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: events,
    earningsEmails: earningsEmails.map((r, i) => ({
      id: i + 1,
      recipient: "user@example.com",
      sent_at: `${EVENT_DATE} 09:00:00`,
      ...r,
    })),
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
  } as unknown as Snapshot;
}

/** `now` = 110 minutes before the given ET release (inside the Worker's [105,120] window). */
function previewNow(date: string, releaseTime: string): Date {
  return new Date(composeReleaseInstant(date, releaseTime)!.getTime() - 110 * MIN);
}

const sentIds = (r: Awaited<ReturnType<typeof runEarningsFallback>>, phase: string) =>
  r.details.filter((d) => d.status === "sent" && d.phase === phase).map((d) => d.eventId);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ id: "mock-email-id" } as never);
});

// ── Preview ──────────────────────────────────────────────────────────────────

describe("Worker finder — a preview handled on a sibling row", () => {
  // The reviewer's shape: Nasdaq row (id 1) before the open, Finnhub twin
  // (id 2) on the afternoon default, both showing.
  const nasdaq = () => row({ id: 1, symbol: "ZZA", source: "nasdaq", release_time: "07:00", event_time: "BMO" });
  const finnhub = () => row({ id: 2, symbol: "ZZA", source: "finnhub", release_time: "16:15" });
  const afternoon = () => previewNow(EVENT_DATE, "16:15");

  it("baseline: with nothing sent, each row is a candidate in its own window", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([nasdaq(), finnhub()], ["ZZA"]));
    const morning = await runEarningsFallback(makeEnv(), { now: previewNow(EVENT_DATE, "07:00") });
    expect(sentIds(morning, "preview")).toEqual([1]);

    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([nasdaq(), finnhub()], ["ZZA"]));
    const later = await runEarningsFallback(makeEnv(), { now: afternoon() });
    expect(sentIds(later, "preview")).toEqual([2]);
  });

  it("the Worker's own morning preview on the Nasdaq row stops the Finnhub row's afternoon preview", async () => {
    // Mac down all day: one KV store across both ticks.
    const env = makeEnv();
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([nasdaq(), finnhub()], ["ZZA"]));
    const morning = await runEarningsFallback(env, { now: previewNow(EVENT_DATE, "07:00") });
    expect(sentIds(morning, "preview")).toEqual([1]);

    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([nasdaq(), finnhub()], ["ZZA"]));
    const later = await runEarningsFallback(env, { now: afternoon() });

    expect(later.sent).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(later.details).toContainEqual(
      expect.objectContaining({ eventId: 2, phase: "preview", status: "skipped", reason: "sibling-cloud-already-sent" }),
    );
    // No marker for the dropped row: nothing was sent for it.
    expect(await env.CRON_KV.get(earningsMarkerKey("cloud", "preview", 2))).toBeNull();
  });

  it("the Mac's preview on the sibling, shipped in the snapshot -> no candidate", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([nasdaq(), finnhub()], ["ZZA"], [{ event_id: 1, phase: "preview", error: null }]),
    );
    const res = await runEarningsFallback(makeEnv(), { now: afternoon() });
    expect(res.sent).toBe(0);
    expect(res.swept).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 2, phase: "preview", status: "skipped", reason: "handled-on-sibling" }),
    );
  });

  it("a sent-by-cloud or delivery_unknown row on the sibling blocks too", async () => {
    for (const error of ["sent-by-cloud", "delivery_unknown"]) {
      vi.mocked(loadLatestSnapshot).mockResolvedValue(
        snapshotOf([nasdaq(), finnhub()], ["ZZA"], [{ event_id: 1, phase: "preview", error }]),
      );
      const res = await runEarningsFallback(makeEnv(), { now: afternoon() });
      expect(res.sent, error).toBe(0);
    }
  });

  it("a stale live claim on the sibling in the 2am snapshot does NOT block (same rule the row applies to itself)", async () => {
    for (const error of ["in_progress", "sending"]) {
      vi.mocked(loadLatestSnapshot).mockResolvedValue(
        snapshotOf([nasdaq(), finnhub()], ["ZZA"], [{ event_id: 1, phase: "preview", error }]),
      );
      const res = await runEarningsFallback(makeEnv(), { now: afternoon() });
      expect(sentIds(res, "preview"), error).toEqual([2]);
    }
  });

  it("the Mac's sent marker on the sibling -> no candidate", async () => {
    const env = makeEnv();
    await env.CRON_KV.put(earningsMarkerKey("mac", "preview", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([nasdaq(), finnhub()], ["ZZA"]));
    const res = await runEarningsFallback(env, { now: afternoon() });
    expect(res.sent).toBe(0);
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 2, reason: "sibling-mac-already-sent" }),
    );
  });

  it("a Mac send in progress on the sibling (running marker) -> no candidate", async () => {
    const env = makeEnv();
    await env.CRON_KV.put(earningsRunningKey("preview", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([nasdaq(), finnhub()], ["ZZA"]));
    const res = await runEarningsFallback(env, { now: afternoon() });
    expect(res.sent).toBe(0);
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 2, reason: "sibling-mac-running" }),
    );
  });

  it("a HIDDEN sibling that carries the preview still blocks", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf(
        [{ ...nasdaq(), superseded: 1 }, finnhub()],
        ["ZZA"],
        [{ event_id: 1, phase: "preview", error: null }],
      ),
    );
    const res = await runEarningsFallback(makeEnv(), { now: afternoon() });
    expect(res.sent).toBe(0);

    // ...and by marker as well.
    const env = makeEnv();
    await env.CRON_KV.put(earningsMarkerKey("cloud", "preview", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([{ ...nasdaq(), superseded: 1 }, finnhub()], ["ZZA"]),
    );
    const res2 = await runEarningsFallback(env, { now: afternoon() });
    expect(res2.sent).toBe(0);
  });

  it("a share-class sibling (GOOG preview sent, GOOGL row in window) -> no candidate", async () => {
    const goog = row({ id: 1, symbol: "GOOG", source: "nasdaq", release_time: "07:00" });
    const googl = row({ id: 2, symbol: "GOOGL", release_time: "16:15" });
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([goog, googl], ["GOOGL"], [{ event_id: 1, phase: "preview", error: null }]),
    );
    const res = await runEarningsFallback(makeEnv(), { now: afternoon() });
    expect(res.sent).toBe(0);

    const env = makeEnv();
    await env.CRON_KV.put(earningsMarkerKey("cloud", "preview", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([goog, googl], ["GOOGL"]));
    const res2 = await runEarningsFallback(env, { now: afternoon() });
    expect(res2.sent).toBe(0);
  });

  it("symbol case does not matter when matching the sibling", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf(
        [{ ...nasdaq(), symbol: "zza" }, finnhub()],
        ["ZZA"],
        [{ event_id: 1, phase: "preview", error: null }],
      ),
    );
    const res = await runEarningsFallback(makeEnv(), { now: afternoon() });
    expect(res.sent).toBe(0);
  });

  it("a different DATE for the same symbol still gets its own preview", async () => {
    const earlier = row({ id: 1, symbol: "ZZA", release_time: "07:00" });
    const nextDay = row({ id: 2, symbol: "ZZA", event_date: NEXT_DATE, release_time: "16:15" });
    const env = makeEnv();
    await env.CRON_KV.put(earningsMarkerKey("cloud", "preview", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([earlier, nextDay], ["ZZA"], [{ event_id: 1, phase: "preview", error: null }]),
    );
    const res = await runEarningsFallback(env, { now: previewNow(NEXT_DATE, "16:15") });
    expect(sentIds(res, "preview")).toEqual([2]);
  });

  it("another company's preview on the same date does not block", async () => {
    const other = row({ id: 1, symbol: "ZZB", release_time: "07:00" });
    const env = makeEnv();
    await env.CRON_KV.put(earningsMarkerKey("cloud", "preview", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([other, finnhub()], ["ZZA", "ZZB"], [{ event_id: 1, phase: "preview", error: null }]),
    );
    const res = await runEarningsFallback(env, { now: afternoon() });
    expect(sentIds(res, "preview")).toEqual([2]);
  });

  it("a sibling's RECAP does not block a preview (phases are separate)", async () => {
    const env = makeEnv();
    await env.CRON_KV.put(earningsMarkerKey("cloud", "recap", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([nasdaq(), finnhub()], ["ZZA"], [{ event_id: 1, phase: "recap", error: null }]),
    );
    const res = await runEarningsFallback(env, { now: afternoon() });
    expect(sentIds(res, "preview")).toEqual([2]);
  });

  it("a row with no sibling reads no extra markers (three KV reads for its own keys only)", async () => {
    const env = makeEnv();
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([finnhub()], ["ZZA"]));
    await runEarningsFallback(env, { now: afternoon() });
    const markerReads = vi
      .mocked(env.CRON_KV.get)
      .mock.calls.map((c) => String(c[0]))
      .filter((k) => k.includes("-earnings-preview-"));
    expect(markerReads.sort()).toEqual(
      [
        earningsMarkerKey("mac", "preview", 2),
        earningsMarkerKey("cloud", "preview", 2),
        earningsRunningKey("preview", 2),
      ].sort(),
    );
  });
});

// ── Recap ────────────────────────────────────────────────────────────────────

describe("Worker finder — a recap handled on a sibling row", () => {
  const ACTUAL = "EPS 1.60 · Rev 92000000000";
  const release = () => composeReleaseInstant(EVENT_DATE, "07:00")!;
  const now = () => new Date(release().getTime() + 180 * MIN);
  const enrichedAt = () =>
    new Date(release().getTime() + 150 * MIN).toISOString().replace("T", " ").slice(0, 19);

  /** Road 1: the snapshot shows the row enriched with an actual. */
  const enriched = (id: number, symbol = "ZZA", event_date = EVENT_DATE) =>
    row({ id, symbol, event_date, release_time: "07:00", enriched_at: enrichedAt(), actual_value: ACTUAL });
  const twin = (id: number, symbol = "ZZA", event_date = EVENT_DATE) =>
    row({ id, symbol, source: "nasdaq", event_date, release_time: "07:00" });

  it("baseline: with nothing sent the enriched row is a recap candidate", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([twin(1), enriched(2)], ["ZZA"]));
    const res = await runEarningsFallback(makeEnv(), { now: now() });
    expect(sentIds(res, "recap")).toEqual([2]);
  });

  it("the sibling row already has its recap in the snapshot -> no candidate", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([twin(1), enriched(2)], ["ZZA"], [{ event_id: 1, phase: "recap", error: null }]),
    );
    const res = await runEarningsFallback(makeEnv(), { now: now() });
    expect(res.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 2, phase: "recap", status: "skipped", reason: "handled-on-sibling" }),
    );
  });

  it("the Worker's own recap marker on the sibling -> no candidate", async () => {
    const env = makeEnv();
    await env.CRON_KV.put(earningsMarkerKey("cloud", "recap", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([twin(1), enriched(2)], ["ZZA"]));
    const res = await runEarningsFallback(env, { now: now() });
    expect(res.sent).toBe(0);
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 2, phase: "recap", reason: "sibling-cloud-already-sent" }),
    );
  });

  it("two showing rows that are both recap candidates in one tick send ONE recap", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([enriched(1), enriched(2)], ["ZZA"]));
    const res = await runEarningsFallback(makeEnv(), { now: now() });
    expect(res.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a share-class sibling's recap blocks too", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([twin(1, "GOOG"), enriched(2, "GOOGL")], ["GOOGL"], [{ event_id: 1, phase: "recap", error: null }]),
    );
    const res = await runEarningsFallback(makeEnv(), { now: now() });
    expect(res.sent).toBe(0);
  });

  it("a sibling's PREVIEW does not block the recap", async () => {
    const env = makeEnv();
    await env.CRON_KV.put(earningsMarkerKey("cloud", "preview", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([twin(1), enriched(2)], ["ZZA"], [{ event_id: 1, phase: "preview", error: null }]),
    );
    const res = await runEarningsFallback(env, { now: now() });
    expect(sentIds(res, "recap")).toEqual([2]);
  });

  it("a recap on a different DATE for the same symbol does not block", async () => {
    const env = makeEnv();
    await env.CRON_KV.put(earningsMarkerKey("cloud", "recap", 1), "x");
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([twin(1, "ZZA", "2026-06-12"), enriched(2)], ["ZZA"], [{ event_id: 1, phase: "recap", error: null }]),
    );
    const res = await runEarningsFallback(env, { now: now() });
    expect(sentIds(res, "recap")).toEqual([2]);
  });

  it("the same-day KV road is covered too: sibling recap in the snapshot -> no probe, no candidate", async () => {
    // Row 2 has no enriched_at in the snapshot; its actual sits in a complete
    // cloud-enriched payload written today.
    const pending = row({ id: 2, symbol: "ZZA", release_time: "07:00" });
    const env = makeEnv();
    await env.CRON_KV.put(
      cloudEnrichedKey(2),
      JSON.stringify({
        eventId: 2,
        source_key: "finnhub:ZZA:2026-06-15",
        actual: ACTUAL,
        consensus: null,
        source: "finnhub",
        reaction: { source: "yahoo", spy: { t_pre: 500, t_post: 505, delta_pct: 1 } },
        fetchedAt: new Date(release().getTime() + 170 * MIN).toISOString(),
      }),
    );
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf([twin(1), pending], ["ZZA"]));
    const base = await runEarningsFallback(env, { now: now(), dryRun: true });
    expect(sentIds(base, "recap")).toEqual([2]);

    vi.mocked(env.CRON_KV.get).mockClear();
    vi.mocked(loadLatestSnapshot).mockResolvedValue(
      snapshotOf([twin(1), pending], ["ZZA"], [{ event_id: 1, phase: "recap", error: null }]),
    );
    const res = await runEarningsFallback(env, { now: now(), dryRun: true });
    expect(res.sent).toBe(0);
    const probed = vi.mocked(env.CRON_KV.get).mock.calls.map((c) => String(c[0]));
    expect(probed).not.toContain(cloudEnrichedKey(2));
  });
});
