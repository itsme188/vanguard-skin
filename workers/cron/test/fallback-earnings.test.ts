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

import {
  runEarningsFallback,
  renderPositions,
  renderScoreboard,
  evaluateRecapContent,
  type PositionView,
} from "../src/fallback-earnings";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import { composeReleaseInstant } from "../src/reaction-matcher";
import { fetchLiveIbkrPositionsCached } from "../src/ibkr-positions";
import { cloudEnrichedKey } from "../src/cloud-enriched";

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

describe("B20: issuer-family aware held/watchlist/mute gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  function snapshotWith(overrides: {
    heldSymbols?: string[]; watchlistSymbols?: string[]; mutedSymbols?: string[]; eventSymbol?: string;
  }) {
    const snap = makeEarningsSnapshot() as any;
    snap.heldSymbols = overrides.heldSymbols ?? [];
    if (overrides.watchlistSymbols) snap.watchlistSymbols = overrides.watchlistSymbols;
    if (overrides.mutedSymbols) snap.earningsSettings = { enabled: true, mutedSymbols: overrides.mutedSymbols };
    if (overrides.eventSymbol) snap.calendarEvents[0].symbol = overrides.eventSymbol;
    return snap as Snapshot;
  }

  it("GOOGL event with only GOOG held is a candidate (family walk)", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotWith({ heldSymbols: ["GOOG"], eventSymbol: "GOOGL" }),
    );
    const result = await runEarningsFallback(makeEnv(), { now: previewWindowNow() });
    expect(sendEmail).toHaveBeenCalled();
    expect(result.sent).toBeGreaterThan(0);
  });

  it("watchlist-only symbol is a candidate (snapshot v8 parity with push-at-print)", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotWith({ heldSymbols: [], watchlistSymbols: ["AAPL"] }),
    );
    const result = await runEarningsFallback(makeEnv(), { now: previewWindowNow() });
    expect(sendEmail).toHaveBeenCalled();
    expect(result.sent).toBeGreaterThan(0);
  });

  it("mute list is case-insensitive and family-aware", async () => {
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      snapshotWith({ heldSymbols: ["GOOG"], eventSymbol: "GOOGL", mutedSymbols: ["goog"] }),
    );
    const result = await runEarningsFallback(makeEnv(), { now: previewWindowNow() });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });
});

describe("KV recap road (B8: same-day cloud-enriched payloads)", () => {
  const release = () => composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
  const completePayload = () => ({
    eventId: 1,
    source_key: "finnhub:AAPL:2026-06-15",
    actual: "EPS 1.60 · Rev 91,000,000,000",
    consensus: "EPS 1.50 · Rev 90,000,000,000",
    source: "finnhub",
    reaction: { source: "yahoo", window_min: 120, symbol: { symbol: "AAPL", delta_pct: 4.1 }, spy: { delta_pct: 0.3 }, qqq: { delta_pct: 0.5 } },
    fetchedAt: new Date(release().getTime() + 125 * 60_000).toISOString(),
  });

  beforeEach(() => {
    vi.mocked(loadLatestSnapshot).mockReset();
    vi.mocked(sendEmail).mockClear();
    vi.mocked(fetchLiveIbkrPositionsCached).mockResolvedValue([]);
  });

  it("sends a recap from a complete payload and writes the cloud marker", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    await env.CRON_KV.put(cloudEnrichedKey(1), JSON.stringify(completePayload()));
    const now = new Date(release().getTime() + 150 * 60_000); // fetchedAt + 25min
    const res = await runEarningsFallback(env, { now });
    expect(res.sent).toBe(1);
    expect(res.details[0]).toMatchObject({ eventId: 1, phase: "recap", status: "sent" });
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).not.toBeNull();
  });

  it("skips an incomplete payload with reason, no marker, no email", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    const p = completePayload();
    (p as Record<string, unknown>).actual = null;
    await env.CRON_KV.put(cloudEnrichedKey(1), JSON.stringify(p));
    const now = new Date(release().getTime() + 150 * 60_000);
    const res = await runEarningsFallback(env, { now });
    expect(res.sent).toBe(0);
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).toBeNull();
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 1, phase: "recap", status: "skipped", reason: "payload-incomplete" }),
    );
  });

  it("reports payload-missing when nothing is in KV yet", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    const now = new Date(release().getTime() + 60 * 60_000);
    const res = await runEarningsFallback(env, { now });
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 1, phase: "recap", status: "skipped", reason: "payload-missing" }),
    );
  });

  it("degrades a KV read failure to a markerless skip and keeps running", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    (env.CRON_KV.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key.startsWith("cloud-enriched-")) throw new Error("kv down");
      return null;
    });
    const now = new Date(release().getTime() + 60 * 60_000);
    const res = await runEarningsFallback(env, { now });
    expect(res.failed).toBe(0);
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 1, phase: "recap", status: "skipped", reason: "kv-error" }),
    );
  });

  it("does not recap an expired payload (fetchedAt older than 4h)", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(makeEarningsSnapshot());
    const env = makeEnv();
    await env.CRON_KV.put(cloudEnrichedKey(1), JSON.stringify(completePayload()));
    const now = new Date(release().getTime() + 125 * 60_000 + 4 * 3600_000 + 60_000);
    const res = await runEarningsFallback(env, { now });
    expect(res.sent).toBe(0);
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });
});

