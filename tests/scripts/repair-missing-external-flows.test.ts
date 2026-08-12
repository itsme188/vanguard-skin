import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { partitionCandidates } from "@/lib/compute/cash-flow-audit";
import {
  findCandidates,
  buildProposedTransaction,
  applyProposedTransactions,
  nonIbkrAccountIds,
  selectRun,
  collectFlagValues,
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
    const proposals = candidates.map((c) => buildProposedTransaction(c));

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

  it("tags a candidate 'external-flow-candidate' when total_value corroborates the cash residual", () => {
    insertValuation(db, 1, "2026-07-10", [REDACTED], [REDACTED]);
    insertValuation(db, 1, "2026-07-11", [REDACTED], [REDACTED]);

    expect(findCandidates(db)[0].classification).toBe("external-flow-candidate");
  });
});

describe("classification integration — matches the 2026-08-12 live-data verification", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    nextTxnId = 1;
    // Extra synthetic non-IBKR accounts so each of the four real windows is
    // isolated in its own 2-row series — otherwise chaining all four
    // windows onto one account would also create three incidental "bridge"
    // pairs (07-11->07-13, 07-14->07-30, 07-31->08-02) that aren't part of
    // what we're verifying here.
    db.prepare(
      `INSERT INTO accounts (id, name) VALUES
         (10, 'Cluster External'), (11, 'Cluster Internal A'),
         (12, 'Cluster Internal B'), (13, 'Cluster Internal C')`
    ).run();
  });

  it("classifies exactly one external-flow-candidate (07-11) and three internal-shifts, matching the live audit", () => {
    // 2026-07-10 -> 2026-07-11: cash +[REDACTED], total_value +[REDACTED], zero transactions.
    insertValuation(db, 10, "2026-07-10", [REDACTED], [REDACTED]);
    insertValuation(db, 10, "2026-07-11", [REDACTED], [REDACTED]);

    // 2026-07-13 -> 2026-07-14: cash -[REDACTED] (explained [REDACTED]), total_value only -[REDACTED].
    insertValuation(db, 11, "2026-07-13", [REDACTED], [REDACTED]);
    insertValuation(db, 11, "2026-07-14", [REDACTED], [REDACTED]);
    insertTxn(db, 11, "2026-07-14", "FEE", [REDACTED]);

    // 2026-07-30 -> 2026-07-31: cash -[REDACTED] (explained [REDACTED]), total_value only -[REDACTED].
    insertValuation(db, 12, "2026-07-30", [REDACTED], [REDACTED]);
    insertValuation(db, 12, "2026-07-31", [REDACTED], [REDACTED]);
    insertTxn(db, 12, "2026-07-31", "FEE", [REDACTED]);

    // 2026-08-02 -> 2026-08-03: cash +[REDACTED], total_value only +[REDACTED] (the round-trip back).
    insertValuation(db, 13, "2026-08-02", [REDACTED], [REDACTED]);
    insertValuation(db, 13, "2026-08-03", [REDACTED], [REDACTED]);

    const candidates = findCandidates(db, { accountIds: [10, 11, 12, 13] });
    expect(candidates).toHaveLength(4);

    const { externalFlowCandidates, internalShifts } = partitionCandidates(candidates);
    expect(externalFlowCandidates).toHaveLength(1);
    expect(externalFlowCandidates[0].toDate).toBe("2026-07-11");
    expect(internalShifts).toHaveLength(3);
    expect(internalShifts.map((p) => p.toDate).sort()).toEqual(["2026-07-14", "2026-07-31", "2026-08-03"]);
  });

  it("only builds a proposal for the external-flow-candidate; applying it inserts exactly one row", () => {
    insertValuation(db, 10, "2026-07-10", [REDACTED], [REDACTED]);
    insertValuation(db, 10, "2026-07-11", [REDACTED], [REDACTED]);
    insertValuation(db, 11, "2026-07-13", [REDACTED], [REDACTED]);
    insertValuation(db, 11, "2026-07-14", [REDACTED], [REDACTED]);
    insertTxn(db, 11, "2026-07-14", "FEE", [REDACTED]);

    const candidates = findCandidates(db, { accountIds: [10, 11] });
    const result = selectRun(candidates);
    expect(result.error).toBeNull();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].tradeDate).toBe("2026-07-11");

    const inserted = applyProposedTransactions(db, result.proposals);
    expect(inserted).toBe(1);
    // The only rows are the pre-seeded FEE (account 11) and the one
    // synthesized DEPOSIT (account 10) — the internal-shift's cash
    // residual never got a row of its own.
    const rows = db.prepare(`SELECT account_id, type FROM transactions ORDER BY account_id`).all() as {
      account_id: number;
      type: string;
    }[];
    expect(rows).toEqual([
      { account_id: 10, type: "DEPOSIT" },
      { account_id: 11, type: "FEE" },
    ]);
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

    const proposals = before.map((c) => buildProposedTransaction(c));
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

    const proposals = findCandidates(db).map((c) => buildProposedTransaction(c));
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

// ─── selectRun: --only / --amount handling ─────────────────────────────

