import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  auditAndRepair,
  parseConfig,
  walkLedger,
  fetchLedgerLegs,
  fetchLatestHoldingsQtyBySecurity,
  sweepSiblings,
  formatReport,
  type SplitBasisAuditTarget,
  type LedgerLeg,
} from "@/scripts/repair-split-basis-audit";

// Synthetic fixtures only — the real symbols, split dates and guard
// quantities live in the gitignored data/repair-configs/split-basis-audit.json
// and are injected at the CLI. Shapes mirror the real disease: a 4:1 forward
// split whose pre-split transaction rows were never re-based.
const SPLIT_DATE = "2020-08-28";
const RATIO = 4;
const PRE_QTY = 30.318;
const PRE_PRICE = 1094.92;
const ACCOUNT = 1; // migration 002 seeds 1='Vanguard Taxable', 2=Roth, 3=IBKR

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

let nextSecurityId = 1000;
function seedSecurity(
  db: Database.Database,
  symbol: string,
  securityType: string | null = "Stock"
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
    `test:txn:${id}`
  );
  return id;
}

function seedHolding(
  db: Database.Database,
  securityId: number,
  quantity: number,
  asOfDate: string,
  accountId = ACCOUNT
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, `test:hold:${accountId}:${securityId}:${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, close: number): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'canonical')`
  ).run(securityId, date, close);
}

function readTxn(db: Database.Database, id: number) {
  return db
    .prepare(
      `SELECT quantity, price_per_share, amount, source_key, type, trade_date
         FROM transactions WHERE id = ?`
    )
    .get(id) as {
    quantity: number;
    price_per_share: number | null;
    amount: number | null;
    source_key: string;
    type: string;
    trade_date: string;
  };
}

function target(over: Partial<SplitBasisAuditTarget> = {}): SplitBasisAuditTarget {
  return {
    symbol: "AAAA",
    splitDate: SPLIT_DATE,
    ratio: RATIO,
    expectedPreSplitTxnQty: PRE_QTY,
    priceRows: [],
    ...over,
  };
}

beforeEach(() => {
  nextSecurityId = 1000;
  nextTxnId = 1;
});

// ─── parseConfig ───────────────────────────────────────────────────────

describe("parseConfig", () => {
  it("accepts a well-formed entry and defaults priceRows to []", () => {
    const parsed = parseConfig(
      JSON.parse(
        '[{"symbol":"AAAA","splitDate":"2020-08-28","ratio":4,"expectedPreSplitTxnQty":30.318}]'
      )
    );
    expect(parsed).toEqual([
      {
        symbol: "AAAA",
        splitDate: "2020-08-28",
        ratio: 4,
        expectedPreSplitTxnQty: 30.318,
        priceRows: [],
      },
    ]);
  });

  it("parses priceRows", () => {
    const parsed = parseConfig([
      {
        symbol: "AAAA",
        splitDate: "2020-08-28",
        ratio: 4,
        expectedPreSplitTxnQty: 30.318,
        priceRows: [{ date: "2025-06-30", preSplitClose: 1094.92 }],
      },
    ]);
    expect(parsed[0].priceRows).toEqual([{ date: "2025-06-30", preSplitClose: 1094.92 }]);
  });

  it("accepts an empty array (sweep-only mode)", () => {
    expect(parseConfig([])).toEqual([]);
  });

  it("rejects a non-array config", () => {
    expect(() => parseConfig({})).toThrow("must be a JSON array");
    expect(() => parseConfig(null)).toThrow("must be a JSON array");
  });

  it("rejects a non-object entry without throwing a TypeError", () => {
    expect(() => parseConfig([null])).toThrow("entry must be an object");
    expect(() => parseConfig(["AAAA"])).toThrow("entry must be an object");
  });

  it("rejects malformed entries", () => {
    const base = {
      symbol: "AAAA",
      splitDate: "2020-08-28",
      ratio: 4,
      expectedPreSplitTxnQty: 30.318,
    };
    expect(() => parseConfig([{ ...base, symbol: "" }])).toThrow("malformed");
    expect(() => parseConfig([{ ...base, splitDate: "08/28/2020" }])).toThrow("YYYY-MM-DD");
    expect(() => parseConfig([{ ...base, ratio: 0 }])).toThrow("ratio must be a number > 0");
    expect(() => parseConfig([{ ...base, ratio: -2 }])).toThrow("ratio must be a number > 0");
    expect(() => parseConfig([{ ...base, ratio: 1 }])).toThrow("no-op");
    expect(() => parseConfig([{ ...base, expectedPreSplitTxnQty: "30" }])).toThrow("malformed");
    expect(() => parseConfig([{ ...base, priceRows: {} }])).toThrow("priceRows must be an array");
    expect(() => parseConfig([{ ...base, priceRows: [{ date: "x", preSplitClose: 1 }] }])).toThrow(
      "priceRows[0].date"
    );
    expect(() =>
      parseConfig([{ ...base, priceRows: [{ date: "2025-06-30", preSplitClose: null }] }])
    ).toThrow("priceRows[0].preSplitClose");
  });

  it("accepts a reverse-split fractional ratio", () => {
    const parsed = parseConfig([
      { symbol: "BBBB", splitDate: "2021-01-04", ratio: 0.1, expectedPreSplitTxnQty: 500 },
    ]);
    expect(parsed[0].ratio).toBe(0.1);
  });
});