describe("recap safety gates (B8)", () => {
  const baseEvent = () =>
    ({
      id: 1, source: "finnhub", event_type: "earnings", event_date: EVENT_DATE,
      event_time: "AMC", title: "AAPL earnings", description: null, security_id: null,
      symbol: "AAPL", expected_impact: "high",
      consensus_estimate: "EPS 1.50 · Rev 90,000,000,000",
      previous_value: null, raw_json: null,
      consensus_value: null, actual_value: null, reaction_snapshot: null,
    }) as unknown as import("../src/state").CalendarEventRow;

  it("no actual anywhere → send:false no-actual", () => {
    expect(evaluateRecapContent(baseEvent(), null)).toEqual({ send: false, reason: "no-actual" });
  });

  it("payload actual counts as the actual", () => {
    const v = evaluateRecapContent(baseEvent(), {
      eventId: 1, source_key: "finnhub:AAPL:2026-06-15",
      actual: "EPS 1.60 · Rev 91,000,000,000", consensus: null, source: "finnhub",
      reaction: null, fetchedAt: new Date().toISOString(),
    });
    expect(v).toEqual({ send: true, implausible: false });
  });

  it("implausible actual + no reaction → send:false implausible-no-data-point", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).actual_value = "EPS 5.11"; // vs cons 1.50 → ratio 3.4
    expect(evaluateRecapContent(ev, null)).toEqual({ send: false, reason: "implausible-no-data-point" });
  });

  it("implausible actual + reaction present → sends, flagged implausible", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).actual_value = "EPS 5.11";
    (ev as Record<string, unknown>).reaction_snapshot = JSON.stringify({ symbol: { delta_pct: -4.2 } });
    expect(evaluateRecapContent(ev, null)).toEqual({ send: true, implausible: true });
  });

  it("implausible actual + junk empty-object reaction → still no-data-point (final-review fix)", () => {
    // A malformed/empty reaction_snapshot (e.g. `{}`) is truthy but carries
    // no renderable delta — the old `!= null` check would have let this
    // through as "has a reaction" and sent a fully-blanked scoreboard.
    const ev = baseEvent();
    (ev as Record<string, unknown>).actual_value = "EPS 5.11"; // vs cons 1.50 → implausible
    (ev as Record<string, unknown>).reaction_snapshot = JSON.stringify({});
    expect(evaluateRecapContent(ev, null)).toEqual({ send: false, reason: "implausible-no-data-point" });
  });

  it("unparseable consensus doesn't trip the sign-flip guard (final-review fix)", () => {
    // parseFinnhubFigure's EPS regex only ever captures valid float syntax,
    // so a NaN can't actually reach isPlausibleEarnings through this path
    // today (Number() on a regex-captured "-?\d+(?:\.\d+)?" string always
    // succeeds) — the num() guard in evaluateRecapContent is defense-in-depth
    // for if that regex ever loosens. This test instead pins the adjacent,
    // reachable case: a non-numeric consensus string parses to a null eps
    // (not NaN), which correctly carries no plausibility claim at all rather
    // than spuriously failing the sign-flip check.
    const ev = baseEvent();
    (ev as Record<string, unknown>).consensus_estimate = "EPS abc";
    (ev as Record<string, unknown>).actual_value = "EPS 1.60";
    expect(evaluateRecapContent(ev, null)).toEqual({ send: true, implausible: false });
  });

  it("scoreboard NEVER renders consensus_value in the Actual column", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).consensus_value = "EPS 1.55 · Rev 90,500,000,000";
    const md = renderScoreboard(ev, "recap", null, false);
    const epsRow = md.split("\n").find((l) => l.includes("**EPS**"))!;
    expect(epsRow).toContain("| — |"); // Actual cell blank — 1.55 must not appear as actual
  });

  it("scoreboard consensus precedence: consensus_value > payload.consensus > consensus_estimate", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).consensus_value = "EPS 1.55 · Rev 90,500,000,000";
    const md = renderScoreboard(ev, "recap", null, false);
    expect(md).toContain("1.55");
    const md2 = renderScoreboard(baseEvent(), "recap", {
      eventId: 1, source_key: "x", actual: null, consensus: "EPS 1.52 · Rev 90,200,000,000",
      source: "finnhub", reaction: null, fetchedAt: new Date().toISOString(),
    }, false);
    expect(md2).toContain("1.52");
    expect(renderScoreboard(baseEvent(), "recap", null, false)).toContain("1.50");
  });

  it("scoreboard blanks implausible actuals and appends the ⚠ line", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).actual_value = "EPS 5.11 · Rev 91,000,000,000";
    (ev as Record<string, unknown>).reaction_snapshot = JSON.stringify({ symbol: { delta_pct: -4.2 } });
    const md = renderScoreboard(ev, "recap", null, true);
    expect(md).not.toContain("5.11");
    expect(md).toContain("⚠ Reported actuals were flagged as implausible");
    expect(md).toContain("-4.20%"); // reaction row still renders
  });

  it("scoreboard renders the payload reaction when the snapshot has none", () => {
    const ev = baseEvent();
    (ev as Record<string, unknown>).actual_value = "EPS 1.60 · Rev 91,000,000,000";
    const md = renderScoreboard(ev, "recap", {
      eventId: 1, source_key: "x", actual: null, consensus: null, source: "finnhub",
      reaction: { symbol: { delta_pct: 3.15 }, spy: { delta_pct: 0.4 } },
      fetchedAt: new Date().toISOString(),
    }, false);
    expect(md).toContain("+3.15%");
  });

  it("end-to-end: snapshot-road recap with enriched_at but NULL actual is skipped markerless", async () => {
    const snap = makeEarningsSnapshot();
    const ev = snap.calendarEvents[0] as Record<string, unknown>;
    const release = composeReleaseInstant(EVENT_DATE, RELEASE_TIME)!;
    ev.enriched_at = new Date(release.getTime() + 130 * 60_000).toISOString().replace("T", " ").slice(0, 19);
    ev.actual_value = null;
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snap as never);
    const env = makeEnv();
    const res = await runEarningsFallback(env, { now: new Date(release.getTime() + 150 * 60_000) });
    expect(res.sent).toBe(0);
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).toBeNull();
    expect(res.details).toContainEqual(
      expect.objectContaining({ eventId: 1, phase: "recap", status: "skipped", reason: "no-actual" }),
    );
  });
});