function makePoint(overrides: Partial<import("@/lib/compute/cash-flow-audit").CashFlowResidualPoint>) {
  return {
    accountId: 1,
    accountName: "Vanguard Taxable",
    fromDate: "2026-07-10",
    toDate: "2026-07-11",
    cashBefore: [REDACTED],
    cashAfter: [REDACTED],
    totalValueAtFrom: [REDACTED],
    totalValueAtTo: [REDACTED],
    delta: [REDACTED],
    explained: 0,
    residual: [REDACTED],
    totalDelta: [REDACTED],
    totalDeltaPct: [REDACTED] / [REDACTED],
    classification: "external-flow-candidate" as const,
    ...overrides,
  };
}

describe("selectRun", () => {
  it("with no --only/--amount, proposes every external-flow-candidate and reports every internal-shift", () => {
    const external = makePoint({ toDate: "2026-07-11" });
    const internal = makePoint({
      toDate: "2026-07-14",
      classification: "internal-shift",
      residual: -[REDACTED],
      totalDelta: -[REDACTED],
    });

    const result = selectRun([external, internal]);
    expect(result.error).toBeNull();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].tradeDate).toBe("2026-07-11");
    expect(result.externalFlowCandidates).toEqual([external]);
    expect(result.internalShifts).toEqual([internal]);
    expect(result.unmatchedOnlyDates).toEqual([]);
  });

  it("--only restricts both the proposal list and the internal-shift list to the requested date(s)", () => {
    const external = makePoint({ toDate: "2026-07-11" });
    const internal = makePoint({ toDate: "2026-07-14", classification: "internal-shift" });

    const result = selectRun([external, internal], { onlyDates: ["2026-07-11"] });
    expect(result.externalFlowCandidates).toEqual([external]);
    expect(result.internalShifts).toEqual([]);
    expect(result.proposals).toHaveLength(1);
  });

  it("--only reports an unmatched date instead of silently ignoring the typo", () => {
    const external = makePoint({ toDate: "2026-07-11" });

    const result = selectRun([external], { onlyDates: ["2026-07-11", "2026-09-01"] });
    expect(result.unmatchedOnlyDates).toEqual(["2026-09-01"]);
    expect(result.externalFlowCandidates).toEqual([external]);
  });

  it("--amount overrides the proposal's amount and recomputes source_key when exactly one candidate is selected", () => {
    const external = makePoint({ toDate: "2026-07-11", residual: [REDACTED] });

    const result = selectRun([external], { onlyDates: ["2026-07-11"], amountOverride: [REDACTED] });
    expect(result.error).toBeNull();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].amount).toBe([REDACTED]);
    expect(result.proposals[0].sourceKey).toBe("repair-missing-flow:1:2026-07-11:[REDACTED]");
    expect(result.proposals[0].notes).toContain("overridden");
  });

  it("--amount errors when zero candidates are selected (nothing to apply it to)", () => {
    const result = selectRun([], { amountOverride: [REDACTED] });
    expect(result.error).toMatch(/requires exactly one/);
    expect(result.proposals).toEqual([]);
  });

  it("--amount errors when --only, alone, doesn't pin down a single date", () => {
    const a = makePoint({ toDate: "2026-07-11" });
    const b = makePoint({ toDate: "2026-08-03" });

    // No --only at all — even though there happens to be only one
    // external-flow-candidate some of the time, --amount must not silently
    // ride along on a coincidence; it demands an explicit --only.
    const noOnly = selectRun([a], { amountOverride: [REDACTED] });
    expect(noOnly.error).toMatch(/requires exactly one date selected via --only \(got 0\)/);
    expect(noOnly.proposals).toEqual([]);

    // --only naming two dates isn't "exactly one" either.
    const twoOnly = selectRun([a, b], { onlyDates: ["2026-07-11", "2026-08-03"], amountOverride: [REDACTED] });
    expect(twoOnly.error).toMatch(/got 2/);
    expect(twoOnly.proposals).toEqual([]);
  });

  it("--amount errors when a single --only date still matches more than one external-flow-candidate (two accounts, same date)", () => {
    const acct1 = makePoint({ accountId: 1, accountName: "Vanguard Taxable", toDate: "2026-07-11" });
    const acct2 = makePoint({ accountId: 2, accountName: "Vanguard Roth IRA", toDate: "2026-07-11" });

    const result = selectRun([acct1, acct2], { onlyDates: ["2026-07-11"], amountOverride: [REDACTED] });
    expect(result.error).toMatch(/found 2/);
    expect(result.proposals).toEqual([]);
  });

  it("--amount errors when the --only-selected candidate is an internal-shift, not external", () => {
    const internal = makePoint({ toDate: "2026-07-14", classification: "internal-shift" });

    const result = selectRun([internal], { onlyDates: ["2026-07-14"], amountOverride: 5_000 });
    expect(result.error).toMatch(/found 0/);
    expect(result.proposals).toEqual([]);
  });
});

describe("collectFlagValues", () => {
  it("collects every occurrence of a repeatable flag", () => {
    expect(collectFlagValues(["--only", "2026-07-11", "--apply", "--only", "2026-08-03"], "--only")).toEqual([
      "2026-07-11",
      "2026-08-03",
    ]);
  });

  it("returns [] when the flag is absent", () => {
    expect(collectFlagValues(["--apply"], "--only")).toEqual([]);
  });

  it("ignores a flag with no following value (end of argv)", () => {
    expect(collectFlagValues(["--apply", "--only"], "--only")).toEqual([]);
  });

  it("collects a single-use flag like --amount as a one-element array", () => {
    expect(collectFlagValues(["--apply", "--amount", "[REDACTED]"], "--amount")).toEqual(["[REDACTED]"]);
  });
});
