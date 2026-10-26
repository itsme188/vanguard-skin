/**
 * T-EXERCISE (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 12, §0 item 4, rulings R5, R14, R15): a pending option that was in
 * fact exercised or assigned leaves the pending list once its closing rows
 * are imported and the lots recomputed.
 *
 *  - Linked cases: the option lot closes with a zero result and the premium
 *    lands on the stock leg (arithmetic as in tests/compute/tax-lots-options.test.ts).
 *  - Silent cases (the engine says NOTHING): the option still closes and
 *    leaves pending, the premium stays realized on the option, there is no
 *    replay warning, and the ledger-only Data Health warning names it.
 *  - Failed-link case (the engine DOES warn): the premium stays realized on
 *    the option and the replay warning reaches the import route's response;
 *    no `exercise-leg-missing` (the link exists).
 *
 * Synthetic symbols and small round numbers only; amount NULL, so dollars
 * are quantity x price (x 100 for an option).
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { computeExerciseLinks, computeTaxLots } from "@/lib/compute/tax-lots";
import { getPendingStatementPairs } from "@/lib/queries/pending-statement";
import { runIntegrityChecks } from "@/lib/queries/integrity-checks";
import { insertSecurity, insertTxn } from "../setup/pending-options-shorts-seed";
import { createPendingTestDb, seedHold } from "../setup/pending-statement-fixtures";

const OPTS = { today: "2026-10-26" };
const ACCT = 3;

let db: Database.Database;
let stock: number;

beforeEach(() => {
  db = createPendingTestDb();
  stock = insertSecurity(db, "ZZEH");
});

function seedOption(symbol: string, optionType: "CALL" | "PUT" | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date, option_type, underlying_symbol)
         VALUES (?, ?, 'option', 100, '2027-01-15', ?, 'ZZEH')`
      )
      .run(symbol, `${symbol} contract`, optionType).lastInsertRowid
  );
}

/** Opened, held per live data, then a live zero on 05-20: pending before the exercise rows arrive. */
function pendingOption(symbol: string, optionType: "CALL" | "PUT" | null, openType: string, price: number): number {
  const opt = seedOption(symbol, optionType);
  insertTxn(db, ACCT, opt, "2026-02-01", openType, 1, price);
  seedHold(db, ACCT, opt, "2026-03-01", "tws", openType === "SELL_TO_OPEN" ? -1 : 1);
  seedHold(db, ACCT, opt, "2026-05-20", "live-zero");
  computeTaxLots(db);
  expect(getPendingStatementPairs(db, undefined, OPTS).map((p) => [p.security_id, p.reason])).toEqual([
    [opt, "awaiting_statement"],
  ]);
  return opt;
}

function optionSale(opt: number) {
  return db
    .prepare(
      `SELECT tls.proceeds, tls.cost_basis_allocated, tls.realized_gain_loss, tls.premium_rollover
         FROM tax_lot_sales tls JOIN tax_lots tl ON tl.id = tls.tax_lot_id WHERE tl.security_id = ?`
    )
    .all(opt) as Array<{ proceeds: number; cost_basis_allocated: number; realized_gain_loss: number; premium_rollover: number }>;
}

function optionOpen(opt: number): number {
  return (db.prepare("SELECT COALESCE(SUM(quantity_remaining), 0) AS q FROM tax_lots WHERE security_id = ?").get(opt) as { q: number }).q;
}

function stockLotBasis(): number {
  return (db.prepare("SELECT cost_basis FROM tax_lots WHERE security_id = ? ORDER BY id DESC LIMIT 1").get(stock) as { cost_basis: number }).cost_basis;
}

function stockSaleProceeds(): number {
  return (
    db
      .prepare(
        `SELECT SUM(tls.proceeds) AS p FROM tax_lot_sales tls JOIN tax_lots tl ON tl.id = tls.tax_lot_id WHERE tl.security_id = ?`
      )
      .get(stock) as { p: number }
  ).p;
}

function exerciseWarnings() {
  const { warnings } = runIntegrityChecks(db, OPTS);
  return {
    price: warnings.filter((w) => w.kind === "exercise-price-missing"),
    leg: warnings.filter((w) => w.kind === "exercise-leg-missing"),
  };
}

