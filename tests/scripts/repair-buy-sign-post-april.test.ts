import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  fetchWrongSignRows,
  normalizedAmountFor,
  rewriteSourceKeyCents,
} from "@/scripts/repair-buy-sign-post-april";

// Mirrors tests/scripts/repair-inkind-transfer-fmv.test.ts's fresh()/seed* idiom —
// migration 002 seeds accounts 1='Vanguard Taxable', 2='Vanguard Roth IRA', 3='IBKR'.
function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

const ACCOUNT = 1;

let nextSecurityId = 1000;
function seedSecurity(db: Database.Database, symbol: string): number {
  const id = nextSecurityId++;
  db.prepare(`INSERT INTO securities (id, symbol, currency) VALUES (?, ?, 'USD')`).run(id, symbol);
  return id;
}

let nextTxnId = 1;
interface TxnSeed {
  securityId: number;
  tradeDate: string;
  type: string;
  amount: number;
  sourceKey: string;
}
function seedTxn(db: Database.Database, t: TxnSeed): number {
  const id = nextTxnId++;
  db.prepare(
    `INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount, source_key)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, ACCOUNT, t.securityId, t.tradeDate, t.type, t.amount, t.sourceKey);
  return id;
}

beforeEach(() => {
  nextSecurityId = 1000;
  nextTxnId = 1;
});

describe("fetchWrongSignRows", () => {
  it("selects a post-2026-04 BUY_TO_OPEN row with a positive amount", () => {
    const db = fresh();
    const secId = seedSecurity(db, "INTC  260717P00100000");
    const id = seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-05",
      type: "BUY_TO_OPEN",
      amount: 2202,
      sourceKey: "canonical:txn:Vanguard Taxable:INTC  260717P00100000:2026-05-05:BUY_TO_OPEN:220200",
    });

    const rows = fetchWrongSignRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, type: "BUY_TO_OPEN", amount: 2202 });
  });

  it("selects a post-2026-04 SELL_TO_CLOSE row with a negative amount", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAPL  260717C00150000");
    const id = seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-06",
      type: "SELL_TO_CLOSE",
      amount: -1000,
      sourceKey: "canonical:txn:Vanguard Taxable:AAPL  260717C00150000:2026-05-06:SELL_TO_CLOSE:-100000",
    });

    const rows = fetchWrongSignRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, type: "SELL_TO_CLOSE", amount: -1000 });
  });

  it("does NOT select a pre-2026-04 BUY row with a positive amount (legacy-positive era)", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAPL");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-03-31",
      type: "BUY",
      amount: 1500,
      sourceKey: "canonical:txn:Vanguard Taxable:AAPL:2026-03-31:BUY:150000",
    });

    expect(fetchWrongSignRows(db)).toHaveLength(0);
  });

  it("does NOT select a TRANSFER row, even with a matching amount sign, post-2026-04", () => {
    const db = fresh();
    const secId = seedSecurity(db, "VMFXX");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-10",
      type: "TRANSFER",
      amount: 250, // positive — would look like a "wrong-sign BUY" only if type were ignored
      sourceKey: "canonical:txn:Vanguard Taxable:VMFXX:2026-05-10:TRANSFER:25000",
    });

    expect(fetchWrongSignRows(db)).toHaveLength(0);
  });

  it("does NOT select a zero-amount row", () => {
    const db = fresh();
    const secId = seedSecurity(db, "XMTR");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-10",
      type: "BUY",
      amount: 0,
      sourceKey: "canonical:txn:Vanguard Taxable:XMTR:2026-05-10:BUY:0",
    });

    expect(fetchWrongSignRows(db)).toHaveLength(0);
  });

  it("does NOT select an already-correct-sign row (negative BUY, positive SELL) post-2026-04", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAPL");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-10",
      type: "BUY",
      amount: -1500,
      sourceKey: "canonical:txn:Vanguard Taxable:AAPL:2026-05-10:BUY:-150000",
    });
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-11",
      type: "SELL",
      amount: 1500,
      sourceKey: "canonical:txn:Vanguard Taxable:AAPL:2026-05-11:SELL:150000",
    });

    expect(fetchWrongSignRows(db)).toHaveLength(0);
  });

  it("does NOT select a non-canonical source_key even if type/amount/date otherwise match", () => {
    const db = fresh();
    const secId = seedSecurity(db, "AAPL");
    seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-10",
      type: "BUY",
      amount: 1500,
      sourceKey: "tws:txn:12345",
    });

    expect(fetchWrongSignRows(db)).toHaveLength(0);
  });

  it("mixed fixture: selects only the true violations, in trade_date/id order", () => {
    const db = fresh();
    const secId = seedSecurity(db, "MIXED");

    const legacyId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-03-15",
      type: "BUY",
      amount: 500,
      sourceKey: "canonical:txn:Vanguard Taxable:MIXED:2026-03-15:BUY:50000",
    });
    const transferId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-01",
      type: "TRANSFER",
      amount: -250,
      sourceKey: "canonical:txn:Vanguard Taxable:MIXED:2026-05-01:TRANSFER:-25000",
    });
    const zeroId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-02",
      type: "BUY",
      amount: 0,
      sourceKey: "canonical:txn:Vanguard Taxable:MIXED:2026-05-02:BUY:0",
    });
    const correctId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-03",
      type: "SELL",
      amount: 800,
      sourceKey: "canonical:txn:Vanguard Taxable:MIXED:2026-05-03:SELL:80000",
    });
    const wrongBuyId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-04",
      type: "BUY_TO_OPEN",
      amount: 2202,
      sourceKey: "canonical:txn:Vanguard Taxable:MIXED:2026-05-04:BUY_TO_OPEN:220200",
    });
    const wrongSellId = seedTxn(db, {
      securityId: secId,
      tradeDate: "2026-05-05",
      type: "SELL_TO_OPEN",
      amount: -900,
      sourceKey: "canonical:txn:Vanguard Taxable:MIXED:2026-05-05:SELL_TO_OPEN:-90000",
    });

    const rows = fetchWrongSignRows(db);
    expect(rows.map((r) => r.id)).toEqual([wrongBuyId, wrongSellId]);
    // Sanity: the untouched ids are all real rows, not accidentally excluded by construction.
    expect([legacyId, transferId, zeroId, correctId].every((id) => !rows.some((r) => r.id === id))).toBe(true);
  });
});

describe("normalizedAmountFor", () => {
  it("flips a BUY-family positive amount to negative", () => {
    expect(normalizedAmountFor("BUY_TO_OPEN", 2202)).toBe(-2202);
    expect(normalizedAmountFor("BUY", 1500)).toBe(-1500);
    expect(normalizedAmountFor("BUY_TO_CLOSE", 500)).toBe(-500);
    expect(normalizedAmountFor("BUY_TO_COVER", 1500)).toBe(-1500);
  });

  it("flips a SELL-family negative amount to positive", () => {
    expect(normalizedAmountFor("SELL_TO_CLOSE", -1000)).toBe(1000);
    expect(normalizedAmountFor("SELL", -1500)).toBe(1500);
    expect(normalizedAmountFor("SELL_TO_OPEN", -900)).toBe(900);
  });
});

describe("rewriteSourceKeyCents", () => {
  it("replaces the trailing cents segment, no ordinal", () => {
    const key = "canonical:txn:Vanguard Taxable:INTC  260717P00100000:2026-05-05:BUY_TO_OPEN:220200";
    expect(rewriteSourceKeyCents(key, -2202)).toBe(
      "canonical:txn:Vanguard Taxable:INTC  260717P00100000:2026-05-05:BUY_TO_OPEN:-220200"
    );
  });

  it("preserves a trailing :#N disambiguation ordinal", () => {
    const key = "canonical:txn:Vanguard Taxable:XMTR:2026-05-13:BUY_TO_OPEN:220200:#2";
    expect(rewriteSourceKeyCents(key, -2202)).toBe(
      "canonical:txn:Vanguard Taxable:XMTR:2026-05-13:BUY_TO_OPEN:-220200:#2"
    );
  });

  it("round-trips a negative-to-positive rewrite (SELL-family repair direction)", () => {
    const key = "canonical:txn:Vanguard Taxable:AAPL  260717C00150000:2026-05-06:SELL_TO_CLOSE:-100000";
    expect(rewriteSourceKeyCents(key, 1000)).toBe(
      "canonical:txn:Vanguard Taxable:AAPL  260717C00150000:2026-05-06:SELL_TO_CLOSE:100000"
    );
  });

  it("throws a loud error on a source_key that doesn't match the expected shape", () => {
    expect(() => rewriteSourceKeyCents("not-a-canonical-key", -100)).toThrow(/doesn't match/);
  });
});
