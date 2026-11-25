/**
 * POST /api/compute/gains-at-risk/candidates (Gains at risk step 3, Task S4:
 * P10, P12, D3, D9, F4, T10, T26). Call 2: no broker, read-only.
 *
 * The body's shape and the candidates' own validator answer 400 before any
 * database read; then each candidate's underlying (422) and the single-name
 * driver (400). The book's figures equal the compute route's for the same
 * body. Synthetic ZZ* tickers and invented figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { classifyRoute } from "@/lib/auth/route-policy";
import { buildTrialEntryById } from "@/lib/compute/gains-at-risk-trial";
import type { CandidateRequestItem } from "@/lib/compute/gains-at-risk-candidate-check";

const state = vi.hoisted(() => ({ db: null as unknown as Database.Database, api: null as unknown }));

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));
vi.mock("@/lib/tws/client", () => ({ getIbApi: vi.fn(() => state.api) }));

const NOW = "2026-11-10T19:32:00Z"; // Tue 14:32 Eastern
const TODAY = "2026-11-10";
const EXPIRY = "2027-03-19";
let zzq: number;

function security(symbol: string, o: { conId?: number | null; currency?: string } = {}): number {
  return state.db
    .prepare("INSERT INTO securities (symbol, name, security_type, ib_con_id, currency) VALUES (?, ?, 'ETF', ?, ?)")
    .run(symbol, `${symbol} name`, o.conId === undefined ? 5001 : o.conId, o.currency ?? "USD")
    .lastInsertRowid as number;
}

/** A candidate exactly as call 1 would return it: the entry solved by id at the quote's own underlying. */
function candidate(conId: number, strike: number, underlyingSecurityId = zzq): CandidateRequestItem {
  const at = new Date(NOW).toISOString();
  const entry = buildTrialEntryById(
    state.db,
    {
      kind: "option",
      underlyingSecurityId,
      right: "put",
      side: "buy",
      expiry: EXPIRY,
      strike,
      contracts: 1,
      price: 6.4,
      quotedUnderlyingPrice: 510,
      brokerContractId: conId,
    },
    { now: () => new Date(NOW) },
  );
  if (!entry.ok || entry.position.kind !== "option") throw new Error(`fixture entry refused: ${entry.ok ? "" : entry.reason}`);
  const p = entry.position;
  return {
    conId,
    underlyingSecurityId,
    right: "put",
    expiry: EXPIRY,
    strike,
    multiplier: 100,
    tradingClass: "ZZQ",
    quote: {
      bid: 6.3,
      ask: 6.5,
      mid: 6.4,
      tickKind: "live",
      session: "regular-session",
      optionObservedAt: at,
      underlyingObservedAt: at,
      underlyingPrice: 510,
    },
    entry: {
      kind: "option",
      underlyingSecurityId,
      right: "put",
      side: "buy",
      expiry: EXPIRY,
      strike,
      contracts: 1,
      pricePaid: p.pricePaid,
      entryUnderlyingPrice: p.entryUnderlyingPrice,
      valuationPriceAtEntry: p.valuationPriceAtEntry,
      entryVolatility: p.entryVolatility,
      brokerContractId: conId,
    },
  };
}

function gainsBody(): Record<string, unknown> {
  return { scope: "all", driverSymbol: "SPY", valuationDate: TODAY, moves: [-0.2, -0.1, 0], volChangePoints: 0 };
}
function body(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...gainsBody(), budgetUsd: 10_000, selectedMove: -0.2, candidates: [candidate(77001, 500)], ...patch };
}

async function postTo(path: string, b: unknown) {
  const mod =
    path === "candidates"
      ? await import("@/app/api/compute/gains-at-risk/candidates/route")
      : await import("@/app/api/compute/gains-at-risk/route");
  const res = await mod.POST(
    new Request(`http://localhost/api/compute/gains-at-risk/${path}`, {
      method: "POST",
      body: typeof b === "string" ? b : JSON.stringify(b),
      headers: { "content-type": "application/json" },
    }) as never,
  );
  return { res, body: await res.json() };
}
const post = (b: unknown) => postTo("candidates", b);

