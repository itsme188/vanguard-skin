/**
 * The TWS sync must never write an fx_rates row (2026-09-14 removal). It used
 * to derive one from `Position.marketValue ÷ (marketPrice × qty ×
 * multiplier)` and write it as source `tws_derived`, on the assumption that
 * `marketValue` was USD-base. That assumption was disproven live: a JPY
 * position derived exactly 1.0 (native currency, not USD-base), and nothing
 * stopped the bad write because no `ibkr_ledger` rate existed yet for JPY.
 * The derive is gone; this file is a standalone harness copy (mirroring
 * tests/tws/positions.test.ts's mock setup) that pins the new contract: a
 * foreign-currency position still gets its `securities.currency` set, but
 * `fx_rates` stays untouched by this path regardless of what marketValue
 * says. Currency/rate figures here are synthetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { SecType } from "@stoqey/ib";

function mockObservable<T>(value: T) {
  return {
    subscribe(observer: { next: (v: T) => void; error?: (e: Error) => void }) {
      const timer = setTimeout(() => observer.next(value), 5);
      return { unsubscribe: () => clearTimeout(timer) };
    },
  };
}

function makeAccountUpdate(
  positions: Array<{
    account?: string;
    symbol: string;
    secType?: string;
    conId?: number;
    pos: number;
    avgCost?: number;
    marketPrice?: number;
    marketValue?: number;
    currency?: string;
  }>,
  nlv: number,
  cash: number,
) {
  const portfolio = new Map<string, unknown[]>();
  for (const p of positions) {
    const acct = p.account ?? "U1234567";
    if (!portfolio.has(acct)) portfolio.set(acct, []);
    portfolio.get(acct)!.push({
      account: acct,
      contract: {
        symbol: p.symbol,
        secType: p.secType ?? SecType.STK,
        conId: p.conId ?? Math.floor(Math.random() * 100000),
        exchange: "SMART",
        currency: p.currency ?? "USD",
        localSymbol: p.symbol,
      },
      pos: p.pos,
      avgCost: p.avgCost ?? 0,
      marketPrice: p.marketPrice ?? 0,
      marketValue: p.marketValue ?? p.pos * (p.marketPrice ?? 0),
      unrealizedPNL: 0,
      realizedPNL: 0,
    });
  }

  const summaryValues = new Map([
    ["NetLiquidation", new Map([["USD", { value: String(nlv), ingressTm: Date.now() }]])],
    ["TotalCashValue", new Map([["USD", { value: String(cash), ingressTm: Date.now() }]])],
  ]);
  const value = new Map([["U1234567", summaryValues]]);

  return { all: { portfolio, value } };
}

let mockApi: { getAccountUpdates: ReturnType<typeof vi.fn> } | null = null;

vi.mock("@/lib/tws/client", () => ({
  getIbApi: () => mockApi,
}));

describe("TWS portfolio sync — fx_rates removal (2026-09-14)", () => {
  let db: Database.Database;
  const TEST_ACCOUNT = "U1234567";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    mockApi = { getAccountUpdates: vi.fn() };
  });

  async function getSyncPortfolio() {
    const mod = await import("@/lib/tws/positions");
    return (dbArg: Database.Database) =>
      mod.syncPortfolio(dbArg, { ibkrAccountCode: TEST_ACCOUNT });
  }

  it("writes no fx_rates row for a foreign-currency position, even when marketValue implies ~1.0", async () => {
    // JPY-shaped values: marketValue == marketPrice * qty (the native-
    // currency-mistaken-for-USD-base shape that used to derive a bogus 1.0).
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate(
          [
            {
              symbol: "9999",
              pos: 100,
              avgCost: 2500,
              marketPrice: 2600,
              marketValue: 260_000, // == marketPrice * pos -> old derive would yield 1.0
              currency: "JPY",
              conId: 777,
            },
          ],
          484_374.59,
          64_983.18,
        ),
      ),
    );

    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);

    const sec = db.prepare("SELECT currency FROM securities WHERE symbol = '9999'").get() as any;
    expect(sec.currency).toBe("JPY");

    const count = db.prepare("SELECT COUNT(*) c FROM fx_rates").get() as any;
    expect(count.c).toBe(0);
  });

  it("writes no fx_rates row for a foreign-currency position with a plausible non-1.0-implying marketValue either", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate(
          [
            {
              symbol: "8888",
              pos: 10,
              avgCost: 100_000,
              marketPrice: 173_100,
              marketValue: 1271, // a plausible USD-base figure, if it existed
              currency: "JPY",
              conId: 778,
            },
          ],
          484_374.59,
          64_983.18,
        ),
      ),
    );

    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);

    const count = db.prepare("SELECT COUNT(*) c FROM fx_rates").get() as any;
    expect(count.c).toBe(0);
  });
});
