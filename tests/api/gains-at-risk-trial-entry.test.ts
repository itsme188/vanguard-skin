/**
 * POST /api/compute/gains-at-risk/trial-entry (Gains at risk step 2, Task S3,
 * rulings R1, R10, P1, P9, P11).
 *
 * The one place a trial position is fixed: `lookup` finds a name the app
 * knows; `entry` solves a typed option price once, at the click, and records
 * the holdings snapshot. Nothing is stored and nothing reaches the broker.
 * Synthetic ZZ* tickers and round numbers only. Clock fixed at
 * 2026-11-10 15:00 UTC (10:00 Eastern).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { classifyRoute } from "@/lib/auth/route-policy";
import { buildTrialEntry, trialValuationPrice } from "@/lib/compute/gains-at-risk-trial";
import { trialEntryBodyProblem } from "@/lib/analysis/gains-at-risk-input";

const state = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  api: {
    getContractDetails: (() => {}) as (...a: unknown[]) => unknown,
    getMarketDataSnapshot: (() => {}) as (...a: unknown[]) => unknown,
    getHistoricalData: (() => {}) as (...a: unknown[]) => unknown,
  },
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(() => state.api),
}));

const NOW = "2026-11-10T15:00:00Z";
const TODAY = "2026-11-10";
const IBKR = 3;

let zzq: number;

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

async function postRaw(raw: string) {
  const { POST } = await import("@/app/api/compute/gains-at-risk/trial-entry/route");
  const res = await POST(
    new Request("http://localhost/api/compute/gains-at-risk/trial-entry", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    }) as never,
  );
  return { res, body: await res.json() };
}
const post = (b: unknown) => postRaw(JSON.stringify(b));

const optionRequest = (patch: Record<string, unknown> = {}) => ({
  kind: "option",
  symbol: "ZZQ",
  right: "put",
  side: "buy",
  expiry: "2027-03-19",
  strike: 480,
  contracts: 2,
  price: 20,
  ...patch,
});

describe("POST /api/compute/gains-at-risk/trial-entry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
    state.api = {
      getContractDetails: vi.fn(),
      getMarketDataSnapshot: vi.fn(),
      getHistoricalData: vi.fn(),
    };
    zzq = state.db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency, ib_con_id) VALUES ('ZZQ', 'ZZQ Fund', 'ETF', 'USD', 5001)")
      .run().lastInsertRowid as number;
    state.db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-09', 500, 'test')").run(zzq);
    // The exact contract, held in the IBKR account: the snapshot must count it.
    const put = state.db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, currency, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
         VALUES ('ZZQ 270319P00480000', 'ZZQ put', 'Option', 'USD', 'ZZQ', 480, '2027-03-19', 'PUT', 100)`,
      )
      .run().lastInsertRowid as number;
    state.db
      .prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, 3, 'tws-zz-1')")
      .run(IBKR, put, TODAY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    state.db.close();
  });

  it("lookup: a known symbol, and the R10 sentence for an unknown one", async () => {
    const known = await post({ action: "lookup", symbol: " zzq " });
    expect(known.res.status).toBe(200);
    expect(known.body).toEqual({
      success: true,
      data: {
        action: "lookup",
        security: {
          securityId: zzq,
          symbol: "ZZQ",
          name: "ZZQ Fund",
          price: 500,
          priceDate: "2026-11-09",
          priceSource: "book",
          hasContractId: true,
          dailyBars: { count: 0, through: null },
        },
      },
    });

    const { res, body } = await post({ action: "lookup", symbol: "zzzz" });
    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error).toBe("The app does not know ZZZZ yet. Add it to the watchlist first.");
  });

  it("lookup refuses a name priced in another currency", async () => {
    state.db.prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZZJP', 'ZZ Japan', 'Stock', 'JPY')").run();
    const { res, body } = await post({ action: "lookup", symbol: "ZZJP" });
    expect(res.status).toBe(422);
    expect(body.error).toBe("ZZJP is not priced in US dollars. Trial positions are US-dollar only.");
  });

  it("entry: an option record with the solved volatility and the holdings snapshot; an unsolvable price is 422", async () => {
    const before = tableCounts();
    const { res, body } = await post({ action: "entry", request: optionRequest() });
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    const direct = buildTrialEntry(state.db, optionRequest() as never, { today: TODAY, now: new Date(NOW) });
    expect(direct.ok).toBe(true);
    // The entry is buildTrialEntry's own record, untouched, with the app's valuation price beside it.
    expect(body.data).toEqual({
      action: "entry",
      entry: JSON.parse(JSON.stringify(direct)),
      underlyingPriceSource: "book",
      appValuation: { price: 500, date: "2026-11-09", source: "book" },
    });
    expect(body.data.appValuation).toEqual(trialValuationPrice(state.db, zzq, { today: TODAY }));
    const entry = body.data.entry;
    expect(entry.position).toMatchObject({
      kind: "option",
      underlyingSecurityId: zzq,
      right: "put",
      side: "buy",
      expiry: "2027-03-19",
      strike: 480,
      contracts: 2,
      pricePaid: 20,
      entryUnderlyingPrice: 500,
    });
    expect(entry.position.entryVolatility).toBeGreaterThan(0);
    expect(entry.position.entryVolatility).toBeLessThan(10);
    expect(entry.holdingsAtAddByAccount).toEqual({ [IBKR]: 3 });
    // The app's own valuation price at the click, recorded on the option (engine field; S1 fix round).
    expect(entry.position.valuationPriceAtEntry).toBe(500);
    // Held as the underlying of a live option: the book's own price.
    expect(entry.underlyingPriceSource).toBe("book");
    expect(entry.staleCloseDate).toBeNull();
    // Nothing is stored, and the broker is never asked.
    expect(tableCounts()).toEqual(before);
    expect(state.api.getContractDetails).not.toHaveBeenCalled();
    expect(state.api.getMarketDataSnapshot).not.toHaveBeenCalled();
    expect(state.api.getHistoricalData).not.toHaveBeenCalled();

    // The quote's underlying price is used when one was fetched.
    const quoted = await post({ action: "entry", request: optionRequest({ quotedUnderlyingPrice: 505 }) });
    // A client-supplied quote is labelled as such (the server did not fetch it), with the app's own price beside it.
    expect(quoted.body.data.entry).toMatchObject({ underlyingPrice: 505, underlyingPriceDate: TODAY });
    expect(quoted.body.data.underlyingPriceSource).toBe("client-quote");
    expect(quoted.body.data.appValuation).toEqual({ price: 500, date: "2026-11-09", source: "book" });
    expect(quoted.body.data.entry.position.valuationPriceAtEntry).toBe(500);
    // Without a quote the source is the app's own.
    expect(body.data.underlyingPriceSource).toBe("book");

    // A price below exercise value: 422 with a sentence, nothing solved.
    const below = await post({ action: "entry", request: optionRequest({ strike: 600, price: 50 }) });
    expect(below.res.status).toBe(422);
    expect(below.body).toEqual({
      success: false,
      error: "That price is below what the option is worth if exercised now. Check the price.",
    });
    // A price no volatility explains.
    const unsolvable = await post({ action: "entry", request: optionRequest({ strike: 500, price: 499 }) });
    expect(unsolvable.res.status).toBe(422);
    expect(unsolvable.body.error).toBe("No volatility explains that price. Check the price.");
  });

  it("entry: shares, and the R10 sentence for an unknown symbol", async () => {
    const shares = await post({ action: "entry", request: { kind: "shares", symbol: "ZZQ", side: "sell", quantity: 10, price: 501 } });
    expect(shares.res.status).toBe(200);
    expect(shares.body.data.entry.position).toEqual({ kind: "shares", securityId: zzq, side: "sell", quantity: 10, price: 501 });

    const unknown = await post({ action: "entry", request: { kind: "shares", symbol: "ZZZZ", side: "buy", quantity: 1, price: 1 } });
    expect(unknown.res.status).toBe(422);
    expect(unknown.body.error).toBe("The app does not know ZZZZ yet. Add it to the watchlist first.");

    state.db.prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZZNP', 'No price', 'Stock', 'USD')").run();
    const noPrice = await post({ action: "entry", request: { kind: "shares", symbol: "ZZNP", side: "buy", quantity: 1, price: 1 } });
    expect(noPrice.res.status).toBe(422);
    expect(noPrice.body.error).toBe("ZZNP is not a security the app holds a price for.");
  });

  it("entry refuses an expiry before today", async () => {
    const before = tableCounts();
    const { res, body } = await post({ action: "entry", request: optionRequest({ expiry: "2026-11-09" }) });
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain("expiry");
    expect(tableCounts()).toEqual(before);
    // Today itself is allowed by the body check (the entry itself refuses it after the 16:00 close).
    expect(trialEntryBodyProblem({ action: "entry", request: optionRequest({ expiry: TODAY }) }, TODAY)).toBeNull();
  });

  it.each([
    ["{", "body"],
    ["[]", "body"],
    ['{"action":"delete"}', "action"],
    ['{"action":"lookup"}', "symbol"],
    ['{"action":"lookup","symbol":""}', "symbol"],
    ['{"action":"lookup","symbol":"   "}', "symbol"],
    [JSON.stringify({ action: "lookup", symbol: "Z".repeat(33) }), "symbol"],
    ['{"action":"entry"}', "request"],
    [JSON.stringify({ action: "entry", request: optionRequest({ kind: "future" }) }), "kind"],
    [JSON.stringify({ action: "entry", request: optionRequest({ right: "P" }) }), "right"],
    [JSON.stringify({ action: "entry", request: optionRequest({ side: "sell" }) }), "side"],
    [JSON.stringify({ action: "entry", request: optionRequest({ expiry: "2027-02-30" }) }), "expiry"],
    [JSON.stringify({ action: "entry", request: optionRequest({ strike: 0 }) }), "strike"],
    [JSON.stringify({ action: "entry", request: optionRequest({ strike: 100001 }) }), "strike"],
    [JSON.stringify({ action: "entry", request: optionRequest({ contracts: 1.5 }) }), "contracts"],
    [JSON.stringify({ action: "entry", request: optionRequest({ contracts: 501 }) }), "contracts"],
    [JSON.stringify({ action: "entry", request: optionRequest({ contracts: 0 }) }), "contracts"],
    [JSON.stringify({ action: "entry", request: optionRequest({ price: -1 }) }), "price"],
    [JSON.stringify({ action: "entry", request: optionRequest({ price: "6.4" }) }), "price"],
    [JSON.stringify({ action: "entry", request: optionRequest({ quotedUnderlyingPrice: 0 }) }), "quotedUnderlyingPrice"],
    [JSON.stringify({ action: "entry", request: { kind: "shares", symbol: "ZZQ", side: "write", quantity: 1, price: 1 } }), "side"],
    [JSON.stringify({ action: "entry", request: { kind: "shares", symbol: "ZZQ", side: "buy", quantity: 1_000_001, price: 1 } }), "quantity"],
    [JSON.stringify({ action: "entry", request: { kind: "shares", symbol: "ZZQ", side: "buy", quantity: 10, price: 100_001 } }), "price"],
  ])("a malformed body %s answers 400 naming %s, with zero writes", async (raw, field) => {
    const before = tableCounts();
    const { res, body } = await postRaw(raw);
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain(field);
    expect(tableCounts()).toEqual(before);
    expect(state.api.getContractDetails).not.toHaveBeenCalled();
  });

  it("an internal failure answers 500 with a fixed sentence and one content-free log line", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(state.db, "prepare").mockImplementation(() => {
      throw new Error("SQLITE_ERROR: zz_secret_detail");
    });
    const { res, body } = await post({ action: "lookup", symbol: "ZZQ" });
    expect(res.status).toBe(500);
    expect(body).toEqual({ success: false, error: "Could not prepare the trial position." });
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]).toEqual(["[gains-at-risk-trial-entry] failed"]);
  });

  it("all four routes are human routes", () => {
    for (const path of [
      "/api/compute/gains-at-risk",
      "/api/compute/gains-at-risk/trial-entry",
      "/api/tws/option-quote",
      "/api/tws/daily-bars/ensure",
    ]) {
      expect(classifyRoute("POST", path)).toBe("human");
    }
  });
});
