import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  planDuplicateDeletions,
  planRetypes,
  planOptionSplits,
  planExpiredQtyFix,
  RETYPE_TARGETS,
  OPTION_SPLIT_TARGETS,
} from "@/scripts/repair-mistyped-option-legs";

// Mirrors tests/scripts/repair-split-basis-audit.test.ts's fresh()/seed* idiom —
// migration 002 seeds accounts 1='Vanguard Taxable', 2='Vanguard Roth IRA', 3='IBKR'.
function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

const ACCOUNT = 1;

let nextSecurityId = 1000;
function seedSecurity(
  db: Database.Database,
  symbol: string,
  securityType: string | null = "Option"
): number {
  const id = nextSecurityId++;
  db.prepare(`INSERT INTO securities (id, symbol, name, security_type) VALUES (?, ?, ?, ?)`).run(
    id,
    symbol,
    symbol,
    securityType
  );
  return id;
}

let nextTxnId = 1;
interface TxnSeed {
  securityId: number;
  tradeDate: string;
  type: string;
  quantity: number | null;
  price?: number | null;
  amount?: number | null;
  accountId?: number;
  sourceKey?: string;
}
function seedTxn(db: Database.Database, t: TxnSeed): number {
  const id = nextTxnId++;
  db.prepare(
    `INSERT INTO transactions
       (id, account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    t.accountId ?? ACCOUNT,
    t.securityId,
    t.tradeDate,
    t.type,
    t.quantity,
    t.amount ?? null,
    t.price === undefined ? null : t.price,
    t.sourceKey ?? `test:txn:${id}`
  );
  return id;
}

beforeEach(() => {
  nextSecurityId = 1000;
  nextTxnId = 1;
});

// ─── planDuplicateDeletions ─────────────────────────────────────────────

describe("planDuplicateDeletions", () => {
  it("plans exactly one deletion, deleting the legacy-spelled row and keeping the OCC-spelled row", () => {
    const db = fresh();
    // The securities row carries the current (OCC) canonical symbol; both
    // transaction rows reference the same security_id — the defect lives
    // purely in the transaction source_key text embedded at import time.
    const secId = seedSecurity(db, "SHOP  250620P00080000", "Option");
    const legacyId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-04-15",
      type: "BUY_TO_OPEN",
      quantity: 1,
      price: 7.41,
      sourceKey: "canonical:txn:Vanguard Taxable:SHOP 250620 P 80.00:2025-04-15:BUY_TO_OPEN:74100",
    });
    const occId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-04-15",
      type: "BUY_TO_OPEN",
      quantity: 1,
      price: 7.41,
      sourceKey: "canonical:txn:Vanguard Taxable:SHOP  250620P00080000:2025-04-15:BUY_TO_OPEN:74100",
    });

    const plans = planDuplicateDeletions(db);
    expect(plans).toHaveLength(1);
    expect(plans[0].deleteId).toBe(legacyId);
    expect(plans[0].keepId).toBe(occId);
    expect(plans[0].label).toBe("SHOP  250620P00080000 2025-04-15 BUY_TO_OPEN qty=1");
  });

  it("leaves a group of two OCC-keyed rows alone (no legacy spelling present)", () => {
    const db = fresh();
    const secId = seedSecurity(db, "SHOP  250620P00080000", "Option");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-04-15",
      type: "BUY_TO_OPEN",
      quantity: 1,
      price: 7.41,
      sourceKey: "canonical:txn:Vanguard Taxable:SHOP  250620P00080000:2025-04-15:BUY_TO_OPEN:74100",
    });
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-04-15",
      type: "BUY_TO_OPEN",
      quantity: 1,
      price: 7.41,
      // Distinct source_key (UNIQUE column) but still OCC-spelled — not the
      // known disease shape (legacy+OCC pair), so it must be left alone.
      sourceKey: "canonical:txn:Vanguard Taxable:SHOP  250620P00080000:2025-04-15:BUY_TO_OPEN:74101",
    });

    expect(planDuplicateDeletions(db)).toEqual([]);
  });

  it("ignores a duplicate pair on a non-option security", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAPL", "Stock");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-04-15",
      type: "BUY",
      quantity: 10,
      price: 150,
      sourceKey: "canonical:txn:Vanguard Taxable:AAPL:2025-04-15:BUY:150000",
    });
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-04-15",
      type: "BUY",
      quantity: 10,
      price: 150,
      sourceKey: "canonical:txn:Vanguard Taxable:AAPL:2025-04-15:BUY:150001",
    });

    expect(planDuplicateDeletions(db)).toEqual([]);
  });
});

// ─── planRetypes ─────────────────────────────────────────────────────────

describe("planRetypes", () => {
  it("plans a retype + key rewrite for a SELL_TO_OPEN row matching a RETYPE_TARGET", () => {
    const db = fresh();
    const target = RETYPE_TARGETS[0]; // GOOG  250516P00160000 2025-05-07 qty=2
    const secId = seedSecurity(db, target.occSymbol, "Option");
    const rowId = seedTxn(db, {
      securityId: secId,
      tradeDate: target.tradeDate,
      type: "SELL_TO_OPEN",
      quantity: target.quantity,
      price: 160,
      sourceKey:
        "canonical:txn:Vanguard Taxable:GOOG  250516P00160000:2025-05-07:SELL_TO_OPEN:-32000",
    });

    const plans = planRetypes(db);
    expect(plans[0]).toEqual({
      id: rowId,
      label: "GOOG  250516P00160000 2025-05-07 SELL_TO_OPEN→SELL_TO_CLOSE qty=2",
      newKey: "canonical:txn:Vanguard Taxable:GOOG  250516P00160000:2025-05-07:SELL_TO_CLOSE:-32000",
      action: "retype + key rewrite",
      ok: true,
    });
  });

  it("refuses when a row with the new source_key already exists", () => {
    const db = fresh();
    const target = RETYPE_TARGETS[1]; // VEU   250620C00060000 2025-06-06 qty=5
    const secId = seedSecurity(db, target.occSymbol, "Option");
    seedTxn(db, {
      securityId: secId,
      tradeDate: target.tradeDate,
      type: "SELL_TO_OPEN",
      quantity: target.quantity,
      price: 60,
      sourceKey: "canonical:txn:Vanguard Taxable:VEU   250620C00060000:2025-06-06:SELL_TO_OPEN:12500",
    });
    // Pre-existing row already occupying the would-be new key — a clash.
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-01-01",
      type: "SELL_TO_CLOSE",
      quantity: 5,
      price: 60,
      sourceKey: "canonical:txn:Vanguard Taxable:VEU   250620C00060000:2025-06-06:SELL_TO_CLOSE:12500",
    });

    const plans = planRetypes(db);
    expect(plans[1].ok).toBe(false);
    expect(plans[1].action).toBe("new source_key already exists — refusing");
    expect(plans[1].newKey).toBe(
      "canonical:txn:Vanguard Taxable:VEU   250620C00060000:2025-06-06:SELL_TO_CLOSE:12500"
    );
  });

  it("reports already repaired when the SELL_TO_OPEN row is gone but a matching SELL_TO_CLOSE exists", () => {
    const db = fresh();
    const target = RETYPE_TARGETS[2]; // QQQ   250815P00556000 2025-08-05 qty=10
    const secId = seedSecurity(db, target.occSymbol, "Option");
    seedTxn(db, {
      securityId: secId,
      tradeDate: target.tradeDate,
      type: "SELL_TO_CLOSE",
      quantity: target.quantity,
      price: 556,
      sourceKey: "canonical:txn:Vanguard Taxable:QQQ   250815P00556000:2025-08-05:SELL_TO_CLOSE:99999",
    });

    const plans = planRetypes(db);
    expect(plans[2]).toEqual({
      id: -1,
      label: "QQQ   250815P00556000 2025-08-05 SELL_TO_OPEN→SELL_TO_CLOSE qty=10",
      newKey: null,
      ok: true,
      action: "already repaired",
    });
  });

  it("refuses when the row is absent entirely", () => {
    const db = fresh();
    // No rows seeded for RETYPE_TARGETS[3] (APP) at all.
    const plans = planRetypes(db);
    expect(plans[3]).toEqual({
      id: -1,
      label: "APP   251017P00450000 2025-10-01 SELL_TO_OPEN→SELL_TO_CLOSE qty=1",
      newKey: null,
      ok: false,
      action: "ROW NOT FOUND — refusing",
    });
  });
});

// ─── planOptionSplits ────────────────────────────────────────────────────

describe("planOptionSplits", () => {
  it("plans a ×4/÷4 normalization for a pre-split qty=1 row", () => {
    const db = fresh();
    const target = OPTION_SPLIT_TARGETS[0]; // IBKR  250620P00140000 2025-04-17 BUY_TO_OPEN preQty=1 ratio=4
    const secId = seedSecurity(db, target.occSymbol, "Option");
    const rowId = seedTxn(db, {
      securityId: secId,
      tradeDate: target.tradeDate,
      type: target.type,
      quantity: 1,
      price: 12,
    });

    const plans = planOptionSplits(db);
    expect(plans[0]).toEqual({
      id: rowId,
      label: "IBKR  250620P00140000 2025-04-17 BUY_TO_OPEN ×4",
      ok: true,
      action: "normalize",
      newQty: 4,
      newPrice: 3,
    });
  });

  it("reports already normalized when qty is already 4", () => {
    const db = fresh();
    const target = OPTION_SPLIT_TARGETS[1]; // IBKR  270115C00220000
    const secId = seedSecurity(db, target.occSymbol, "Option");
    const rowId = seedTxn(db, {
      securityId: secId,
      tradeDate: target.tradeDate,
      type: target.type,
      quantity: 4,
      price: 2.5,
    });

    const plans = planOptionSplits(db);
    expect(plans[1].id).toBe(rowId);
    expect(plans[1].ok).toBe(true);
    expect(plans[1].action).toBe("already normalized");
  });

  it("refuses an unexpected quantity", () => {
    const db = fresh();
    const target = OPTION_SPLIT_TARGETS[0];
    const secId = seedSecurity(db, target.occSymbol, "Option");
    const rowId = seedTxn(db, {
      securityId: secId,
      tradeDate: target.tradeDate,
      type: target.type,
      quantity: 2,
      price: 12,
    });

    const plans = planOptionSplits(db);
    expect(plans[0].id).toBe(rowId);
    expect(plans[0].ok).toBe(false);
    expect(plans[0].action).toBe("UNEXPECTED qty 2 — refusing");
  });

  it("excludes a still-present legacy duplicate via excludeIds, yielding a clean single-row plan", () => {
    const db = fresh();
    const target = OPTION_SPLIT_TARGETS[0];
    const secId = seedSecurity(db, target.occSymbol, "Option");
    const keepId = seedTxn(db, {
      securityId: secId,
      tradeDate: target.tradeDate,
      type: target.type,
      quantity: 1,
      price: 8,
    });
    const dupId = seedTxn(db, {
      securityId: secId,
      tradeDate: target.tradeDate,
      type: target.type,
      quantity: 1,
      price: 8,
    });

    // Without exclusion, two rows match and planning refuses.
    const withoutExclude = planOptionSplits(db);
    expect(withoutExclude[0].ok).toBe(false);
    expect(withoutExclude[0].action).toBe("expected 1 row, found 2 (run after dedup)");

    // With the duplicate excluded (as the caller does post-dedup-plan), a
    // clean single-row normalize plan comes out.
    const withExclude = planOptionSplits(db, [dupId]);
    expect(withExclude[0]).toEqual({
      id: keepId,
      label: "IBKR  250620P00140000 2025-04-17 BUY_TO_OPEN ×4",
      ok: true,
      action: "normalize",
      newQty: 4,
      newPrice: 2,
    });
  });
});

// ─── planExpiredQtyFix ───────────────────────────────────────────────────

describe("planExpiredQtyFix", () => {
  const SYMBOL = "GOOG  250516P00160000";
  const LABEL = "GOOG 250516P00160000 2025-05-16 EXPIRED qty 2→1";

  it("plans qty 2→1", () => {
    const db = fresh();
    const secId = seedSecurity(db, SYMBOL, "Option");
    const rowId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-05-16",
      type: "EXPIRED",
      quantity: 2,
    });

    const plan = planExpiredQtyFix(db);
    expect(plan).toEqual({ id: rowId, label: LABEL, newKey: null, ok: true, action: "qty 2→1" });
  });

  it("reports already repaired when qty is already 1", () => {
    const db = fresh();
    const secId = seedSecurity(db, SYMBOL, "Option");
    const rowId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-05-16",
      type: "EXPIRED",
      quantity: 1,
    });

    const plan = planExpiredQtyFix(db);
    expect(plan).toEqual({ id: rowId, label: LABEL, newKey: null, ok: true, action: "already repaired" });
  });

  it("refuses an unexpected quantity", () => {
    const db = fresh();
    const secId = seedSecurity(db, SYMBOL, "Option");
    const rowId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-05-16",
      type: "EXPIRED",
      quantity: 3,
    });

    const plan = planExpiredQtyFix(db);
    expect(plan).toEqual({
      id: rowId,
      label: LABEL,
      newKey: null,
      ok: false,
      action: "UNEXPECTED qty 3 — refusing",
    });
  });
});

// ─── exported constants ──────────────────────────────────────────────────

describe("exported constants", () => {
  it("RETYPE_TARGETS has the 7 documented mistyped closing legs", () => {
    expect(RETYPE_TARGETS).toHaveLength(7);
    expect(RETYPE_TARGETS[0]).toEqual({
      occSymbol: "GOOG  250516P00160000",
      tradeDate: "2025-05-07",
      quantity: 2,
    });
    expect(RETYPE_TARGETS[6]).toEqual({
      occSymbol: "META  251107P00700000",
      tradeDate: "2025-11-04",
      quantity: 1,
    });
  });

  it("OPTION_SPLIT_TARGETS has the 2 documented pre-split IBKR option legs", () => {
    expect(OPTION_SPLIT_TARGETS).toHaveLength(2);
    expect(OPTION_SPLIT_TARGETS[0]).toEqual({
      occSymbol: "IBKR  250620P00140000",
      tradeDate: "2025-04-17",
      type: "BUY_TO_OPEN",
      preQty: 1,
      ratio: 4,
    });
    expect(OPTION_SPLIT_TARGETS[1]).toEqual({
      occSymbol: "IBKR  270115C00220000",
      tradeDate: "2025-04-17",
      type: "BUY_TO_OPEN",
      preQty: 1,
      ratio: 4,
    });
  });
});
