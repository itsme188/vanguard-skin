/**
 * POST /api/tws/option-quote (Gains at risk step 2, Task S3, rulings R8, R10, P9, P10).
 *
 * Body { underlyingSecurityId, right, expiry, strike }. The body is checked,
 * then the underlying on the server (non-option, US dollar, broker contract
 * on file), and only then is the broker asked. A refusal sends zero broker
 * requests and writes nothing. A fake IB API and a migrated in-memory
 * database; no TWS connection. Synthetic ZZ* tickers only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { SecType } from "@stoqey/ib";
import { runMigrations } from "@/lib/db/migrate";
import { classifyRoute } from "@/lib/auth/route-policy";
import { optionQuoteBodyProblem } from "@/lib/analysis/gains-at-risk-input";
import { OPTION_QUOTE_RATE_LIMIT, resetOptionQuoteLimiter } from "@/lib/tws/option-quote";

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

function fakeApi(optionTicks: Array<[number, number]> = [[1, 6.3], [2, 6.5], [4, 6.1]]) {
  return {
    getContractDetails: vi.fn(async () => [{ contract: { conId: 77001, multiplier: 100, tradingClass: "ZZQ" } }]),
    getMarketDataSnapshot: vi.fn(async (c: { secType?: string }) =>
      new Map(
        (c.secType === SecType.OPT ? optionTicks : ([[4, 510]] as Array<[number, number]>)).map(([t, v]) => [t, { value: v }]),
      ),
    ),
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
  expect(api.getMarketDataSnapshot).not.toHaveBeenCalled();
  expect(api.getHistoricalData).not.toHaveBeenCalled();
  expect(api.setMarketDataType).not.toHaveBeenCalled();
}

async function postRaw(raw: string) {
  const { POST } = await import("@/app/api/tws/option-quote/route");
  const res = await POST(
    new Request("http://localhost/api/tws/option-quote", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    }) as never,
  );
  return { res, body: await res.json() };
}
const post = (b: unknown) => postRaw(JSON.stringify(b));
const validBody = () => ({ underlyingSecurityId: zzq, right: "put", expiry: "2027-03-19", strike: 500 });

describe("POST /api/tws/option-quote", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
    api = fakeApi();
    state.api = api;
    zzq = security("ZZQ");
    resetOptionQuoteLimiter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    state.db.close();
  });

  it("503 when not connected; 200 with the result and the session label", async () => {
    state.api = null;
    const off = await post(validBody());
    expect(off.res.status).toBe(503);
    expect(off.body).toEqual({ success: false, error: "Connect the broker to fetch quotes." });

    state.api = api;
    const { res, body } = await post(validBody());
    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        request: validBody(),
        quote: {
          ok: true,
          bid: 6.3,
          ask: 6.5,
          mid: 6.4,
          last: 6.1,
          underlyingLast: 510,
          tickKind: "live",
          fetchedAt: new Date(NOW).toISOString(),
        },
        session: "regular-session",
      },
    });
  });

  it("after the close the session label is market-closed", async () => {
    vi.setSystemTime(new Date("2026-11-10T22:00:00Z")); // 17:00 Eastern
    const { body } = await post(validBody());
    expect(body.data.session).toBe("market-closed");
    expect(body.data.quote.ok).toBe(true);
  });

  it("a one-sided quote answers 200 with no price filled", async () => {
    api = fakeApi([[1, 6.3]]);
    state.api = api;
    const { res, body } = await post(validBody());
    expect(res.status).toBe(200);
    expect(body.data.quote).toEqual({ ok: false, reason: "no-two-sided-quote", bid: 6.3, ask: null, last: null });
  });

  it.each([
    "{",
    "[]",
    "null",
    '{"securityId":0}',
    '{"securityId":1.5}',
    '{"underlyingSecurityId":1,"right":"X"}',
    '{"underlyingSecurityId":1,"right":"put","expiry":"2026-02-30","strike":5}',
    '{"underlyingSecurityId":1,"right":"put","expiry":"2027-01-15","strike":-1}',
    '{"underlyingSecurityId":1,"right":"put","expiry":"2027-01-15","strike":0}',
    '{"underlyingSecurityId":1,"right":"put","expiry":"2027-01-15","strike":100001}',
    '{"underlyingSecurityId":1,"right":"put","expiry":"20270115","strike":5}',
    '{"underlyingSecurityId":0,"right":"put","expiry":"2027-01-15","strike":5}',
    '{"underlyingSecurityId":"1","right":"put","expiry":"2027-01-15","strike":5}',
    '{"underlyingSecurityId":1,"right":"P","expiry":"2027-01-15","strike":5}',
    '{"underlyingSecurityId":1,"right":"put","expiry":"2026-11-09","strike":5}', // before today
  ])("a malformed body %s answers 400 with zero broker requests and zero writes", async (raw) => {
    const before = tableCounts();
    const { res, body } = await postRaw(raw);
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(tableCounts()).toEqual(before);
    noBrokerRequests();
  });

  it("the body check refuses a non-finite strike (checked directly: JSON cannot carry one)", () => {
    for (const strike of [Infinity, NaN]) {
      expect(optionQuoteBodyProblem({ underlyingSecurityId: 1, right: "put", expiry: "2027-01-15", strike })).toContain("strike");
    }
    expect(optionQuoteBodyProblem({ underlyingSecurityId: 1, right: "call", expiry: "2027-01-15", strike: 5 })).toBeNull();
  });

  it("an option row, a non-USD row and a row with no contract id are refused 422 before any broker request", async () => {
    const ids = [
      security("ZZQ 270319P00500000", { type: "Option", conId: 9 }),
      security("ZZJP", { currency: "JPY" }),
      security("ZZNC", { conId: null }),
      99999,
    ];
    const before = tableCounts();
    for (const id of ids) {
      const { res, body } = await post({ ...validBody(), underlyingSecurityId: id });
      expect(res.status).toBe(422);
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
    }
    expect(tableCounts()).toEqual(before);
    noBrokerRequests();
  });

  it("writes nothing on a successful quote", async () => {
    const before = tableCounts();
    await post(validBody());
    expect(tableCounts()).toEqual(before);
    expect(api.getHistoricalData).not.toHaveBeenCalled();
  });

  it("an internal failure answers 500 with a fixed sentence and one content-free log line", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(state.db, "prepare").mockImplementation(() => {
      throw new Error("SQLITE_ERROR: zz_secret_detail");
    });
    const { res, body } = await post(validBody());
    expect(res.status).toBe(500);
    expect(body).toEqual({ success: false, error: "Could not fetch the quote." });
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]).toEqual(["[option-quote] failed"]);
  });

  it("beyond 30 quotes in 60 seconds: 429 with Retry-After and a plain sentence, zero broker requests", async () => {
    for (let i = 0; i < OPTION_QUOTE_RATE_LIMIT; i++) {
      expect((await post(validBody())).res.status).toBe(200);
    }
    api = fakeApi();
    state.api = api;
    const { res, body } = await post(validBody());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(body).toEqual({ success: false, error: "Too many quotes in a minute. Try again in 60 seconds." });
    noBrokerRequests();
    // A malformed body or a refused security never uses a slot, and is still answered first.
    expect((await postRaw("{")).res.status).toBe(400);
    // Sixty seconds on, the window has rolled.
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    expect((await post(validBody())).res.status).toBe(200);
  });

  it("is a human route", () => {
    expect(classifyRoute("POST", "/api/tws/option-quote")).toBe("human");
  });
});
