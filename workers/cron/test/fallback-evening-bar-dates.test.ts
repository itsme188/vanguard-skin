/**
 * Evening movers compare every name on SPY's own two trading days.
 *
 * Mac rule (lib/digest/anomalies.ts::resolveTradingDayPair): one consecutive
 * trading-day pair comes from SPY, and a name missing either date is omitted.
 * The Worker used to take each symbol's own last two closes and ignore their
 * dates, so a fund whose latest price was not posted yet had YESTERDAY's move
 * compared with SPY's move TODAY: a wrong, or repeated, mover line.
 *
 * The Worker now reads the bar timestamps from the same response and keeps a
 * symbol only when its last two Eastern dates equal SPY's. A symbol that does
 * not match is omitted, never flagged. This can only remove a mover line.
 *
 * Public tickers and invented round prices.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { FallbackEnv } from "../src/fallback-digest";
import type { Snapshot } from "../src/state";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
  jsonSchema: (s: unknown) => s,
}));
vi.mock("../src/ai", () => ({
  getModelForFeature: vi.fn(() => "mock-model"),
  generateWithFailover: vi.fn(
    async (
      _env: unknown,
      _feature: unknown,
      _catalog: unknown,
      call: (model: unknown, mode: "outputFormat" | "jsonTool") => Promise<unknown>,
    ) => call("mock-model", "outputFormat"),
  ),
  structuredOutputProviderOptions: vi.fn(() => ({})),
}));
vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});
vi.mock("../src/gmail", () => ({
  getAccessToken: vi.fn(async () => "mock-token"),
  listMessages: vi.fn(async () => []),
  getMessage: vi.fn(),
  extractMessage: vi.fn(),
}));
vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));

global.fetch = vi.fn();

import {
  runFallbackEvening,
  evaluateAnomalies,
  fetchLast2ClosesBatch,
  restrictToSpySession,
} from "../src/fallback-evening";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import { generateText } from "ai";

/** Epoch seconds of a UTC instant. */
const at = (iso: string) => Date.parse(iso) / 1000;
// US equity daily bars are stamped at the 09:30 Eastern open.
const TUE = at("2026-10-06T13:30:00Z");
const WED = at("2026-10-07T13:30:00Z");
const THU = at("2026-10-08T13:30:00Z");

function yahooReturns(body: Record<string, unknown>) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => body });
}

const HOLDINGS = [
  { symbol: "GOOG", securityId: 42, accountId: 1 },
  { symbol: "VTSAX", securityId: 43, accountId: 1 },
];
const BETAS = [
  { securityId: 42, lookbackDays: 60, beta: 1.0, computedAt: "2026-10-01" },
  { securityId: 43, lookbackDays: 60, beta: 1.0, computedAt: "2026-10-01" },
];

async function flaggedSymbols(body: Record<string, unknown>): Promise<string[] | null> {
  yahooReturns(body);
  const closes = restrictToSpySession(await fetchLast2ClosesBatch(["SPY", "GOOG", "VTSAX"]));
  const flags = evaluateAnomalies(HOLDINGS, BETAS, closes);
  return flags ? flags.map((f) => f.symbol) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  (global.fetch as ReturnType<typeof vi.fn>).mockReset();
});

