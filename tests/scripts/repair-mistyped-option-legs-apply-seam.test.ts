import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// Synthetic targets only: the real constant is never restated in a test.
vi.mock("@/lib/securities/option-resymbol-targets", () => ({
  OPTION_RESYMBOL_TARGETS: [
    {
      fromSymbol: "ZZA   260101C00100000",
      toSymbol: "ZZA   260101C00050000",
      tradeDate: "2025-01-10",
      type: "BUY_TO_OPEN",
      preQty: 3,
      ratio: 2,
    },
    {
      fromSymbol: "ZZB   260101P00040000",
      toSymbol: "ZZB   260101P00010000",
      tradeDate: "2025-02-03",
      type: "BUY_TO_OPEN",
      preQty: 1,
      ratio: 1,
    },
  ],
}));

import {
  applyMistypedOptionLegPlans,
  planDuplicateDeletions,
  planRetypes,
  planExpiredQtyFix,
  planOptionSplits,
  planOptionResymbols,
} from "@/scripts/repair-mistyped-option-legs";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function sec(db: Database.Database, id: number, symbol: string): number {
  db.prepare(`INSERT INTO securities (id, symbol, name, security_type) VALUES (?, ?, ?, 'Option')`).run(id, symbol, symbol);
  return id;
}

function txn(
  db: Database.Database,
  t: { id: number; account: number; sec: number; date: string; type: string; qty: number; price: number | null; key: string }
) {
  db.prepare(
    `INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(t.id, t.account, t.sec, t.date, t.type, t.qty, t.price, t.key);
}

function dump(db: Database.Database) {
  return db
    .prepare(`SELECT id, security_id, quantity, price_per_share AS price, type, source_key FROM transactions ORDER BY id`)
    .all();
}

function plansFor(db: Database.Database) {
  const dups = planDuplicateDeletions(db);
  return {
    dups,
    retypes: planRetypes(db),
    expFix: planExpiredQtyFix(db),
    optSplits: planOptionSplits(db, dups.map((d) => d.deleteId)),
    resymbols: planOptionResymbols(db),
  };
}

describe("repair-mistyped-option-legs apply seam", () => {
  it("the apply seam reproduces the CLI's writes", () => {
    const db = fresh();
    sec(db, 9001, "ZZA   260101C00100000");
    sec(db, 9002, "ZZA   260101C00050000");
    sec(db, 9003, "ZZB   260101P00040000");
    sec(db, 9004, "ZZB   260101P00010000");
    sec(db, 9005, "ZZC   260101C00020000");
    txn(db, { id: 1, account: 1, sec: 9001, date: "2025-01-10", type: "BUY_TO_OPEN", qty: 3, price: 4, key: "k:ZZA:1" });
    txn(db, { id: 2, account: 1, sec: 9003, date: "2025-02-03", type: "BUY_TO_OPEN", qty: 1, price: 2.5, key: "k:ZZB:1" });
    // an untouched row on the old symbol, wrong date: must stay where it is
    txn(db, { id: 3, account: 1, sec: 9001, date: "2025-01-11", type: "BUY_TO_OPEN", qty: 3, price: 4, key: "k:ZZA:2" });
    // an exact duplicate pair: legacy-keyed copy is deleted, OCC-keyed one stays
    txn(db, { id: 4, account: 1, sec: 9005, date: "2025-03-03", type: "BUY_TO_OPEN", qty: 2, price: 1, key: "x:ZZC 260101 C 20.00:1" });
    txn(db, { id: 5, account: 1, sec: 9005, date: "2025-03-03", type: "BUY_TO_OPEN", qty: 2, price: 1, key: "x:ZZC  260101C00020000:1" });
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (1, 9001, '2025-01-10', 4, 3, 3, 12)`
    ).run();

    const plans = plansFor(db);
    expect(plans.dups.map((d) => [d.deleteId, d.keepId])).toEqual([[4, 5]]);
    expect(plans.resymbols.filter((r) => r.action === "resymbol + normalize").map((r) => r.id)).toEqual([1, 2]);

    applyMistypedOptionLegPlans(db, plans);

    expect(dump(db)).toEqual([
      { id: 1, security_id: 9002, quantity: 6, price: 2, type: "BUY_TO_OPEN", source_key: "k:ZZA:1" },
      { id: 2, security_id: 9004, quantity: 1, price: 2.5, type: "BUY_TO_OPEN", source_key: "k:ZZB:1" },
      { id: 3, security_id: 9001, quantity: 3, price: 4, type: "BUY_TO_OPEN", source_key: "k:ZZA:2" },
      { id: 5, security_id: 9005, quantity: 2, price: 1, type: "BUY_TO_OPEN", source_key: "x:ZZC  260101C00020000:1" },
    ]);
    // the seam clears the lot tables first, as the CLI did
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tax_lots`).get()).toEqual({ n: 0 });

    // a second planning pass finds the finished state, with nothing left to do
    const again = plansFor(db);
    expect(again.resymbols.map((r) => r.action)).toEqual(["already repaired", "already repaired"]);
    expect(again.dups).toEqual([]);
  });

  it("the planner supports only its own rows", () => {
    const db = fresh();
    sec(db, 9001, "ZZA   260101C00100000");
    sec(db, 9002, "ZZA   260101C00050000");
    sec(db, 9003, "ZZB   260101P00040000");
    sec(db, 9004, "ZZB   260101P00010000");
    // mapped old symbol, but another account
    txn(db, { id: 1, account: 2, sec: 9001, date: "2025-01-10", type: "BUY_TO_OPEN", qty: 3, price: 4, key: "k1" });
    // mapped old symbol, but a type the target does not name
    txn(db, { id: 2, account: 1, sec: 9003, date: "2025-02-03", type: "SELL_TO_OPEN", qty: 1, price: 2, key: "k2" });
    // mapped old symbol, but a date the target does not name
    txn(db, { id: 3, account: 1, sec: 9001, date: "2025-01-12", type: "BUY_TO_OPEN", qty: 3, price: 4, key: "k3" });

    const plans = planOptionResymbols(db);
    expect(plans.every((p) => !p.ok && p.id === -1 && p.action === "ROW NOT FOUND — refusing")).toBe(true);
    expect(plans).toHaveLength(2);

    const before = dump(db);
    applyMistypedOptionLegPlans(db, plansFor(db));
    expect(dump(db)).toEqual(before);
  });
});