// ─── Transaction rewrite ───────────────────────────────────────────────

describe("auditAndRepair — transaction basis", () => {
  it("rewrites pre-split rows product-preserving and leaves amount + source_key alone", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    const preId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
      amount: -(PRE_QTY * PRE_PRICE),
    });
    const postId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2021-03-01",
      type: "BUY",
      quantity: 10,
      price: 150,
      amount: -1500,
    });

    const before = readTxn(db, preId);
    const beforeProduct = before.quantity * (before.price_per_share ?? 0);

    const report = auditAndRepair(db, [target()], { apply: true });
    const t = report.targets[0];
    expect(t.status).toBe("needs-repair");
    expect(t.changed).toBe(true);
    expect(t.securityId).toBe(secId);
    expect(t.preSplitRowCount).toBe(1);
    expect(t.actualPreSplitTxnQty).toBeCloseTo(PRE_QTY, 6);

    const after = readTxn(db, preId);
    expect(after.quantity).toBeCloseTo(PRE_QTY * RATIO, 9);
    expect(after.price_per_share!).toBeCloseTo(PRE_PRICE / RATIO, 9);
    // The invariant the whole repair exists to preserve:
    expect(after.quantity * after.price_per_share!).toBeCloseTo(beforeProduct, 6);
    // Cash and the dedup key never move.
    expect(after.amount).toBe(before.amount);
    expect(after.source_key).toBe(before.source_key);

    // Post-split rows are already on the right basis — untouched.
    const post = readTxn(db, postId);
    expect(post.quantity).toBe(10);
    expect(post.price_per_share).toBe(150);
  });

  it("leaves a NULL price_per_share NULL while still scaling the quantity", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    const id = seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "TRANSFER_IN",
      quantity: PRE_QTY,
      price: null,
      amount: null,
    });

    auditAndRepair(db, [target()], { apply: true });

    const row = readTxn(db, id);
    expect(row.quantity).toBeCloseTo(PRE_QTY * RATIO, 9);
    expect(row.price_per_share).toBeNull();
  });

  it("dry-run plans the rewrite but writes nothing", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    const id = seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });

    const report = auditAndRepair(db, [target()], { apply: false });
    expect(report.applied).toBe(false);
    expect(report.targets[0].status).toBe("needs-repair");
    expect(report.targets[0].rowPlans).toEqual([
      {
        id,
        tradeDate: "2019-05-10",
        type: "BUY",
        oldQuantity: PRE_QTY,
        newQuantity: PRE_QTY * RATIO,
        oldPrice: PRE_PRICE,
        newPrice: PRE_PRICE / RATIO,
      },
    ]);

    const row = readTxn(db, id);
    expect(row.quantity).toBe(PRE_QTY);
    expect(row.price_per_share).toBe(PRE_PRICE);
  });

  it("is idempotent — a second apply reports already-normalized and changes nothing", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    const id = seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
      amount: -(PRE_QTY * PRE_PRICE),
    });

    auditAndRepair(db, [target()], { apply: true });
    const snapshot = readTxn(db, id);

    const second = auditAndRepair(db, [target()], { apply: true });
    expect(second.targets[0].status).toBe("already-normalized");
    expect(second.targets[0].changed).toBe(false);
    expect(second.targets[0].rowPlans).toEqual([]);
    expect(readTxn(db, id)).toEqual(snapshot);

    // ...and a third run is still a no-op.
    auditAndRepair(db, [target()], { apply: true });
    expect(readTxn(db, id)).toEqual(snapshot);
  });

  it("refuses a symbol whose pre-split sum matches neither guard state", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    const id = seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: 77.5, // neither 30.318 nor 121.272
      price: PRE_PRICE,
    });

    const report = auditAndRepair(db, [target()], { apply: true });
    const t = report.targets[0];
    expect(t.status).toBe("unexpected-sum");
    expect(t.changed).toBe(false);
    expect(t.message).toContain("UNEXPECTED");
    expect(t.rowPlans).toEqual([]);

    const row = readTxn(db, id);
    expect(row.quantity).toBe(77.5);
    expect(row.price_per_share).toBe(PRE_PRICE);
  });

  it("sums MULTIPLE pre-split rows for the guard and rewrites them all", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    const a = seedTxn(db, {
      securityId: secId,
      tradeDate: "2018-01-02",
      type: "BUY",
      quantity: 20,
      price: 1000,
    });
    const b = seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "REINVESTMENT",
      quantity: 10.318,
      price: PRE_PRICE,
    });

    const report = auditAndRepair(db, [target()], { apply: true });
    expect(report.targets[0].status).toBe("needs-repair");
    expect(report.targets[0].preSplitRowCount).toBe(2);
    expect(readTxn(db, a).quantity).toBeCloseTo(80, 9);
    expect(readTxn(db, a).price_per_share!).toBeCloseTo(250, 9);
    expect(readTxn(db, b).quantity).toBeCloseTo(41.272, 9);
  });

  it("normalizes a REVERSE split in the shrinking direction (ratio 0.1)", () => {
    const db = fresh();
    const secId = seedSecurity(db, "BBBB");
    const id = seedTxn(db, {
      securityId: secId,
      tradeDate: "2020-11-02",
      type: "BUY",
      quantity: 500,
      price: 4,
    });

    const report = auditAndRepair(
      db,
      [target({ symbol: "BBBB", ratio: 0.1, expectedPreSplitTxnQty: 500, splitDate: "2021-01-04" })],
      { apply: true }
    );
    expect(report.targets[0].status).toBe("needs-repair");

    const row = readTxn(db, id);
    expect(row.quantity).toBeCloseTo(50, 9);
    expect(row.price_per_share!).toBeCloseTo(40, 9);
    expect(row.quantity * row.price_per_share!).toBeCloseTo(2000, 6);
  });

  it("reports a missing security without throwing, and writes nothing", () => {
    const db = fresh();
    const report = auditAndRepair(db, [target()], { apply: true });
    expect(report.targets[0].status).toBe("security-not-found");
    expect(report.targets[0].securityId).toBeNull();
    expect(report.targets[0].ledger).toBeNull();
  });

  it("does NOT resolve an OPTION security by symbol", () => {
    const db = fresh();
    // An option row carrying the same symbol string must never be picked up.
    const optId = seedSecurity(db, "AAAA", "Option");
    seedTxn(db, {
      securityId: optId,
      tradeDate: "2019-05-10",
      type: "BUY_TO_OPEN",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });

    const report = auditAndRepair(db, [target()], { apply: true });
    expect(report.targets[0].status).toBe("security-not-found");
    expect(readTxn(db, 1).quantity).toBe(PRE_QTY); // untouched
  });

  it("resolves the symbol case-insensitively", () => {
    const db = fresh();
    const secId = seedSecurity(db, "aaaa");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    const report = auditAndRepair(db, [target()], { apply: false });
    expect(report.targets[0].securityId).toBe(secId);
    expect(report.targets[0].status).toBe("needs-repair");
  });

  it("reports no-pre-split-rows when nothing predates the split date", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2021-03-01",
      type: "BUY",
      quantity: 10,
      price: 150,
    });
    const report = auditAndRepair(db, [target()], { apply: true });
    expect(report.targets[0].status).toBe("no-pre-split-rows");
    expect(report.targets[0].changed).toBe(false);
  });

  it("ignores a NULL-quantity pre-split row in the guard sum and never rewrites it", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    const cashId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-04-01",
      type: "DIVIDEND",
      quantity: null,
      amount: 12.5,
    });
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });

    const report = auditAndRepair(db, [target()], { apply: true });
    expect(report.targets[0].status).toBe("needs-repair");
    expect(report.targets[0].preSplitRowCount).toBe(1);
    expect(readTxn(db, cashId).quantity).toBeNull();
  });
});

