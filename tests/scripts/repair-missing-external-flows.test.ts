import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  findCandidates,
  buildProposedTransaction,
  applyProposedTransactions,
  nonIbkrAccountIds,
} from "@/scripts/repair-missing-external-flows";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db); // seeds Vanguard Taxable(1), Vanguard Roth IRA(2), IBKR(3)
  return db;
}

function insertValuation(
  db: Database.Database,
  accountId: number,
  date: string,
  cash: number,
  totalValue: number
): void {
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, date, cash, totalValue - cash, totalValue);
}

let nextTxnId = 1;
function insertTxn(
  db: Database.Database,
  accountId: number,
  date: string,
  type: string,
  amount: number
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(accountId, date, type, amount, `test:${nextTxnId++}`);
}

describe("nonIbkrAccountIds", () => {
  it("excludes the IBKR-named account and keeps the two Vanguard accounts", () => {
    const db = createTestDb();
    expect(nonIbkrAccountIds(db)).toEqual([1, 2]);
  });
});

describe("findCandidates / buildProposedTransaction", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    nextTxnId = 1;
  });

  it("finds the 2026-07-11-style candidate: a large jump with zero transactions", () => {
    insertValuation(db, 1, "2026-07-10", [REDACTED], [REDACTED]);
    insertValuation(db, 1, "2026-07-11", [REDACTED], [REDACTED]);

    const candidates = findCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].accountId).toBe(1);
    expect(candidates[0].toDate).toBe("2026-07-11");
    expect(candidates[0].residual).toBeCloseTo([REDACTED], 1);
  });

  it("builds a DEPOSIT proposal for a positive residual and a WITHDRAWAL for a negative one", () => {
    insertValuation(db, 1, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 1, "2026-07-11", 260_000, 1_500_000); // +180,000
    insertValuation(db, 1, "2026-07-14", 20_000, 1_300_000); // -240,000

    const candidates = findCandidates(db);
    expect(candidates).toHaveLength(2);
    const proposals = candidates.map(buildProposedTransaction);

    const deposit = proposals.find((p) => p.tradeDate === "2026-07-11")!;
    expect(deposit.type).toBe("DEPOSIT");
    expect(deposit.amount).toBeGreaterThan(0);

    const withdrawal = proposals.find((p) => p.tradeDate === "2026-07-14")!;
    expect(withdrawal.type).toBe("WITHDRAWAL");
    expect(withdrawal.amount).toBeLessThan(0);
  });

  it("produces a deterministic source_key so re-running finds the same candidate identically", () => {
    insertValuation(db, 1, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 1, "2026-07-11", 260_000, 1_500_000);

    const first = buildProposedTransaction(findCandidates(db)[0]);
    const second = buildProposedTransaction(findCandidates(db)[0]);
    expect(first.sourceKey).toBe(second.sourceKey);
  });

  it("does not surface a fully-explained deposit day as a candidate", () => {
    insertValuation(db, 1, "2026-07-16", [REDACTED], 1_500_000);
    insertValuation(db, 1, "2026-07-17", [REDACTED], [REDACTED]);
    insertTxn(db, 1, "2026-07-17", "DEPOSIT", [REDACTED]);

    expect(findCandidates(db)).toHaveLength(0);
  });

  it("excludes the IBKR account from candidates by default", () => {
    insertValuation(db, 3, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 3, "2026-07-11", 260_000, 1_500_000); // would clear the bar on any account

    expect(findCandidates(db)).toHaveLength(0);
    // But scanning it explicitly still finds the same math (proves IBKR
    // exclusion is a scoping choice, not a computation difference).
    expect(findCandidates(db, { accountIds: [3] })).toHaveLength(1);
  });
});

describe("applyProposedTransactions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    nextTxnId = 1;
  });

  it("inserts one is_external_flow=1 row per candidate and a second run finds zero candidates", () => {
    insertValuation(db, 1, "2026-07-10", [REDACTED], [REDACTED]);
    insertValuation(db, 1, "2026-07-11", [REDACTED], [REDACTED]);

    const before = findCandidates(db);
    expect(before).toHaveLength(1);

    const proposals = before.map(buildProposedTransaction);
    const inserted = applyProposedTransactions(db, proposals);
    expect(inserted).toBe(1);

    const row = db
      .prepare(`SELECT type, amount, is_external_flow, trade_date FROM transactions WHERE source_key = ?`)
      .get(proposals[0].sourceKey) as { type: string; amount: number; is_external_flow: number; trade_date: string };
    expect(row.type).toBe("DEPOSIT");
    expect(row.amount).toBeCloseTo([REDACTED], 1);
    expect(row.is_external_flow).toBe(1);
    expect(row.trade_date).toBe("2026-07-11");

    // Idempotence: the repair itself now explains the delta.
    const after = findCandidates(db);
    expect(after).toHaveLength(0);
  });

  it("is idempotent via INSERT OR IGNORE — re-applying the same proposal inserts nothing new", () => {
    insertValuation(db, 1, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 1, "2026-07-11", 260_000, 1_500_000);

    const proposals = findCandidates(db).map(buildProposedTransaction);
    expect(applyProposedTransactions(db, proposals)).toBe(1);
    expect(applyProposedTransactions(db, proposals)).toBe(0); // second apply of the SAME proposal

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE source_key = ?`)
      .get(proposals[0].sourceKey) as { n: number };
    expect(count.n).toBe(1);
  });

  it("dry-run (findCandidates alone) never writes to the transactions table", () => {
    insertValuation(db, 1, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 1, "2026-07-11", 260_000, 1_500_000);

    findCandidates(db); // no apply call
    const count = db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get() as { n: number };
    expect(count.n).toBe(0);
  });
});
