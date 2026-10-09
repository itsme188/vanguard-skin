/**
 * The "possible duplicate ledger rows" check.
 *
 * The lot roll-back (integrity-checks-lot-rollback.test.ts) cannot tell a
 * duplicated import dated AFTER the newest statement from a real purchase
 * whose sale is not imported yet. This check covers that window: identical
 * rows (same account, security, date, type, quantity and cents) where one
 * carries the importer's `:#N` ordinal suffix or the rows came from different
 * import batches. It is a question, never an accusation: WARNING only, never
 * critical, never a score cap.
 *
 * Source keys are written in the shapes the real parsers produce
 * (lib/import/parsers/canonical-csv.ts, ibkr-activity.ts, vanguard-pdf.ts).
 * Synthetic tickers and round amounts only. Accounts are the migration seed:
 * 1 = Vanguard Taxable, 3 = IBKR.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import {
  runIntegrityChecks,
  scanPossibleDuplicateLedgerHits,
  groupIntegrityHits,
  integrityCheckIdOf,
  INTEGRITY_CHECK_LABELS,
  INTEGRITY_CHECK_ORDER,
  type IntegrityHit,
} from "@/lib/queries/integrity-checks";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedHold } from "../setup/pending-statement-fixtures";

const STMT = "2026-08-31";
const BEFORE = "2026-08-20";
const TRADE = "2026-09-05";
const VANGUARD = 1;
const IBKR = 3;

let db: Database.Database;

function seedBatch(filename: string): number {
  return Number(
    db
      .prepare("INSERT INTO import_batches (filename, source_type) VALUES (?, 'canonical-csv')")
      .run(filename).lastInsertRowid
  );
}

function seedTxn(opts: {
  accountId: number;
  securityId: number | null;
  date: string;
  type: string;
  quantity: number | null;
  amount: number;
  sourceKey: string | null;
  batchId: number | null;
}): void {
  db.prepare(
    `INSERT INTO transactions
       (account_id, security_id, import_batch_id, trade_date, type, quantity, amount, price_per_share, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`
  ).run(
    opts.accountId,
    opts.securityId,
    opts.batchId,
    opts.date,
    opts.type,
    opts.quantity,
    opts.amount,
    opts.sourceKey
  );
}

/** canonical-csv key: account name, symbol, date, type as typed, integer cents. */
function canonicalKey(symbol: string, date: string, type: string, amount: number, ordinal = 1): string {
  const base = `canonical:txn:Vanguard Taxable:${symbol}:${date}:${type}:${Math.round(amount * 100)}`;
  return ordinal === 1 ? base : `${base}:#${ordinal}`;
}

/** ibkr-activity trade key: date, symbol, signed quantity, proceeds. */
function ibkrKey(symbol: string, date: string, signedQty: number, proceeds: number, ordinal = 1): string {
  const base = `ibkr:trade:${date}:${symbol}:${signedQty}:${proceeds}`;
  return ordinal === 1 ? base : `${base}:#${ordinal}`;
}

function dupHits(): IntegrityHit[] {
  return scanPossibleDuplicateLedgerHits(db);
}

beforeEach(() => {
  db = createPendingTestDb();
});

