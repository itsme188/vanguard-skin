/**
 * POST /api/tws/daily-bars/ensure (Gains at risk step 2, Task S3, rulings R9 and P9).
 *
 * Body { securityId }. The body is checked, then the security on the server
 * (non-option, US dollar, broker contract on file), and only then is the
 * one-security capture run. A refusal sends zero broker requests and writes
 * nothing. A fake IB API, a fake bar fetcher and a migrated in-memory
 * database; no TWS connection. Synthetic ZZ* tickers only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { classifyRoute } from "@/lib/auth/route-policy";
import { addDays } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";
import type { FetchOhlcvOptions, FetchOhlcvResult } from "@/lib/tws/ohlcv";

const state = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  api: null as unknown,
  fetchCalls: [] as unknown[],
  fetchFails: false,
  /** When set, the ensure call answers this instead of running. */
  ensureAnswer: null as unknown,
}));

vi.mock("@/lib/tws/daily-bar-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tws/daily-bar-capture")>();
  return {
    ...actual,
    ensureDailyBarsForSecurity: (...args: Parameters<typeof actual.ensureDailyBarsForSecurity>) =>
      state.ensureAnswer !== null ? Promise.resolve(state.ensureAnswer) : actual.ensureDailyBarsForSecurity(...args),
  };
});

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(() => state.api),
}));

vi.mock("@/lib/tws/ohlcv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tws/ohlcv")>();
  return {
    ...actual,
    fetchOhlcvBars: vi.fn(async (_db: Database.Database, opts: FetchOhlcvOptions): Promise<FetchOhlcvResult> => {
      state.fetchCalls.push(opts);
      if (state.fetchFails) throw new Error("Timeout after 30s");
      const out: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
      for (let d = addDays("2026-11-10", -730); d <= "2026-11-10"; d = addDays(d, 1)) {
        if (!isMarketClosed(d)) out.push({ date: d, open: 100, high: 100, low: 100, close: 100, volume: 100 });
      }
      const bars = opts.maxBarDate ? actual.storableDailyBars(out, opts.maxBarDate) : out;
      return { bars, barsInserted: 0, fromCache: false, symbol: "ZZ" };
    }),
  };
});

const NOW = "2026-11-10T15:00:00Z";

function fakeApi() {
  return {
    getContractDetails: vi.fn(),
    getMarketDataSnapshot: vi.fn(),
    setMarketDataType: vi.fn(),
    getHistoricalData: vi.fn(),
  };
}
let api: ReturnType<typeof fakeApi>;

function security(symbol: string, o: { type?: string; conId?: number | null; currency?: string } = {}): number {
  return state.db
    .prepare("INSERT INTO securities (symbol, name, security_type, ib_con_id, currency) VALUES (?, ?, ?, ?, ?)")
    .run(symbol, `${symbol} name`, o.type ?? "Stock", o.conId === undefined ? 4000 + symbol.length : o.conId, o.currency ?? "USD")
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
  expect(state.fetchCalls).toEqual([]);
}

async function postRaw(raw: string) {
  const { POST } = await import("@/app/api/tws/daily-bars/ensure/route");
  const res = await POST(
    new Request("http://localhost/api/tws/daily-bars/ensure", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    }) as never,
  );
  return { res, body: await res.json() };
}
const post = (b: unknown) => postRaw(JSON.stringify(b));

type G = { __tws_dailyBarLedger?: unknown; __tws_dailyBarRunning?: boolean; __tws_dailyBarEnsureFailures?: unknown; __tws_dailyBarLastBatchAt?: number };
const gl = globalThis as unknown as G;

