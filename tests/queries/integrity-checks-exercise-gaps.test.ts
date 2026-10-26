/**
 * Ledger-only warnings for an option exercise or assignment whose premium is
 * NOT moved to the stock leg while the engine says nothing (plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * §0 item 4, Task 8, rulings R5, R14, R15):
 *  - `exercise-price-missing`: a price-less EXERCISED / ASSIGNED option row;
 *  - `exercise-leg-missing`: a priced one the engine's own lookup
 *    (`computeExerciseLinks`) did not link.
 * Both are warnings (never a cap) and run outside the convention gate.
 * Synthetic symbols and small round numbers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeExerciseLinks } from "@/lib/compute/tax-lots";
import { runIntegrityChecks, integrityCheckIdOf, groupIntegrityHits } from "@/lib/queries/integrity-checks";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import { createPendingTestDb, seedSec } from "../setup/pending-statement-fixtures";

const ACCT = 3; // IBKR

let db: Database.Database;
let seq = 0;
let stock: number;

beforeEach(() => {
  db = createPendingTestDb();
  stock = seedSec(db, "ZZEX");
});

function seedOpt(symbol: string, optionType: string | null = "PUT", underlying: string | null = "ZZEX"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date, option_type, underlying_symbol)
         VALUES (?, ?, 'option', 100, '2026-04-17', ?, ?)`
      )
      .run(symbol, `${symbol} contract`, optionType, underlying).lastInsertRowid
  );
}

function txn(sec: number, date: string, type: string, qty: number, price: number | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`
      )
      .run(ACCT, sec, date, type, qty, price, `iceg-${seq++}`).lastInsertRowid
  );
}

function exerciseWarnings() {
  const { warnings, critical } = runIntegrityChecks(db);
  return {
    critical,
    price: warnings.filter((w) => w.kind === "exercise-price-missing"),
    leg: warnings.filter((w) => w.kind === "exercise-leg-missing"),
  };
}

describe("exercise-price-missing", () => {
  it("a price-less ASSIGNED row gives one warning, and only that one (not exercise-leg-missing too)", () => {
    const opt = seedOpt("ZZEX  260417P00050000");
    txn(opt, "2026-03-01", "SELL_TO_OPEN", 1, 2);
    const assigned = txn(opt, "2026-04-17", "ASSIGNED", 1, null);
    txn(stock, "2026-04-17", "BUY", 100, 50);
    const { price, leg, critical } = exerciseWarnings();
    expect(price).toEqual([
      {
        key: `exercise-price-missing:${assigned}`,
        severity: "warning",
        kind: "exercise-price-missing",
        reason:
          "ZZEX  260417P00050000 (IBKR), assignment on 2026-04-17: exercise or assignment with no price: its premium stays on the option and is not moved to the stock",
      },
    ]);
    expect(leg).toEqual([]);
    expect(critical).toEqual([]);
    expect(integrityCheckIdOf(price[0].key)).toBe("exercise-price");
  });

  it("a zero price counts as no price", () => {
    const opt = seedOpt("ZZEX  260417P00050000");
    const assigned = txn(opt, "2026-04-17", "ASSIGNED", 1, 0);
    const { price, leg } = exerciseWarnings();
    expect(price.map((h) => h.key)).toEqual([`exercise-price-missing:${assigned}`]);
    expect(leg).toEqual([]);
  });

  it("a priced ASSIGNED row gives no price warning", () => {
    const opt = seedOpt("ZZEX  260417P00050000");
    txn(opt, "2026-04-17", "ASSIGNED", 1, 2);
    txn(stock, "2026-04-17", "BUY", 100, 50);
    expect(exerciseWarnings().price).toEqual([]);
  });

  it("the warning never caps, and it runs without the convention marker (ledger only)", () => {
    const opt = seedOpt("ZZEX  260417P00050000");
    txn(opt, "2026-04-17", "EXERCISED", 1, null);
    const { lotDriftChecked } = runIntegrityChecks(db);
    expect(lotDriftChecked).toBe(false);
    const conf = getDataConfidence(db);
    expect(conf.integrity.warnings.some((w) => w.kind === "exercise-price-missing")).toBe(true);
    expect(conf.integrity.critical).toEqual([]);
    expect(conf.capReason).toBeNull();
  });
});

describe("exercise-leg-missing", () => {
  it("a priced ASSIGNED with no stock leg → one warning with the no-matching-trade wording", () => {
    const opt = seedOpt("ZZEX  260417P00050000");
    const assigned = txn(opt, "2026-04-17", "ASSIGNED", 1, 2);
    expect(computeExerciseLinks(db).links.has(assigned)).toBe(false);
    const { leg, price, critical } = exerciseWarnings();
    expect(leg).toEqual([
      {
        key: `exercise-leg-missing:${assigned}`,
        severity: "warning",
        kind: "exercise-leg-missing",
        reason:
          "ZZEX  260417P00050000 (IBKR), assignment on 2026-04-17: no matching stock trade was found: its premium stays on the option and is not moved to the stock",
      },
    ]);
    expect(price).toEqual([]);
    expect(critical).toEqual([]);
    expect(integrityCheckIdOf(leg[0].key)).toBe("exercise-leg");
  });

  it("a priced ASSIGNED whose option lacks option_type → one warning with the metadata wording", () => {
    const opt = seedOpt("ZZEX  260417P00050000", null);
    const assigned = txn(opt, "2026-04-17", "ASSIGNED", 1, 2);
    txn(stock, "2026-04-17", "BUY", 100, 50); // a stock leg exists, but the lookup never reads this option
    const { leg } = exerciseWarnings();
    expect(leg.map((h) => [h.key, h.reason])).toEqual([
      [
        `exercise-leg-missing:${assigned}`,
        "ZZEX  260417P00050000 (IBKR), assignment on 2026-04-17: the option has no underlying or call/put recorded, so its premium stays on the option and is not moved to the stock",
      ],
    ]);
  });

  it("a priced EXERCISED whose option lacks underlying_symbol → the metadata wording", () => {
    const opt = seedOpt("ZZEX  260417C00050000", "CALL", null);
    txn(opt, "2026-04-17", "EXERCISED", 1, 2);
    const { leg } = exerciseWarnings();
    expect(leg).toHaveLength(1);
    expect(leg[0].reason).toContain("exercise on 2026-04-17: the option has no underlying or call/put recorded");
  });

  it("a priced, linked ASSIGNED → no warning", () => {
    const opt = seedOpt("ZZEX  260417P00050000");
    const assigned = txn(opt, "2026-04-17", "ASSIGNED", 1, 2);
    txn(stock, "2026-04-17", "BUY", 100, 50); // short put assigned → stock BUY
    expect(computeExerciseLinks(db).links.has(assigned)).toBe(true);
    const { leg, price } = exerciseWarnings();
    expect(leg).toEqual([]);
    expect(price).toEqual([]);
  });

  it("a stock trade of the wrong direction is not a link (the engine's lookup decides) → warning", () => {
    const opt = seedOpt("ZZEX  260417P00050000");
    const assigned = txn(opt, "2026-04-17", "ASSIGNED", 1, 2);
    txn(stock, "2026-04-17", "SELL", 100, 50); // a short put needs a BUY
    const { leg } = exerciseWarnings();
    expect(leg.map((h) => h.key)).toEqual([`exercise-leg-missing:${assigned}`]);
  });

  it("the new checks group under their own labels on Data Health", () => {
    const opt = seedOpt("ZZEX  260417P00050000");
    txn(opt, "2026-04-17", "ASSIGNED", 1, 2);
    txn(opt, "2026-04-18", "EXERCISED", 1, null);
    const groups = groupIntegrityHits(runIntegrityChecks(db).warnings);
    expect(groups.map((g) => g.check)).toEqual(["exercise-price", "exercise-leg"]);
    for (const g of groups) expect(g.label).not.toMatch(/[-_:.]/);
  });
});
