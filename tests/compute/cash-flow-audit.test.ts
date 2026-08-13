import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  computeCashFlowResiduals,
  isUnexplainedCashFlow,
  isLikelyIbkrAccountName,
  classifyCashFlowResidual,
  partitionCandidates,
  CASH_AFFECTING_SIGNED_SQL,
  DEFAULT_RESIDUAL_ABS_FLOOR,
  DEFAULT_RESIDUAL_REL_FLOOR,
  CORROBORATION_RATIO,
  type CashFlowResidualPoint,
} from "@/lib/compute/cash-flow-audit";

/**
 * Minimal schema — just the tables computeCashFlowResiduals reads. Mirrors
 * tests/compute/factors-flow-adjusted.test.ts's precedent for testing a
 * flow-related pure function without the full migration set.
 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, valuation_date TEXT NOT NULL,
      cash_balance REAL NOT NULL, holdings_value REAL NOT NULL DEFAULT 0,
      total_value REAL NOT NULL, UNIQUE(account_id, valuation_date)
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER,
      trade_date TEXT NOT NULL, type TEXT NOT NULL, quantity REAL, amount REAL,
      price_per_share REAL, fees REAL DEFAULT 0, is_external_flow INTEGER DEFAULT 0,
      source_key TEXT UNIQUE, notes TEXT
    );
  `);
  db.exec(`INSERT INTO accounts (id, name) VALUES (1, 'Vanguard Taxable'), (2, 'Vanguard Roth IRA'), (3, 'IBKR')`);
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

describe("computeCashFlowResiduals", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    nextTxnId = 1;
  });

  it("computes zero residual when there is no cash movement and no transactions", () => {
    insertValuation(db, 1, "2026-07-01", 10_000, 200_000);
    insertValuation(db, 1, "2026-07-02", 10_000, 200_000);

    const points = computeCashFlowResiduals(db, { accountIds: [1] });
    expect(points).toHaveLength(1);
    expect(points[0].delta).toBe(0);
    expect(points[0].explained).toBe(0);
    expect(points[0].residual).toBe(0);
  });

  it("finds a large unexplained jump with the correct residual, classified as an external-flow-candidate", () => {
    insertValuation(db, 1, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 1, "2026-07-11", 210_500, 1_500_000); // +130,500 cash, +100,000 total_value, zero transactions

    const points = computeCashFlowResiduals(db, { accountIds: [1] });
    expect(points).toHaveLength(1);
    const point = points[0];
    expect(point.delta).toBeCloseTo(130_500, 5);
    expect(point.explained).toBe(0);
    expect(point.residual).toBeCloseTo(130_500, 5);
    expect(point.totalValueAtFrom).toBe(1_400_000);
    expect(point.totalDelta).toBe(100_000);
    expect(point.totalDeltaPct).toBeCloseTo(100_000 / 1_500_000, 6);
    expect(point.classification).toBe("external-flow-candidate");
    expect(isUnexplainedCashFlow(point)).toBe(true);
  });

  it("classifies a large cash residual as an internal-shift when total_value barely moves", () => {
    // Mirrors the live-data finding: cash_balance jumps but holdings_value
    // absorbs almost the same amount in the opposite direction, so
    // total_value (what risk metrics actually run on) stays smooth.
    insertValuation(db, 1, "2026-07-30", 205_000, 1_560_000);
    insertValuation(db, 1, "2026-07-31", 9_800, 1_548_600); // cash -195,200, total_value only -11,400

    const points = computeCashFlowResiduals(db, { accountIds: [1] });
    const point = points[0];
    expect(point.residual).toBeLessThan(-190_000);
    expect(Math.abs(point.totalDelta)).toBeLessThan(Math.abs(point.residual) * CORROBORATION_RATIO);
    expect(point.classification).toBe("internal-shift");
    // Still flagged as unexplained by cash-only criteria — the script must
    // filter classification itself, isUnexplainedCashFlow doesn't.
    expect(isUnexplainedCashFlow(point)).toBe(true);
  });

  it("does NOT flag a day whose cash delta is fully explained by a recorded transaction", () => {
    insertValuation(db, 1, "2026-07-16", 130_250, 1_500_000);
    insertValuation(db, 1, "2026-07-17", 300_250, 1_670_000); // +170,000
    insertTxn(db, 1, "2026-07-17", "DEPOSIT", 170_000);

    const points = computeCashFlowResiduals(db, { accountIds: [1] });
    expect(points).toHaveLength(1);
    expect(points[0].residual).toBeCloseTo(0, 2);
    expect(isUnexplainedCashFlow(points[0])).toBe(false);
  });

  it("does NOT flag a day with substantial recorded activity even when the residual is large (explained-negligible gate)", () => {
    // A real $200k deposit landed and a lot of same-day trading happened,
    // but this audit's simplified per-type model doesn't net it exactly —
    // `explained` is large (not "zero transactions that date"), so this
    // must NOT be treated as the same bug as a literally unexplained jump.
    insertValuation(db, 1, "2026-07-16", 130_250, 1_500_000);
    insertValuation(db, 1, "2026-07-17", 300_250, 1_670_000); // +170,000
    insertTxn(db, 1, "2026-07-17", "DEPOSIT", 200_000);
    insertTxn(db, 1, "2026-07-17", "BUY", -50_000);

    const points = computeCashFlowResiduals(db, { accountIds: [1] });
    expect(points).toHaveLength(1);
    // explained = 200,000 - 50,000 = 150,000 (well above the negligible floor)
    expect(points[0].explained).toBeCloseTo(150_000, 5);
    expect(isUnexplainedCashFlow(points[0])).toBe(false);
  });

  it("aggregates ALL transactions in a window spanning a weekend gap (prev valuation row, not prev calendar day)", () => {
    // Friday valuation, then the next valuation row is Monday (no Sat/Sun
    // rows at all) — Saturday/Sunday transactions must still be swept into
    // the Friday->Monday window, not silently dropped.
    insertValuation(db, 1, "2026-07-10", 10_000, 200_000); // Friday
    insertValuation(db, 1, "2026-07-13", 13_000, 203_000); // Monday, +3,000
    insertTxn(db, 1, "2026-07-11", "DEPOSIT", 1_000); // Saturday
    insertTxn(db, 1, "2026-07-12", "DEPOSIT", 2_000); // Sunday

    const points = computeCashFlowResiduals(db, { accountIds: [1] });
    expect(points).toHaveLength(1);
    expect(points[0].explained).toBe(3_000);
    expect(points[0].residual).toBe(0);
  });

  it("excludes transactions on/before the first valuation date (already baked into starting cash)", () => {
    insertTxn(db, 1, "2026-07-01", "DEPOSIT", 5_000); // before the series starts
    insertValuation(db, 1, "2026-07-05", 10_000, 200_000);
    insertValuation(db, 1, "2026-07-06", 10_000, 200_000);

    const points = computeCashFlowResiduals(db, { accountIds: [1] });
    expect(points).toHaveLength(1);
    expect(points[0].explained).toBe(0); // the 07-01 deposit is out of window
  });

  describe("BUY sign normalization", () => {
    it("treats a BUY as a cash outflow regardless of the stored sign (canonical-CSV era stores it positive)", () => {
      insertValuation(db, 1, "2026-01-01", 10_000, 200_000);
      insertValuation(db, 1, "2026-01-02", 5_000, 195_000); // -5,000
      insertTxn(db, 1, "2026-01-02", "BUY", 5_000); // stored POSITIVE (the bug this normalizes)

      const points = computeCashFlowResiduals(db, { accountIds: [1] });
      expect(points[0].explained).toBe(-5_000);
      expect(points[0].residual).toBe(0);
    });
  });

  describe("REINVESTMENT/DIVIDEND netting", () => {
    it("nets a DIVIDEND + REINVESTMENT pair (both stored positive) to zero cash effect", () => {
      insertValuation(db, 1, "2026-02-01", 10_000, 200_000);
      insertValuation(db, 1, "2026-02-02", 10_000, 200_100); // cash unchanged — reinvested, not paid to cash
      insertTxn(db, 1, "2026-02-02", "DIVIDEND", 52.73);
      insertTxn(db, 1, "2026-02-02", "REINVESTMENT", 52.73); // stored positive, must net to -52.73 effectively

      const points = computeCashFlowResiduals(db, { accountIds: [1] });
      expect(points[0].explained).toBeCloseTo(0, 5);
      expect(points[0].residual).toBe(0);
    });
  });

  describe("excluded types", () => {
    it("does not count TRANSFER_IN/TRANSFER_OUT as cash movement (security transfers, not cash)", () => {
      insertValuation(db, 1, "2026-03-01", 10_000, 200_000);
      insertValuation(db, 1, "2026-03-02", 10_000, 200_000);
      insertTxn(db, 1, "2026-03-02", "TRANSFER_IN", 50_000); // a security arriving, not cash

      const points = computeCashFlowResiduals(db, { accountIds: [1] });
      expect(points[0].explained).toBe(0);
    });

    it("does not count RECONCILE_CLOSE (engine-owned) as cash movement", () => {
      insertValuation(db, 1, "2026-03-01", 10_000, 200_000);
      insertValuation(db, 1, "2026-03-02", 10_000, 200_000);
      insertTxn(db, 1, "2026-03-02", "RECONCILE_CLOSE", 9_999);

      const points = computeCashFlowResiduals(db, { accountIds: [1] });
      expect(points[0].explained).toBe(0);
    });
  });

  it("scopes to the requested accountIds and keeps accounts independent", () => {
    insertValuation(db, 1, "2026-07-10", 10_000, 200_000);
    insertValuation(db, 1, "2026-07-11", 10_000, 200_000);
    insertValuation(db, 2, "2026-07-10", 5_000, 100_000);
    insertValuation(db, 2, "2026-07-11", 5_000, 100_000);

    const points = computeCashFlowResiduals(db, { accountIds: [1] });
    expect(points).toHaveLength(1);
    expect(points[0].accountId).toBe(1);
  });

  it("gracefully returns [] when required tables are missing (minimal in-memory DB precedent)", () => {
    const bareDb = new Database(":memory:");
    bareDb.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    expect(computeCashFlowResiduals(bareDb)).toEqual([]);
  });
});

describe("isUnexplainedCashFlow", () => {
  // isUnexplainedCashFlow only looks at explained/residual/totalValueAtTo —
  // classification is irrelevant to it (that's the script/data-confidence's
  // job), so these fixture defaults are arbitrary-but-valid filler.
  const base = {
    accountId: 1,
    accountName: "Vanguard Taxable",
    fromDate: "2026-07-10",
    toDate: "2026-07-11",
    cashBefore: 80_000,
    cashAfter: 260_000,
    totalValueAtFrom: 1_400_000,
    totalValueAtTo: 1_500_000,
    totalDelta: 100_000,
    totalDeltaPct: 100_000 / 1_500_000,
    classification: "external-flow-candidate" as const,
  };

  it("flags when residual clears both the absolute and relative floor and explained is negligible", () => {
    const point = { ...base, delta: 180_000, explained: 0, residual: 180_000 };
    expect(isUnexplainedCashFlow(point)).toBe(true);
  });

  it("does not flag when residual is below the absolute floor even if relatively large", () => {
    const point = {
      ...base,
      totalValueAtTo: 10_000, // tiny account, so 0.05*10,000=500 relative floor clears easily
      delta: 4_999,
      explained: 0,
      residual: 4_999,
    };
    expect(Math.abs(point.residual)).toBeLessThan(DEFAULT_RESIDUAL_ABS_FLOOR);
    expect(isUnexplainedCashFlow(point)).toBe(false);
  });

  it("does not flag when residual is below the relative floor even if above the absolute floor", () => {
    const point = {
      ...base,
      totalValueAtTo: 10_000_000, // 5% of this is 500,000
      delta: 6_000,
      explained: 0,
      residual: 6_000,
    };
    expect(Math.abs(point.residual)).toBeGreaterThan(DEFAULT_RESIDUAL_ABS_FLOOR);
    expect(Math.abs(point.residual)).toBeLessThan(point.totalValueAtTo * DEFAULT_RESIDUAL_REL_FLOOR);
    expect(isUnexplainedCashFlow(point)).toBe(false);
  });

  it("does not flag when explained activity is not negligible, even with a big residual", () => {
    const point = { ...base, delta: 180_000, explained: 50_000, residual: 130_000 };
    expect(isUnexplainedCashFlow(point)).toBe(false);
  });

  it("respects custom floors (e.g. the more sensitive data-confidence bar)", () => {
    const point = { ...base, totalValueAtTo: 110_000, delta: 2_500, explained: 0, residual: 2_500 };
    expect(isUnexplainedCashFlow(point)).toBe(false); // fails the 5%/$5,000 default
    expect(isUnexplainedCashFlow(point, { absFloor: 1_000, relFloor: 0.02 })).toBe(true); // clears the 2% bar
  });
});

describe("isLikelyIbkrAccountName", () => {
  it("matches an IBKR-named account case-insensitively", () => {
    expect(isLikelyIbkrAccountName("IBKR")).toBe(true);
    expect(isLikelyIbkrAccountName("ibkr brokerage")).toBe(true);
  });

  it("does not match a Vanguard-named account", () => {
    expect(isLikelyIbkrAccountName("Vanguard Taxable")).toBe(false);
    expect(isLikelyIbkrAccountName("Vanguard Roth IRA")).toBe(false);
  });
});

describe("CASH_AFFECTING_SIGNED_SQL", () => {
  it("is a non-empty SQL fragment usable inside a SUM(...) aggregate", () => {
    expect(CASH_AFFECTING_SIGNED_SQL).toContain("CASE");
    expect(CASH_AFFECTING_SIGNED_SQL).toContain("END");
  });
});

describe("classifyCashFlowResidual", () => {
  it("classifies the 2026-07-11-style jump as external-flow-candidate (total_value corroborates)", () => {
    // Same shape as the real window: total_value moved ~58% of the residual, same sign.
    expect(classifyCashFlowResidual(150_000, 87_000)).toBe("external-flow-candidate");
  });

  it("classifies the 2026-07-13->07-14-style shift as internal-shift (total_value nearly flat)", () => {
    // Same shape as the real window: total_value moved only ~11% of the residual.
    expect(classifyCashFlowResidual(-120_000, -13_200)).toBe("internal-shift");
  });

  it("classifies the 2026-07-30->07-31-style shift as internal-shift", () => {
    expect(classifyCashFlowResidual(-200_000, -12_000)).toBe("internal-shift");
  });

  it("classifies the 2026-08-02->08-03-style shift (the round-trip back) as internal-shift", () => {
    expect(classifyCashFlowResidual(210_000, 26_500)).toBe("internal-shift");
  });

  it("requires the total_value move to share the residual's sign, even if the magnitude clears the ratio", () => {
    // total_value moved the OPPOSITE direction of the cash residual — not a corroborating flow.
    expect(classifyCashFlowResidual(100_000, -80_000)).toBe("internal-shift");
  });

  it("is a boundary at exactly half the residual's magnitude (>=, not >)", () => {
    expect(classifyCashFlowResidual(100_000, 50_000)).toBe("external-flow-candidate");
    expect(classifyCashFlowResidual(100_000, 49_999)).toBe("internal-shift");
  });

  it("treats a zero residual as internal-shift unless total_value is also exactly zero", () => {
    expect(classifyCashFlowResidual(0, 0)).toBe("external-flow-candidate");
    expect(classifyCashFlowResidual(0, 500)).toBe("internal-shift");
  });
});

describe("source-seam classification", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    nextTxnId = 1;
  });

  it("classifies a residual point on a seam interval as source-seam", () => {
    // Same fixture shape as the external-flow-candidate test: a jump with
    // zero transactions. Without the seam this would classify as
    // external-flow-candidate; with a seam on the landing date it must not.
    insertValuation(db, 1, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 1, "2026-07-11", 210_500, 1_500_000);

    const seams = new Map([[1, ["2026-07-11"]]]);
    const points = computeCashFlowResiduals(db, {
      accountIds: [1],
      seamDatesByAccount: seams,
    });
    const seamPoint = points.find((p) => p.toDate === "2026-07-11")!;
    expect(seamPoint.classification).toBe("source-seam");
  });

  it("does not let account A's seam reclassify account B's same-date point", () => {
    // Both accounts jump on the same date; only account 1 has a seam there.
    insertValuation(db, 1, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 1, "2026-07-11", 210_500, 1_500_000);
    insertValuation(db, 2, "2026-07-10", 40_000, 700_000);
    insertValuation(db, 2, "2026-07-11", 105_250, 750_000);

    const seams = new Map([[1, ["2026-07-11"]]]); // seam only in account 1
    const points = computeCashFlowResiduals(db, { seamDatesByAccount: seams });

    expect(
      points.find((p) => p.accountId === 1 && p.toDate === "2026-07-11")!.classification
    ).toBe("source-seam");
    expect(
      points.find((p) => p.accountId === 2 && p.toDate === "2026-07-11")!.classification
    ).not.toBe("source-seam");
  });

  it("is byte-identical when seamDatesByAccount is omitted vs. an empty map", () => {
    insertValuation(db, 1, "2026-07-01", 10_000, 200_000);
    insertValuation(db, 1, "2026-07-02", 10_000, 200_000);

    const a = computeCashFlowResiduals(db, { accountIds: [1] });
    const b = computeCashFlowResiduals(db, { accountIds: [1], seamDatesByAccount: new Map() });
    expect(b).toEqual(a);
    expect(a.every((p) => p.classification !== "source-seam")).toBe(true);
  });
});

describe("partitionCandidates", () => {
  function point(overrides: Partial<CashFlowResidualPoint>): CashFlowResidualPoint {
    return {
      accountId: 1,
      accountName: "Vanguard Taxable",
      fromDate: "2026-07-10",
      toDate: "2026-07-11",
      cashBefore: 80_000,
      cashAfter: 260_000,
      totalValueAtFrom: 1_400_000,
      totalValueAtTo: 1_500_000,
      delta: 180_000,
      explained: 0,
      residual: 180_000,
      totalDelta: 100_000,
      totalDeltaPct: 100_000 / 1_500_000,
      classification: "external-flow-candidate",
      ...overrides,
    };
  }

  it("splits points into externalFlowCandidates and internalShifts by classification", () => {
    const external = point({ toDate: "2026-07-11", classification: "external-flow-candidate" });
    const internal = point({ toDate: "2026-07-14", classification: "internal-shift" });

    const { externalFlowCandidates, internalShifts, seamPoints } = partitionCandidates([
      external,
      internal,
    ]);
    expect(externalFlowCandidates).toEqual([external]);
    expect(internalShifts).toEqual([internal]);
    expect(seamPoints).toEqual([]);
  });

  it("returns empty arrays for an empty input", () => {
    expect(partitionCandidates([])).toEqual({
      externalFlowCandidates: [],
      internalShifts: [],
      seamPoints: [],
    });
  });

  it("puts a source-seam point ONLY in seamPoints, never in the other two buckets", () => {
    const external = point({ toDate: "2026-07-11", classification: "external-flow-candidate" });
    const internal = point({ toDate: "2026-07-14", classification: "internal-shift" });
    const seam = point({ toDate: "2026-07-17", classification: "source-seam" });

    const { externalFlowCandidates, internalShifts, seamPoints } = partitionCandidates([
      external,
      internal,
      seam,
    ]);
    expect(seamPoints).toEqual([seam]);
    expect(externalFlowCandidates).not.toContain(seam);
    expect(internalShifts).not.toContain(seam);
  });
});
