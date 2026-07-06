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

// Mock ONLY the cached network fetch in ibkr-positions; the pure transforms
// (merge, family filter) stay real so the test exercises the actual combine logic.
vi.mock("../src/ibkr-positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ibkr-positions")>();
  return { ...actual, fetchLiveIbkrPositionsCached: vi.fn() };
});

import { runEarningsFallback, renderPositions, type PositionView } from "../src/fallback-earnings";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import { composeReleaseInstant } from "../src/reaction-matcher";
import { fetchLiveIbkrPositionsCached } from "../src/ibkr-positions";

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

/** `now` placed inside the Worker's preview window (105–120 min before release). */
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

describe("runEarningsFallback Mac-first preview window (final-review fix pass)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  /** `now` placed `minutesOut` minutes before release. */
  function nowMinutesBeforeRelease(minutesOut: number): Date {
    const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME);
    if (!release) throw new Error("composeReleaseInstant returned null in test setup");
    return new Date(release.getTime() - minutesOut * 60 * 1000);
  }

  it("an event 130min out is NOT a Worker candidate (Mac-exclusive [120,135] band)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEarningsSnapshot(),
    );

    const result = await runEarningsFallback(env, { now: nowMinutesBeforeRelease(130) });

    expect(result.swept).toBe(0);
    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("an event 115min out IS a Worker candidate (inside the narrowed [105,120] window)", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEarningsSnapshot(),
    );

    const result = await runEarningsFallback(env, { now: nowMinutesBeforeRelease(115) });

    expect(result.swept).toBe(1);
    expect(result.sent).toBe(1);
  });
});

describe("runEarningsFallback claim-aware dedup (final-review fix pass)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  it("does NOT skip a candidate whose only snapshot audit row is a live 'in_progress' claim", async () => {
    const snap = makeEarningsSnapshot();
    (snap as unknown as Snapshot).earningsEmails = [
      {
        id: 1,
        event_id: 1,
        phase: "preview",
        recipient: "user@example.com",
        sent_at: "2026-06-15 12:00:00",
        error: "in_progress",
      },
    ];
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);

    const result = await runEarningsFallback(env, { now: previewWindowNow() });

    // A claim isn't a send — the Worker must still see this as a candidate
    // and fire its own fallback (subject to the KV marker check, which is
    // separate from this snapshot-derived audited set).
    expect(result.swept).toBe(1);
    expect(result.sent).toBe(1);
  });

  it("DOES skip a candidate with a completed local send (error IS NULL) in the snapshot", async () => {
    const snap = makeEarningsSnapshot();
    (snap as unknown as Snapshot).earningsEmails = [
      {
        id: 1,
        event_id: 1,
        phase: "preview",
        recipient: "user@example.com",
        sent_at: "2026-06-15 12:00:00",
        error: null,
      },
    ];
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap);

    const result = await runEarningsFallback(env, { now: previewWindowNow() });

    expect(result.swept).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
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

describe("renderPositions privacy (presence-only, no cost-basis leak)", () => {
  it("never emits exact cost basis for a stock; shows presence + return % when priced", () => {
    const views: PositionView[] = [
      {
        account_name: "IBKR",
        symbol: "AAPL",
        security_type: "stock",
        underlying_symbol: null,
        option_type: null,
        strike_price: null,
        expiration_date: null,
        multiplier: null,
        quantity: 100,
        cost_basis: 18300, // $183/sh
        latest_price: 205, // → +12.0%
      },
    ];
    const out = renderPositions(views, "AAPL", ["AAPL"], true);
    expect(out).not.toContain("18300");
    expect(out).not.toContain("18,300");
    expect(out).not.toMatch(/cost basis/i);
    expect(out).toContain("100 sh AAPL");
    expect(out).toContain("up ~"); // priced live row → return % present
  });

  it("never emits total cost for an option position", () => {
    const views: PositionView[] = [
      {
        account_name: "IBKR",
        symbol: "AAPL  260619C00145000",
        security_type: "option",
        underlying_symbol: "AAPL",
        option_type: "CALL",
        strike_price: 145,
        expiration_date: "2026-06-19",
        multiplier: 100,
        quantity: 3,
        cost_basis: 4200,
        latest_price: 18,
      },
    ];
    const out = renderPositions(views, "AAPL", ["AAPL"], true);
    expect(out).not.toContain("4200");
    expect(out).not.toMatch(/total cost/i);
    expect(out).toContain("AAPL $145 call");
  });

  it("omits return % for snapshot rows without a price (no leak, honest)", () => {
    const views: PositionView[] = [
      {
        account_name: "Vanguard Taxable",
        symbol: "AAPL",
        security_type: "stock",
        underlying_symbol: null,
        option_type: null,
        strike_price: null,
        expiration_date: null,
        multiplier: null,
        quantity: 50,
        cost_basis: 9000,
      },
    ];
    const out = renderPositions(views, "AAPL", ["AAPL"], false);
    expect(out).not.toContain("9000");
    expect(out).toContain("50 sh AAPL");
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
    (fetchLiveIbkrPositionsCached as ReturnType<typeof vi.fn>).mockResolvedValue([
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
    (fetchLiveIbkrPositionsCached as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("IBKR down"));

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
    expect(fetchLiveIbkrPositionsCached).not.toHaveBeenCalled();
  });
});

describe("runEarningsFallback shorts surface (B7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  function htmlOfLastSend(): string {
    const calls = (sendEmail as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][1].html as string;
  }

  const AAPL_SECURITY = {
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
  };

  /** Snapshot with a +500 sh long position (Vanguard) and a -300 sh short (IBKR), same security. */
  function snapshotWithLongAndShortAapl(): Snapshot {
    const snap = makeEarningsSnapshot();
    (snap as unknown as Snapshot).accounts = [
      { id: 1, name: "Vanguard Taxable" },
      { id: 2, name: "IBKR" },
    ];
    (snap as unknown as Snapshot).securities = [AAPL_SECURITY];
    (snap as unknown as Snapshot).holdings = [
      { id: 1, account_id: 1, security_id: 10, quantity: 500, cost_basis: 90000, as_of_date: EVENT_DATE },
      { id: 2, account_id: 2, security_id: 10, quantity: -300, cost_basis: 54000, as_of_date: EVENT_DATE },
    ];
    return snap;
  }

  /** Snapshot with ONLY a -300 sh short position (no long leg at all). */
  function snapshotWithShortOnlyAapl(): Snapshot {
    const snap = makeEarningsSnapshot();
    (snap as unknown as Snapshot).accounts = [{ id: 2, name: "IBKR" }];
    (snap as unknown as Snapshot).securities = [AAPL_SECURITY];
    (snap as unknown as Snapshot).holdings = [
      { id: 1, account_id: 2, security_id: 10, quantity: -300, cost_basis: 54000, as_of_date: EVENT_DATE },
    ];
    return snap;
  }

  it("renders long and short buckets separately, never a netted count", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotWithLongAndShortAapl(),
    );

    const result = await runEarningsFallback(env, { now: previewWindowNow() });
    expect(result.sent).toBe(1);

    const html = htmlOfLastSend();
    expect(html).toContain("500 long shares");
    expect(html).toContain("300 short shares");
    expect(html).not.toContain("200");
  });

  it("a short-only position renders presence, not 'No current holdings'", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotWithShortOnlyAapl(),
    );

    const result = await runEarningsFallback(env, { now: previewWindowNow() });
    expect(result.sent).toBe(1);

    const html = htmlOfLastSend();
    expect(html).toContain("300 sh short AAPL");
    expect(html).not.toMatch(/No current/);
  });
});
