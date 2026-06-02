/**
 * Tests for workers/cron/src/fallback-earnings.ts
 *
 * Focus: the observability guard added 2026-05-31 — a candidate whose send
 * throws must increment `failed` AND populate `lastError` so an all-fail run is
 * diagnosable instead of returning a bare count. (Sibling of fallback-digest's
 * listErrors/articleErrors/lastError pattern.)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FallbackEnv } from "../src/fallback-earnings";
import type { Snapshot } from "../src/state";

// ── Dependency mocks ─────────────────────────────────────────────────────────

vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});

vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));

import { runEarningsFallback } from "../src/fallback-earnings";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import { composeReleaseInstant } from "../src/reaction-matcher";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<FallbackEnv> = {}): FallbackEnv {
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
    RESEND_FROM_DOMAIN: "myportfoliodesk.com",
    ...overrides,
  };
}

const EVENT_DATE = "2026-06-15";
const RELEASE_TIME = "16:00";

/** Snapshot with one held earnings event whose release is at EVENT_DATE/RELEASE_TIME. */
function makeEarningsSnapshot(): Snapshot {
  return {
    schemaVersion: 2,
    snapshotDate: EVENT_DATE,
    generatedAt: new Date().toISOString(),
    heldSymbols: ["AAPL"],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: [
      {
        id: 1,
        week_of: EVENT_DATE,
        event_date: EVENT_DATE,
        event_type: "earnings",
        title: "AAPL earnings",
        description: null,
        symbol: "AAPL",
        event_time: "AMC",
        release_time: RELEASE_TIME,
        expected_impact: "high",
        source: "finnhub",
        source_key: "finnhub:AAPL:2026-06-15",
        raw_json: {},
        enriched_at: null,
        consensus_estimate: "EPS 1.50 · Rev 90B",
        consensus_value: null,
        actual_value: null,
        previous_value: null,
        reaction_snapshot: null,
      },
    ],
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
  } as unknown as Snapshot;
}

/** `now` placed inside the preview window (105–135 min before release). */
function previewWindowNow(): Date {
  const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME);
  if (!release) throw new Error("composeReleaseInstant returned null in test setup");
  return new Date(release.getTime() - 120 * 60 * 1000);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runEarningsFallback observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations — re-establish the success default so
    // the failure test's mockRejectedValue can't leak into the clean-send test.
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  it("populates lastError and counts the failure when the only candidate's send throws", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEarningsSnapshot(),
    );
    (sendEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("402 insufficient credits"),
    );

    const result = await runEarningsFallback(env, { now: previewWindowNow() });

    expect(result.swept).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.lastError).toMatch(/402 insufficient credits/);
    expect(result.details[0].status).toBe("failed");
    expect(result.details[0].reason).toMatch(/402 insufficient credits/);
  });

  it("leaves lastError undefined on a clean send", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEarningsSnapshot(),
    );
    // sendEmail default mock resolves successfully.

    const result = await runEarningsFallback(env, { now: previewWindowNow() });

    expect(result.swept).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.lastError).toBeUndefined();
  });

  it("no candidates → swept 0, no lastError", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEarningsSnapshot(),
    );
    // `now` far outside the preview window → no candidate.
    const result = await runEarningsFallback(env, { now: new Date("2026-01-01T00:00:00Z") });

    expect(result.swept).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.lastError).toBeUndefined();
  });
});

describe("runEarningsFallback v5 context (notes + bogeys)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  function htmlOfLastSend(): string {
    const calls = (sendEmail as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][1].html as string;
  }

  it("renders the user's prior notes + curated bogeys into the cloud email", async () => {
    const snap = makeEarningsSnapshot();
    (snap as unknown as Snapshot).schemaVersion = 5;
    (snap as unknown as Snapshot).notes = [
      {
        id: 7,
        note_type: "trade_thesis",
        content: "Long AAPL into the print — Services margin is the swing factor.",
        event_date: "2026-06-10",
        sentiment: "bullish",
        tags: "thesis",
        symbol: "AAPL",
        underlying_symbol: null,
      },
    ];
    (snap as unknown as Snapshot).earningsBogeys = [
      {
        id: 3,
        event_id: 1,
        source: "pdf_upload",
        source_label: "TMT Breakout 2026-06-14 weekly preview",
        eps_consensus: 1.5,
        eps_whisper: 1.58,
        revenue_consensus_usd: 90_000_000_000,
        revenue_whisper_usd: 92_000_000_000,
        segment_breakdown_json: null,
        guidance_notes: "Watch FY guide on Services",
        notes: null,
        uploaded_at: "2026-06-14 12:00:00",
      },
    ];
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);

    const result = await runEarningsFallback(env, { now: previewWindowNow() });
    expect(result.sent).toBe(1);

    const html = htmlOfLastSend();
    // Note content surfaces
    expect(html).toContain("Services margin is the swing factor");
    // Bogey source + whisper surface (the whole point — Finnhub lacks whispers)
    expect(html).toContain("TMT Breakout 2026-06-14 weekly preview");
    expect(html).toContain("1.58");
  });

  it("renders fine when notes/bogeys are absent (back-compat with v2 snapshot)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEarningsSnapshot(), // v2, no notes/earningsBogeys fields
    );
    const result = await runEarningsFallback(env, { now: previewWindowNow() });
    expect(result.sent).toBe(1);
  });
});