describe("evening movers: every name is compared on SPY's two trading days", () => {
  it("all dates match: the same flags, with the same figures, as before the date check", async () => {
    const body = {
      SPY: { timestamp: [TUE, WED, THU], close: [495, 500, 510] },
      GOOG: { timestamp: [TUE, WED, THU], close: [210, 200, 180] },
      VTSAX: { timestamp: [TUE, WED, THU], close: [99, 100, 90] },
    };
    yahooReturns(body);
    const raw = await fetchLast2ClosesBatch(["SPY", "GOOG", "VTSAX"]);
    const before = evaluateAnomalies(HOLDINGS, BETAS, raw);
    const after = evaluateAnomalies(HOLDINGS, BETAS, restrictToSpySession(raw));
    expect(after).toEqual(before);
    expect((after ?? []).map((f) => f.symbol).sort()).toEqual(["GOOG", "VTSAX"]);
    // SPY +2%, GOOG -10%: the figures the existing evening test is built on.
    const goog = (after ?? []).find((f) => f.symbol === "GOOG");
    expect(goog?.actualPct).toBeCloseTo(-10, 6);
    expect(goog?.spyPct).toBeCloseTo(2, 6);
  });

  it("a fund one day behind (today's price not posted) is omitted; the others are unchanged", async () => {
    // VTSAX's last two bars are Tuesday and Wednesday: its -10% is YESTERDAY's
    // move. It used to be flagged against SPY's move today.
    const symbols = await flaggedSymbols({
      SPY: { timestamp: [TUE, WED, THU], close: [495, 500, 510] },
      GOOG: { timestamp: [TUE, WED, THU], close: [210, 200, 180] },
      VTSAX: { timestamp: [TUE, WED], close: [100, 90] },
    });
    expect(symbols).toEqual(["GOOG"]);
  });

  it("a name with today's bar but a gap before it is omitted", async () => {
    const symbols = await flaggedSymbols({
      SPY: { timestamp: [TUE, WED, THU], close: [495, 500, 510] },
      GOOG: { timestamp: [TUE, WED, THU], close: [210, null, 180] }, // Wednesday missing
      VTSAX: { timestamp: [TUE, WED, THU], close: [99, 100, 90] },
    });
    expect(symbols).toEqual(["VTSAX"]);
  });

  it("SPY missing its latest bar: every other name is ahead of it, so no movers and no throw", async () => {
    const symbols = await flaggedSymbols({
      SPY: { timestamp: [TUE, WED, THU], close: [495, 500, null] },
      GOOG: { timestamp: [TUE, WED, THU], close: [210, 200, 180] },
      VTSAX: { timestamp: [TUE, WED, THU], close: [99, 100, 90] },
    });
    expect(symbols ?? []).toEqual([]);
  });

  it("SPY absent, or with one bar, or with no timestamps: no movers, no throw", async () => {
    const others = {
      GOOG: { timestamp: [WED, THU], close: [200, 180] },
      VTSAX: { timestamp: [WED, THU], close: [100, 90] },
    };
    expect(await flaggedSymbols(others)).toBeNull();
    expect(await flaggedSymbols({ ...others, SPY: { timestamp: [THU], close: [510] } })).toBeNull();
    expect(await flaggedSymbols({ ...others, SPY: { close: [500, 510] } })).toBeNull();
  });

  it("a name with no timestamps cannot be placed on a day and is omitted", async () => {
    const symbols = await flaggedSymbols({
      SPY: { timestamp: [WED, THU], close: [500, 510] },
      GOOG: { close: [200, 180] },
      VTSAX: { timestamp: [WED, THU], close: [100, 90] },
    });
    expect(symbols).toEqual(["VTSAX"]);
  });

  it("two SPY bars on one Eastern day are not a trading-day pair: no movers", async () => {
    const symbols = await flaggedSymbols({
      SPY: { timestamp: [THU, THU + 3600], close: [500, 510] },
      GOOG: { timestamp: [THU, THU + 3600], close: [200, 180] },
      VTSAX: { timestamp: [THU, THU + 3600], close: [100, 90] },
    });
    expect(symbols).toBeNull();
  });
});

describe("bar dates are Eastern calendar days", () => {
  const datesOf = async (timestamps: number[]) => {
    yahooReturns({ SPY: { timestamp: timestamps, close: timestamps.map((_, i) => 500 + i) } });
    const spy = (await fetchLast2ClosesBatch(["SPY"])).get("SPY");
    return [spy?.priorDate, spy?.todayDate];
  };

  it("autumn clock change (1 Nov 2026): 04:30 UTC on 2 Nov is still 1 Nov in New York", async () => {
    // Standard time (UTC-5) began at 06:00 UTC on 1 Nov. On summer time the
    // same instant would already be 00:30 on 2 Nov.
    expect(await datesOf([at("2026-10-31T03:30:00Z"), at("2026-11-02T04:30:00Z")])).toEqual([
      "2026-10-30",
      "2026-11-01",
    ]);
  });

  it("spring clock change (8 Mar 2026): 04:30 UTC on 9 Mar is already 9 Mar in New York", async () => {
    // Summer time (UTC-4) began at 07:00 UTC on 8 Mar. On standard time the
    // same instant would still be 23:30 on 8 Mar.
    expect(await datesOf([at("2026-03-08T04:30:00Z"), at("2026-03-09T04:30:00Z")])).toEqual([
      "2026-03-07",
      "2026-03-09",
    ]);
  });

  it("the sessions either side of the autumn change pair up: the open moves from 13:30 to 14:30 UTC", async () => {
    const FRI = at("2026-10-30T13:30:00Z"); // 09:30 summer time
    const MON = at("2026-11-02T14:30:00Z"); // 09:30 standard time
    yahooReturns({
      SPY: { timestamp: [FRI, MON], close: [500, 510] },
      GOOG: { timestamp: [FRI, MON], close: [200, 180] },
      // A fund stamped at midnight Eastern on the same two days still matches.
      VTSAX: { timestamp: [at("2026-10-30T04:00:00Z"), at("2026-11-02T05:00:00Z")], close: [100, 90] },
    });
    const raw = await fetchLast2ClosesBatch(["SPY", "GOOG", "VTSAX"]);
    expect(raw.get("SPY")).toEqual({ prior: 500, today: 510, priorDate: "2026-10-30", todayDate: "2026-11-02" });
    expect([...restrictToSpySession(raw).keys()].sort()).toEqual(["GOOG", "SPY", "VTSAX"]);
  });
});