describe("identical rows dated after the newest statement", () => {
  it("flags a second copy imported under the :#2 suffix, as a warning that never caps the score", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    const batch = seedBatch("september.csv");
    for (const ordinal of [1, 2]) {
      seedTxn({
        accountId: VANGUARD,
        securityId: sec,
        date: TRADE,
        type: "BUY",
        quantity: 10,
        amount: -1000,
        sourceKey: canonicalKey("ZZA", TRADE, "BUY", -1000, ordinal),
        batchId: batch,
      });
    }

    const hits = dupHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("warning");
    expect(hits[0].key.startsWith("duplicate-ledger:")).toBe(true);
    expect(hits[0].reason).toBe(
      `ZZA (Vanguard Taxable): 2 identical BUY rows on ${TRADE}: check for a duplicate import`
    );

    const all = runIntegrityChecks(db);
    expect(all.warnings.filter((h) => h.key.startsWith("duplicate-ledger:"))).toHaveLength(1);
    expect(all.critical.filter((h) => h.key.startsWith("duplicate-ledger:"))).toHaveLength(0);
  });

  it("does not change the confidence score or its cap", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    const batch = seedBatch("september.csv");
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "BUY",
      quantity: 10,
      amount: -1000,
      sourceKey: canonicalKey("ZZA", TRADE, "BUY", -1000),
      batchId: batch,
    });
    const before = getDataConfidence(db);

    // The same row again, as the importer writes a second copy from one file.
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "BUY",
      quantity: 10,
      amount: -1000,
      sourceKey: canonicalKey("ZZA", TRADE, "BUY", -1000, 2),
      batchId: batch,
    });
    const after = getDataConfidence(db);

    expect(after.integrity.warnings.some((h) => h.key.startsWith("duplicate-ledger:"))).toBe(true);
    expect(after.integrity.critical.some((h) => h.key.startsWith("duplicate-ledger:"))).toBe(false);
    expect(after.capReason).toEqual(before.capReason);
    expect(after.overallScore).toBe(before.overallScore);
  });

  it("flags the same row arriving through two import batches under different keys", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "SELL",
      quantity: 5,
      amount: 600,
      sourceKey: canonicalKey("ZZA", TRADE, "SELL", 600),
      batchId: seedBatch("september.csv"),
    });
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "SELL",
      quantity: 5,
      amount: 600,
      sourceKey: `vanguard-pdf:txn:Vanguard Taxable:${TRADE}:ZZA:sell:600`,
      batchId: seedBatch("september.pdf"),
    });

    const hits = dupHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toContain("2 identical SELL rows");
  });

  it("counts every copy once: three copies are one hit that says three", () => {
    const sec = seedSec(db, "ZZB");
    seedHold(db, IBKR, sec, STMT, "stmt", 50);
    const batch = seedBatch("activity.csv");
    for (const ordinal of [1, 2, 3]) {
      seedTxn({
        accountId: IBKR,
        securityId: sec,
        date: TRADE,
        type: "BUY",
        quantity: 20,
        amount: -500,
        sourceKey: ibkrKey("ZZB", TRADE, 20, -500, ordinal),
        batchId: batch,
      });
    }
    const hits = dupHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toContain("3 identical BUY rows");
  });

  it("compares the type in upper case and the amount in cents", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    const batch = seedBatch("september.csv");
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "buy",
      quantity: 10,
      amount: -1000.001,
      sourceKey: canonicalKey("ZZA", TRADE, "buy", -1000),
      batchId: batch,
    });
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "BUY",
      quantity: 10,
      amount: -1000,
      sourceKey: canonicalKey("ZZA", TRADE, "BUY", -1000, 2),
      batchId: batch,
    });
    expect(dupHits()).toHaveLength(1);
  });
});

describe("rows with no import batch", () => {
  const seedBatchless = (sec: number, sourceKey: string | null) =>
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "BUY",
      quantity: 10,
      amount: -1000,
      sourceKey,
      batchId: null,
    });

  it("each is its own origin: two identical batch-less rows with no ordinal suffix are one question", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    seedBatchless(sec, "manual:a");
    seedBatchless(sec, "manual:b");

    const hits = dupHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("warning");
    expect(hits[0].reason).toBe(
      `ZZA (Vanguard Taxable): 2 identical BUY rows on ${TRADE}: check for a duplicate import`
    );
    const all = runIntegrityChecks(db);
    expect(all.critical.filter((h) => h.key.startsWith("duplicate-ledger:"))).toHaveLength(0);
  });

  it("a batch-less row beside an imported twin is still a hit, and a lone one is not", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    seedBatchless(sec, "manual:a");
    expect(dupHits()).toEqual([]);
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "BUY",
      quantity: 10,
      amount: -1000,
      sourceKey: canonicalKey("ZZA", TRADE, "BUY", -1000),
      batchId: seedBatch("september.csv"),
    });
    expect(dupHits()).toHaveLength(1);
  });

  it("does not change the confidence score or its cap", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    seedBatchless(sec, "manual:a");
    const before = getDataConfidence(db);
    seedBatchless(sec, "manual:b");
    const after = getDataConfidence(db);
    expect(after.integrity.warnings.some((h) => h.key.startsWith("duplicate-ledger:"))).toBe(true);
    expect(after.integrity.critical.some((h) => h.key.startsWith("duplicate-ledger:"))).toBe(false);
    expect(after.capReason).toEqual(before.capReason);
    expect(after.overallScore).toBe(before.overallScore);
  });
});