// ─── prices rows ───────────────────────────────────────────────────────

describe("auditAndRepair — prices rows", () => {
  const PRICE_DATE = "2025-06-30";
  const withPriceRow = target({
    priceRows: [{ date: PRICE_DATE, preSplitClose: PRE_PRICE }],
  });

  function setup(close: number | null): { db: Database.Database; secId: number } {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    if (close != null) seedPrice(db, secId, PRICE_DATE, close);
    return { db, secId };
  }

  function readClose(db: Database.Database, secId: number): number {
    return (
      db
        .prepare(`SELECT close_price FROM prices WHERE security_id = ? AND date = ?`)
        .get(secId, PRICE_DATE) as { close_price: number }
    ).close_price;
  }

  it("normalizes a price row still carrying the pre-split close", () => {
    const { db, secId } = setup(PRE_PRICE);
    const report = auditAndRepair(db, [withPriceRow], { apply: true });
    const pr = report.targets[0].priceRows[0];
    expect(pr.status).toBe("needs-repair");
    expect(pr.changed).toBe(true);
    expect(pr.newClose).toBeCloseTo(PRE_PRICE / RATIO, 9);
    expect(readClose(db, secId)).toBeCloseTo(PRE_PRICE / RATIO, 9);
  });

  it("reports an already-normalized price row and writes nothing", () => {
    const { db, secId } = setup(PRE_PRICE / RATIO);
    const report = auditAndRepair(db, [withPriceRow], { apply: true });
    const pr = report.targets[0].priceRows[0];
    expect(pr.status).toBe("already-normalized");
    expect(pr.changed).toBe(false);
    expect(readClose(db, secId)).toBeCloseTo(PRE_PRICE / RATIO, 9);
  });

  it("refuses a price row matching neither guard state", () => {
    const { db, secId } = setup(500);
    const report = auditAndRepair(db, [withPriceRow], { apply: true });
    const pr = report.targets[0].priceRows[0];
    expect(pr.status).toBe("unexpected-value");
    expect(pr.changed).toBe(false);
    expect(pr.message).toContain("UNEXPECTED");
    expect(readClose(db, secId)).toBe(500);
  });

  it("reports a missing price row as skipped", () => {
    const { db } = setup(null);
    const report = auditAndRepair(db, [withPriceRow], { apply: true });
    expect(report.targets[0].priceRows[0].status).toBe("row-missing");
  });

  it("dry-run does not write the price row", () => {
    const { db, secId } = setup(PRE_PRICE);
    auditAndRepair(db, [withPriceRow], { apply: false });
    expect(readClose(db, secId)).toBe(PRE_PRICE);
  });
});

