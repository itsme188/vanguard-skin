/**
 * Synthetic figures and symbols only (the repo is public). The real rows live
 * in the gitignored data/repair-configs/option-exercise-basis.json.
 *
 * The defect: an option exercise row the engine cannot link (no price, or an
 * IBKR exercise imported as SELL_TO_CLOSE at $0) leaves the premium as a
 * realized option loss while the stock leg sits at the strike. The repair
 * types and prices the row; a recompute then moves the premium onto the stock
 * leg. Conservation: once every affected share is closed, total realized
 * gain is unchanged; while shares are open, the realized change equals the
 * change in open long basis minus the change in open short proceeds.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import {
  parseRepairConfig,
  planOptionExerciseRepair,
  rehearsalImage,
  runOptionExerciseRepair,
  type RepairConfig,
} from "@/scripts/repair-option-exercise-basis";

const TODAY = "2026-01-15";
const ACCOUNT = "Synthetic Taxable";
const BROKER_ACCOUNT = "Synthetic Broker";
const DIRECTION_CLOSE = (time: string) =>
  `IBKR trade direction: ${JSON.stringify({ open: false, close: true, time })}`;
const DIRECTION_OPEN = (time: string) =>
  `IBKR trade direction: ${JSON.stringify({ open: true, close: false, time })}`;

let db: Database.Database;

function createDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  return d;
}

function accountId(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function security(id: number, symbol: string, type: string, opt?: { underlying: string; kind: "CALL" | "PUT"; strike: number }) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, symbol, symbol, type,
    opt?.underlying ?? null, opt?.kind ?? null, opt?.strike ?? null,
    opt ? "2025-06-20" : null, opt ? 100 : null,
  );
}

function txn(
  acct: number,
  securityId: number,
  type: string,
  date: string,
  quantity: number,
  price: number | null,
  amount: number | null,
  notes: string | null = null,
): number {
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, type, trade_date, quantity, price_per_share, amount, fees, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(acct, securityId, type, date, quantity, price, amount, notes).lastInsertRowid as number;
}

function realizedTotal(): number {
  return (db.prepare("SELECT COALESCE(SUM(realized_gain_loss), 0) AS g FROM tax_lot_sales").get() as { g: number }).g;
}

function openLong(): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(cost_basis * quantity_remaining / quantity_acquired), 0) AS b
       FROM tax_lots WHERE is_short = 0 AND quantity_remaining > 0`,
  ).get() as { b: number }).b;
}

function openShort(): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(cost_basis * quantity_remaining / quantity_acquired), 0) AS b
       FROM tax_lots WHERE is_short = 1 AND quantity_remaining > 0`,
  ).get() as { b: number }).b;
}

function lotFor(acquisitionTxn: number) {
  return db
    .prepare("SELECT cost_basis, acquisition_price, quantity_remaining, is_short FROM tax_lots WHERE acquisition_transaction_id = ?")
    .get(acquisitionTxn) as { cost_basis: number; acquisition_price: number; quantity_remaining: number; is_short: number };
}

/**
 * Two exercises:
 *  - ZZA long call (1 contract, $5 premium, $50 strike) exercised with NO
 *    price; 100 shares delivered; 40 sold at $60, 60 still held.
 *  - ZZB long put (2 contracts, $3 premium, $40 strike) in a broker account,
 *    imported as SELL_TO_CLOSE at $0 with close-only broker evidence; 200
 *    shares delivered SHORT at the strike, covered later at $35.
 */
interface Fixture {
  callExercise: number;
  callLeg: number;
  putExercise: number;
  putLeg: number;
  laterSale: number;
}

function seedFixture(): Fixture {
  const acct = accountId(ACCOUNT);
  const broker = accountId(BROKER_ACCOUNT);
  security(901, "ZZA", "Stock");
  security(902, "ZZA   250620C00050000", "Option", { underlying: "ZZA", kind: "CALL", strike: 50 });
  security(903, "ZZB", "Stock");
  security(904, "ZZB   250620P00040000", "Option", { underlying: "ZZB", kind: "PUT", strike: 40 });

  txn(acct, 902, "BUY_TO_OPEN", "2025-02-03", 1, 5, -500);
  const callExercise = txn(acct, 902, "EXERCISED", "2025-06-20", 1, null, 0);
  const callLeg = txn(acct, 901, "BUY", "2025-06-20", 100, 50, -5000);
  const laterSale = txn(acct, 901, "SELL", "2025-08-01", 40, 60, 2400);

  txn(broker, 904, "BUY_TO_OPEN", "2025-03-03", 2, 3, -600, `IBKR trade direction: ${JSON.stringify({ open: true, close: false, time: "2025-03-03 10:00:00" })}`);
  const putExercise = txn(broker, 904, "SELL_TO_CLOSE", "2025-06-20", 2, 0, 0, DIRECTION_CLOSE("2025-06-20 16:20:00"));
  const putLeg = txn(broker, 903, "SELL", "2025-06-20", 200, 40, 8000, DIRECTION_OPEN("2025-06-20 16:20:00"));
  txn(broker, 903, "BUY_TO_COVER", "2025-06-25", 200, 35, -7000, `IBKR trade direction: ${JSON.stringify({ open: false, close: true, time: "2025-06-25 10:00:00" })}`);

  return { callExercise, callLeg, putExercise, putLeg, laterSale };
}