describe("intel rows in cloud scoreboard (Task 9: snapshot v9)", () => {
  const baseEvent = () =>
    ({
      id: 1, source: "finnhub", event_type: "earnings", event_date: EVENT_DATE,
      event_time: "AMC", title: "AAPL earnings", description: null, security_id: null,
      symbol: "AAPL", source_key: "finnhub:AAPL:2026-06-15", expected_impact: "high",
      consensus_estimate: "EPS 1.50 · Rev 90,000,000,000",
      previous_value: null, raw_json: null,
      consensus_value: null, actual_value: null, reaction_snapshot: null,
    }) as unknown as import("../src/state").CalendarEventRow;

  it("renders implied + history rows with as-of label when snapshot carries v9 fields", () => {
    const event = baseEvent();
    const md = renderScoreboard(event, "preview", null, false, {
      intel: {
        eventId: event.id,
        sourceKey: event.source_key as unknown as string,
        impliedMovePct: 4.8,
        impliedMethod: "straddle",
        expiryUsed: "2026-07-18",
        computedAt: "2026-07-14 06:00:00",
      },
      history: {
        rows: [
          { reportedDate: "2026-04-15", epsActual: 1.6, epsEstimate: 1.5, surprisePct: 6.7, postPrintMovePct: 3.1 },
          { reportedDate: "2026-01-15", epsActual: 1.4, epsEstimate: 1.45, surprisePct: -3.4, postPrintMovePct: -2.0 },
        ],
        summary: { avgAbsMovePct: 3.2, beatCount: 6, missCount: 2, quarterCount: 8 },
      },
    });
    expect(md).toContain("Expected move (options)");
    expect(md).toContain("±4.8%");
    expect(md).toContain("as of");
    expect(md).toContain("Avg move last 8 prints");
  });

  it("pre-v9 snapshot (fields absent) renders the classic scoreboard unchanged", () => {
    const md = renderScoreboard(baseEvent(), "preview", null, false, undefined);
    expect(md).not.toContain("Expected move (options)");
    expect(md).not.toContain("Avg move last 8 prints");
  });

  it("v9-capable snapshot but no intel/history match for this event renders dash rows, not omitted", () => {
    const md = renderScoreboard(baseEvent(), "preview", null, false, { intel: null, history: null });
    expect(md).toContain("Expected move (options)");
    const row = md.split("\n").find((l) => l.includes("Expected move (options)"))!;
    expect(row).toContain("| — | — | — |");
    const histRow = md.split("\n").find((l) => l.includes("Avg move last 8 prints"))!;
    expect(histRow).toContain("| — | — | — |");
  });

  it("recap phase compares realized reaction against implied move ('inside'/'outside')", () => {
    const ev = baseEvent();
    (ev as unknown as Record<string, unknown>).reaction_snapshot = JSON.stringify({
      symbol: { delta_pct: 3.1 },
    });
    const md = renderScoreboard(ev, "recap", null, false, {
      intel: {
        eventId: ev.id, sourceKey: "x", impliedMovePct: 4.8, impliedMethod: "straddle",
        expiryUsed: "2026-07-18", computedAt: "2026-07-14 06:00:00",
      },
      history: null,
    });
    const row = md.split("\n").find((l) => l.includes("Expected move (options)"))!;
    expect(row).toContain("inside");
  });
});

