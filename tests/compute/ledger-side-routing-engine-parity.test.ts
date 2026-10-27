/**
 * The side-routing catalogue (lib/queries/ledger-side-routing.ts) against the
 * engine itself. Plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 3, §0 item 5, rulings R2/R11/R13.
 *
 * For every type in the engine's two loaders plus TRANSFER_OUT (and one type
 * neither loader reads), with no evidence, open-only, close-only and mixed
 * IBKR direction evidence, with and without a price, on a stock and on an
 * option: seed one row in an account that holds one long and one short lot
 * of that security, run `computeTaxLots`, and check the catalogue's answer
 * against what the engine did. Mixed rows are then checked by OUTCOME.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import {
  ENGINE_CLOSING_TYPES,
  ENGINE_OPENING_TYPES,
  routeLedgerRow,
  type LedgerRowInput,
} from "@/lib/queries/ledger-side-routing";
import { createPendingTestDb } from "../setup/pending-statement-fixtures";

const ACCOUNT = 3;
const BASE_DATE = "2026-01-02";
const ROW_DATE = "2026-01-05";
const ROW_QTY = 5;

type Evidence = "none" | "open" | "close" | "mixed";
const EVIDENCE: Evidence[] = ["none", "open", "close", "mixed"];
const NOTE_CODE: Record<Exclude<Evidence, "none">, string> = { open: "O", close: "C", mixed: "O;C" };

function noteFor(evidence: Evidence): string | null {
  return evidence === "none" ? null : (ibkrTradeDirectionNote(NOTE_CODE[evidence], "") ?? null);
}

interface LotRow {
  id: number;
  is_short: number;
  quantity_acquired: number;
  quantity_remaining: number;
  acquisition_transaction_id: number | null;
}

let db: Database.Database;
const secs: Record<"stock" | "option", number> = { stock: 0, option: 0 };

function insertTxn(
  securityId: number,
  date: string,
  type: string,
  qty: number | null,
  price: number | null,
  notes: string | null,
  key: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(ACCOUNT, securityId, date, type, qty, price, 60, notes, key).lastInsertRowid
  );
}

function lotsOf(securityId: number): LotRow[] {
  return db
    .prepare(
      `SELECT id, is_short, quantity_acquired, quantity_remaining, acquisition_transaction_id
         FROM tax_lots WHERE security_id = ? ORDER BY id`
    )
    .all(securityId) as LotRow[];
}

beforeAll(() => {
  db = createPendingTestDb();
  secs.stock = Number(
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ZZRT', 'ZZRT Corp', 'Stock')").run()
      .lastInsertRowid
  );
  secs.option = Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier)
         VALUES ('ZZRT  270115C00050000', 'ZZRT call', 'option', 100)`
      )
      .run().lastInsertRowid
  );
  // One long and one short lot of each security, opened before the test row.
  insertTxn(secs.stock, BASE_DATE, "BUY", 10, 10, null, "rt-base-stock-long");
  insertTxn(secs.stock, BASE_DATE, "SHORT_SELL", 10, 10, null, "rt-base-stock-short");
  insertTxn(secs.option, BASE_DATE, "BUY_TO_OPEN", 10, 1, null, "rt-base-opt-long");
  insertTxn(secs.option, BASE_DATE, "SELL_TO_OPEN", 10, 1, null, "rt-base-opt-short");
});

afterAll(() => db.close());

/** Runs `fn` inside a transaction that is always rolled back, so every case starts from the same seed. */
function inRollback<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    return fn();
  } finally {
    db.exec("ROLLBACK");
  }
}

const TYPES = [...ENGINE_OPENING_TYPES, ...ENGINE_CLOSING_TYPES, "transfer_out", "dividend"].map((t) =>
  t.toUpperCase()
);

/**
 * Engine limit found while building this test (reported, not fixed: the
 * engine is out of scope). A row the CLOSING loader reads without a price
 * (EXPIRED / EXERCISED / ASSIGNED, or a REDEMPTION carrying an amount) that
 * carries OPEN-ONLY direction evidence is routed to `createLot`, which
 * inserts a NULL acquisition price and the whole recompute throws. Evidence
 * is only ever written on IBKR trade rows (BUY / SELL / BUY_TO_OPEN /
 * SELL_TO_CLOSE), so no importer produces this row today.
 */
