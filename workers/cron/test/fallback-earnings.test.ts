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

// Mock ONLY the network fetch in ibkr-positions; the pure transforms (merge,
// family filter) stay real so the test exercises the actual combine logic.
vi.mock("../src/ibkr-positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ibkr-positions")>();
  return { ...actual, fetchLiveIbkrPositions: vi.fn() };
});

import { runEarningsFallback } from "../src/fallback-earnings";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import { composeReleaseInstant } from "../src/reaction-matcher";
import { fetchLiveIbkrPositions } from "../src/ibkr-positions";

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

describe("runEarningsFallback Tier 3 live-IBKR position refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  function htmlOfLastSend(): string {
    const calls = (sendEmail as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][1].html as string;
  }

  /** Snapshot carrying a STALE IBKR AAPL holding (999 sh) + DB join rows. */
  function snapshotWithStaleIbkr(): Snapshot {
    const snap = makeEarningsSnapshot();
    (snap as unknown as Snapshot).accounts = [{ id: 3, name: "IBKR" }];
    (snap as unknown as Snapshot).securities = [
      {
        id: 10,
        symbol: "AAPL",
        name: "Apple",
        security_type: "stock",
        asset_class: "STK",
        sector: null,
        underlying_symbol: null,
        option_type: null,
        strike_price: null,
        expiration_date: null,
        multiplier: null,
      },
    ];
    (snap as unknown as Snapshot).holdings = [
      { id: 1, account_id: 3, security_id: 10, quantity: 999, cost_basis: 99999, as_of_date: EVENT_DATE },
    ];
    return snap;
  }

  const IBKR_ENV: Partial<FallbackEnv> = {
    IBKR_CONSUMER_KEY: "QAJVIHZHI",
    IBKR_ACCESS_TOKEN: "tok",
    IBKR_PREPEND: "deadbeef",
    IBKR_DH_PRIME: "00cb",
    IBKR_SIGNATURE_KEY_PKCS8: "cGtjczg=",
  };

  it("replaces the stale snapshot IBKR row with the live position", async () => {
    const env = makeEnv(IBKR_ENV);
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithStaleIbkr());
    (fetchLiveIbkrPositions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { symbol: "AAPL", securityType: "Stock", underlyingSymbol: null, optionType: null, strikePrice: null, expirationDate: null, multiplier: null, quantity: 100, costBasis: 15000, mktPrice: 180 },
    ]);

    const result = await runEarningsFallback(env, { now: previewWindowNow() });
    expect(result.sent).toBe(1);

    const html = htmlOfLastSend();
    expect(html).toContain("100 sh"); // live quantity
    expect(html).not.toContain("999"); // stale snapshot row gone
    expect(html).toContain("IBKR live"); // provenance disclosed
  });

  it("falls back to the stale snapshot position when the live fetch throws", async () => {
    const env = makeEnv(IBKR_ENV);
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithStaleIbkr());
    (fetchLiveIbkrPositions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IBKR down"));

    const result = await runEarningsFallback(env, { now: previewWindowNow() });
    expect(result.sent).toBe(1); // email still ships — best-effort

    const html = htmlOfLastSend();
    expect(html).toContain("999"); // degraded to snapshot
    expect(html).not.toContain("IBKR live");
  });

  it("does not attempt a live fetch when IBKR is not configured", async () => {
    const env = makeEnv(); // no IBKR_* vars
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithStaleIbkr());

    const result = await runEarningsFallback(env, { now: previewWindowNow() });
    expect(result.sent).toBe(1);
    expect(fetchLiveIbkrPositions).not.toHaveBeenCalled();
  });
});