describe("rows that are not hits", () => {
  it("ignores identical rows in one batch when neither carries an ordinal suffix", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    const batch = seedBatch("september.csv");
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "BUY",
      quantity: 10,
      amount: -1000,
      sourceKey: "pst-a",
      batchId: batch,
    });
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "BUY",
      quantity: 10,
      amount: -1000,
      sourceKey: "pst-b",
      batchId: batch,
    });
    expect(dupHits()).toEqual([]);
  });

  it("ignores a difference of one cent, a different quantity, a different date or a different account", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    seedHold(db, IBKR, sec, STMT, "stmt", 100);
    const rows: Array<[number, string, number, number]> = [
      [VANGUARD, TRADE, 10, -1000],
      [VANGUARD, TRADE, 10, -1000.01],
      [VANGUARD, TRADE, 11, -1000],
      [VANGUARD, "2026-09-06", 10, -1000],
      [IBKR, TRADE, 10, -1000],
    ];
    rows.forEach(([accountId, date, quantity, amount], i) => {
      seedTxn({
        accountId,
        securityId: sec,
        date,
        type: "BUY",
        quantity,
        amount,
        sourceKey: `other:${i}:#2`,
        batchId: seedBatch(`file-${i}.csv`),
      });
    });
    expect(dupHits()).toEqual([]);
  });

  it("ignores twins dated on or before the newest statement (the roll-back checks that window)", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    const batch = seedBatch("august.csv");
    for (const date of [BEFORE, STMT]) {
      for (const ordinal of [1, 2]) {
        seedTxn({
          accountId: VANGUARD,
          securityId: sec,
          date,
          type: "BUY",
          quantity: 10,
          amount: -1000,
          sourceKey: canonicalKey("ZZA", date, "BUY", -1000, ordinal),
          batchId: batch,
        });
      }
    }
    expect(dupHits()).toEqual([]);
  });

  it("ignores rows with no quantity (dividends, interest) and rows with no security", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    const batch = seedBatch("september.csv");
    for (const ordinal of [1, 2]) {
      seedTxn({
        accountId: VANGUARD,
        securityId: sec,
        date: TRADE,
        type: "DIVIDEND",
        quantity: null,
        amount: 25,
        sourceKey: canonicalKey("ZZA", TRADE, "DIVIDEND", 25, ordinal),
        batchId: batch,
      });
      seedTxn({
        accountId: VANGUARD,
        securityId: sec,
        date: TRADE,
        type: "TRANSFER_OUT",
        quantity: 0,
        amount: 0,
        sourceKey: canonicalKey("ZZA", TRADE, "TRANSFER_OUT", 0, ordinal),
        batchId: batch,
      });
      seedTxn({
        accountId: VANGUARD,
        securityId: null,
        date: TRADE,
        type: "DEPOSIT",
        quantity: 1,
        amount: 500,
        sourceKey: canonicalKey("cash", TRADE, "DEPOSIT", 500, ordinal),
        batchId: batch,
      });
    }
    expect(dupHits()).toEqual([]);
  });

  it("never counts engine-owned closes", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, VANGUARD, sec, STMT, "stmt", 100);
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "RECONCILE_CLOSE",
      quantity: 10,
      amount: 1000,
      sourceKey: "engine:close:a",
      batchId: null,
    });
    seedTxn({
      accountId: VANGUARD,
      securityId: sec,
      date: TRADE,
      type: "RECONCILE_CLOSE",
      quantity: 10,
      amount: 1000,
      sourceKey: "engine:close:b:#2",
      batchId: seedBatch("x.csv"),
    });
    expect(dupHits()).toEqual([]);
  });
});

describe("an account with no statement book", () => {
  it("scans the last 45 days only", () => {
    const sec = seedSec(db, "ZZA");
    const today = todayET();
    const recent = addDays(today, -10);
    const old = addDays(today, -60);
    const batch = seedBatch("activity.csv");
    for (const date of [recent, old]) {
      for (const ordinal of [1, 2]) {
        seedTxn({
          accountId: IBKR,
          securityId: sec,
          date,
          type: "BUY",
          quantity: 10,
          amount: -1000,
          sourceKey: ibkrKey("ZZA", date, 10, -1000, ordinal),
          batchId: batch,
        });
      }
    }
    const hits = dupHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toContain(recent);
  });

  it("a live-only holdings row is not a statement book", () => {
    const sec = seedSec(db, "ZZA");
    const today = todayET();
    seedHold(db, IBKR, sec, addDays(today, -1), "tws", 100);
    const date = addDays(today, -20);
    const batch = seedBatch("activity.csv");
    for (const ordinal of [1, 2]) {
      seedTxn({
        accountId: IBKR,
        securityId: sec,
        date,
        type: "BUY",
        quantity: 10,
        amount: -1000,
        sourceKey: ibkrKey("ZZA", date, 10, -1000, ordinal),
        batchId: batch,
      });
    }
    expect(dupHits()).toHaveLength(1);
  });
});

describe("how a reader sees it", () => {
  it("has its own plain-language group on the Data Health page", () => {
    expect(integrityCheckIdOf("duplicate-ledger:12")).toBe("duplicate-ledger");
    expect(INTEGRITY_CHECK_ORDER).toContain("duplicate-ledger");
    expect(INTEGRITY_CHECK_LABELS["duplicate-ledger"]).toBe(
      "Identical ledger rows on one day, possibly a duplicate import"
    );
    const groups = groupIntegrityHits([
      { key: "duplicate-ledger:12", severity: "warning", reason: "x" },
    ]);
    expect(groups.map((g) => g.check)).toEqual(["duplicate-ledger"]);
  });
});