function configFor(f: Fixture): RepairConfig {
  return parseRepairConfig({
    rows: [
      {
        transactionId: f.callExercise,
        accountName: ACCOUNT,
        optionSymbol: "ZZA   250620C00050000",
        tradeDate: "2025-06-20",
        quantity: 1,
        before: { type: "EXERCISED", pricePerShare: null },
        after: { type: "EXERCISED" },
        premiumPerShare: 5,
        stockLegTransactionId: f.callLeg,
      },
      {
        transactionId: f.putExercise,
        accountName: BROKER_ACCOUNT,
        optionSymbol: "ZZB   250620P00040000",
        tradeDate: "2025-06-20",
        quantity: 2,
        before: { type: "SELL_TO_CLOSE", pricePerShare: 0 },
        after: { type: "EXERCISED" },
        premiumPerShare: 3,
        stockLegTransactionId: f.putLeg,
      },
    ],
  });
}

describe("repair-option-exercise-basis", () => {
  let f: Fixture;
  beforeEach(() => {
    db = createDb();
    f = seedFixture();
  });

  it("before the repair the premium is a realized option loss and the stock sits at the strike", () => {
    computeTaxLots(db);
    expect(lotFor(f.callLeg).cost_basis).toBeCloseTo(5000, 6);
    expect(lotFor(f.callLeg).acquisition_price).toBeCloseTo(50, 6);
    expect(lotFor(f.putLeg).cost_basis).toBeCloseTo(8000, 6); // short proceeds at the strike
  });

  it("after the repair and a recompute the premium sits in the stock leg, and lifetime gain is conserved", () => {
    computeTaxLots(db);
    const realizedBefore = realizedTotal();
    const longBefore = openLong();
    const shortBefore = openShort();

    const result = runOptionExerciseRepair(db, configFor(f), { apply: true, today: TODAY });
    expect(result.updated).toBe(2);
    computeTaxLots(db);

    // Long call: basis = strike + premium.
    expect(lotFor(f.callLeg).cost_basis).toBeCloseTo(5500, 6);
    expect(lotFor(f.callLeg).acquisition_price).toBeCloseTo(55, 6);
    // Long put delivered short: proceeds = strike - premium.
    expect(lotFor(f.putLeg).cost_basis).toBeCloseTo(7400, 6);
    // The option closes are now rollovers with zero gain.
    const rolls = db
      .prepare("SELECT realized_gain_loss, premium_rollover FROM tax_lot_sales WHERE sale_transaction_id IN (?, ?)")
      .all(f.callExercise, f.putExercise) as Array<{ realized_gain_loss: number; premium_rollover: number }>;
    expect(rolls).toHaveLength(2);
    for (const r of rolls) {
      expect(r.premium_rollover).toBe(1);
      expect(r.realized_gain_loss).toBeCloseTo(0, 6);
    }

    // Conservation while shares are open: the realized change equals the
    // change in open long basis minus the change in open short proceeds.
    const dRealized = realizedTotal() - realizedBefore;
    const dLong = openLong() - longBefore;
    const dShort = openShort() - shortBefore;
    expect(dRealized).toBeCloseTo(dLong - dShort, 6);
    expect(dLong).toBeCloseTo(60 * 5, 6); // the 60 shares still held carry their premium share
  });

  it("once every affected share is sold, total realized gain is unchanged", () => {
    const acct = accountId(ACCOUNT);
    txn(acct, 901, "SELL", "2025-09-02", 60, 70, 4200);
    computeTaxLots(db);
    const realizedBefore = realizedTotal();
    runOptionExerciseRepair(db, configFor(f), { apply: true, today: TODAY });
    computeTaxLots(db);
    expect(realizedTotal()).toBeCloseTo(realizedBefore, 6);
    expect(openLong()).toBeCloseTo(0, 6);
  });

  it("is idempotent and bumps the tax-input generation once", () => {
    const gen0 = getTaxInputGeneration(db);
    expect(runOptionExerciseRepair(db, configFor(f), { apply: true, today: TODAY }).updated).toBe(2);
    expect(getTaxInputGeneration(db)).toBe(gen0 + 1);
    const second = runOptionExerciseRepair(db, configFor(f), { apply: true, today: TODAY });
    expect(second.updated).toBe(0);
    expect(second.plan.rows.every((r) => r.state === "already-repaired")).toBe(true);
    expect(getTaxInputGeneration(db)).toBe(gen0 + 1);
    const row = db.prepare("SELECT type, price_per_share, notes, amount FROM transactions WHERE id = ?").get(f.putExercise) as {
      type: string; price_per_share: number; notes: string; amount: number;
    };
    expect(row.type).toBe("EXERCISED");
    expect(row.price_per_share).toBe(40); // the strike, the price the stock was delivered at
    expect(row.amount).toBe(0); // cash and identity columns untouched
    expect(row.notes.startsWith(DIRECTION_CLOSE("2025-06-20 16:20:00"))).toBe(true); // broker evidence kept on its line
  });

  it("a dry run writes nothing", () => {
    const result = runOptionExerciseRepair(db, configFor(f), { apply: false, today: TODAY });
    expect(result.plan.refusals).toEqual([]);
    expect(result.updated).toBe(0);
    const row = db.prepare("SELECT type, price_per_share FROM transactions WHERE id = ?").get(f.callExercise) as {
      type: string; price_per_share: number | null;
    };
    expect(row.price_per_share).toBeNull();
  });

  it("refuses the whole run when a stock leg is not the delivery of the exercise", () => {
    db.prepare("UPDATE transactions SET quantity = 150 WHERE id = ?").run(f.callLeg);
    const plan = planOptionExerciseRepair(db, configFor(f));
    expect(plan.refusals.join("\n")).toMatch(/contracts x multiplier/);
    expect(() => runOptionExerciseRepair(db, configFor(f), { apply: true, today: TODAY })).toThrow(/refusing to write/);
    const putRow = db.prepare("SELECT type FROM transactions WHERE id = ?").get(f.putExercise) as { type: string };
    expect(putRow.type).toBe("SELL_TO_CLOSE"); // the healthy row was not written either
  });

  it("refuses a row in neither state, a leg on the wrong side, and broker evidence that is not close-only", () => {
    db.prepare("UPDATE transactions SET price_per_share = 9 WHERE id = ?").run(f.callExercise);
    db.prepare("UPDATE transactions SET type = 'BUY' WHERE id = ?").run(f.putLeg);
    db.prepare("UPDATE transactions SET notes = ? WHERE id = ?").run(
      `IBKR trade direction: ${JSON.stringify({ open: true, close: true, time: "2025-06-20 16:20:00" })}`,
      f.putExercise,
    );
    const reasons = planOptionExerciseRepair(db, configFor(f)).refusals.join("\n");
    expect(reasons).toMatch(/neither the expected before-state/);
    expect(reasons).toMatch(/is not SELL/);
    expect(reasons).toMatch(/not close-only/);
  });

  it("rolls everything back when the engine would link the exercise to a different stock trade", () => {
    // A lower-id BUY of the same underlying on the same day: the engine's
    // lookup takes it first, so the configured leg would not get the premium.
    const acct = accountId(ACCOUNT);
    db.prepare(
      `INSERT INTO transactions (id, account_id, security_id, type, trade_date, quantity, price_per_share, amount, fees)
       VALUES (0, ?, 901, 'BUY', '2025-06-20', 10, 52, -520, 0)`,
    ).run(acct);
    const gen0 = getTaxInputGeneration(db);
    expect(() => runOptionExerciseRepair(db, configFor(f), { apply: true, today: TODAY })).toThrow(/links it to transaction 0/);
    const rows = db.prepare("SELECT type, price_per_share FROM transactions WHERE id IN (?, ?) ORDER BY id").all(
      f.callExercise, f.putExercise,
    ) as Array<{ type: string; price_per_share: number | null }>;
    expect(rows).toEqual([
      { type: "EXERCISED", price_per_share: null },
      { type: "SELL_TO_CLOSE", price_per_share: 0 },
    ]);
    expect(getTaxInputGeneration(db)).toBe(gen0);
  });

  it("rejects a malformed config", () => {
    expect(() => parseRepairConfig({ rows: [] })).toThrow(/non-empty/);
    const good = configFor(f).rows[0];
    expect(() => parseRepairConfig({ rows: [{ ...good, after: { type: "SELL", pricePerShare: 5 } }] })).toThrow(/EXERCISED or ASSIGNED/);
    expect(() => parseRepairConfig({ rows: [{ ...good, premiumPerShare: 0 }] })).toThrow(/positive/);
    // The price is the strike, read from the option: a configured price is refused.
    expect(() => parseRepairConfig({ rows: [{ ...good, after: { type: "EXERCISED", pricePerShare: 5 } }] })).toThrow(
      /no longer read.*strike/,
    );
    expect(() => parseRepairConfig({ rows: [good, good] })).toThrow(/duplicate/);
  });

  it("writes the STRIKE as the exercise price and says so in the notes", () => {
    runOptionExerciseRepair(db, configFor(f), { apply: true, today: TODAY });
    const call = db.prepare("SELECT price_per_share, notes FROM transactions WHERE id = ?").get(f.callExercise) as {
      price_per_share: number; notes: string;
    };
    expect(call.price_per_share).toBe(50);
    expect(call.notes).toMatch(/priced at the strike/);
  });

  it("the tax result at the strike is identical to the premium-per-share version", () => {
    const digest = () => ({
      sales: db
        .prepare(
          `SELECT l.acquisition_transaction_id AS lot_txn, s.sale_transaction_id, s.quantity_sold,
                  ROUND(s.proceeds, 6) AS p, ROUND(s.cost_basis_allocated, 6) AS c,
                  ROUND(s.realized_gain_loss, 6) AS g, s.is_long_term, s.premium_rollover, s.sale_date
             FROM tax_lot_sales s JOIN tax_lots l ON l.id = s.tax_lot_id
            ORDER BY s.sale_transaction_id, lot_txn`,
        )
        .all(),
      lots: db
        .prepare(
          `SELECT acquisition_transaction_id, ROUND(cost_basis, 6) AS c, ROUND(acquisition_price, 6) AS a,
                  quantity_remaining, is_short
             FROM tax_lots ORDER BY acquisition_transaction_id`,
        )
        .all(),
    });
    // Premium version: the rows exactly as the earlier script wrote them.
    db.prepare("UPDATE transactions SET type = 'EXERCISED', price_per_share = 5 WHERE id = ?").run(f.callExercise);
    db.prepare("UPDATE transactions SET type = 'EXERCISED', price_per_share = 3 WHERE id = ?").run(f.putExercise);
    computeTaxLots(db);
    const premium = digest();
    expect(premium.sales.length).toBeGreaterThan(0);
    runOptionExerciseRepair(db, configFor(f), { apply: true, today: TODAY });
    computeTaxLots(db);
    expect(digest()).toEqual(premium);
  });

  it("recognises a row priced at the premium by an earlier run and rewrites it to the strike", () => {
    db.prepare("UPDATE transactions SET type = 'EXERCISED', price_per_share = 3, notes = notes || ? WHERE id = ?").run(
      "\nrepaired earlier at the premium",
      f.putExercise,
    );
    const plan = planOptionExerciseRepair(db, configFor(f));
    expect(plan.refusals).toEqual([]);
    expect(plan.rows.map((r) => r.state)).toEqual(["needs-repair", "premium-to-strike"]);
    expect(runOptionExerciseRepair(db, configFor(f), { apply: true, today: TODAY }).updated).toBe(2);
    const put = db.prepare("SELECT price_per_share, notes FROM transactions WHERE id = ?").get(f.putExercise) as {
      price_per_share: number; notes: string;
    };
    expect(put.price_per_share).toBe(40);
    expect(put.notes).toMatch(/repaired earlier at the premium\n.*changed from the premium per share to the strike/);
    const again = planOptionExerciseRepair(db, configFor(f));
    expect(again.rows.every((r) => r.state === "already-repaired")).toBe(true);
  });

  it("a row at its after-type with an unknown price is refused, not rewritten", () => {
    db.prepare("UPDATE transactions SET type = 'EXERCISED', price_per_share = 7 WHERE id = ?").run(f.putExercise);
    expect(planOptionExerciseRepair(db, configFor(f)).refusals.join("\n")).toMatch(/neither the expected before-state/);
  });

  it("the strike must equal the stock leg's price within one cent", () => {
    db.prepare("UPDATE transactions SET price_per_share = 50.005 WHERE id = ?").run(f.callLeg);
    expect(planOptionExerciseRepair(db, configFor(f)).refusals).toEqual([]);
    db.prepare("UPDATE transactions SET price_per_share = 50.02 WHERE id = ?").run(f.callLeg);
    expect(planOptionExerciseRepair(db, configFor(f)).refusals.join("\n")).toMatch(/not the strike \(within one cent\)/);
  });

  it("the rehearsal image of a WAL-mode file is writable in memory and leaves the file alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-option-exercise-"));
    const file = path.join(dir, "wal.db");
    try {
      const fileDb = new Database(file);
      fileDb.pragma("journal_mode = WAL");
      fileDb.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);");
      const copy = new Database(rehearsalImage(fileDb));
      copy.prepare("INSERT INTO t VALUES (2)").run();
      expect((copy.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(2);
      expect((fileDb.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(1);
      copy.close();
      fileDb.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
