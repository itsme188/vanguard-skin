/**
 * Corp-actions hardening (U12): the split replay reads only split rows, and a
 * book that is long in one place and short in another keeps each direction's
 * quantities and its share-delta cross-check right.
 *
 * Synthetic fixtures only: fake tickers, small round numbers.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getPendingStatementPairs } from "@/lib/queries/pending-statement";
import {
  createPendingTestDb,
  seedSec,
  seedLot,
  seedHold,
} from "../setup/pending-statement-fixtures";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Second')").run();
  db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZZA', 'Stock')").run();
  const first = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
  const second = (db.prepare("SELECT id FROM accounts WHERE name='Second'").get() as { id: number }).id;
  const sec = (db.prepare("SELECT id FROM securities WHERE symbol='ZZZA'").get() as { id: number }).id;
  return { db, first, second, sec };
}

let keySeq = 0;
function insertTxn(db: Database.Database, accountId: number, secId: number,
  date: string, type: string, qty: number, price: number) {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(accountId, secId, date, type, qty, price, qty * price, `u12:${keySeq++}`);
}

function insertAction(db: Database.Database, secId: number, accountId: number | null,
  actionType: string, date: string, num: number, den: number, delta: number | null) {
  db.prepare(
    `INSERT INTO corporate_actions
       (security_id, account_id, action_type, effective_date, ratio_numerator, ratio_denominator,
        applied, source, source_key, quantity_delta)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'import', ?, ?)`,
  ).run(secId, accountId, actionType, date, num, den, `u12:ca:${actionType}:${date}:${keySeq++}`, delta);
}

interface LotRow {
  account_id: number;
  is_short: number;
  quantity_acquired: number;
  quantity_remaining: number;
  acquisition_price: number;
  cost_basis: number;
}
/** Open lots on one explicit side — never "whatever is left over". */
function openLots(db: Database.Database, accountId: number, isShort: 0 | 1): LotRow[] {
  return db
    .prepare(
      `SELECT account_id, is_short, quantity_acquired, quantity_remaining, acquisition_price, cost_basis
         FROM tax_lots
        WHERE account_id = ? AND is_short = ? AND quantity_remaining > 0
        ORDER BY id`,
    )
    .all(accountId, isShort) as LotRow[];
}
function delta(db: Database.Database): number | null {
  return (db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null })
    .reconcile_delta;
}

