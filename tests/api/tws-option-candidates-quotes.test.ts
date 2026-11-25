/**
 * POST /api/tws/option-candidates/quotes (Gains at risk step 3, Task S4:
 * P10, P13, D1, D2, D7, F2, F5, F9, T14).
 *
 * Order: the body (400), the underlying on the server (422), the connection
 * (503), then the batch (a running sync 409, the lock 423, no free slot 429).
 * A refusal sends zero broker requests and writes nothing. A fake IB API and a
 * migrated in-memory database; no TWS connection. Synthetic ZZ* tickers and
 * invented figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { SecType } from "@stoqey/ib";
import { runMigrations } from "@/lib/db/migrate";
import { classifyRoute } from "@/lib/auth/route-policy";
import { todayET } from "@/lib/calendar/date-utils";
import {
  OPTION_QUOTE_LOCK_WAIT_MS,
  OPTION_QUOTE_RATE_LIMIT,
  reserveOptionQuoteSlots,
  resetOptionQuoteLimiter,
} from "@/lib/tws/option-quote";
import type { BatchContractRequest, OptionQuoteBatchResult } from "@/lib/tws/option-quote-batch";
import {
  batchRefusalSentence,
  QUOTE_LOCK_BUSY_RETRY_AFTER_SECONDS,
  type QuotesResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";

const state = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  api: null as unknown,
  syncing: false,
  /** When set, the batch answers this instead of running (a whole-pull refusal or a scripted row). */
  batchOverride: null as null | ((req: { contracts: { conId: number }[] }) => OptionQuoteBatchResult),
  entryCalls: 0,
  batchNow: [] as (() => Date)[],
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(() => state.api),
}));

vi.mock("@/lib/tws/sync-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tws/sync-state")>();
  return { ...actual, isSyncing: () => state.syncing };
});

vi.mock("@/lib/tws/option-quote-batch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tws/option-quote-batch")>();
  return {
    ...actual,
    fetchOptionQuoteBatch: (...args: Parameters<typeof actual.fetchOptionQuoteBatch>) => {
      if (args[2]?.now) state.batchNow.push(args[2].now);
      if (state.batchOverride) return Promise.resolve(state.batchOverride(args[1]));
      return actual.fetchOptionQuoteBatch(...args);
    },
  };
});

vi.mock("@/lib/compute/gains-at-risk-trial", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/gains-at-risk-trial")>();
  return {
    ...actual,
    buildTrialEntryById: (...args: Parameters<typeof actual.buildTrialEntryById>) => {
      state.entryCalls++;
      return actual.buildTrialEntryById(...args);
    },
  };
});

const NOW = "2026-11-10T19:32:00Z"; // Tue 14:32 Eastern
const UNDERLYING_CON_ID = 5001;
const EXPIRY = "2027-03-19";

type Ticks = Array<[number, number]>;

interface FakeOpts {
  optionTicks?: (conId: number) => Ticks;
  /** Moves the clock this far while that snapshot runs (option snapshots, then underlying calls by number). */
  optionAdvanceMs?: number;
  underlyingAdvanceMs?: (call: number) => number;
}

let registry: Map<number, BatchContractRequest>;

function fakeApi(o: FakeOpts = {}) {
  let underlyingCalls = 0;
  return {
    getContractDetails: vi.fn(async (lookup: { conId: number }) => {
      const c = registry.get(lookup.conId);
      if (!c) return [];
      return [
        {
          contract: {
            conId: c.conId,
            symbol: "ZZQ",
            secType: "OPT",
            right: c.right === "put" ? "P" : "C",
            lastTradeDateOrContractMonth: c.expiry.replace(/-/g, ""),
            strike: c.strike,
            multiplier: "100",
            tradingClass: "ZZQ",
          },
        },
      ];
    }),
    getMarketData: vi.fn((c: { secType?: string; conId?: number }) => ({
      subscribe(obs: { next: (u: unknown) => void; complete: () => void }) {
        const isOption = c.secType === SecType.OPT;
        const ticks: Ticks = isOption ? (o.optionTicks?.(c.conId!) ?? [[1, 6.3], [2, 6.5]]) : [[4, 510]];
        const advance = isOption ? (o.optionAdvanceMs ?? 0) : (o.underlyingAdvanceMs?.(++underlyingCalls) ?? 0);
        queueMicrotask(() => {
          if (advance) vi.setSystemTime(new Date(Date.now() + advance));
          obs.next({ all: new Map(ticks.map(([t, v]) => [t, { value: v }])) });
          obs.complete();
        });
        return { unsubscribe: () => {} };
      },
    })),
    setMarketDataType: vi.fn(),
    getSecDefOptParams: vi.fn(),
    getHistoricalData: vi.fn(),
  };
}
let api: ReturnType<typeof fakeApi>;
let zzq: number;

