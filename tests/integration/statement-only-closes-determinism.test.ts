/**
 * Determinism across live syncs (spec 2026-10-02 statement-only synthetic
 * closes §3 item 5, plus the import undo/restore leg of §2.3).
 *
 * After a recompute, live syncs — position writes that supersede or mint
 * `:live` tombstones, live price writes, the reconciler's live passes — must
 * leave `tax_input_generation` unchanged, and a second engine run must be
 * identical to the first by a source_key-keyed digest. Driven through the
 * real writer functions (IBKR Web API, Plaid, closed-position reconciler,
 * import commit / undo / restore). Synthetic tickers and round numbers only.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getTaxInputGeneration, getTaxConventionState } from "@/lib/compute/tax-convention";
import { commitImport } from "@/lib/import/engine";
import { undoImportWithRecovery, restoreImportBatch, readRecoveryManifest } from "@/lib/import/recovery";
import { writeIbkrHoldings } from "@/lib/ibkr/refresh";
import { writePlaidHoldings } from "@/lib/plaid/refresh";
import { reconcileClosedEquityHoldings, removeOrphanedReconTombstones } from "@/lib/mutations/closed-equity";
import type { MappedPosition } from "@/lib/ibkr/map-positions";
import type { PlaidMapResult, MappedPlaidPosition } from "@/lib/plaid/map-holdings";
import type { ParsedImportResult, ParsedHolding, ParsedTransaction } from "@/lib/import/types";
import { ledgerDigest } from "../setup/ledger-digest";

const ACCOUNT = "IBKR"; // seeded by the migrations; the IBKR writer's default account
let db: Database.Database;
let accountId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  accountId = (db.prepare(`SELECT id FROM accounts WHERE name = ?`).get(ACCOUNT) as { id: number }).id;
});

function secId(symbol: string): number {
  return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
}

function buy(symbol: string, date: string, qty: number, price: number): ParsedTransaction {
  return {
    accountName: ACCOUNT,
    tradeDate: date,
    type: "BUY",
    symbol,
    quantity: qty,
    pricePerShare: price,
    amount: -(qty * price),
    sourceKey: `zz:buy:${symbol}:${date}`,
  };
}

function stmtHold(symbol: string, date: string, qty: number): ParsedHolding {
  return { accountName: ACCOUNT, symbol, quantity: qty, asOfDate: date, sourceKey: `canonical:hold:${symbol}:${date}` };
}

function parsed(overrides: Partial<ParsedImportResult>): ParsedImportResult {
  return {
    sourceType: "canonical-csv",
    sourceName: "synthetic-fixture.csv",
    transactions: [],
    securities: [],
    holdings: [],
    prices: [],
    snapshots: [],
    corporateActions: [],
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function ibkrStock(symbol: string, qty: number, price: number): MappedPosition {
  return {
    symbol,
    securityType: "Stock",
    assetClass: "STK",
    conid: 5000 + symbol.charCodeAt(symbol.length - 1),
    quantity: qty,
    avgCost: price,
    costBasis: qty * price,
    mktPrice: price,
    mktValue: qty * price,
    currency: "USD",
  };
}

function plaidBook(positions: [string, number][], prices: [string, number, string][] = []): PlaidMapResult {
  return {
    positions: positions.map(
      ([symbol, quantity]) =>
        ({ plaidAccountId: "pZ", symbol, name: null, securityType: "Stock", quantity }) as MappedPlaidPosition,
    ),
    cashByAccount: {},
    totalByAccount: {},
    unmatched: [],
    mutualFundPrices: prices.map(([symbol, price, asOf]) => ({ plaidAccountId: "pZ", symbol, price, asOf })),
  };
}

function syntheticCloses(): { symbol: string; trade_date: string }[] {
  return db
    .prepare(
      `SELECT s.symbol, t.trade_date FROM transactions t JOIN securities s ON s.id = t.security_id
        WHERE t.type = 'RECONCILE_CLOSE' ORDER BY s.symbol`,
    )
    .all() as { symbol: string; trade_date: string }[];
}

function openQty(symbol: string): number {
  return (
    db.prepare(`SELECT COALESCE(SUM(quantity_remaining), 0) AS q FROM tax_lots WHERE security_id = ?`).get(secId(symbol)) as {
      q: number;
    }
  ).q;
}

/** Two statements: ZZA drops out of the second (statement flat); ZZB and ZZC stay held. */
function seedStatementBook(): { secondBatchId: number } {
  commitImport(
    db,
    parsed({
      securities: ["ZZA", "ZZB", "ZZC"].map((symbol) => ({ symbol, name: `${symbol} Corp`, securityType: "Stock" })),
      transactions: [buy("ZZA", "2026-01-05", 100, 10), buy("ZZB", "2026-01-05", 100, 20), buy("ZZC", "2026-01-05", 100, 30)],
      holdings: [stmtHold("ZZA", "2026-01-31", 100), stmtHold("ZZB", "2026-01-31", 100), stmtHold("ZZC", "2026-01-31", 100)],
    }),
  );
  const second = commitImport(
    db,
    parsed({ holdings: [stmtHold("ZZB", "2026-02-28", 100), stmtHold("ZZC", "2026-02-28", 100)] }),
  );
  return { secondBatchId: second.batchId };
}