function engineThrowsOn(type: string, evidence: Evidence, priced: boolean): boolean {
  const t = type.toLowerCase();
  return (
    evidence === "open" &&
    !priced &&
    (t === "expired" || t === "exercised" || t === "assigned" || t === "redemption")
  );
}

interface Case {
  type: string;
  evidence: Evidence;
  priced: boolean;
  cls: "stock" | "option";
}
const CASES: Case[] = [];
for (const cls of ["stock", "option"] as const)
  for (const type of TYPES)
    for (const evidence of EVIDENCE)
      for (const priced of [true, false]) CASES.push({ type, evidence, priced, cls });

describe("routeLedgerRow matches computeTaxLots over the type x evidence x price matrix", () => {
  it.each(CASES.map((c) => [`${c.cls} ${c.type} evidence=${c.evidence} ${c.priced ? "priced" : "no price"}`, c] as const))(
    "%s",
    (_name, c) => {
      const securityId = secs[c.cls];
      const row: LedgerRowInput = {
        type: c.type,
        quantity: ROW_QTY,
        price_per_share: c.priced ? 12 : null,
        amount: 60,
        notes: noteFor(c.evidence),
        security_type: c.cls,
      };
      const route = routeLedgerRow(row);

      if (engineThrowsOn(c.type, c.evidence, c.priced)) {
        // The catalogue says what the engine attempts: an opening it cannot store.
        expect(route).toMatchObject({ role: "open", side: "short", engineLoads: true });
        inRollback(() => {
          insertTxn(securityId, ROW_DATE, c.type, ROW_QTY, null, row.notes, "rt-case");
          expect(() => computeTaxLots(db)).toThrow();
        });
        return;
      }

      const { before, after, rowId, warnings } = inRollback(() => {
        computeTaxLots(db);
        const before = lotsOf(securityId);
        const rowId = insertTxn(securityId, ROW_DATE, c.type, ROW_QTY, row.price_per_share, row.notes, "rt-case");
        const result = computeTaxLots(db);
        return { before, after: lotsOf(securityId), rowId, warnings: result.replayWarnings };
      });

      const baseLong = before.find((l) => l.is_short === 0)!;
      const baseShort = before.find((l) => l.is_short === 1)!;
      expect(baseLong.quantity_remaining).toBe(10);
      expect(baseShort.quantity_remaining).toBe(10);

      const created = after.filter((l) => l.acquisition_transaction_id === rowId);
      const old = after.filter((l) => l.acquisition_transaction_id !== rowId);
      const longRemaining = old.filter((l) => l.is_short === 0).reduce((s, l) => s + l.quantity_remaining, 0);
      const shortRemaining = old.filter((l) => l.is_short === 1).reduce((s, l) => s + l.quantity_remaining, 0);

      if (!route.engineLoads || route.role === "none") {
        expect(created).toEqual([]);
        expect([longRemaining, shortRemaining]).toEqual([10, 10]);
        return;
      }
      switch (route.role) {
        case "open":
          expect(created).toHaveLength(1);
          expect(created[0].is_short).toBe(route.side === "short" ? 1 : 0);
          expect(created[0].quantity_acquired).toBe(ROW_QTY);
          expect([longRemaining, shortRemaining]).toEqual([10, 10]);
          expect(route.certainty).toBe("certain");
          break;
        case "close":
          expect(created).toEqual([]);
          expect([longRemaining, shortRemaining]).toEqual(route.side === "long" ? [5, 10] : [10, 5]);
          expect(route.certainty).toBe("certain");
          break;
        case "close_either":
          expect(created).toEqual([]);
          expect(longRemaining + shortRemaining).toBe(15);
          expect(route.certainty).toBe("certain");
          break;
        case "mixed":
          // 10 open on the closing side, a mixed row of 5: the engine cannot
          // split it (quantity not larger than what is open) and does nothing.
          expect(route.certainty).toBe("needs_replay");
          expect(created).toEqual([]);
          expect([longRemaining, shortRemaining]).toEqual([10, 10]);
          expect(warnings.some((w) => w.includes(`mixed opening/closing transaction ${rowId}`))).toBe(true);
          break;
      }
    }
  );

  it("every mixed-evidence row reads needs_replay; every other role reads certain", () => {
    for (const c of CASES) {
      const r = routeLedgerRow({
        type: c.type,
        quantity: ROW_QTY,
        price_per_share: c.priced ? 12 : null,
        amount: 60,
        notes: noteFor(c.evidence),
        security_type: c.cls,
      });
      expect(r.certainty).toBe(r.role === "mixed" ? "needs_replay" : "certain");
    }
  });

  it("evidence is ignored on a bond row (the engine reads it on stock, ETF and option rows only)", () => {
    const r = routeLedgerRow({
      type: "SELL",
      quantity: 5,
      price_per_share: 99,
      amount: 60,
      notes: noteFor("open"),
      security_type: "Bond",
    });
    expect(r).toMatchObject({ role: "close", side: "long", certainty: "certain", engineLoads: true });
  });
});