function security(symbol: string, o: { type?: string; conId?: number | null; currency?: string } = {}): number {
  return state.db
    .prepare("INSERT INTO securities (symbol, name, security_type, ib_con_id, currency) VALUES (?, ?, ?, ?, ?)")
    .run(symbol, `${symbol} name`, o.type ?? "ETF", o.conId === undefined ? UNDERLYING_CON_ID : o.conId, o.currency ?? "USD")
    .lastInsertRowid as number;
}

function contract(i: number, patch: Partial<BatchContractRequest> = {}): BatchContractRequest {
  const c: BatchContractRequest = {
    conId: 77000 + i,
    right: "put",
    expiry: EXPIRY,
    strike: 500 - 5 * i,
    multiplier: 100,
    tradingClass: "ZZQ",
    ...patch,
  };
  registry.set(c.conId, c);
  return c;
}

function tableCounts(): Record<string, number> {
  const names = (
    state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const n of names) out[n] = (state.db.prepare(`SELECT COUNT(*) AS n FROM "${n}"`).get() as { n: number }).n;
  return out;
}

function noBrokerRequests(): void {
  expect(api.getContractDetails).not.toHaveBeenCalled();
  expect(api.getMarketData).not.toHaveBeenCalled();
  expect(api.setMarketDataType).not.toHaveBeenCalled();
  expect(api.getSecDefOptParams).not.toHaveBeenCalled();
  expect(api.getHistoricalData).not.toHaveBeenCalled();
}

async function postRaw(raw: string) {
  const { POST } = await import("@/app/api/tws/option-candidates/quotes/route");
  const res = await POST(
    new Request("http://localhost/api/tws/option-candidates/quotes", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    }) as never,
  );
  return { res, body: await res.json() };
}
const post = (b: unknown) => postRaw(JSON.stringify(b));
const validBody = (n = 1) => ({ underlyingSecurityId: zzq, contracts: Array.from({ length: n }, (_, i) => contract(i)) });