describe("POST /api/compute/gains-at-risk/candidates", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
    zzq = security("ZZQ");
    state.db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-09', 505, 'test')").run(zzq);
    state.db
      .prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, ?, 40, 'k-zzq')")
      .run(zzq, TODAY);
    state.api = { getMarketData: vi.fn(), getContractDetails: vi.fn(), setMarketDataType: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    state.db.close();
  });

  it("is a human route", () => {
    expect(classifyRoute("POST", "/api/compute/gains-at-risk/candidates")).toBe("human");
  });

  it("T10 result, yearGain and freshness equal the compute route's for the same body; one row per candidate, sized exactly", async () => {
    const b = body({ candidates: [candidate(77001, 500), candidate(77002, 495)] });
    const call2 = await post(b);
    expect(call2.res.status).toBe(200);
    const plain = await postTo("", b);
    expect(plain.res.status).toBe(200);
    const { rows, budgetUsd, selectedMove, ...book } = call2.body.data;
    expect(JSON.stringify(book)).toBe(JSON.stringify(plain.body.data));
    expect("candidates" in call2.body.data.result).toBe(false);
    expect(budgetUsd).toBe(10_000);
    expect(selectedMove).toBe(-0.2);
    expect(rows.map((r: { conId: number }) => r.conId)).toEqual([77001, 77002]);
    // 6.40 x 100 = 640 a contract; 10,000 buys 15 (9,600), 400 unspent.
    expect(rows[0]).toEqual(
      expect.objectContaining({ status: "priced", contracts: 15, capped: false, perContractUsd: 640, costUsd: 9600, unspentUsd: 400 }),
    );
    expect(rows[0].quote.source).toBe("client-supplied");
    expect(rows[0].engine.cases.measured.atSelectedMoveUsd).toEqual(expect.any(Number));
    // Never sends a broker request.
    const api = state.api as Record<string, ReturnType<typeof vi.fn>>;
    for (const f of Object.values(api)) expect(f).not.toHaveBeenCalled();
  });

  it("a budget under one contract gives a zero-contracts row with no book figures", async () => {
    const { res, body: out } = await post(body({ budgetUsd: 639.99 }));
    expect(res.status).toBe(200);
    expect(out.data.rows[0]).toEqual(expect.objectContaining({ status: "zero-contracts", perContractUsd: 640 }));
    expect(out.data.rows[0].engine).toBeUndefined();
  });

  it("a single-name driver on the list is used; one not on it is 400", async () => {
    const ok = await post(body({ driver: { kind: "single-name", securityId: zzq }, moves: [-0.2, 0, 0.2] }));
    expect(ok.res.status).toBe(200);
    expect(ok.body.data.result.driverKind).toBe("single-name");
    expect(ok.body.data.rows[0].engine.cases.measured.crossingDirection).toBe("fall");

    const other = security("ZZNH");
    const bad = await post(body({ driver: { kind: "single-name", securityId: other } }));
    expect(bad.res.status).toBe(400);
    expect(bad.body.error).toBe("driver is not one of the names this page can stress.");
  });

  function withItem(patch: (c: CandidateRequestItem) => unknown): Record<string, unknown> {
    return body({ candidates: [patch(candidate(77001, 500))] });
  }

  it.each([
    ["entry.side", (c: CandidateRequestItem) => ({ ...c, entry: { ...c.entry, side: "write" } })],
    ["right", (c: CandidateRequestItem) => ({ ...c, right: "x" })],
    ["quote.bid", (c: CandidateRequestItem) => ({ ...c, quote: { ...c.quote, bid: 0 } })],
    ["quote.bid", (c: CandidateRequestItem) => ({ ...c, quote: { ...c.quote, bid: 6.6 } })],
    ["quote.bid", (c: CandidateRequestItem) => ({ ...c, quote: { ...c.quote, bid: 6.30005 } })],
    ["quote.mid", (c: CandidateRequestItem) => ({ ...c, quote: { ...c.quote, mid: 6.41 } })],
    ["entry.pricePaid", (c: CandidateRequestItem) => ({ ...c, entry: { ...c.entry, pricePaid: 6.5 } })],
    ["entry.strike", (c: CandidateRequestItem) => ({ ...c, entry: { ...c.entry, strike: 495 } })],
    ["entry.expiry", (c: CandidateRequestItem) => ({ ...c, entry: { ...c.entry, expiry: "2027-04-16" } })],
    ["entry.brokerContractId", (c: CandidateRequestItem) => ({ ...c, entry: { ...c.entry, brokerContractId: 1 } })],
    ["multiplier", (c: CandidateRequestItem) => ({ ...c, multiplier: 10 })],
    ["entry.entryVolatility", (c: CandidateRequestItem) => ({ ...c, entry: { ...c.entry, entryVolatility: 10.01 } })],
    ["entry.valuationPriceAtEntry", (c: CandidateRequestItem) => ({ ...c, entry: { ...c.entry, valuationPriceAtEntry: 0 } })],
    ["quote.underlyingPrice", (c: CandidateRequestItem) => ({ ...c, quote: { ...c.quote, underlyingPrice: 0 } })],
  ])("T26/F4 refuses candidates[0].%s with 400 before any database read", async (field, patch) => {
    const b = withItem(patch);
    const prepare = vi.spyOn(state.db, "prepare");
    const { res, body: out } = await post(b);
    expect(res.status).toBe(400);
    expect(out.success).toBe(false);
    expect(out.error).toContain(`candidates[0].${field}`);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("budget 10.005, 0, a text and over the bound answer 400 naming budgetUsd, before any database read", async () => {
    const bodies = [10.005, 0, -5, "100", 10_000_000.01].map((budgetUsd) => body({ budgetUsd }));
    const prepare = vi.spyOn(state.db, "prepare");
    for (const b of bodies) {
      const { res, body: out } = await post(b);
      expect(res.status).toBe(400);
      expect(out.error).toContain("budgetUsd");
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("selectedMove missing or not among moves is 400; 31 candidates is 400; 0 candidates is 400; a duplicate conId is 400", async () => {
    const noSelected = body();
    delete noSelected.selectedMove;
    for (const b of [
      noSelected,
      body({ selectedMove: -0.3 }),
      body({ candidates: Array.from({ length: 31 }, (_, i) => ({ ...candidate(77001, 500), conId: 70000 + i })) }),
      body({ candidates: [] }),
      body({ candidates: "x" }),
      body({ candidates: [candidate(77001, 500), candidate(77001, 500)] }),
    ]) {
      const { res } = await post(b);
      expect(res.status).toBe(400);
    }
  });

  it("a candidate on an unknown, option or non-dollar underlying is 422", async () => {
    const jp = security("ZZJP", { currency: "JPY" });
    const base = candidate(77001, 500);
    for (const id of [99999, jp]) {
      const item = { ...base, underlyingSecurityId: id, entry: { ...base.entry, underlyingSecurityId: id } };
      const { res, body: out } = await post(body({ candidates: [item] }));
      expect(res.status).toBe(422);
      expect(out.success).toBe(false);
    }
  });

  it.each([["ZZ-Q"], ["A".repeat(13)], [""]])("fix 5: a candidate tradingClass %o is 400 naming candidates[0].tradingClass", async (tradingClass) => {
    const b = withItem((c) => ({ ...c, tradingClass }));
    const { res, body: out } = await post(b);
    expect(res.status).toBe(400);
    expect(out.error).toContain("candidates[0].tradingClass");
  });

  it("fix 4: a 500 logs one content-free line (stage and error class), never the message", async () => {
    const b = body();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(state.db, "prepare").mockImplementation(() => {
      throw new Error("SQLITE_ERROR: zz_secret_detail");
    });
    const { res, body: out } = await post(b);
    expect(res.status).toBe(500);
    expect(out).toEqual({ success: false, error: "Could not compute the candidates." });
    expect(err.mock.calls).toEqual([["[gains-at-risk-candidates] compute failed: Error"]]);
    expect(JSON.stringify(err.mock.calls)).not.toContain("zz_secret_detail");
  });

  it("malformed JSON is 400", async () => {
    expect((await post("{")).res.status).toBe(400);
  });
});