describe("statement-only synthetic closes: live syncs are not tax inputs", () => {
  it("live syncs leave the generation unchanged and a second engine run is identical by digest", () => {
    seedStatementBook();
    computeTaxLots(db);
    expect(syntheticCloses()).toEqual([{ symbol: "ZZA", trade_date: "2026-02-28" }]);
    const digest1 = ledgerDigest(db);
    const gen1 = getTaxInputGeneration(db);
    expect(getTaxConventionState(db).recomputeCurrent).toBe(true);

    // ── Live day 1 (IBKR Web API): ZZB gone from the live book, ZZA re-bought
    //    live (fills not imported), live prices for everything. Then the
    //    reconciler's live passes run, as auto-refresh does.
    writeIbkrHoldings(
      db,
      { accountCode: "U0", netLiq: 1000, cash: 100, positions: [ibkrStock("ZZA", 50, 12), ibkrStock("ZZC", 100, 31)] },
      { asOfDate: "2026-03-05" },
    );
    expect(reconcileClosedEquityHoldings(db, { accountId })).toBe(1); // ZZB → :live tombstone
    const zzbLatest = db
      .prepare(`SELECT quantity, source_key FROM holdings WHERE security_id = ? ORDER BY as_of_date DESC LIMIT 1`)
      .get(secId("ZZB")) as { quantity: number; source_key: string };
    expect(zzbLatest.quantity).toBe(0);
    expect(zzbLatest.source_key.endsWith(":live")).toBe(true);

    // ── Live day 2 (Plaid, same account): ZZB re-appears (supersedes the
    //    :live tombstone on a newer date), ZZA flat again live, a live price
    //    after the statement zero. Then the live passes again.
    writePlaidHoldings(
      db,
      plaidBook(
        [
          ["ZZB", 100],
          ["ZZC", 100],
        ],
        [["ZZA", 13, "2026-03-06"]],
      ),
      { pZ: accountId },
      "2026-03-06",
    );
    reconcileClosedEquityHoldings(db, { accountId });

    // ── Ghost/orphan cleanup of live tombstones.
    db.prepare(`DELETE FROM holdings WHERE source_key LIKE 'tws-%' AND as_of_date = '2026-03-05'`).run();
    expect(removeOrphanedReconTombstones(db, { accountIds: [accountId] })).toBeGreaterThan(0);

    expect(getTaxInputGeneration(db)).toBe(gen1);
    expect(getTaxConventionState(db).recomputeCurrent).toBe(true);

    computeTaxLots(db);
    expect(ledgerDigest(db)).toBe(digest1);
    expect(syntheticCloses()).toEqual([{ symbol: "ZZA", trade_date: "2026-02-28" }]);
    expect(openQty("ZZB")).toBe(100); // live-only flat history never closed it
  });

  it("a live-only flat leaves lots open; the statement that confirms it mints the close and bumps", () => {
    seedStatementBook();
    computeTaxLots(db);
    const gen1 = getTaxInputGeneration(db);

    writeIbkrHoldings(
      db,
      { accountCode: "U0", netLiq: 1000, cash: 100, positions: [ibkrStock("ZZB", 100, 21)] },
      { asOfDate: "2026-03-05" },
    );
    reconcileClosedEquityHoldings(db, { accountId }); // ZZC → :live tombstone
    expect(getTaxInputGeneration(db)).toBe(gen1);
    computeTaxLots(db);
    expect(openQty("ZZC")).toBe(100);
    expect(syntheticCloses().map((r) => r.symbol)).toEqual(["ZZA"]);

    // The March statement omits ZZC → statement pass mints a :stmt tombstone.
    commitImport(db, parsed({ holdings: [stmtHold("ZZB", "2026-03-31", 100)] }));
    expect(getTaxInputGeneration(db)).toBeGreaterThan(gen1);
    computeTaxLots(db);
    expect(syntheticCloses()).toEqual([
      { symbol: "ZZA", trade_date: "2026-02-28" },
      { symbol: "ZZC", trade_date: "2026-03-31" },
    ]);
    expect(openQty("ZZC")).toBe(0);
  });

  it("import undo and restore of a statement batch still bump (statement-grade change, rule unchanged)", () => {
    const { secondBatchId } = seedStatementBook();
    computeTaxLots(db);
    expect(syntheticCloses().map((r) => r.symbol)).toEqual(["ZZA"]);
    const dir = mkdtempSync(join(tmpdir(), "stmt-only-closes-"));
    try {
      const g0 = getTaxInputGeneration(db);
      const { manifestPath } = undoImportWithRecovery(db, secondBatchId, { manifestDir: dir });
      const g1 = getTaxInputGeneration(db);
      expect(g1).toBeGreaterThan(g0);
      computeTaxLots(db);
      expect(syntheticCloses()).toEqual([]); // the statement evidence went with the batch

      restoreImportBatch(db, readRecoveryManifest(manifestPath));
      expect(getTaxInputGeneration(db)).toBeGreaterThan(g1);
      computeTaxLots(db);
      expect(syntheticCloses()).toEqual([{ symbol: "ZZA", trade_date: "2026-02-28" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
