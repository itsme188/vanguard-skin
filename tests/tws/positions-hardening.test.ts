/**
 * Tombstone-supersession + synthetic-close price bump tests for
 * lib/tws/positions.ts::syncPortfolio (Task 6, spec 2026-08-31
 * reconciler-hardening §4). Mirrors the mocking idiom in
 * tests/tws/positions.test.ts (mock @stoqey/ib Observable helpers, dynamic
 * import of the module under test so it picks up the mock).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { SecType } from "@stoqey/ib";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { countReconRowsOnDate } from "@/lib/mutations/closed-equity";

// ── Mock @stoqey/ib Observable helpers (same shape as positions.test.ts) ──

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

const TEST_ACCOUNT = "U1234567";

describe("syncPortfolio — tombstone-supersession + price bumps (reconciler-hardening, spec §4)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    mockApi = { getAccountUpdates: vi.fn() };
  });

  async function getSyncPortfolio() {
    const mod = await import("@/lib/tws/positions");
    return (dbArg: Database.Database, opts?: Record<string, unknown>) =>
      mod.syncPortfolio(dbArg, { ibkrAccountCode: TEST_ACCOUNT, ...opts });
  }

  function ibkrAccountId(): number {
    return (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
  }
  function seedSecurity(symbol: string): number {
    return (
      db
        .prepare(`INSERT INTO securities (symbol, security_type) VALUES (?, 'Stock') RETURNING id`)
        .get(symbol) as { id: number }
    ).id;
  }
  function seedTombstone(accountId: number, securityId: number, date: string): void {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(accountId, securityId, date, `recon:closed-equity:${accountId}:${securityId}:${date}:live`);
  }

  it("bumps on newer-date tombstone supersession (re-bought)", async () => {
    const acctId = ibkrAccountId();
    const secId = seedSecurity("NET");
    seedTombstone(acctId, secId, "2000-01-01"); // latest row for NET is a tombstone
    const before = getTaxInputGeneration(db);

    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate([{ symbol: "NET", pos: 60, avgCost: 200, marketPrice: 269.42, conId: 111 }], 1000, 500),
      ),
    );

    const syncPortfolio = await getSyncPortfolio();
    const result = await syncPortfolio(db);

    expect(result.positionsSynced).toBe(1);
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("same-date REPLACE of a tombstone bumps", async () => {
    const acctId = ibkrAccountId();
    const secId = seedSecurity("SPY");
    const today = new Date().toISOString().slice(0, 10); // matches syncPortfolio's own `today`
    seedTombstone(acctId, secId, today);
    expect(countReconRowsOnDate(db, acctId, today)).toBe(1);
    const before = getTaxInputGeneration(db);

    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate([{ symbol: "SPY", pos: 10, avgCost: 400, marketPrice: 420, conId: 222 }], 1000, 500),
      ),
    );

    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);

    expect(countReconRowsOnDate(db, acctId, today)).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("routine sync of a held-only book does not bump (no tombstone anywhere)", async () => {
    const before = getTaxInputGeneration(db);

    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate([{ symbol: "AAPL", pos: 100, avgCost: 150, marketPrice: 175, conId: 333 }], 1000, 500),
      ),
    );

    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);

    expect(getTaxInputGeneration(db)).toBe(before);
  });

  it("a throw inside the writer's transaction rolls back writes AND bump together", async () => {
    const acctId = ibkrAccountId();
    const secId = seedSecurity("NET");
    seedTombstone(acctId, secId, "2000-01-01");
    const before = getTaxInputGeneration(db);

    // No outer transaction wraps this call (discriminating: proves the
    // writer's OWN db.transaction rolls things back, not a caller's). The
    // sentinel quantity aborts the SECOND position's holdings insert, after
    // the first (NET, a tombstone re-buy) already wrote.
    db.exec(
      `CREATE TEMP TRIGGER boom BEFORE INSERT ON holdings WHEN NEW.quantity = 424242 BEGIN SELECT RAISE(ABORT,'boom'); END`,
    );

    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate(
          [
            { symbol: "NET", pos: 60, avgCost: 200, marketPrice: 269.42, conId: 111 },
            { symbol: "BOOM", pos: 424242, avgCost: 1, marketPrice: 1, conId: 444 },
          ],
          1000,
          500,
        ),
      ),
    );

    const syncPortfolio = await getSyncPortfolio();
    await expect(syncPortfolio(db)).rejects.toThrow();

    const netRows = db
      .prepare(`SELECT quantity FROM holdings WHERE security_id = ? ORDER BY as_of_date`)
      .all(secId) as { quantity: number }[];
    expect(netRows).toEqual([{ quantity: 0 }]); // only the original tombstone survives
    expect(getTaxInputGeneration(db)).toBe(before);
  });

  it("a price-write failure rolls back the holdings writes it now shares a transaction with (proves the merged commit — this test fails against the pre-fix two-transaction split)", async () => {
    const acctId = ibkrAccountId();
    const secId = seedSecurity("NET");
    seedTombstone(acctId, secId, "2000-01-01");
    const before = getTaxInputGeneration(db);

    db.exec(
      `CREATE TEMP TRIGGER boomPrice BEFORE INSERT ON prices WHEN NEW.close_price = 999999 BEGIN SELECT RAISE(ABORT,'boom-price'); END`,
    );

    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate(
          [
            { symbol: "NET", pos: 60, avgCost: 200, marketPrice: 269.42, conId: 111 },
            { symbol: "BOOM", pos: 5, avgCost: 1, marketPrice: 999999, conId: 444 },
          ],
          1000,
          500,
        ),
      ),
    );

    const syncPortfolio = await getSyncPortfolio();
    await expect(syncPortfolio(db)).rejects.toThrow();

    const netRows = db
      .prepare(`SELECT quantity FROM holdings WHERE security_id = ? ORDER BY as_of_date`)
      .all(secId) as { quantity: number }[];
    // NET's re-buy holdings write must have rolled back together with the
    // aborted BOOM price insert — only the original tombstone survives.
    expect(netRows).toEqual([{ quantity: 0 }]);
    expect(getTaxInputGeneration(db)).toBe(before);
  });

  it("ghost-row cleanup that reverts a pair to an underlying tombstone bumps — neither the recon count nor newerDateSupersession sees this (review fix)", async () => {
    const acctId = ibkrAccountId();
    const secId = seedSecurity("X");
    seedTombstone(acctId, secId, "2000-01-01"); // pre-existing tombstone, older date

    // Sync 1 (intraday): X reported non-zero today — a re-buy over the
    // tombstone. This itself is a newerDateSupersession bump.
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate([{ symbol: "X", pos: 10, avgCost: 5, marketPrice: 6, conId: 555 }], 1000, 500),
      ),
    );
    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);
    const afterSync1 = getTaxInputGeneration(db);

    // Sync 2 (same day, later intraday): X no longer reported — closed out
    // intraday. Ghost-row cleanup deletes X's today row (absent from this
    // sync's position set), reverting X's latest holdings row back to the
    // OLDER tombstone underneath it — a held→closed transition that neither
    // detector above sees (the delete only touches tws-% rows, so recon
    // counts on today's date are unaffected; newerDateSupersession only
    // fires on a write, and X has no write in this sync at all).
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate([{ symbol: "OTHER", pos: 1, avgCost: 1, marketPrice: 1, conId: 999 }], 1000, 500),
      ),
    );
    const result2 = await syncPortfolio(db);

    expect(result2.staleRowsRemoved).toBe(1); // X's ghost row was deleted
    expect(getTaxInputGeneration(db)).toBe(afterSync1 + 1);

    const xRows = db
      .prepare(`SELECT quantity FROM holdings WHERE security_id = ? ORDER BY as_of_date`)
      .all(secId) as { quantity: number }[];
    // The tombstone from 2000-01-01 is latest again; today's re-buy row is gone.
    expect(xRows.map((r) => r.quantity)).toEqual([0]);
  });

  it("routine two-sync held-only cycle does not bump (ghost-cleanup control — nothing closes, nothing deletes)", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate([{ symbol: "HELD", pos: 100, avgCost: 150, marketPrice: 175, conId: 777 }], 1000, 500),
      ),
    );
    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);
    const afterSync1 = getTaxInputGeneration(db);

    // Second intraday sync, same day, same position reported again —
    // nothing closed, so ghost-row cleanup deletes nothing.
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(
        makeAccountUpdate([{ symbol: "HELD", pos: 100, avgCost: 150, marketPrice: 176, conId: 777 }], 1000, 500),
      ),
    );
    const result2 = await syncPortfolio(db);

    expect(result2.staleRowsRemoved).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(afterSync1);
  });
});