// ─── holdings audit ────────────────────────────────────────────────────

describe("auditAndRepair — pre-split holdings audit", () => {
  it("flags pre-split holdings rows REVIEW-NEEDED and never touches them", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    seedHolding(db, secId, PRE_QTY, "2019-12-31");
    seedHolding(db, secId, PRE_QTY * RATIO, "2026-06-30");

    const report = auditAndRepair(db, [target()], { apply: true });
    expect(report.targets[0].preSplitHoldingsRows).toBe(1);
    expect(report.targets[0].holdingsReview).toBe("review-needed");

    const stale = db
      .prepare(`SELECT quantity FROM holdings WHERE security_id = ? AND as_of_date = '2019-12-31'`)
      .get(secId) as { quantity: number };
    expect(stale.quantity).toBe(PRE_QTY);
  });

  it("reports ok when no holdings row predates the split", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    seedHolding(db, secId, PRE_QTY * RATIO, "2026-06-30");

    const report = auditAndRepair(db, [target()], { apply: true });
    expect(report.targets[0].preSplitHoldingsRows).toBe(0);
    expect(report.targets[0].holdingsReview).toBe("ok");
  });
});

// ─── ledger walk ───────────────────────────────────────────────────────

describe("walkLedger", () => {
  const legs = (...l: Partial<LedgerLeg>[]): LedgerLeg[] =>
    l.map((x) => ({ type: "buy", quantity: 0, rowCount: 1, preSplit: false, ...x }));

  it("adds buy-family and subtracts sell-family quantities", () => {
    const walk = walkLedger(
      legs(
        { type: "BUY", quantity: 100 },
        { type: "REINVESTMENT", quantity: 5 },
        { type: "TRANSFER_IN", quantity: 20 },
        { type: "SELL", quantity: 30 },
        { type: "TRANSFER_OUT", quantity: 15 }
      ),
      1,
      80
    );
    expect(walk.added).toBe(125);
    expect(walk.subtracted).toBe(45);
    expect(walk.walked).toBe(80);
    expect(walk.residual).toBe(0);
    expect(walk.ties).toBe(true);
  });

  it("reports a non-tie residual", () => {
    const walk = walkLedger(legs({ type: "BUY", quantity: 100 }), 1, 121.272);
    expect(walk.residual).toBeCloseTo(-21.272, 6);
    expect(walk.ties).toBe(false);
  });

  it("scales only the pre-split legs by the split factor", () => {
    // 30.318 pre-split shares, unadjusted, against a post-split 121.272 position.
    const raw = walkLedger(legs({ type: "BUY", quantity: PRE_QTY, preSplit: true }), 1, 121.272);
    expect(raw.ties).toBe(false);
    expect(raw.residual).toBeCloseTo(-90.954, 6);

    const hypothetical = walkLedger(
      legs({ type: "BUY", quantity: PRE_QTY, preSplit: true }),
      RATIO,
      121.272
    );
    expect(hypothetical.walked).toBeCloseTo(121.272, 6);
    expect(hypothetical.ties).toBe(true);

    // A post-split leg is never scaled.
    const mixed = walkLedger(
      legs(
        { type: "BUY", quantity: PRE_QTY, preSplit: true },
        { type: "BUY", quantity: 10, preSplit: false }
      ),
      RATIO,
      131.272
    );
    expect(mixed.ties).toBe(true);
  });

  it("ignores cash-only types and counts them separately", () => {
    const walk = walkLedger(
      legs(
        { type: "BUY", quantity: 10 },
        { type: "DIVIDEND", quantity: 12.5, rowCount: 3 },
        { type: "FEE", quantity: 1 }
      ),
      1,
      10
    );
    expect(walk.walked).toBe(10);
    expect(walk.ties).toBe(true);
    expect(walk.ignoredCashOnlyRows).toBe(4);
    expect(walk.unrecognized).toEqual([]);
  });

  it("excludes engine-owned RECONCILE_CLOSE rows but counts them", () => {
    const walk = walkLedger(
      legs({ type: "BUY", quantity: 10 }, { type: "RECONCILE_CLOSE", quantity: 10 }),
      1,
      10
    );
    expect(walk.walked).toBe(10);
    expect(walk.engineSyntheticRows).toBe(1);
  });

  it("reports unrecognized quantity-carrying types instead of guessing a direction", () => {
    const walk = walkLedger(
      legs({ type: "BUY", quantity: 10 }, { type: "SPINOFF", quantity: 2, rowCount: 2 }),
      1,
      10
    );
    expect(walk.walked).toBe(10);
    expect(walk.unrecognized).toEqual([{ type: "spinoff", rows: 2, quantity: 2 }]);
  });

  it("compares types case-insensitively", () => {
    const walk = walkLedger(legs({ type: "Buy", quantity: 10 }, { type: "sell", quantity: 4 }), 1, 6);
    expect(walk.walked).toBe(6);
    expect(walk.ties).toBe(true);
  });
});