describe("computeTaxLots: split replay reads split rows only", () => {
  it("an import-sourced non-split action (SPINOFF) is never replayed as a split", () => {
    const { db, first, sec } = setup();
    insertTxn(db, first, sec, "2026-06-01", "BUY", 100, 400);
    insertAction(db, sec, first, "SPINOFF", "2026-07-01", 4, 1, 300);
    const result = computeTaxLots(db);
    const [lot] = openLots(db, first, 0);
    expect(lot.quantity_acquired).toBeCloseTo(100);
    expect(lot.quantity_remaining).toBeCloseTo(100);
    expect(lot.acquisition_price).toBeCloseTo(400);
    expect(lot.cost_basis).toBeCloseTo(40000);
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("an import-sourced MERGER after a statement zero does not trip the split guard", () => {
    const { db, first, sec } = setup();
    insertTxn(db, first, sec, "2026-06-01", "BUY", 100, 400);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 0, 0, '2026-06-15', ?)`,
    ).run(first, sec, `recon:closed-equity:${first}:${sec}:2026-06-15:stmt`);
    insertAction(db, sec, first, "MERGER", "2026-07-01", 4, 1, null);
    const result = computeTaxLots(db);
    expect(openLots(db, first, 0)).toHaveLength(0);
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("split rows still replay whatever the stored letter case", () => {
    const { db, first, sec } = setup();
    insertTxn(db, first, sec, "2026-06-01", "BUY", 100, 400);
    insertAction(db, sec, first, "split", "2026-07-01", 4, 1, 300);
    computeTaxLots(db);
    const [lot] = openLots(db, first, 0);
    expect(lot.quantity_remaining).toBeCloseTo(400);
    expect(lot.acquisition_price).toBeCloseTo(100);
    expect(delta(db)).toBeNull();
  });

  it("the pending-statement read model applies the same split-only filter", () => {
    const db = createPendingTestDb();
    const sec = seedSec(db, "ZZZB");
    seedLot(db, 3, sec);
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    db.prepare(
      `INSERT INTO corporate_actions
         (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source, source_key)
       VALUES (?, 'MERGER', '2026-07-20', 2, 1, 0, 'import', 'u12:ca:merger')`,
    ).run(sec);
    expect(getPendingStatementPairs(db).map((p) => p.symbol)).toEqual(["ZZZB"]);
  });
});

describe("computeTaxLots: mixed long + short book on one security", () => {
  it("long in one account, short in another: the split scales both; the cross-check reads only the importing (long) account", () => {
    const { db, first, second, sec } = setup();
    insertTxn(db, first, sec, "2026-06-01", "BUY", 100, 400);
    insertTxn(db, second, sec, "2026-06-02", "SELL_TO_OPEN", 50, 410);
    insertAction(db, sec, first, "SPLIT", "2026-07-01", 4, 1, 300);   // long 100 -> 400
    const result = computeTaxLots(db);

    const [long] = openLots(db, first, 0);
    expect(long.quantity_remaining).toBeCloseTo(400);
    expect(long.acquisition_price).toBeCloseTo(100);
    expect(long.cost_basis).toBeCloseTo(40000);
    expect(openLots(db, first, 1)).toHaveLength(0);

    const [short] = openLots(db, second, 1);
    expect(short.quantity_remaining).toBeCloseTo(200);
    expect(short.acquisition_price).toBeCloseTo(102.5);
    expect(short.cost_basis).toBeCloseTo(20500);
    expect(openLots(db, second, 0)).toHaveLength(0);

    expect(delta(db)).toBeNull();
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("same book, statement from the SHORT account: the broker's negative delta matches", () => {
    const { db, first, second, sec } = setup();
    insertTxn(db, first, sec, "2026-06-01", "BUY", 100, 400);
    insertTxn(db, second, sec, "2026-06-02", "SELL_TO_OPEN", 50, 410);
    insertAction(db, sec, second, "SPLIT", "2026-07-01", 4, 1, -150);  // short -50 -> -200
    const result = computeTaxLots(db);
    expect(openLots(db, first, 0)[0].quantity_remaining).toBeCloseTo(400);
    expect(openLots(db, second, 1)[0].quantity_remaining).toBeCloseTo(200);
    expect(delta(db)).toBeNull();
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("a statement delta with the wrong sign for the short account is flagged, not absorbed by the other account's long", () => {
    const { db, first, second, sec } = setup();
    insertTxn(db, first, sec, "2026-06-01", "BUY", 100, 400);
    insertTxn(db, second, sec, "2026-06-02", "SELL_TO_OPEN", 50, 410);
    insertAction(db, sec, second, "SPLIT", "2026-07-01", 4, 1, 150);
    const result = computeTaxLots(db);
    expect(delta(db)).toBeCloseTo(-300);                               // implied -150 minus stated +150
    expect(result.replayWarnings.join("\n")).toContain("ZZZA");
  });

  it("long -> flat -> short in one account: only the open short is scaled and cross-checked", () => {
    const { db, first, sec } = setup();
    insertTxn(db, first, sec, "2026-05-01", "BUY", 100, 400);
    insertTxn(db, first, sec, "2026-05-20", "SELL", 100, 420);
    insertTxn(db, first, sec, "2026-06-02", "SELL_TO_OPEN", 50, 410);
    insertAction(db, sec, first, "SPLIT", "2026-07-01", 4, 1, -150);
    const result = computeTaxLots(db);

    expect(openLots(db, first, 0)).toHaveLength(0);
    const [short] = openLots(db, first, 1);
    expect(short.quantity_remaining).toBeCloseTo(200);
    expect(short.acquisition_price).toBeCloseTo(102.5);

    // The closed long round-trip keeps its original units and result.
    const sale = db.prepare("SELECT quantity_sold, realized_gain_loss FROM tax_lot_sales").get() as Record<string, number>;
    expect(sale.quantity_sold).toBeCloseTo(100);
    expect(sale.realized_gain_loss).toBeCloseTo(2000);
    expect(delta(db)).toBeNull();
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("long and short open together in one account: the cross-check nets them by sign", () => {
    const { db, first, sec } = setup();
    insertTxn(db, first, sec, "2026-06-01", "BUY", 100, 400);
    insertTxn(db, first, sec, "2026-06-02", "SELL_TO_OPEN", 40, 410);
    insertAction(db, sec, first, "SPLIT", "2026-07-01", 4, 1, 180);    // net +60 -> +240
    const result = computeTaxLots(db);
    expect(openLots(db, first, 0)[0].quantity_remaining).toBeCloseTo(400);
    expect(openLots(db, first, 1)[0].quantity_remaining).toBeCloseTo(160);
    expect(delta(db)).toBeNull();
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("an unmatched plain SELL never mints a short lot", () => {
    const { db, first, second, sec } = setup();
    insertTxn(db, first, sec, "2026-06-01", "BUY", 100, 400);
    insertTxn(db, second, sec, "2026-06-02", "SELL", 50, 410);         // no lot in this account
    computeTaxLots(db);
    expect(openLots(db, second, 1)).toHaveLength(0);
    expect(openLots(db, first, 0)[0].quantity_remaining).toBeCloseTo(100);
  });
});