describe("T-EXERCISE linked cases: zero result on the option, premium landed on the stock, pair leaves pending", () => {
  it("assigned short put: stock basis = strike cost - premium received", () => {
    const opt = pendingOption("ZZEH  270115P00160000", "PUT", "SELL_TO_OPEN", 7);
    insertTxn(db, ACCT, opt, "2026-05-15", "ASSIGNED", 1, 7);
    insertTxn(db, ACCT, stock, "2026-05-15", "BUY", 100, 160);
    const result = computeTaxLots(db);
    expect(result.replayWarnings).toEqual([]);
    expect(optionOpen(opt)).toBe(0);
    expect(optionSale(opt)).toEqual([{ proceeds: 700, cost_basis_allocated: 700, realized_gain_loss: 0, premium_rollover: 1 }]);
    const premiumIn = 700; // 1 x 7 x 100
    const landed = 16000 - stockLotBasis(); // strike cost minus the stock lot's basis
    expect(landed).toBeCloseTo(premiumIn, 9);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  });

  it("assigned short call: stock sale proceeds = strike proceeds + premium received", () => {
    insertTxn(db, ACCT, stock, "2025-06-01", "BUY", 100, 150);
    const opt = pendingOption("ZZEH  270115C00180000", "CALL", "SELL_TO_OPEN", 6);
    insertTxn(db, ACCT, opt, "2026-05-15", "ASSIGNED", 1, 6);
    insertTxn(db, ACCT, stock, "2026-05-15", "SELL", 100, 180);
    const result = computeTaxLots(db);
    expect(result.replayWarnings).toEqual([]);
    expect(optionOpen(opt)).toBe(0);
    expect(optionSale(opt)).toEqual([{ proceeds: 600, cost_basis_allocated: 600, realized_gain_loss: 0, premium_rollover: 1 }]);
    expect(stockSaleProceeds() - 18000).toBeCloseTo(600, 9);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  });

  it("exercised long call: stock basis = strike cost + premium paid", () => {
    const opt = pendingOption("ZZEH  270115C00180001", "CALL", "BUY_TO_OPEN", 5);
    insertTxn(db, ACCT, opt, "2026-05-15", "EXERCISED", 1, 5);
    insertTxn(db, ACCT, stock, "2026-05-15", "BUY", 100, 180);
    const result = computeTaxLots(db);
    expect(result.replayWarnings).toEqual([]);
    expect(optionOpen(opt)).toBe(0);
    expect(optionSale(opt)).toEqual([{ proceeds: 500, cost_basis_allocated: 500, realized_gain_loss: 0, premium_rollover: 1 }]);
    expect(stockLotBasis() - 18000).toBeCloseTo(500, 9);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  });

  it("exercised long put: stock sale proceeds = strike proceeds - premium paid", () => {
    insertTxn(db, ACCT, stock, "2025-06-01", "BUY", 100, 150);
    const opt = pendingOption("ZZEH  270115P00170000", "PUT", "BUY_TO_OPEN", 8);
    insertTxn(db, ACCT, opt, "2026-05-15", "EXERCISED", 1, 8);
    insertTxn(db, ACCT, stock, "2026-05-15", "SELL", 100, 170);
    const result = computeTaxLots(db);
    expect(result.replayWarnings).toEqual([]);
    expect(optionOpen(opt)).toBe(0);
    expect(optionSale(opt)).toEqual([{ proceeds: 800, cost_basis_allocated: 800, realized_gain_loss: 0, premium_rollover: 1 }]);
    expect(17000 - stockSaleProceeds()).toBeCloseTo(800, 9);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  });

  it("no exercise warning for any linked case", () => {
    const opt = pendingOption("ZZEH  270115P00160000", "PUT", "SELL_TO_OPEN", 7);
    insertTxn(db, ACCT, opt, "2026-05-15", "ASSIGNED", 1, 7);
    insertTxn(db, ACCT, stock, "2026-05-15", "BUY", 100, 160);
    computeTaxLots(db);
    expect(exerciseWarnings()).toEqual({ price: [], leg: [] });
  });
});