// ── B13: per-run candidate cap (subrequest budget guard) ─────────────────────
//
// Each sent candidate costs ~5 subrequests (3 KV marker reads + 1 Resend fetch
// + 1 KV marker write), and the single */15 invocation's 50-subrequest free-tier
// budget is shared with calendar-enrich (itself capped at 10 candidates). An
// uncapped clustered-AMC run could die mid-loop with markers half-written.

function makeCapEvent(
  overrides: Partial<Record<string, unknown>> & { id: number },
): Record<string, unknown> {
  return {
    ...(makeEarningsSnapshot().calendarEvents[0] as unknown as Record<string, unknown>),
    source_key: `finnhub:AAPL:${EVENT_DATE}:${overrides.id}`,
    ...overrides,
  };
}

function makeSnapshotWithEvents(events: Record<string, unknown>[]): Snapshot {
  const snap = makeEarningsSnapshot() as unknown as { calendarEvents: unknown[] };
  snap.calendarEvents = events;
  return snap as unknown as Snapshot;
}

describe("B13: per-run candidate cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  it("processes at most 5 candidates per run; overflow deferred markerless for the next tick", async () => {
    const events = Array.from({ length: 7 }, (_, i) => makeCapEvent({ id: i + 1 }));
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshotWithEvents(events),
    );
    const env = makeEnv();

    const result = await runEarningsFallback(env, { now: previewWindowNow() });

    expect(result.swept).toBe(7); // all discovered candidates stay visible in the count
    expect(result.sent).toBe(5);
    expect(sendEmail).toHaveBeenCalledTimes(5);
    const deferred = result.details.filter((d) => d.reason === "deferred-cap");
    expect(deferred).toHaveLength(2);
    expect(result.skipped).toBe(2);
    // No cloud-sent marker for deferred events — the next tick must retry them.
    const putKeys = (env.CRON_KV.put as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(putKeys).toHaveLength(5);
    for (const d of deferred) {
      expect(putKeys).not.toContain(`cloud-sent-earnings-${d.phase}-${d.eventId}`);
    }
  });

  it("prioritizes previews closest to release when over cap", async () => {
    // The 16:00 event (furthest out, 120 min) is listed FIRST — naive
    // array-order slicing would keep it and drop a closer release instead.
    const times = ["16:00", "15:50", "15:52", "15:54", "15:56", "15:58"];
    const events = times.map((t, i) => makeCapEvent({ id: i + 1, release_time: t }));
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshotWithEvents(events),
    );
    const env = makeEnv();

    // now = 120 min before the 16:00 release → distances 110–120 min, all in-window.
    const result = await runEarningsFallback(env, { now: previewWindowNow() });

    expect(result.sent).toBe(5);
    const deferred = result.details.filter((d) => d.reason === "deferred-cap");
    expect(deferred).toHaveLength(1);
    expect(deferred[0].eventId).toBe(1); // the 16:00 event — furthest from release
  });

  it("defers recaps before previews (recap window is 4h; preview window is 15 min)", async () => {
    const recap = makeCapEvent({
      id: 99,
      release_time: "13:00", // release already past → not a preview candidate
      enriched_at: "2026-06-15 17:30:00", // 30 min before `now` → inside recap window
      actual_value: "EPS 1.60 · Rev 92000000000",
      consensus_value: "EPS 1.50 · Rev 90000000000",
    });
    const previews = Array.from({ length: 5 }, (_, i) => makeCapEvent({ id: i + 1 }));
    // Recap listed FIRST — array order must not beat phase priority.
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSnapshotWithEvents([recap, ...previews]),
    );
    const env = makeEnv();

    const result = await runEarningsFallback(env, { now: previewWindowNow() });

    expect(result.sent).toBe(5);
    const deferred = result.details.filter((d) => d.reason === "deferred-cap");
    expect(deferred).toHaveLength(1);
    expect(deferred[0].eventId).toBe(99);
    expect(deferred[0].phase).toBe("recap");
  });
});