describe("mixed trades checked by outcome (R11)", () => {
  function freshSec(symbol: string): number {
    return Number(
      db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')").run(symbol, symbol)
        .lastInsertRowid
    );
  }

  it("successful residual opening: 40 long open, a mixed SELL of 100 closes the 40 and opens a 60 short lot", () => {
    inRollback(() => {
      const sec = freshSec("ZZMXA");
      insertTxn(sec, "2026-02-02", "BUY", 40, 10, null, "mx-a-buy");
      const notes = noteFor("mixed");
      const id = insertTxn(sec, "2026-02-10", "SELL", 100, 12, notes, "mx-a-sell");
      const route = routeLedgerRow({ type: "SELL", quantity: 100, price_per_share: 12, amount: 60, notes, security_type: "stock" });
      expect(route).toMatchObject({ role: "mixed", closeSide: "long", openSide: "short", certainty: "needs_replay", engineLoads: true });

      computeTaxLots(db);
      const lots = lotsOf(sec);
      // Hand-written expected state: the 40 long lot is closed, a 60 short lot is open.
      expect(lots.map((l) => [l.is_short, l.quantity_acquired, l.quantity_remaining, l.acquisition_transaction_id === id])).toEqual([
        [0, 40, 0, false],
        [1, 60, 60, true],
      ]);
      // closeSide (long) is the side that was consumed; openSide (short) the side created.
    });
  });

  it("refused mixed trade: nothing open on the closing side, no lot consumed or created, a replay warning", () => {
    inRollback(() => {
      const sec = freshSec("ZZMXB");
      insertTxn(sec, "2026-02-02", "SHORT_SELL", 30, 10, null, "mx-b-short");
      const id = insertTxn(sec, "2026-02-10", "SELL", 100, 12, noteFor("mixed"), "mx-b-sell");
      const result = computeTaxLots(db);
      expect(lotsOf(sec).map((l) => [l.is_short, l.quantity_remaining])).toEqual([[1, 30]]);
      expect(result.replayWarnings.some((w) => w.includes(`mixed opening/closing transaction ${id}`))).toBe(true);
    });
  });

  it("refused mixed trade, quantity not larger than what is open: no lot consumed or created, a replay warning", () => {
    inRollback(() => {
      const sec = freshSec("ZZMXC");
      insertTxn(sec, "2026-02-02", "BUY", 100, 10, null, "mx-c-buy");
      const id = insertTxn(sec, "2026-02-10", "SELL", 100, 12, noteFor("mixed"), "mx-c-sell");
      const result = computeTaxLots(db);
      expect(lotsOf(sec).map((l) => [l.is_short, l.quantity_remaining])).toEqual([[0, 100]]);
      expect(result.replayWarnings.some((w) => w.includes(`mixed opening/closing transaction ${id}`))).toBe(true);
    });
  });
});