describe("auditAndRepair — ledger walk integration", () => {
  it("TIES once the pre-split rows are normalized (dry run walks the hypothetical)", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    seedHolding(db, secId, PRE_QTY * RATIO, "2026-06-30");

    const dry = auditAndRepair(db, [target()], { apply: false });
    expect(dry.targets[0].ledger!.walked).toBeCloseTo(PRE_QTY * RATIO, 6);
    expect(dry.targets[0].ledger!.ties).toBe(true);

    const applied = auditAndRepair(db, [target()], { apply: true });
    expect(applied.targets[0].ledger!.ties).toBe(true);
  });

  it("reports a residual when rows are still missing from the ledger, and repairs anyway", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    const id = seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    // Broker says 200 shares — 78.728 more than the ledger can explain.
    seedHolding(db, secId, 200, "2026-06-30");

    const report = auditAndRepair(db, [target()], { apply: true });
    expect(report.targets[0].status).toBe("needs-repair");
    expect(report.targets[0].changed).toBe(true);
    const ledger = report.targets[0].ledger!;
    expect(ledger.ties).toBe(false);
    expect(ledger.residual).toBeCloseTo(PRE_QTY * RATIO - 200, 6);
    // The basis repair still landed.
    expect(readTxn(db, id).quantity).toBeCloseTo(PRE_QTY * RATIO, 9);
  });

  it("sums the latest nonzero holdings row PER (account, security), not globally", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2021-01-05",
      type: "BUY",
      quantity: 30,
      price: 150,
      accountId: 2,
    });
    // Account 1: stale row then the current one. Account 2 has an older latest date.
    seedHolding(db, secId, 999, "2024-01-31", 1);
    seedHolding(db, secId, PRE_QTY * RATIO, "2026-06-30", 1);
    seedHolding(db, secId, 30, "2025-12-31", 2);

    const map = fetchLatestHoldingsQtyBySecurity(db);
    expect(map.get(secId)).toBeCloseTo(PRE_QTY * RATIO + 30, 6);

    const report = auditAndRepair(db, [target()], { apply: false });
    expect(report.targets[0].ledger!.latestHoldingsQty).toBeCloseTo(PRE_QTY * RATIO + 30, 6);
    expect(report.targets[0].ledger!.ties).toBe(true);
  });

  it("excludes a demoted routing-artifact donation leg from the walk", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2021-01-05",
      type: "BUY",
      quantity: 100,
      price: 150,
    });
    const outId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-04-10",
      type: "TRANSFER_OUT",
      quantity: 35,
      price: 200,
    });
    const artifactId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2025-04-10",
      type: "TRANSFER_OUT",
      quantity: 35,
      price: 200,
    });
    const donationId = db
      .prepare(
        `INSERT INTO donations (source_key, kind, security_id, quantity, fmv_usd, received_date)
         VALUES ('test:donation:1', 'stock', ?, 35, 7000, '2025-04-10')`
      )
      .run(secId).lastInsertRowid as number;
    db.prepare(
      `INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, 'out')`
    ).run(donationId, outId);
    db.prepare(
      `INSERT INTO donation_leg_links (donation_id, transaction_id, role)
       VALUES (?, ?, 'routing_artifact')`
    ).run(donationId, artifactId);

    const legs = fetchLedgerLegs(db, secId, null);
    const walk = walkLedger(legs, 1, 65);
    expect(walk.subtracted).toBe(35); // not 70
    expect(walk.ties).toBe(true);
  });
});