// ── Through the real evening run ────────────────────────────────────────────

function makeEnv(): FallbackEnv {
  const store = new Map<string, string>();
  return {
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
    ANTHROPIC_API_KEY: "test-key",
    BRIEFING_EMAIL_TO: "user@example.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_DOMAIN: "example.com",
  };
}

function eveningSnapshot(): Snapshot {
  const articles = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    source_id: 1,
    source_name: "TEST SOURCE",
    gmail_message_id: `msg-${i}`,
    received_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    subject: `Article ${i + 1}`,
    sender: "test@example.com",
    summary: `Summary ${i + 1}`,
    key_themes: JSON.stringify(["theme1"]),
    sentiment: "neutral",
    sentiment_score: null,
    mentioned_symbols: null,
    portfolio_relevance: "Some relevance",
    source_url: null,
    website_url: null,
    processed_at: new Date().toISOString(),
    ai_model: null,
  }));
  return {
    schemaVersion: 3,
    snapshotDate: "2026-10-08",
    generatedAt: new Date().toISOString(),
    heldSymbols: ["GOOG"],
    settings: {
      last_digest_sent_at: "2026-10-08T08:45:00Z",
      last_briefing_sent_at: null,
      evening_email_recipients: null,
    },
    calendarEvents: [],
    researchSources: [],
    recentArticlesMeta: articles,
    deepReadArticles: [],
    vanguardHoldings: HOLDINGS,
    securityBetas: BETAS,
  } as unknown as Snapshot;
}

describe("runFallbackEvening: the mover block in the delivered email", () => {
  beforeEach(() => {
    (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text:
        "## Evening Recap\n\n" +
        "Across today's coverage, several themes connected. Multiple sources " +
        "flagged macro pressure and earnings reactions in held names. " +
        "Citations were consistent across the day's newsletter feeds, " +
        "supporting a coherent narrative across sources.\n\n" +
        "## Also covered\n\n" +
        "A handful of single-source notes with thin coverage.",
    });
    (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(eveningSnapshot());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function deliveredHtml(body: Record<string, unknown>): Promise<string> {
    yahooReturns(body);
    const result = await runFallbackEvening(makeEnv());
    expect(result.kind).toBe("success");
    const calls = (sendEmail as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1][1].html as string;
  }

  it("dates match: both names are listed", async () => {
    const html = await deliveredHtml({
      SPY: { timestamp: [WED, THU], close: [500, 510] },
      GOOG: { timestamp: [WED, THU], close: [200, 180] },
      VTSAX: { timestamp: [WED, THU], close: [100, 90] },
    });
    expect(html).toContain("Significant Moves in Vanguard Holdings");
    // The line as it has always read for these prices.
    expect(html).toContain(">GOOG</strong> -10.0% — expected +2.0% (beta 1.0 × SPY +2.0%). Direction flipped.");
    expect(html).toContain(">VTSAX</strong> -10.0% — expected +2.0% (beta 1.0 × SPY +2.0%). Direction flipped.");
  });

  it("the fund is a day behind: it is not listed, GOOG still is", async () => {
    const html = await deliveredHtml({
      SPY: { timestamp: [TUE, WED, THU], close: [495, 500, 510] },
      GOOG: { timestamp: [TUE, WED, THU], close: [210, 200, 180] },
      VTSAX: { timestamp: [TUE, WED], close: [100, 90] },
    });
    expect(html).toContain(">GOOG</strong> -10.0% — expected +2.0% (beta 1.0 × SPY +2.0%). Direction flipped.");
    expect(html).not.toContain(">VTSAX</strong>");
  });

  it("SPY has no bar for today: the email still sends, with no mover block", async () => {
    const html = await deliveredHtml({
      SPY: { timestamp: [TUE, WED, THU], close: [495, 500, null] },
      GOOG: { timestamp: [TUE, WED, THU], close: [210, 200, 180] },
      VTSAX: { timestamp: [TUE, WED, THU], close: [99, 100, 90] },
    });
    expect(html).not.toContain("Significant Moves in Vanguard Holdings");
    expect(html).not.toContain(">GOOG</strong>");
  });
});