describe("POST /api/tws/option-candidates/quotes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
    registry = new Map();
    api = fakeApi();
    state.api = api;
    state.syncing = false;
    state.batchOverride = null;
    state.entryCalls = 0;
    state.batchNow = [];
    zzq = security("ZZQ");
    state.db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-09', 505, 'test')").run(zzq);
    resetOptionQuoteLimiter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    state.db.close();
  });

  it("is a human route", () => {
    expect(classifyRoute("POST", "/api/tws/option-candidates/quotes")).toBe("human");
  });

  it("F2 a two-sided row carries the complete record: brokerContractId === conId, holdings, stale date, underlying price and date, client-quote, appValuation", async () => {
    const before = tableCounts();
    const { res, body } = await post(validBody(1));
    expect(res.status).toBe(200);
    const data = body.data as QuotesResponse;
    expect(data.underlyingSecurityId).toBe(zzq);
    expect(data.requestedConIds).toEqual([77000]);
    expect(data.rows).toHaveLength(1);
    const row = data.rows[0];
    if (row.status !== "quoted") throw new Error(`expected quoted, got ${row.status}`);
    expect(row.quote).toEqual({
      bid: 6.3,
      ask: 6.5,
      mid: 6.4,
      tickKind: "live",
      session: "regular-session",
      optionObservedAt: new Date(NOW).toISOString(),
      underlyingObservedAt: new Date(NOW).toISOString(),
      underlyingPrice: 510,
    });
    const { entry } = row.record;
    expect(row.record.underlyingPriceSource).toBe("client-quote");
    expect(row.record.appValuation).toEqual({ price: 505, date: "2026-11-09", source: "stored-price" });
    expect(entry.ok).toBe(true);
    expect(entry.position).toEqual(
      expect.objectContaining({
        kind: "option",
        underlyingSecurityId: zzq,
        right: "put",
        side: "buy",
        expiry: EXPIRY,
        strike: 500,
        contracts: 1,
        pricePaid: 6.4,
        entryUnderlyingPrice: 510,
        valuationPriceAtEntry: 505,
        brokerContractId: 77000,
      }),
    );
    expect(entry.symbol).toBe("ZZQ");
    expect(entry.underlyingPrice).toBe(510);
    expect(entry.underlyingPriceDate).toBe(todayET());
    expect(entry.underlyingPriceSource).toBe("quote");
    expect(entry.staleCloseDate).toBeNull();
    expect(entry.holdingsAtAddByAccount).toEqual({});
    expect(tableCounts()).toEqual(before);
  });

  it("a below-intrinsic mid is a no-entry row with its sentence; a refused contract is a 200 row", async () => {
    const deep = contract(1, { strike: 600 }); // intrinsic 90 at 510; the mid is 6.4
    const odd = contract(2);
    api = fakeApi({ optionTicks: (conId) => (conId === odd.conId ? [[1, 6.3]] : [[1, 6.3], [2, 6.5]]) });
    state.api = api;
    const { res, body } = await post({ underlyingSecurityId: zzq, contracts: [deep, odd] });
    expect(res.status).toBe(200);
    const [a, b] = body.data.rows;
    expect(a).toEqual(
      expect.objectContaining({ conId: deep.conId, status: "no-entry", refusal: "below-intrinsic" }),
    );
    expect(a.sentence).toBe("That price is below what the option is worth if exercised now. Check the price.");
    expect(a.quote.mid).toBe(6.4);
    expect(b).toEqual({
      conId: odd.conId,
      status: "not-quoted",
      reason: "no-two-sided-quote",
      sentence: batchRefusalSentence("no-two-sided-quote"),
      bid: 6.3,
      ask: null,
    });
  });

  it("F5 a batch row refused prices-too-far-apart comes back not-quoted with that sentence and no entry (spy: 0 entry calls)", async () => {
    // The option takes 40 s; the fresh underlying read then takes 80 s more, so the gap stays over 30 s.
    api = fakeApi({ optionAdvanceMs: 40_000, underlyingAdvanceMs: (n) => (n === 2 ? 80_000 : 0) });
    state.api = api;
    const { res, body } = await post(validBody(1));
    expect(res.status).toBe(200);
    expect(body.data.rows[0]).toEqual(
      expect.objectContaining({
        status: "not-quoted",
        reason: "not-quoted-prices-too-far-apart",
        sentence: "Not quoted: prices read too far apart. Refresh the quotes.",
      }),
    );
    expect(body.data.rows[0].record).toBeUndefined();
    expect(state.entryCalls).toBe(0);
  });

  it("F5 the orchestrator's own check: an ok batch row more than 30 s from its underlying is not-quoted, no entry solved", async () => {
    state.batchOverride = (req) => ({
      ok: true,
      contracts: req.contracts.map((c) => ({
        conId: c.conId,
        ok: true as const,
        bid: 6.3,
        ask: 6.5,
        mid: 6.4,
        last: null,
        tickKind: "live" as const,
        optionObservedAt: "2026-11-10T19:32:31.000Z",
        underlyingObservedAt: "2026-11-10T19:32:00.000Z",
        underlyingPrice: 510,
      })),
    });
    const { body } = await post(validBody(1));
    expect(body.data.rows[0]).toEqual({
      conId: 77000,
      status: "not-quoted",
      reason: "not-quoted-prices-too-far-apart",
      sentence: batchRefusalSentence("not-quoted-prices-too-far-apart"),
      bid: 6.3,
      ask: 6.5,
    });
    expect(state.entryCalls).toBe(0);
  });

  it("F9 the route hands the batch a clock that advances, and the same clock reaches the entry", async () => {
    await post(validBody(1));
    expect(state.batchNow).toHaveLength(1);
    const clock = state.batchNow[0];
    const first = clock().getTime();
    vi.setSystemTime(new Date(Date.parse(NOW) + 5_000));
    expect(clock().getTime()).toBe(first + 5_000);
  });

  it("F9 quoteCandidates: one injected now() reaches the batch and the entry (the entry's today is todayET(now()))", async () => {
    const { quoteCandidates } = await import("@/lib/compute/gains-at-risk-candidate-quotes");
    const at = new Date("2026-11-12T15:00:00Z"); // a different day from the system clock
    const now = vi.fn(() => at);
    const out = await quoteCandidates(state.db, validBody(1), { api: api as never, now });
    if (!out.ok) throw new Error("expected ok");
    const row = out.data.rows[0];
    if (row.status !== "quoted") throw new Error(`expected quoted, got ${row.status}`);
    expect(row.quote.optionObservedAt).toBe(at.toISOString());
    expect(row.record.entry.underlyingPriceDate).toBe(todayET(at));
    expect(row.record.entry.underlyingPriceDate).toBe("2026-11-12");
    expect(now).toHaveBeenCalled();
  });

  it.each([
    ["{"],
    ["[]"],
    ["null"],
    [JSON.stringify({ underlyingSecurityId: 0, contracts: [] })],
  ])("T14 malformed %s: 400 and zero broker requests", async (raw) => {
    const { res, body } = await postRaw(raw);
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    noBrokerRequests();
  });

  it.each([
    ["an id of 0", (b: ReturnType<typeof validBody>) => ({ ...b, underlyingSecurityId: 0 })],
    ["no contracts", (b: ReturnType<typeof validBody>) => ({ ...b, contracts: [] })],
    ["16 contracts", (b: ReturnType<typeof validBody>) => ({ ...b, contracts: Array.from({ length: 16 }, (_, i) => contract(i)) })],
    ["a duplicate conId", (b: ReturnType<typeof validBody>) => ({ ...b, contracts: [contract(0), contract(0)] })],
    ["a past expiry", (b: ReturnType<typeof validBody>) => ({ ...b, contracts: [contract(0, { expiry: "2026-11-09" })] })],
    ["right x", (b: ReturnType<typeof validBody>) => ({ ...b, contracts: [{ ...contract(0), right: "x" }] })],
    ["multiplier 10", (b: ReturnType<typeof validBody>) => ({ ...b, contracts: [{ ...contract(0), multiplier: 10 }] })],
    ["an empty trading class", (b: ReturnType<typeof validBody>) => ({ ...b, contracts: [{ ...contract(0), tradingClass: "" }] })],
    ["a conId of 1.5", (b: ReturnType<typeof validBody>) => ({ ...b, contracts: [{ ...contract(0), conId: 1.5 }] })],
    ["expiry 2027-02-30", (b: ReturnType<typeof validBody>) => ({ ...b, contracts: [{ ...contract(0), expiry: "2027-02-30" }] })],
  ])("T14 malformed (%s): 400 and zero broker requests", async (_label, patch) => {
    const before = tableCounts();
    const { res, body } = await post(patch(validBody(1)));
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(tableCounts()).toEqual(before);
    noBrokerRequests();
  });

  it("T14 unknown, option, non-dollar and contract-less securities: 422, zero broker requests", async () => {
    const ids = [
      99999,
      security("ZZQ 270319P00500000", { type: "Option", conId: 9 }),
      security("ZZJP", { currency: "JPY" }),
      security("ZZNC", { conId: null }),
    ];
    for (const id of ids) {
      const { res, body } = await post({ ...validBody(1), underlyingSecurityId: id });
      expect(res.status).toBe(422);
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
    }
    noBrokerRequests();
  });

  it("T14 not connected 503 and a running sync 409, each with zero broker requests", async () => {
    state.api = null;
    const off = await post(validBody(1));
    expect(off.res.status).toBe(503);
    expect(off.body).toEqual({ success: false, error: "Connect the broker to fetch quotes." });

    state.api = api;
    state.syncing = true;
    const sync = await post(validBody(1));
    expect(sync.res.status).toBe(409);
    expect(sync.body).toEqual({ success: false, error: "A sync is running. Try again in a moment." });
    noBrokerRequests();
  });

  it("D7 no free quote slot: 429 with Retry-After and zero broker requests", async () => {
    expect(reserveOptionQuoteSlots(OPTION_QUOTE_RATE_LIMIT).granted).toBe(OPTION_QUOTE_RATE_LIMIT);
    const { res, body } = await post(validBody(2));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(body).toEqual({ success: false, error: "Too many quotes in a minute. Try again in 60 seconds." });
    noBrokerRequests();
  });

  it("D7 fewer free slots than asked: the rest are 200 rows not-quoted-rate-limit with the retry time", async () => {
    reserveOptionQuoteSlots(OPTION_QUOTE_RATE_LIMIT - 1);
    const { res, body } = await post(validBody(3));
    expect(res.status).toBe(200);
    expect(body.data.rows.map((r: { status: string }) => r.status)).toEqual(["quoted", "not-quoted", "not-quoted"]);
    expect(body.data.rows[1]).toEqual(
      expect.objectContaining({ reason: "not-quoted-rate-limit", retryAfterSeconds: 60, sentence: batchRefusalSentence("not-quoted-rate-limit", 60) }),
    );
  });

  it("the quote lock could not be had in time (batch broker-busy): 503 with Retry-After 20 and its own sentence", async () => {
    state.batchOverride = () => ({ ok: false, reason: "broker-busy" });
    const { res, body } = await post(validBody(1));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("20");
    expect(QUOTE_LOCK_BUSY_RETRY_AFTER_SECONDS).toBe(OPTION_QUOTE_LOCK_WAIT_MS / 1000);
    expect(body).toEqual({ success: false, error: "The broker was busy with another request. Try again in a moment." });
  });

  it("fix 1: an expiry past three years, and today's expiry after the 16:00 close, are 400 with zero broker requests", async () => {
    for (const expiry of ["9999-12-31", "2029-11-11"]) {
      const { res, body } = await post({ underlyingSecurityId: zzq, contracts: [contract(0, { expiry })] });
      expect(res.status).toBe(400);
      expect(body.error).toContain("contracts[0].expiry");
    }
    vi.setSystemTime(new Date("2026-11-10T21:00:00Z")); // 16:00 Eastern
    const late = await post({ underlyingSecurityId: zzq, contracts: [contract(0, { expiry: "2026-11-10" })] });
    expect(late.res.status).toBe(400);
    expect(late.body.error).toContain("contracts[0].expiry");
    noBrokerRequests();
  });

  it("fix 1: three years to the day passes, and today's expiry before the close reaches the broker", async () => {
    expect((await post({ underlyingSecurityId: zzq, contracts: [contract(0, { expiry: "2029-11-09" })] })).res.status).toBe(200);
    vi.setSystemTime(new Date("2026-11-10T20:59:00Z")); // 15:59 Eastern
    const { res } = await post({ underlyingSecurityId: zzq, contracts: [contract(1, { expiry: "2026-11-10" })] });
    expect(res.status).toBe(200);
    expect(api.getMarketData).toHaveBeenCalled();
  });

  it.each([["ZZ-Q"], ["A".repeat(13)], [" ZZQ"], [7]])("fix 5: tradingClass %o is 400 naming the field, zero broker requests", async (tradingClass) => {
    const { res, body } = await post({ underlyingSecurityId: zzq, contracts: [{ ...contract(0), tradingClass }] });
    expect(res.status).toBe(400);
    expect(body.error).toContain("contracts[0].tradingClass");
    noBrokerRequests();
  });

  it("every batch refusal kind has a sentence", () => {
    for (const r of [
      "not-standard-contract",
      "not-quoted-rate-limit",
      "not-quoted-timed-out",
      "broker-disconnected",
      "not-quoted-broker-busy",
      "not-quoted-sync-running",
      "not-quoted-prices-too-far-apart",
      "not-quoted-no-underlying-price",
      "off-tick-grid",
      "no-two-sided-quote",
      "timeout",
      "broker-error",
    ] as const) {
      expect(batchRefusalSentence(r).length).toBeGreaterThan(5);
      expect(batchRefusalSentence(r)).not.toMatch(/\bhedges?\b/i);
    }
  });

  it("an internal failure answers 500 with a fixed sentence and one content-free log line", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(state.db, "prepare").mockImplementation(() => {
      throw new Error("SQLITE_ERROR: zz_secret_detail");
    });
    const { res, body } = await post(validBody(1));
    expect(res.status).toBe(500);
    expect(body).toEqual({ success: false, error: "Could not fetch the quotes." });
    expect(err.mock.calls).toEqual([["[option-candidates-quotes] failed"]]);
  });
});