// ─── sibling sweep ─────────────────────────────────────────────────────

describe("sweepSiblings", () => {
  it("flags a mismatched symbol and passes a clean one", () => {
    const db = fresh();
    const cleanId = seedSecurity(db, "CLEAN");
    seedTxn(db, {
      securityId: cleanId,
      tradeDate: "2021-01-05",
      type: "BUY",
      quantity: 40,
      price: 10,
    });
    seedTxn(db, {
      securityId: cleanId,
      tradeDate: "2022-01-05",
      type: "SELL",
      quantity: 15,
      price: 12,
    });
    seedHolding(db, cleanId, 25, "2026-06-30");

    const brokenId = seedSecurity(db, "BROKEN");
    // Pre-split basis never re-based: ledger says 30.318, broker says 121.272.
    seedTxn(db, {
      securityId: brokenId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    seedHolding(db, brokenId, PRE_QTY * RATIO, "2026-06-30");

    const { siblings, scanned } = sweepSiblings(db, []);
    expect(scanned).toBe(2);
    expect(siblings.map((s) => s.symbol)).toEqual(["BROKEN"]);
    expect(siblings[0].walked).toBeCloseTo(PRE_QTY, 6);
    expect(siblings[0].latestHoldingsQty).toBeCloseTo(PRE_QTY * RATIO, 6);
    expect(siblings[0].residual).toBeCloseTo(PRE_QTY - PRE_QTY * RATIO, 6);
    expect(siblings[0].configured).toBe(false);
  });

  it("annotates a configured target as a known case", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    seedHolding(db, secId, PRE_QTY * RATIO, "2026-06-30");

    const { siblings } = sweepSiblings(db, [target()]);
    expect(siblings).toHaveLength(1);
    expect(siblings[0].configured).toBe(true);
  });

  it("skips option securities and securities with no live position", () => {
    const db = fresh();
    const optId = seedSecurity(db, "AAAA  260717C00150000", "Option");
    seedTxn(db, {
      securityId: optId,
      tradeDate: "2026-05-01",
      type: "BUY_TO_OPEN",
      quantity: 5,
      price: 2,
    });
    seedHolding(db, optId, 3, "2026-06-30"); // mismatched, but options are out of scope

    const closedId = seedSecurity(db, "CLOSED");
    seedTxn(db, {
      securityId: closedId,
      tradeDate: "2021-01-05",
      type: "BUY",
      quantity: 10,
      price: 10,
    });
    seedHolding(db, closedId, 0, "2026-06-30"); // zero -> not a live position

    const { siblings, scanned } = sweepSiblings(db, []);
    expect(scanned).toBe(0);
    expect(siblings).toEqual([]);
  });

  it("sorts findings by |residual| descending", () => {
    const db = fresh();
    for (const [symbol, txnQty, holdQty] of [
      ["SMALL", 10, 11],
      ["BIG", 10, 60],
      ["MID", 10, 25],
    ] as const) {
      const id = seedSecurity(db, symbol);
      seedTxn(db, { securityId: id, tradeDate: "2021-01-05", type: "BUY", quantity: txnQty, price: 10 });
      seedHolding(db, id, holdQty, "2026-06-30");
    }
    const { siblings } = sweepSiblings(db, []);
    expect(siblings.map((s) => s.symbol)).toEqual(["BIG", "MID", "SMALL"]);
  });

  it("runs inside auditAndRepair and reflects the post-repair state", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    seedHolding(db, secId, PRE_QTY * RATIO, "2026-06-30");

    const dry = auditAndRepair(db, [target()], { apply: false });
    expect(dry.siblings.map((s) => s.symbol)).toEqual(["AAAA"]);

    const applied = auditAndRepair(db, [target()], { apply: true });
    expect(applied.siblings).toEqual([]); // the repair made the position reconcile
  });
});

// ─── report formatting ─────────────────────────────────────────────────

describe("formatReport", () => {
  it("renders per-symbol status, row rewrites, residuals and the sweep", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAAA");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2019-05-10",
      type: "BUY",
      quantity: PRE_QTY,
      price: PRE_PRICE,
    });
    seedHolding(db, secId, PRE_QTY * RATIO, "2026-06-30");

    const other = seedSecurity(db, "BROKEN");
    seedTxn(db, { securityId: other, tradeDate: "2021-01-05", type: "BUY", quantity: 10, price: 10 });
    seedHolding(db, other, 25, "2026-06-30");

    const text = formatReport(auditAndRepair(db, [target()], { apply: false }));
    expect(text).toContain("[DRY RUN]");
    expect(text).toContain("needs-repair");
    expect(text).toContain("amount + source_key unchanged");
    expect(text).toContain("ledger walk");
    expect(text).toContain("BROKEN");
    expect(text).toContain("possible untranscribed rows or unapplied split");
  });

  it("says sweep-only when there are no targets", () => {
    const db = fresh();
    const text = formatReport(auditAndRepair(db, [], { apply: false }));
    expect(text).toContain("sweep-only mode");
    expect(text).toContain("Every scanned position ties");
  });
});
