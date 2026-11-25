/**
 * POST /api/compute/gains-at-risk/single-name-drivers (Gains at risk step 3,
 * Task S4: P1, P21, F8, T20). Read-only; the broker is never asked.
 * Synthetic ZZ* tickers and invented figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { classifyRoute } from "@/lib/auth/route-policy";
import { listCandidateUnderlyings, listSingleNameDrivers } from "@/lib/compute/gains-at-risk-drivers";

const state = vi.hoisted(() => ({ db: null as unknown as Database.Database, api: null as unknown }));

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));
vi.mock("@/lib/tws/client", () => ({ getIbApi: vi.fn(() => state.api) }));

const NOW = "2026-11-10T15:00:00Z";
const TODAY = "2026-11-10";

function stock(id: number, symbol: string, conId: number | null): void {
  state.db
    .prepare("INSERT INTO securities (id, symbol, name, security_type, currency, ib_con_id) VALUES (?, ?, ?, 'Stock', 'USD', ?)")
    .run(id, symbol, `${symbol} Corp`, conId);
  state.db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-09', 50, 'test')").run(id);
}

async function postRaw(raw: string) {
  const { POST } = await import("@/app/api/compute/gains-at-risk/single-name-drivers/route");
  const res = await POST(
    new Request("http://localhost/api/compute/gains-at-risk/single-name-drivers", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    }) as never,
  );
  return { res, body: await res.json() };
}
const post = (b: unknown) => postRaw(JSON.stringify(b));

describe("POST /api/compute/gains-at-risk/single-name-drivers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
    stock(101, "ZZA", 7101);
    stock(102, "ZZB", null);
    stock(103, "ZZT", 7103);
    state.db
      .prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 101, ?, 10, 'k1')")
      .run(TODAY);
    state.db
      .prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 102, ?, -5, 'k2')")
      .run(TODAY);
    state.api = { getMarketData: vi.fn(), getContractDetails: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
    state.db.close();
  });

  it("is a human route", () => {
    expect(classifyRoute("POST", "/api/compute/gains-at-risk/single-name-drivers")).toBe("human");
  });

  it("returns the list and candidateUnderlyings, exactly the two lib functions' answers", async () => {
    const { res, body } = await post({ trialUnderlyingIds: [103] });
    expect(res.status).toBe(200);
    const drivers = listSingleNameDrivers(state.db, { trialUnderlyingIds: [103], today: TODAY });
    expect(body.data).toEqual({
      drivers,
      candidateUnderlyings: listCandidateUnderlyings(state.db, { drivers, today: TODAY }),
    });
    expect(body.data.drivers.map((d: { symbol: string }) => d.symbol)).toEqual(["ZZA", "ZZB", "ZZT"]);
    expect(body.data.drivers.find((d: { symbol: string }) => d.symbol === "ZZT").reasons).toEqual(["trial"]);
    // ZZB has no broker contract, so the candidate section cannot pull a chain for it.
    expect(body.data.candidateUnderlyings.map((d: { symbol: string }) => d.symbol)).toEqual(["ZZA", "ZZT"]);
    const api = state.api as { getMarketData: ReturnType<typeof vi.fn>; getContractDetails: ReturnType<typeof vi.fn> };
    expect(api.getMarketData).not.toHaveBeenCalled();
    expect(api.getContractDetails).not.toHaveBeenCalled();
  });

  it("fix 3: a non-dollar name and an option id sent as trial underlyings are not listed", async () => {
    state.db
      .prepare("INSERT INTO securities (id, symbol, name, security_type, currency, ib_con_id) VALUES (110, 'ZZJP', 'ZZ Japan', 'Stock', 'JPY', 7110)")
      .run();
    state.db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (110, '2026-11-09', 900, 'test')").run();
    state.db
      .prepare(
        "INSERT INTO securities (id, symbol, name, security_type, currency, ib_con_id) VALUES (111, 'ZZA 270319P00050000', 'ZZA put', 'Option', 'USD', 7111)",
      )
      .run();
    state.db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (111, '2026-11-09', 2, 'test')").run();
    const { res, body } = await post({ trialUnderlyingIds: [110, 111, 103] });
    expect(res.status).toBe(200);
    expect(body.data.drivers.map((d: { securityId: number }) => d.securityId)).toEqual([101, 102, 103]);
  });

  it("an empty list of trial underlyings is fine", async () => {
    const { res, body } = await post({ trialUnderlyingIds: [] });
    expect(res.status).toBe(200);
    expect(body.data.drivers.map((d: { symbol: string }) => d.symbol)).toEqual(["ZZA", "ZZB"]);
  });

  it.each([
    ["{"],
    ["[]"],
    ["null"],
    [JSON.stringify({})],
    [JSON.stringify({ trialUnderlyingIds: Array.from({ length: 13 }, (_, i) => i + 1) })],
    [JSON.stringify({ trialUnderlyingIds: [1.5] })],
    [JSON.stringify({ trialUnderlyingIds: [0] })],
    [JSON.stringify({ trialUnderlyingIds: ["101"] })],
    [JSON.stringify({ trialUnderlyingIds: 101 })],
  ])("a body %s is 400", async (raw) => {
    const { res, body } = await postRaw(raw);
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("twelve ids pass", async () => {
    expect((await post({ trialUnderlyingIds: Array.from({ length: 12 }, (_, i) => i + 1) })).res.status).toBe(200);
  });
});
