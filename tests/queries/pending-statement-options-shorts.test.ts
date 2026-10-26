/**
 * The pending read model for OPTIONS (long and short) and SHORT stock
 * (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 3; rulings R2, R7, R11, R17; spec
 * docs/superpowers/specs/2026-10-08-live-closed-options-shorts-pending-design.md §2, §5, §7).
 *
 * Every expected lot state and figure is written by hand in the test (F6),
 * then the classifier is checked against it. Synthetic symbols and small
 * round numbers only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { bumpTaxInputGeneration } from "@/lib/compute/tax-convention";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import {
  getPendingStatementIndex,
  getPendingStatementPairs,
  isPendingStatementLot,
  pendingStatementKey,
  type PendingStatementPair,
} from "@/lib/queries/pending-statement";
import {
  createPendingTestDb,
  seedHold,
  seedImportSplit,
  seedLot,
  seedSec,
} from "../setup/pending-statement-fixtures";

// A synthetic re-symbol mapping replaces the real constant for this file.
const MAPPING = vi.hoisted(() => [
  {
    fromSymbol: "ZZRS  270115C00100000",
    toSymbol: "ZZRS  270115C00050000",
    tradeDate: "2026-05-01",
    type: "BUY_TO_OPEN",
    preQty: 1,
    ratio: 2,
  },
]);
vi.mock("@/lib/securities/option-resymbol-targets", () => ({
  OPTION_RESYMBOL_TARGETS: MAPPING,
  resymbolTargetsFrom: (fromSymbol: string) => MAPPING.filter((t) => t.fromSymbol === fromSymbol),
}));

const TODAY = "2026-10-26";
const OPTS = { today: TODAY };
const ACCT = 3;

let db: Database.Database;
let seq = 0;
beforeEach(() => {
  db = createPendingTestDb();
});

function seedOpt(symbol: string, expiration: string | null = "2027-01-15"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date)
         VALUES (?, ?, 'option', 100, ?)`
      )
      .run(symbol, `${symbol} contract`, expiration).lastInsertRowid
  );
}

/** A ledger row with amount NULL, so the engine's dollars are qty x price (x 100 for an option). */
function txn(
  sec: number,
  date: string,
  type: string,
  qty: number,
  price: number | null,
  opts: { account?: number; evidence?: "O" | "C" | "O;C" } = {}
): number {
  const notes = opts.evidence ? ibkrTradeDirectionNote(opts.evidence, "") : null;
  return Number(
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`
      )
      .run(opts.account ?? ACCT, sec, date, type, qty, price, notes, `pos-${seq++}`).lastInsertRowid
  );
}

function lotStates(sec: number): Array<[isShort: number, acquired: number, remaining: number]> {
  return (
    db
      .prepare("SELECT is_short, quantity_acquired, quantity_remaining FROM tax_lots WHERE security_id = ? ORDER BY id")
      .all(sec) as Array<{ is_short: number; quantity_acquired: number; quantity_remaining: number }>
  ).map((l) => [l.is_short, l.quantity_acquired, l.quantity_remaining]);
}

function brief(pairs: PendingStatementPair[]) {
  return pairs.map((p) => [p.symbol, p.side, p.reason, p.flat_date]);
}

function syntheticCloses(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'RECONCILE_CLOSE'").get() as { n: number }).n;
}

describe("T-GAP: a statement zero with no closing entry is closing_entry_missing", () => {
  it("long option", () => {
    const sec = seedOpt("ZZGA  270115C00010000");
    txn(sec, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    computeTaxLots(db);
    expect(lotStates(sec)).toEqual([[0, 2, 2]]); // hand: one long lot, still open
    expect(syntheticCloses()).toBe(0);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([
      {
        account_id: ACCT,
        security_id: sec,
        symbol: "ZZGA  270115C00010000",
        side: "long",
        reason: "closing_entry_missing",
        flat_date: "2026-06-30",
        open_quantity: 2,
        open_figure: 600, // 2 contracts x 3.00 x 100
        figure_kind: "cost_basis",
        lot_count: 1,
      },
    ]);
  });

  it("short option", () => {
    const sec = seedOpt("ZZGB  270115P00010000");
    txn(sec, "2026-06-01", "SELL_TO_OPEN", 2, 3);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    computeTaxLots(db);
    expect(lotStates(sec)).toEqual([[1, 2, 2]]);
    const [pair] = getPendingStatementPairs(db, undefined, OPTS);
    expect(pair).toMatchObject({
      side: "short",
      reason: "closing_entry_missing",
      flat_date: "2026-06-30",
      open_quantity: 2,
      open_figure: 600, // premium received, positive
      figure_kind: "short_sale_proceeds",
      lot_count: 1,
    });
  });

  it("short stock (and the engine mints no synthetic close for it)", () => {
    const sec = seedSec(db, "ZZGC");
    txn(sec, "2026-06-01", "SHORT_SELL", 10, 50);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    computeTaxLots(db);
    expect(lotStates(sec)).toEqual([[1, 10, 10]]);
    expect(syntheticCloses()).toBe(0);
    const [pair] = getPendingStatementPairs(db, undefined, OPTS);
    expect(pair).toMatchObject({
      side: "short",
      reason: "closing_entry_missing",
      flat_date: "2026-06-30",
      open_quantity: 10,
      open_figure: 500,
      figure_kind: "short_sale_proceeds",
    });
  });
});

describe("R2 counterexamples: only side-matching evidence ends pending", () => {
  function shortStockAfterStatementZero(symbol: string): number {
    const sec = seedSec(db, symbol);
    txn(sec, "2026-06-01", "SHORT_SELL", 10, 50);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    return sec;
  }

  it("short stock, statement zero, then an import split → still closing_entry_missing", () => {
    const sec = shortStockAfterStatementZero("ZZCA");
    seedImportSplit(db, sec, "2026-07-15");
    computeTaxLots(db);
    expect(lotStates(sec)).toEqual([[1, 20, 20]]); // hand: the 2:1 split doubles the open short lot
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      ["ZZCA", "short", "closing_entry_missing", "2026-06-30"],
    ]);
  });

  it.each([["current"], ["stale"]])(
    "short stock, statement zero, then a plain BUY (no evidence) → short still closing_entry_missing; the new long lot is not pending (%s results)",
    (mode) => {
      const sec = shortStockAfterStatementZero("ZZCB");
      txn(sec, "2026-07-15", "BUY", 4, 60);
      computeTaxLots(db);
      if (mode === "stale") bumpTaxInputGeneration(db);
      expect(lotStates(sec)).toEqual([
        [1, 10, 10],
        [0, 4, 4],
      ]); // hand: the BUY opened a separate long lot, the short is untouched
      const index = getPendingStatementIndex(db, undefined, OPTS);
      expect(brief([...index.pairs])).toEqual([["ZZCB", "short", "closing_entry_missing", "2026-06-30"]]);
      expect(index.reasonFor({ account_id: ACCT, security_id: sec, is_short: 0 })).toBeNull();
    }
  );

  it("short stock, statement zero, then TRANSFER_OUT → still pending", () => {
    const sec = shortStockAfterStatementZero("ZZCC");
    txn(sec, "2026-07-15", "TRANSFER_OUT", 10, 55);
    computeTaxLots(db);
    expect(lotStates(sec)).toEqual([[1, 10, 10]]);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      ["ZZCC", "short", "closing_entry_missing", "2026-06-30"],
    ]);
  });

  it("short stock 100, statement zero, cover of 40 imported → remaining 60 still closing_entry_missing", () => {
    const sec = seedSec(db, "ZZCD");
    txn(sec, "2026-06-01", "SHORT_SELL", 100, 10);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    txn(sec, "2026-07-15", "BUY_TO_COVER", 40, 9);
    computeTaxLots(db);
    expect(lotStates(sec)).toEqual([[1, 100, 60]]);
    const [pair] = getPendingStatementPairs(db, undefined, OPTS);
    expect(pair).toMatchObject({
      side: "short",
      reason: "closing_entry_missing",
      flat_date: "2026-06-30",
      open_quantity: 60,
      open_figure: 600, // 60/100 of the 1,000 short-sale proceeds
      figure_kind: "short_sale_proceeds",
    });
  });

  it("long option, statement zero, then SELL_TO_OPEN on the same contract → long side still pending, the new short is not", () => {
    const sec = seedOpt("ZZCE  270115C00010000");
    txn(sec, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    txn(sec, "2026-07-15", "SELL_TO_OPEN", 1, 4);
    computeTaxLots(db);
    expect(lotStates(sec)).toEqual([
      [0, 2, 2],
      [1, 1, 1],
    ]);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      ["ZZCE  270115C00010000", "long", "closing_entry_missing", "2026-06-30"],
    ]);
  });

  it.each([["current"], ["stale"]])("short: a later SHORT_SELL ends it (%s results)", (mode) => {
    const sec = shortStockAfterStatementZero("ZZCF");
    txn(sec, "2026-07-15", "SHORT_SELL", 5, 55);
    computeTaxLots(db);
    if (mode === "stale") bumpTaxInputGeneration(db);
    expect(lotStates(sec)).toEqual([
      [1, 10, 10],
      [1, 5, 5],
    ]);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  });

  it("short: a newer negative live row ends it (E3)", () => {
    const sec = shortStockAfterStatementZero("ZZCG");
    seedHold(db, ACCT, sec, "2026-07-20", "tws", -10);
    computeTaxLots(db);
    expect(lotStates(sec)).toEqual([[1, 10, 10]]);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  });

  it.each([["current"], ["stale"]])("long option: a later BUY_TO_OPEN ends it (%s results)", (mode) => {
    const sec = seedOpt("ZZCH  270115C00010000");
    txn(sec, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    txn(sec, "2026-07-15", "BUY_TO_OPEN", 1, 3);
    computeTaxLots(db);
    if (mode === "stale") bumpTaxInputGeneration(db);
    expect(lotStates(sec)).toEqual([
      [0, 2, 2],
      [0, 1, 1],
    ]);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  });

  it("long option: a newer positive row ends it (E3)", () => {
    const sec = seedOpt("ZZCI  270115C00010000");
    txn(sec, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    seedHold(db, ACCT, sec, "2026-07-20", "tws", 2);
    computeTaxLots(db);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  });

  it.each([["current"], ["stale"]])(
    "an unpriced reopening (engine does not load it) does not end it (%s results)",
    (mode) => {
      const sec = shortStockAfterStatementZero("ZZCJ");
      txn(sec, "2026-07-15", "SHORT_SELL", 5, null);
      computeTaxLots(db);
      if (mode === "stale") bumpTaxInputGeneration(db);
      expect(lotStates(sec)).toEqual([[1, 10, 10]]);
      expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
        ["ZZCJ", "short", "closing_entry_missing", "2026-06-30"],
      ]);
    }
  );

  it("a reopening dated ON the statement-zero date does not end it (R17)", () => {
    const sec = shortStockAfterStatementZero("ZZCK");
    txn(sec, "2026-06-30", "SHORT_SELL", 5, 55);
    computeTaxLots(db);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      ["ZZCK", "short", "closing_entry_missing", "2026-06-30"],
    ]);
  });

  it("T-FLATDATE end to end: statement zero, same-side reopening, newer live zero → awaiting at the live date", () => {
    const sec = shortStockAfterStatementZero("ZZCL");
    txn(sec, "2026-07-05", "SHORT_SELL", 5, 55);
    seedHold(db, ACCT, sec, "2026-07-10", "live-zero");
    computeTaxLots(db);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      ["ZZCL", "short", "awaiting_statement", "2026-07-10"],
    ]);
  });
});

describe("mixed trades (R11)", () => {
  function setup(symbol: string, withLongBuy: boolean): { sec: number; mixedId: number } {
    const sec = seedSec(db, symbol);
    txn(sec, "2026-06-01", "SHORT_SELL", 30, 10);
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    if (withLongBuy) txn(sec, "2026-07-05", "BUY", 40, 11);
    const mixedId = txn(sec, "2026-07-10", "SELL", 100, 12, { evidence: "O;C" });
    computeTaxLots(db);
    return { sec, mixedId };
  }

  it("current results: a successful residual opening after the statement zero ends the short side's pending state", () => {
    const { sec, mixedId } = setup("ZZMA", true);
    // Hand: old 30 short open; the 40 long lot closed by the mixed SELL; a 60 short lot opened from it.
    expect(lotStates(sec)).toEqual([
      [1, 30, 30],
      [0, 40, 0],
      [1, 60, 60],
    ]);
    const index = getPendingStatementIndex(db, undefined, OPTS);
    expect(index.pairs).toEqual([]);
    const newLot = db
      .prepare("SELECT account_id, security_id, is_short FROM tax_lots WHERE acquisition_transaction_id = ?")
      .get(mixedId) as { account_id: number; security_id: number; is_short: number };
    expect(isPendingStatementLot(index, newLot)).toBe(false); // the new 60 is ordinary open (valued); OPEN-10 for the old 30
  });

  it("current results: a refused mixed trade after the statement zero leaves the side closing_entry_missing", () => {
    const { sec } = setup("ZZMB", false);
    expect(lotStates(sec)).toEqual([[1, 30, 30]]); // hand: nothing open on the long side, the engine refused the split
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      ["ZZMB", "short", "closing_entry_missing", "2026-06-30"],
    ]);
  });

  it("stale results (generation bumped after the recompute): the same successful mixed trade leaves the side pending (intended, conservative)", () => {
    const { sec } = setup("ZZMC", true);
    bumpTaxInputGeneration(db);
    expect(lotStates(sec)).toEqual([
      [1, 30, 30],
      [0, 40, 0],
      [1, 60, 60],
    ]);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([
      {
        account_id: ACCT,
        security_id: sec,
        symbol: "ZZMC",
        side: "short",
        reason: "closing_entry_missing",
        flat_date: "2026-06-30",
        open_quantity: 90, // both stored short lots: 30 + 60
        open_figure: 1020, // 300 + 60 x 12
        figure_kind: "short_sale_proceeds",
        lot_count: 2,
      },
    ]);
  });
});

describe("PR #123 kept, its twin, and OPEN-8", () => {
  it("PR #123 kept: a long stock lot under a live-origin short row is awaiting_statement", () => {
    const sec = seedSec(db, "ZZPA");
    seedLot(db, ACCT, sec, { qty: 30 });
    seedHold(db, ACCT, sec, "2026-06-10", "tws", -30);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      ["ZZPA", "long", "awaiting_statement", "2026-06-10"],
    ]);
  });

  it("twin: a short stock lot under a live-origin long row is awaiting_statement on the short side", () => {
    const sec = seedSec(db, "ZZPB");
    seedLot(db, ACCT, sec, { qty: 30, isShort: 1 });
    seedHold(db, ACCT, sec, "2026-06-10", "tws", 30);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      ["ZZPB", "short", "awaiting_statement", "2026-06-10"],
    ]);
  });

  it("a statement-grade opposite-sign row is NOT pending (OPEN-8, current behaviour)", () => {
    const a = seedOpt("ZZPC  270115C00010000");
    seedLot(db, ACCT, a, { qty: 2, price: 300 });
    seedHold(db, ACCT, a, "2026-06-30", "stmt", -2);
    const b = seedSec(db, "ZZPD");
    seedLot(db, ACCT, b, { qty: 10, isShort: 1 });
    seedHold(db, ACCT, b, "2026-06-30", "stmt", 10);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  });
});

describe("T-RESYMBOL (classifier part, synthetic mapping)", () => {
  const OLD = "ZZRS  270115C00100000";
  const NEW = "ZZRS  270115C00050000";

  function setup(flat: "live-zero" | "stmt-zero", heldIn: number | null): number {
    const oldSec = seedOpt(OLD);
    const newSec = seedOpt(NEW);
    seedLot(db, ACCT, oldSec, { qty: 1, price: 400 });
    seedHold(db, ACCT, oldSec, "2026-07-10", flat);
    if (heldIn != null) seedHold(db, heldIn, newSec, "2026-07-10", "tws", 2);
    return oldSec;
  }

  it("live zero, replacement held in the same account → resymbol_repair_pending at the live date", () => {
    setup("live-zero", ACCT);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      [OLD, "long", "resymbol_repair_pending", "2026-07-10"],
    ]);
  });

  it("statement zero, replacement held in the same account → resymbol_repair_pending", () => {
    setup("stmt-zero", ACCT);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      [OLD, "long", "resymbol_repair_pending", "2026-07-10"],
    ]);
  });

  it("replacement held only in another account → the ordinary reason", () => {
    setup("stmt-zero", 1);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      [OLD, "long", "closing_entry_missing", "2026-07-10"],
    ]);
  });

  it("replacement not held (its newest row is zero) → the ordinary reason", () => {
    setup("live-zero", null);
    const newSec = (db.prepare("SELECT id FROM securities WHERE symbol = ?").get(NEW) as { id: number }).id;
    seedHold(db, ACCT, newSec, "2026-07-01", "tws", 2);
    seedHold(db, ACCT, newSec, "2026-07-10", "tws", 0);
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      [OLD, "long", "awaiting_statement", "2026-07-10"],
    ]);
  });

  it("an unmapped contract → the ordinary reason", () => {
    const sec = seedOpt("ZZRT  270115C00100000");
    seedLot(db, ACCT, sec, { qty: 1, price: 400 });
    seedHold(db, ACCT, sec, "2026-07-10", "live-zero");
    expect(brief(getPendingStatementPairs(db, undefined, OPTS))).toEqual([
      ["ZZRT  270115C00100000", "long", "awaiting_statement", "2026-07-10"],
    ]);
  });
});

describe("T-NO-DOUBLE-FLAG (classifier part): expired beats pending, on the Eastern day", () => {
  it.each([["2026-11-20"], ["20261120"]])("expiration stored as %s", (expiration) => {
    const sec = seedOpt("ZZEX  261120C00010000", expiration);
    seedLot(db, ACCT, sec, { qty: 1, price: 100 });
    seedHold(db, ACCT, sec, "2026-11-02", "live-zero");
    expect(brief(getPendingStatementPairs(db, undefined, { today: "2026-11-20" }))).toEqual([
      ["ZZEX  261120C00010000", "long", "awaiting_statement", "2026-11-02"],
    ]);
    expect(getPendingStatementPairs(db, undefined, { today: "2026-11-21" })).toEqual([]);
    const index = getPendingStatementIndex(db, undefined, { today: "2026-11-21" });
    expect(index.reasonFor({ account_id: ACCT, security_id: sec, is_short: 0 })).toBeNull();
  });

  it("an option with no stored expiration stays eligible (OPEN-5: no invented date)", () => {
    const sec = seedOpt("ZZEN  270115C00010000", null);
    seedLot(db, ACCT, sec, { qty: 1, price: 100 });
    seedHold(db, ACCT, sec, "2026-07-10", "live-zero");
    expect(getPendingStatementPairs(db, undefined, OPTS)).toHaveLength(1);
  });
});

describe("T-SIDE, the index and the key", () => {
  it("both sides of one contract pend separately, never summed, long before short", () => {
    const sec = seedOpt("ZZSD  270115C00010000");
    seedLot(db, ACCT, sec, { qty: 2, price: 300 }); // long, cost 600
    seedLot(db, ACCT, sec, { qty: 1, price: 400, isShort: 1 }); // short, proceeds 400
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    const index = getPendingStatementIndex(db, undefined, OPTS);
    expect(index.pairs.map((p) => [p.side, p.reason, p.open_quantity, p.open_figure, p.figure_kind, p.lot_count])).toEqual([
      ["long", "closing_entry_missing", 2, 600, "cost_basis", 1],
      ["short", "closing_entry_missing", 1, 400, "short_sale_proceeds", 1],
    ]);
    expect(index.sidesFor(ACCT, sec).map((p) => p.side)).toEqual(["long", "short"]);
    expect(index.pairReasons(ACCT, sec)).toEqual(["closing_entry_missing"]);
    expect(index.reasonFor({ account_id: ACCT, security_id: sec, is_short: 1 })).toBe("closing_entry_missing");
    expect(index.sidesFor(ACCT, sec + 99)).toEqual([]);
    expect(index.pairReasons(ACCT, sec + 99)).toEqual([]);
  });

  it("a live short row: the long option side is awaiting, the short side is held (E3)", () => {
    const sec = seedOpt("ZZSE  270115C00010000");
    seedLot(db, ACCT, sec, { qty: 2, price: 300 });
    seedLot(db, ACCT, sec, { qty: 2, price: 400, isShort: 1 });
    seedHold(db, ACCT, sec, "2026-07-10", "tws", -2);
    const index = getPendingStatementIndex(db, undefined, OPTS);
    expect(brief([...index.pairs])).toEqual([["ZZSE  270115C00010000", "long", "awaiting_statement", "2026-07-10"]]);
    expect(isPendingStatementLot(index, { account_id: ACCT, security_id: sec, is_short: 0 })).toBe(true);
    expect(isPendingStatementLot(index, { account_id: ACCT, security_id: sec, is_short: 1 })).toBe(false);
  });

  it("pairReasons lists every reason on the pair in PENDING_REASON_ORDER (sides with different reasons)", () => {
    const sec = seedOpt("ZZSF  270115C00010000");
    seedLot(db, ACCT, sec, { qty: 2, price: 300 });
    seedLot(db, ACCT, sec, { qty: 1, price: 400, isShort: 1 });
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    // A long-side reopening between the statement zero and the live zero
    // (results stale: no recompute ran, so the routing catalogue decides).
    txn(sec, "2026-07-05", "BUY_TO_OPEN", 1, 3);
    seedHold(db, ACCT, sec, "2026-07-10", "live-zero");
    const index = getPendingStatementIndex(db, undefined, OPTS);
    expect(brief([...index.pairs])).toEqual([
      ["ZZSF  270115C00010000", "long", "awaiting_statement", "2026-07-10"],
      ["ZZSF  270115C00010000", "short", "closing_entry_missing", "2026-06-30"],
    ]);
    expect(index.pairReasons(ACCT, sec)).toEqual(["awaiting_statement", "closing_entry_missing"]);
  });

  it("the key carries the side", () => {
    expect(pendingStatementKey({ account_id: 3, security_id: 7, is_short: 0 })).toBe("3:7:long");
    expect(pendingStatementKey({ account_id: 3, security_id: 7, is_short: 1 })).toBe("3:7:short");
    expect(pendingStatementKey({ account_id: 3, security_id: 7, is_short: true })).toBe("3:7:short");
    expect(pendingStatementKey({ account_id: 3, security_id: 7, is_short: null })).toBe("3:7:long");
    expect(pendingStatementKey({ account_id: 3, security_id: 7, is_short: undefined })).toBe("3:7:long");
  });
});

describe("T-SCOPE and never-pending classes", () => {
  beforeEach(() => {
    const a = seedOpt("ZZSA  270115C00010000");
    seedLot(db, 1, a, { qty: 1, price: 100 });
    seedHold(db, 1, a, "2026-07-10", "plaid", 0);
    const b = seedSec(db, "ZZSB");
    seedLot(db, ACCT, b, { qty: 5, isShort: 1 });
    seedHold(db, ACCT, b, "2026-06-30", "stmt-zero");
  });

  it("undefined = every account; a list keeps every listed account; [] = nothing", () => {
    expect(getPendingStatementPairs(db, undefined, OPTS).map((p) => p.account_id)).toEqual([1, ACCT]);
    expect(getPendingStatementPairs(db, [ACCT], OPTS).map((p) => p.symbol)).toEqual(["ZZSB"]);
    expect(getPendingStatementPairs(db, [1, ACCT], OPTS)).toHaveLength(2);
    expect(getPendingStatementPairs(db, [2], OPTS)).toEqual([]);
    expect(getPendingStatementPairs(db, [], OPTS)).toEqual([]);
    expect(getPendingStatementIndex(db, [], OPTS).pairs).toEqual([]);
  });

  it.each([["Bond"], ["Mutual Fund"], ["Money Market"]])("a %s is never pending, long or short", (type) => {
    const sec = seedSec(db, `ZZN${type.replace(/\s/g, "").slice(0, 3).toUpperCase()}`, type);
    seedLot(db, ACCT, sec);
    seedLot(db, ACCT, sec, { isShort: 1 });
    seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    seedHold(db, ACCT, sec, "2026-07-10", "live-zero");
    expect(getPendingStatementPairs(db, undefined, OPTS).map((p) => p.security_id)).not.toContain(sec);
  });
});
