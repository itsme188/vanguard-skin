/**
 * POST /api/tws/option-candidates/chain (Gains at risk step 3, Task S4: P11, D1, D7, T14).
 *
 * Order: the body (400), the underlying on the server (422), the connection
 * (503), then the reader's own bound (429 with Retry-After) before any broker
 * request; a broker timeout 504, a broker error 502. A fake IB API and a
 * migrated in-memory database; no TWS connection. Synthetic ZZ* tickers and
 * invented figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { classifyRoute } from "@/lib/auth/route-policy";
import { OPTION_CHAIN_RATE_LIMIT, resetOptionChainLimiter, reserveOptionChainSlots } from "@/lib/tws/option-chain-reader";
import { defaultCandidateStrikes, type ChainResponse } from "@/lib/analysis/gains-at-risk-candidates-input";

const state = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  api: null as unknown,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(() => state.api),
}));

const NOW = "2026-11-10T19:32:00Z"; // Tue 14:32 Eastern
const STRIKES = [480, 485, 490, 495, 500, 505, 510, 515, 520];

function fakeApi(o: { details?: () => Promise<unknown[]> } = {}) {
  return {
    getSecDefOptParams: vi.fn(async () => [
      { exchange: "SMART", tradingClass: "ZZQ", multiplier: "100", expirations: ["20261218", "20261106", "20270115", "20261218"], strikes: STRIKES },
      { exchange: "SMART", tradingClass: "2ZZQ", multiplier: "100", expirations: ["20261120"], strikes: STRIKES },
    ]),
    getContractDetails: vi.fn(
      o.details ??
        (async (lookup: { lastTradeDateOrContractMonth: string; right: string }) =>
          STRIKES.map((strike, i) => ({
            contract: {
              conId: 80000 + i,
              symbol: "ZZQ",
              right: lookup.right,
              lastTradeDateOrContractMonth: lookup.lastTradeDateOrContractMonth,
              strike,
              multiplier: "100",
              tradingClass: "ZZQ",
            },
          }))),
    ),
    getMarketData: vi.fn(),
    setMarketDataType: vi.fn(),
    getHistoricalData: vi.fn(),
  };
}
let api: ReturnType<typeof fakeApi>;
let zzq: number;

function security(symbol: string, o: { type?: string; conId?: number | null; currency?: string } = {}): number {
  return state.db
    .prepare("INSERT INTO securities (symbol, name, security_type, ib_con_id, currency) VALUES (?, ?, ?, ?, ?)")
    .run(symbol, `${symbol} name`, o.type ?? "ETF", o.conId === undefined ? 5001 : o.conId, o.currency ?? "USD")
    .lastInsertRowid as number;
}

function noBrokerRequests(): void {
  expect(api.getSecDefOptParams).not.toHaveBeenCalled();
  expect(api.getContractDetails).not.toHaveBeenCalled();
  expect(api.getMarketData).not.toHaveBeenCalled();
  expect(api.setMarketDataType).not.toHaveBeenCalled();
}

async function postRaw(raw: string) {
  const { POST } = await import("@/app/api/tws/option-candidates/chain/route");
  const res = await POST(
    new Request("http://localhost/api/tws/option-candidates/chain", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    }) as never,
  );
  return { res, body: await res.json() };
}
const post = (b: unknown) => postRaw(JSON.stringify(b));

describe("POST /api/tws/option-candidates/chain", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
    api = fakeApi();
    state.api = api;
    zzq = security("ZZQ");
    state.db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-09', 507, 'test')").run(zzq);
    resetOptionChainLimiter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    state.db.close();
  });

  it("is a human route", () => {
    expect(classifyRoute("POST", "/api/tws/option-candidates/chain")).toBe("human");
  });

  it("expiries: today or later, the standard class only, ascending, unique", async () => {
    const { res, body } = await post({ underlyingSecurityId: zzq, right: "put" });
    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      kind: "expiries",
      underlyingSecurityId: zzq,
      right: "put",
      expiries: ["2026-12-18", "2027-01-15"],
    } satisfies ChainResponse);
    expect(api.getSecDefOptParams).toHaveBeenCalledTimes(1);
  });

  it("strikes: each expiry's contracts, and defaultConIds the five nearest out-of-the-money strikes", async () => {
    const { res, body } = await post({ underlyingSecurityId: zzq, right: "put", expiries: ["2026-12-18", "2027-01-15"] });
    expect(res.status).toBe(200);
    const data = body.data as Extract<ChainResponse, { kind: "strikes" }>;
    expect(data.kind).toBe("strikes");
    expect(data.valuationPrice).toBe(507);
    expect(data.valuationPriceDate).toBe("2026-11-09");
    expect(data.byExpiry.map((e) => e.expiry)).toEqual(["2026-12-18", "2027-01-15"]);
    for (const e of data.byExpiry) {
      expect(e.contracts.map((c) => c.strike)).toEqual(STRIKES);
      expect(e.contracts[0]).toEqual({ conId: 80000, strike: 480, tradingClass: "ZZQ", multiplier: 100 });
      // Puts below 507: 505, 500, 495, 490, 485 (480 is the sixth).
      const byConId = new Map(e.contracts.map((c) => [c.conId, c.strike]));
      expect(e.defaultConIds.map((id) => byConId.get(id))).toEqual([485, 490, 495, 500, 505]);
      expect(e.droppedNonStandard).toBe(0);
      expect(e.droppedAmbiguous).toBe(0);
    }
    expect(api.getContractDetails).toHaveBeenCalledTimes(2);
  });

  it("calls take the strikes strictly above the price; no price, no defaults", () => {
    const contracts = STRIKES.map((strike, i) => ({ conId: i + 1, strike, tradingClass: "ZZQ", multiplier: 100 as const }));
    expect(defaultCandidateStrikes(contracts, 505, "call")).toEqual([510, 515, 520]);
    expect(defaultCandidateStrikes(contracts, 505, "put")).toEqual([480, 485, 490, 495, 500]);
    expect(defaultCandidateStrikes(contracts, null, "put")).toEqual([]);
    expect(defaultCandidateStrikes(contracts, 500, "put", 2)).toEqual([490, 495]);
  });

  it.each([
    ["{"],
    ["[]"],
    ["null"],
    [JSON.stringify({ underlyingSecurityId: 0, right: "put" })],
    [JSON.stringify({ underlyingSecurityId: 1.5, right: "put" })],
    [JSON.stringify({ underlyingSecurityId: 1, right: "x" })],
    [JSON.stringify({ underlyingSecurityId: 1, right: "put", expiries: [] })],
    [JSON.stringify({ underlyingSecurityId: 1, right: "put", expiries: ["2026-12-18", "2027-01-15", "2027-02-19", "2027-03-19"] })],
    [JSON.stringify({ underlyingSecurityId: 1, right: "put", expiries: ["2026-11-09"] })],
    [JSON.stringify({ underlyingSecurityId: 1, right: "put", expiries: ["2026-12-18", "2026-12-18"] })],
    [JSON.stringify({ underlyingSecurityId: 1, right: "put", expiries: ["20261218"] })],
    [JSON.stringify({ underlyingSecurityId: 1, right: "put", expiries: "2026-12-18" })],
  ])("T14 malformed %s: 400 and zero broker requests", async (raw) => {
    const { res, body } = await postRaw(raw);
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    noBrokerRequests();
  });

  it("fix 1: an expiry past three years, and today's after the 16:00 close, are 400 with zero broker requests", async () => {
    for (const expiries of [["9999-12-31"], ["2026-12-18", "2029-11-11"]]) {
      const { res, body } = await post({ underlyingSecurityId: zzq, right: "put", expiries });
      expect(res.status).toBe(400);
      expect(body.error).toContain("expiries[");
    }
    vi.setSystemTime(new Date("2026-11-10T21:30:00Z")); // 16:30 Eastern
    const late = await post({ underlyingSecurityId: zzq, right: "put", expiries: ["2026-11-10"] });
    expect(late.res.status).toBe(400);
    expect(late.body.error).toContain("expiries[0]");
    noBrokerRequests();
  });

  it("fix 1: today's expiry before the close is accepted", async () => {
    vi.setSystemTime(new Date("2026-11-10T20:30:00Z")); // 15:30 Eastern
    const { res } = await post({ underlyingSecurityId: zzq, right: "put", expiries: ["2026-11-10"] });
    expect(res.status).toBe(200);
    expect(api.getContractDetails).toHaveBeenCalledTimes(1);
  });

  it("T14 unknown, option, non-dollar and contract-less securities: 422, zero broker requests", async () => {
    const ids = [
      99999,
      security("ZZQ 270319P00500000", { type: "Option", conId: 9 }),
      security("ZZJP", { currency: "JPY" }),
      security("ZZNC", { conId: null }),
    ];
    for (const id of ids) {
      const { res, body } = await post({ underlyingSecurityId: id, right: "put" });
      expect(res.status).toBe(422);
      expect(body.success).toBe(false);
    }
    noBrokerRequests();
  });

  it("T14 not connected: 503, zero broker requests", async () => {
    state.api = null;
    const { res, body } = await post({ underlyingSecurityId: zzq, right: "put" });
    expect(res.status).toBe(503);
    expect(body).toEqual({ success: false, error: "Connect the broker to fetch quotes." });
    noBrokerRequests();
  });

  it("D7 over the chain bound: 429 with Retry-After, zero broker requests", async () => {
    expect(reserveOptionChainSlots(OPTION_CHAIN_RATE_LIMIT - 2).ok).toBe(true);
    const { res, body } = await post({ underlyingSecurityId: zzq, right: "put", expiries: ["2026-12-18", "2027-01-15", "2027-02-19"] });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(body).toEqual({ success: false, error: "Too many option-chain requests in a minute. Try again in 60 seconds." });
    noBrokerRequests();
  });

  it("a broker timeout is 504 and a broker error 502", async () => {
    const { QuoteTimeout } = await import("@/lib/tws/option-quote");
    api = fakeApi({ details: () => Promise.reject(new QuoteTimeout()) });
    state.api = api;
    const slow = await post({ underlyingSecurityId: zzq, right: "put", expiries: ["2026-12-18"] });
    expect(slow.res.status).toBe(504);

    api = fakeApi({ details: () => Promise.reject(Object.assign(new Error("zz boom"), { code: 321 })) });
    state.api = api;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = await post({ underlyingSecurityId: zzq, right: "put", expiries: ["2026-12-18"] });
    expect(bad.res.status).toBe(502);
    expect(bad.body).toEqual({ success: false, error: "The broker could not answer. Try again." });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("zz boom");
  });
});