// ── #17 T4: EOD earnings wrap (cloud mirror of lib/earnings/wrap.ts) ──────────
//
// A (date, AMC/BMO) cluster with ≥3 expected-unsent recaps is stapled into ONE
// email instead of N individual recap sends. Fires when all members reported OR
// the slot deadline passed (AMC 20:00 ET) with ≥1 report. Per-member cloud-sent
// markers are written for stapled members only.

describe("EOD earnings wrap (#17 T4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
    vi.mocked(fetchLiveIbkrPositionsCached).mockResolvedValue([]);
  });

  const READY_ACTUAL = "EPS 1.60 · Rev 91000000000";

  /** One AMC earnings row for EVENT_DATE. `actual`/`enriched_at` control readiness + individual-recap eligibility. */
  function wrapEvent(o: {
    id: number;
    symbol: string;
    release_time?: string;
    actual?: string | null;
    enriched_at?: string | null;
    source?: string;
  }): Record<string, unknown> {
    return {
      id: o.id,
      week_of: EVENT_DATE,
      event_date: EVENT_DATE,
      event_type: "earnings",
      title: `${o.symbol} earnings`,
      description: null,
      symbol: o.symbol,
      event_time: "AMC",
      release_time: o.release_time ?? "16:00",
      expected_impact: "high",
      source: o.source ?? "finnhub",
      source_key: `finnhub:${o.symbol}:${EVENT_DATE}`,
      raw_json: {},
      enriched_at: o.enriched_at ?? null,
      consensus_estimate: "EPS 1.50 · Rev 90000000000",
      consensus_value: null,
      actual_value: o.actual ?? null,
      previous_value: null,
      reaction_snapshot: null,
    };
  }

  function wrapSnapshot(events: Record<string, unknown>[], held: string[]): Snapshot {
    const snap = makeEarningsSnapshot() as unknown as {
      calendarEvents: unknown[];
      heldSymbols: string[];
    };
    snap.calendarEvents = events;
    snap.heldSymbols = held;
    return snap as unknown as Snapshot;
  }

  function subjectOfLastSend(): string {
    const calls = (sendEmail as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][1].subject as string;
  }
  function htmlOfLastSend(): string {
    const calls = (sendEmail as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][1].html as string;
  }
  const subjectsOfAllSends = () =>
    (sendEmail as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1].subject as string);

  // 18:30 ET on EVENT_DATE — AMC deadline (20:00 ET) NOT passed.
  const ALL_READY_NOW = new Date("2026-06-15T22:30:00Z");
  // 20:15 ET on EVENT_DATE — past the AMC deadline.
  const PAST_DEADLINE_NOW = new Date("2026-06-16T00:15:00Z");

  it("clusters distinct families (GOOG/GOOGL count once) and staples one email at ≥3", async () => {
    // 4 rows, but GOOG+GOOGL are one family → 3 members → wrap mode.
    const events = [
      wrapEvent({ id: 1, symbol: "GOOG", actual: READY_ACTUAL }),
      wrapEvent({ id: 2, symbol: "GOOGL", actual: READY_ACTUAL }),
      wrapEvent({ id: 3, symbol: "AAPL", actual: READY_ACTUAL }),
      wrapEvent({ id: 4, symbol: "MSFT", actual: READY_ACTUAL }),
    ];
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, ["GOOG", "AAPL", "MSFT"]),
    );
    const env = makeEnv();

    const result = await runEarningsFallback(env, { now: ALL_READY_NOW });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(subjectOfLastSend()).toBe("\u{1F4CA} Earnings wrap — AMC 2026-06-15 (3 names)");
    expect(result.sent).toBe(3);
    // Per-member markers for the 3 surviving cluster members (GOOG wins the family).
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).not.toBeNull();
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-3")).not.toBeNull();
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-4")).not.toBeNull();
    // GOOGL (id 2) was deduped OUT of the cluster — no marker.
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-2")).toBeNull();
  });

  it("below threshold (2 families) → no wrap; individual recaps fire normally", async () => {
    const now = new Date("2026-06-15T20:00:00Z"); // 16:00 ET
    const events = [
      wrapEvent({ id: 1, symbol: "AAPL", actual: READY_ACTUAL, enriched_at: "2026-06-15 19:45:00" }),
      wrapEvent({ id: 2, symbol: "MSFT", actual: READY_ACTUAL, enriched_at: "2026-06-15 19:45:00" }),
    ];
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, ["AAPL", "MSFT"]),
    );

    const result = await runEarningsFallback(makeEnv(), { now });

    expect(sendEmail).toHaveBeenCalledTimes(2);
    for (const s of subjectsOfAllSends()) expect(s).not.toMatch(/Earnings wrap/);
    expect(result.sent).toBe(2);
  });

  it("suppresses individual recaps in wrap mode (3 road-1 recaps → one stapled email)", async () => {
    const now = new Date("2026-06-15T20:00:00Z"); // 16:00 ET; all-ready → fires
    // Every member is ALSO a road-1 individual recap candidate (enriched_at + actual).
    const events = [
      wrapEvent({ id: 1, symbol: "AAPL", actual: READY_ACTUAL, enriched_at: "2026-06-15 19:45:00" }),
      wrapEvent({ id: 2, symbol: "MSFT", actual: READY_ACTUAL, enriched_at: "2026-06-15 19:45:00" }),
      wrapEvent({ id: 3, symbol: "NVDA", actual: READY_ACTUAL, enriched_at: "2026-06-15 19:45:00" }),
    ];
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, ["AAPL", "MSFT", "NVDA"]),
    );

    const result = await runEarningsFallback(makeEnv(), { now });

    // Without suppression this would be 3 individual recap emails.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(subjectOfLastSend()).toContain("Earnings wrap — AMC");
    expect(result.sent).toBe(3);
  });

  it("a member reported only via same-day KV payload counts as ready and is stapled", async () => {
    const events = [
      wrapEvent({ id: 1, symbol: "AAPL", actual: READY_ACTUAL }),
      wrapEvent({ id: 2, symbol: "MSFT", actual: READY_ACTUAL }),
      wrapEvent({ id: 3, symbol: "NVDA", actual: null }), // no snapshot actual — KV only
    ];
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, ["AAPL", "MSFT", "NVDA"]),
    );
    const env = makeEnv();
    await env.CRON_KV.put(
      cloudEnrichedKey(3),
      JSON.stringify({
        eventId: 3,
        source_key: "finnhub:NVDA:2026-06-15",
        actual: READY_ACTUAL,
        consensus: "EPS 1.50 · Rev 90000000000",
        source: "finnhub",
        reaction: { symbol: { delta_pct: 2.2 } },
        fetchedAt: ALL_READY_NOW.toISOString(),
      }),
    );

    const result = await runEarningsFallback(env, { now: ALL_READY_NOW });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(subjectOfLastSend()).toContain("(3 names)");
    expect(result.sent).toBe(3);
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-3")).not.toBeNull();
  });

  it("an actual-only KV payload (no reaction, before T+150 settle) is NOT ready — wrap holds pre-deadline (review fix #17 T4)", async () => {
    // Same shape as the "counts as ready" test above, EXCEPT the KV payload
    // carries an actual with NO reaction and is probed well before the T+150
    // completeness settle. Pre-fix, `ready` only checked `payload.actual !=
    // null`, so NVDA would count ready immediately and the wrap would fire
    // ~2h early with NVDA's reaction column reading "—".
    const release = composeReleaseInstant(EVENT_DATE, "16:00")!;
    const now = new Date(release.getTime() + 60 * 60_000); // T+60min: well before T+150 settle, well before the 20:00 ET AMC deadline
    const events = [
      wrapEvent({ id: 1, symbol: "AAPL", actual: READY_ACTUAL }),
      wrapEvent({ id: 2, symbol: "MSFT", actual: READY_ACTUAL }),
      wrapEvent({ id: 3, symbol: "NVDA", actual: null }), // no snapshot actual — KV only
    ];
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, ["AAPL", "MSFT", "NVDA"]),
    );
    const env = makeEnv();
    await env.CRON_KV.put(
      cloudEnrichedKey(3),
      JSON.stringify({
        eventId: 3,
        source_key: "finnhub:NVDA:2026-06-15",
        actual: READY_ACTUAL,
        consensus: "EPS 1.50 · Rev 90000000000",
        source: "finnhub",
        reaction: null, // reaction not yet captured
        fetchedAt: now.toISOString(),
      }),
    );

    const result = await runEarningsFallback(env, { now });

    // NVDA is not ready and the deadline hasn't passed → the whole cluster
    // holds (AAPL/MSFT's individual road-1 candidacy is irrelevant here since
    // neither has enriched_at set, but the wrap must not fire on 2-of-3).
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).toBeNull();
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-3")).toBeNull();
  });

  it("an actual-only KV payload becomes ready once T+150 settle passes with no reaction ever arriving (review fix #17 T4)", async () => {
    // Same payload as above (reaction: null) but probed AFTER the T+150
    // completeness settle — isPayloadComplete's second branch (release ≥150min
    // old) makes it ready even though no reaction ever showed up, matching
    // road-2's individual-recap completeness bar exactly.
    const release = composeReleaseInstant(EVENT_DATE, "16:00")!;
    const now = new Date(release.getTime() + 150 * 60_000 + 60_000); // T+151min: past the settle
    const events = [
      wrapEvent({ id: 1, symbol: "AAPL", actual: READY_ACTUAL }),
      wrapEvent({ id: 2, symbol: "MSFT", actual: READY_ACTUAL }),
      wrapEvent({ id: 3, symbol: "NVDA", actual: null }),
    ];
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, ["AAPL", "MSFT", "NVDA"]),
    );
    const env = makeEnv();
    await env.CRON_KV.put(
      cloudEnrichedKey(3),
      JSON.stringify({
        eventId: 3,
        source_key: "finnhub:NVDA:2026-06-15",
        actual: READY_ACTUAL,
        consensus: "EPS 1.50 · Rev 90000000000",
        source: "finnhub",
        reaction: null,
        fetchedAt: now.toISOString(),
      }),
    );

    const result = await runEarningsFallback(env, { now });

    // All 3 now ready (well before the 20:00 ET deadline — readiness alone
    // drives the fire, not the deadline fallback).
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(subjectOfLastSend()).toContain("(3 names)");
    expect(result.sent).toBe(3);
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-3")).not.toBeNull();
  });

  it("fires at the deadline with a still-waiting line and no marker for the waiting name", async () => {
    const events = [
      wrapEvent({ id: 1, symbol: "AAPL", actual: READY_ACTUAL }),
      wrapEvent({ id: 2, symbol: "MSFT", actual: READY_ACTUAL }),
      wrapEvent({ id: 3, symbol: "NVDA", actual: null }), // never reported
    ];
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, ["AAPL", "MSFT", "NVDA"]),
    );
    const env = makeEnv();

    const result = await runEarningsFallback(env, { now: PAST_DEADLINE_NOW });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(subjectOfLastSend()).toContain("(2 names)");
    expect(htmlOfLastSend()).toContain("Still waiting on actuals: NVDA");
    expect(result.sent).toBe(2);
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).not.toBeNull();
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-2")).not.toBeNull();
    // The still-waiting member gets NO marker — its recap can still land later.
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-3")).toBeNull();
  });

  it("before the deadline with a not-reported member → holds (no send), individuals suppressed", async () => {
    // AAPL + MSFT are road-1 individual candidates (enriched_at + actual); without
    // wrap-mode suppression they'd send 2 individual recaps. Wrap holds them.
    const events = [
      wrapEvent({ id: 1, symbol: "AAPL", actual: READY_ACTUAL, enriched_at: "2026-06-15 22:15:00" }),
      wrapEvent({ id: 2, symbol: "MSFT", actual: READY_ACTUAL, enriched_at: "2026-06-15 22:15:00" }),
      wrapEvent({ id: 3, symbol: "NVDA", actual: null }), // not reported → wrap waits
    ];
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, ["AAPL", "MSFT", "NVDA"]),
    );
    const env = makeEnv();

    const result = await runEarningsFallback(env, { now: ALL_READY_NOW }); // 18:30 ET, pre-deadline

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(await env.CRON_KV.get("cloud-sent-earnings-recap-1")).toBeNull();
  });

  it("caps the staple at 5 closest releases, defers the rest markerless with a warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 7 distinct families, all reported. release_time ascending → the 2 LATEST
    // (TSLA 16:00, NFLX 16:02) must be deferred.
    const rows: Array<[number, string, string]> = [
      [1, "AAPL", "15:50"],
      [2, "MSFT", "15:52"],
      [3, "NVDA", "15:54"],
      [4, "AMZN", "15:56"],
      [5, "META", "15:58"],
      [6, "TSLA", "16:00"],
      [7, "NFLX", "16:02"],
    ];
    const events = rows.map(([id, symbol, release_time]) =>
      wrapEvent({ id, symbol, release_time, actual: READY_ACTUAL }),
    );
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, rows.map((r) => r[1])),
    );
    const env = makeEnv();

    const result = await runEarningsFallback(env, { now: ALL_READY_NOW });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(subjectOfLastSend()).toContain("(5 names)");
    expect(result.sent).toBe(5);
    for (const id of [1, 2, 3, 4, 5]) {
      expect(await env.CRON_KV.get(`cloud-sent-earnings-recap-${id}`)).not.toBeNull();
    }
    for (const id of [6, 7]) {
      expect(await env.CRON_KV.get(`cloud-sent-earnings-recap-${id}`)).toBeNull();
    }
    const deferred = result.details.filter((d) => d.reason === "deferred-cap");
    expect(deferred.map((d) => d.eventId).sort()).toEqual([6, 7]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("all members already marked (mac/cloud sent) → no send", async () => {
    const events = [
      wrapEvent({ id: 1, symbol: "AAPL", actual: READY_ACTUAL }),
      wrapEvent({ id: 2, symbol: "MSFT", actual: READY_ACTUAL }),
      wrapEvent({ id: 3, symbol: "NVDA", actual: READY_ACTUAL }),
    ];
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      wrapSnapshot(events, ["AAPL", "MSFT", "NVDA"]),
    );
    const env = makeEnv();
    await env.CRON_KV.put("cloud-sent-earnings-recap-1", new Date().toISOString());
    await env.CRON_KV.put("mac-sent-earnings-recap-2", new Date().toISOString());
    await env.CRON_KV.put("cloud-sent-earnings-recap-3", new Date().toISOString());

    const result = await runEarningsFallback(env, { now: ALL_READY_NOW });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });
});

describe("superseded cross-source duplicate events (2026-07-14 JPM/BAC double-preview)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  });

  /** Same print, two calendar rows: finnhub canonical + nasdaq marked superseded
   *  by the Mac's reconcileEarningsDates. The snapshot ships both (SELECT *);
   *  only the canonical row may produce an email. */
  function makeDualSourceSnapshot(): Snapshot {
    const snap = makeEarningsSnapshot();
    const rows = (snap as unknown as { calendarEvents: Record<string, unknown>[] }).calendarEvents;
    rows[0].superseded = 0;
    rows.push({
      ...rows[0],
      id: 2,
      source: "nasdaq",
      source_key: "nasdaq:AAPL:2026-06-15",
      superseded: 1,
    });
    return snap;
  }

  it("skips a superseded event row — one email for the print, sent for the canonical id", async () => {
    const env = makeEnv();
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeDualSourceSnapshot(),
    );

    const result = await runEarningsFallback(env, { now: previewWindowNow() });

    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(result.details.filter((d) => d.status === "sent").map((d) => d.eventId)).toEqual([1]);
  });
});