describe("T-EXERCISE silent cases (R15): the engine emits NO warning; the ledger-only Data Health warning does", () => {
  /** The short put's premium (+700) realized on the option close; the pair leaves pending. */
  function expectRealizedOnOption(opt: number) {
    expect(optionOpen(opt)).toBe(0);
    expect(optionSale(opt)).toEqual([{ proceeds: 700, cost_basis_allocated: 0, realized_gain_loss: 700, premium_rollover: 0 }]);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
  }

  it("priced ASSIGNED with no stock leg → closed, premium realized on the option, no replay warning, exercise-leg-missing", () => {
    const opt = pendingOption("ZZEH  270115P00160000", "PUT", "SELL_TO_OPEN", 7);
    const assigned = insertTxn(db, ACCT, opt, "2026-05-15", "ASSIGNED", 1, 7);
    const result = computeTaxLots(db);
    expect(result.replayWarnings).toEqual([]);
    expectRealizedOnOption(opt);
    const { leg, price } = exerciseWarnings();
    expect(leg.map((h) => h.key)).toEqual([`exercise-leg-missing:${assigned}`]);
    expect(leg[0].reason).toContain("no matching stock trade was found");
    expect(price).toEqual([]);
  });

  it("ASSIGNED with a zero price → same realized result, no replay warning, exercise-price-missing", () => {
    const opt = pendingOption("ZZEH  270115P00160000", "PUT", "SELL_TO_OPEN", 7);
    const assigned = insertTxn(db, ACCT, opt, "2026-05-15", "ASSIGNED", 1, 0);
    insertTxn(db, ACCT, stock, "2026-05-15", "BUY", 100, 160);
    const result = computeTaxLots(db);
    expect(result.replayWarnings).toEqual([]);
    expectRealizedOnOption(opt);
    expect(stockLotBasis()).toBe(16000); // nothing rolled
    const { leg, price } = exerciseWarnings();
    expect(price.map((h) => h.key)).toEqual([`exercise-price-missing:${assigned}`]);
    expect(leg).toEqual([]);
  });

  it("option without option_type → same realized result, no replay warning, exercise-leg-missing with the metadata wording", () => {
    const opt = pendingOption("ZZEH  270115P00160000", null, "SELL_TO_OPEN", 7);
    const assigned = insertTxn(db, ACCT, opt, "2026-05-15", "ASSIGNED", 1, 7);
    insertTxn(db, ACCT, stock, "2026-05-15", "BUY", 100, 160);
    const result = computeTaxLots(db);
    expect(result.replayWarnings).toEqual([]);
    expectRealizedOnOption(opt);
    const { leg } = exerciseWarnings();
    expect(leg.map((h) => h.key)).toEqual([`exercise-leg-missing:${assigned}`]);
    expect(leg[0].reason).toContain("the option has no underlying or call/put recorded");
  });
});

describe("T-EXERCISE failed-link case: the engine DOES warn", () => {
  it("linked stock transaction opened no lot → premium realized on the option, the replay warning reaches the import response, no exercise-leg-missing", () => {
    const opt = pendingOption("ZZEH  270115P00160000", "PUT", "SELL_TO_OPEN", 7);
    const assigned = insertTxn(db, ACCT, opt, "2026-05-15", "ASSIGNED", 1, 7);
    const stockLeg = insertTxn(db, ACCT, stock, "2026-05-15", "BUY", 100, null); // no price: the engine opens no lot
    expect(computeExerciseLinks(db).links.get(assigned)?.stockTxnId).toBe(stockLeg);
    const result = computeTaxLots(db);
    expect(result.replayWarnings).toHaveLength(1);
    expect(result.replayWarnings[0]).toContain(`links to stock transaction ${stockLeg}, which opened no tax lot`);
    expect(optionOpen(opt)).toBe(0);
    expect(optionSale(opt)).toEqual([{ proceeds: 700, cost_basis_allocated: 0, realized_gain_loss: 700, premium_rollover: 0 }]);
    expect(getPendingStatementPairs(db, undefined, OPTS)).toEqual([]);
    expect(exerciseWarnings()).toEqual({ price: [], leg: [] });
    // The import route forwards computeTaxLots' replayWarnings in its response
    // (the Recompute route drops them: OPEN-9).
    const route = fs.readFileSync(path.join(process.cwd(), "app/api/import/route.ts"), "utf8");
    expect(route).toContain("const lotResult = computeTaxLots(db);");
    expect(route).toContain('{ status: "mismatch", warnings: lotResult.replayWarnings }');
  });
});