describe("POST /api/tws/daily-bars/ensure", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
    api = fakeApi();
    state.api = api;
    state.fetchCalls = [];
    state.fetchFails = false;
    state.ensureAnswer = null;
    delete gl.__tws_dailyBarLedger;
    delete gl.__tws_dailyBarRunning;
    delete gl.__tws_dailyBarEnsureFailures;
    delete gl.__tws_dailyBarLastBatchAt;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    state.db.close();
    delete gl.__tws_dailyBarRunning;
  });

  it("fetches one security's daily bars: 200 with the outcome", async () => {
    const id = security("ZZA");
    const { res, body } = await post({ securityId: id });
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { securityId: id, result: { ok: true, outcome: "succeeded" } } });
    expect(state.fetchCalls).toHaveLength(1);
    const n = (state.db.prepare("SELECT COUNT(*) AS n FROM ohlcv_bars WHERE security_id = ?").get(id) as { n: number }).n;
    expect(n).toBeGreaterThan(400);

    // A second click the same day sends nothing.
    const again = await post({ securityId: id });
    expect(again.body.data.result).toEqual({ ok: true, outcome: "already-today" });
    expect(state.fetchCalls).toHaveLength(1);
  });

  it("503 when not connected", async () => {
    const id = security("ZZA");
    state.api = null;
    const before = tableCounts();
    const { res, body } = await post({ securityId: id });
    expect(res.status).toBe(503);
    expect(body).toEqual({ success: false, error: "Connect the broker to fetch daily prices." });
    expect(tableCounts()).toEqual(before);
    noBrokerRequests();
  });

  it("ensure: 409 while a batch runs, 422 for an ineligible security", async () => {
    const id = security("ZZA");
    gl.__tws_dailyBarRunning = true;
    const busy = await post({ securityId: id });
    expect(busy.res.status).toBe(409);
    expect(busy.body.success).toBe(false);
    expect(busy.body.error).toContain("try again in a moment");
    delete gl.__tws_dailyBarRunning;

    const fund = security("ZZMF", { type: "Mutual Fund" });
    const before = tableCounts();
    const ineligible = await post({ securityId: fund });
    expect(ineligible.res.status).toBe(422);
    expect(ineligible.body.success).toBe(false);
    expect(typeof ineligible.body.error).toBe("string");
    expect(tableCounts()).toEqual(before);
    noBrokerRequests();
  });

  it("502 for a failed fetch, then 429 while the name cools down", async () => {
    const id = security("ZZA");
    state.fetchFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = await post({ securityId: id });
    expect(failed.res.status).toBe(502);
    expect(failed.body).toEqual({ success: false, error: "The broker did not send daily prices for ZZA. Try again later." });
    const cooling = await post({ securityId: id });
    expect(cooling.res.status).toBe(429);
    expect(cooling.body.error).toMatch(/Try again in 10 minutes\.$/);
    expect(state.fetchCalls).toHaveLength(1);
    warn.mockRestore();
  });

  it.each([
    "{",
    "[]",
    "null",
    "{}",
    '{"securityId":0}',
    '{"securityId":1.5}',
    '{"securityId":-3}',
    '{"securityId":"7"}',
    '{"securityId":9007199254740993}',
    '{"underlyingSecurityId":1,"right":"X"}',
    '{"underlyingSecurityId":1,"right":"put","expiry":"2026-02-30","strike":5}',
    '{"underlyingSecurityId":1,"right":"put","expiry":"2027-01-15","strike":-1}',
  ])("a malformed body %s answers 400 with zero broker requests and zero writes", async (raw) => {
    security("ZZA");
    const before = tableCounts();
    const { res, body } = await postRaw(raw);
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(tableCounts()).toEqual(before);
    noBrokerRequests();
  });

  it("an option row, a non-USD row and a row with no contract id are refused 422 before any broker request", async () => {
    const ids = [
      security("ZZQ 270319P00500000", { type: "Option" }),
      security("ZZJP", { currency: "JPY" }),
      security("ZZNC", { conId: null }),
      99999, // no such row
    ];
    const before = tableCounts();
    for (const id of ids) {
      const { res, body } = await post({ securityId: id });
      expect(res.status).toBe(422);
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
    }
    expect(tableCounts()).toEqual(before);
    noBrokerRequests();
  });

  it("an internal failure answers 500 with a fixed sentence and one content-free log line", async () => {
    const id = security("ZZA");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(state.db, "prepare").mockImplementation(() => {
      throw new Error("SQLITE_ERROR: zz_secret_detail");
    });
    const { res, body } = await post({ securityId: id });
    expect(res.status).toBe(500);
    expect(body).toEqual({ success: false, error: "Could not fetch daily prices." });
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]).toEqual(["[daily-bars-ensure] failed"]);
  });

  it("an ineligible answer with no reason, and an unrecognised refusal, never guess a reason", async () => {
    const id = security("ZZA");
    state.ensureAnswer = { ok: false, reason: "ineligible" };
    const noReason = await post({ securityId: id });
    expect(noReason.res.status).toBe(422);
    expect(noReason.body).toEqual({ success: false, error: "This security cannot be fetched." });
    expect(noReason.body.error).not.toContain("US session");

    state.ensureAnswer = { ok: false, reason: "zz-new-refusal" };
    const unknown = await post({ securityId: id });
    expect(unknown.res.status).toBe(422);
    expect(unknown.body).toEqual({ success: false, error: "This security cannot be fetched." });

    state.ensureAnswer = { ok: false, reason: "ineligible", ineligibleReason: "zz-new-reason" };
    expect((await post({ securityId: id })).body.error).toBe("This security cannot be fetched.");

    state.ensureAnswer = { ok: false, reason: "ineligible", ineligibleReason: "mutual-fund" };
    expect((await post({ securityId: id })).body.error).toBe("Daily prices are not fetched for ZZA: it is a mutual fund, priced once a day.");
  });

  it("is a human route", () => {
    expect(classifyRoute("POST", "/api/tws/daily-bars/ensure")).toBe("human");
  });
});
