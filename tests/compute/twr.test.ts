import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTwr } from "@/lib/compute/twr";

// ─── Seed helpers ───────────────────────────────────────────────────

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  opts: {
    startingValue?: number;
    twr?: number;
    depositsWithdrawals?: number;
    source?: string;
  } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value, twr, deposits_withdrawals, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    monthEndDate,
    totalValue,
    opts.startingValue ?? null,
    opts.twr ?? null,
    opts.depositsWithdrawals ?? null,
    opts.source ?? "manual"
  );
}

function seedExternalFlow(
  db: Database.Database,
  accountId: number,
  date: string,
  amount: number
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, 'DEPOSIT', ?, 1, ?)`
  ).run(accountId, date, amount, `flow-${accountId}-${date}-${Math.random()}`);
}

describe("TWR computation", () => {
  let db: Database.Database;
  const ACCT_1 = 1; // Vanguard Taxable (seeded by migration)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns null when no snapshots exist", () => {
    const result = computeTwr(db);
    expect(result).toBeNull();
  });

  it("computes simple return with two snapshots and no external flows", () => {
    // Month 1: $100,000 → Month 2: $110,000 = 10% return
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    // First month is skipped (no prior value), second month has V_start = 100000
    expect(result!.perAccount).toHaveLength(1);
    const acct = result!.perAccount[0];
    expect(acct.totalReturn).toBeCloseTo(0.1, 6); // 10%
    expect(acct.monthsIncluded).toBe(1);
  });

  it("chain-links multiple months correctly", () => {
    // Three months: $100k → $110k → $121k = (1.1)(1.1) - 1 = 21%
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);
    seedSnapshot(db, ACCT_1, "2025-03-31", 121000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Two sub-periods: Jan→Feb (+10%), Feb→Mar (+10%)
    // Chain-linked: (1.1)(1.1) - 1 = 0.21
    expect(acct.totalReturn).toBeCloseTo(0.21, 6);
    expect(acct.monthsIncluded).toBe(2);
  });

  it("uses IBKR-provided TWR directly when available", () => {
    // IBKR gives TWR as a percentage (e.g. 5.0 = 5%)
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000, { twr: 5.0, source: "ibkr-activity" });
    seedSnapshot(db, ACCT_1, "2025-02-28", 108000, { twr: 3.0, source: "ibkr-activity" });

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // (1.05)(1.03) - 1 = 0.0815
    expect(acct.totalReturn).toBeCloseTo(0.0815, 4);
    expect(acct.monthsIncluded).toBe(2);
    expect(acct.isPartial).toBe(false);
  });

  it("handles mixed IBKR TWR and computed months", () => {
    // Month 1: IBKR TWR = 4%, Month 2: computed (no IBKR TWR)
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000, { twr: 4.0, source: "ibkr-activity" });
    seedSnapshot(db, ACCT_1, "2025-02-28", 109200); // 5% over 104000

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Month 1: 4% (IBKR)
    // Month 2: V_start = 100000 (prev total_value), V_end = 109200
    //   Modified Dietz: (109200 - 100000) / 100000 = 0.092
    // Chain-linked: (1.04)(1.092) - 1 = 0.13568
    expect(acct.totalReturn).toBeCloseTo(0.13568, 3);
    expect(acct.monthsIncluded).toBe(2);
  });

  it("applies Modified Dietz correctly with external cash flow mid-month", () => {
    // V_start = $100,000
    // Deposit $10,000 on Feb 15 (14 days remaining out of 28)
    // V_end = $115,500
    // Expected: r = (115500 - 100000 - 10000) / (100000 + 10000 * 14/28)
    //            = 5500 / 105000 = 0.05238...
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 115500);
    seedExternalFlow(db, ACCT_1, "2025-02-15", 10000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // (115500 - 100000 - 10000) / (100000 + 10000 * (13/28))
    // 13 days remaining: Feb 15 → Feb 28 = 13 days
    // = 5500 / (100000 + 4642.857) = 5500 / 104642.857 ≈ 0.05255
    expect(acct.totalReturn).toBeCloseTo(0.05255, 3);
    expect(acct.monthsIncluded).toBe(1);
  });

  it("computes portfolio-wide TWR across multiple accounts", () => {
    // Account 1: $100k → $110k (10%)
    // Account 2: $200k → $220k (10%)
    // Portfolio: $300k → $330k (10%)
    const ACCT_2 = 2;

    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);
    seedSnapshot(db, ACCT_2, "2025-01-31", 200000);
    seedSnapshot(db, ACCT_2, "2025-02-28", 220000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    // Portfolio-wide
    expect(result!.totalReturn).toBeCloseTo(0.1, 6); // 10%
    expect(result!.perAccount).toHaveLength(2);
  });

  it("filters by date range", () => {
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);
    seedSnapshot(db, ACCT_1, "2025-03-31", 121000);
    seedSnapshot(db, ACCT_1, "2025-04-30", 133100);

    // Only Feb through Mar (2 months)
    const result = computeTwr(db, {
      startDate: "2025-02-01",
      endDate: "2025-03-31",
    });
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Feb: V_start from prior (Jan = 100000), V_end = 110000 → 10%
    // Mar: V_start = 110000, V_end = 121000 → 10%
    // Chain-linked: (1.1)(1.1) - 1 = 0.21
    expect(acct.totalReturn).toBeCloseTo(0.21, 4);
    expect(acct.monthsIncluded).toBe(2);
  });

  it("filters by account ID", () => {
    const ACCT_2 = 2;

    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);
    seedSnapshot(db, ACCT_2, "2025-01-31", 200000);
    seedSnapshot(db, ACCT_2, "2025-02-28", 206000);

    const result = computeTwr(db, { accountId: ACCT_2 });
    expect(result).not.toBeNull();

    expect(result!.perAccount).toHaveLength(1);
    expect(result!.perAccount[0].accountId).toBe(ACCT_2);
    // (206000 - 200000) / 200000 = 3%
    expect(result!.perAccount[0].totalReturn).toBeCloseTo(0.03, 6);
  });

  it("skips months with V_start = 0 and marks partial", () => {
    // First snapshot has 0 value (new account)
    seedSnapshot(db, ACCT_1, "2025-01-31", 0);
    seedSnapshot(db, ACCT_1, "2025-02-28", 50000);
    seedSnapshot(db, ACCT_1, "2025-03-31", 55000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Jan→Feb: V_start = 0, skipped (partial)
    // Feb→Mar: V_start = 50000, V_end = 55000 → 10%
    expect(acct.totalReturn).toBeCloseTo(0.1, 6);
    expect(acct.isPartial).toBe(true);
    expect(acct.monthsIncluded).toBe(1);
  });

  it("annualizes correctly", () => {
    // 12 months of ~1% monthly return
    const dates = [
      "2025-01-31",
      "2025-02-28",
      "2025-03-31",
      "2025-04-30",
      "2025-05-31",
      "2025-06-30",
      "2025-07-31",
      "2025-08-31",
      "2025-09-30",
      "2025-10-31",
      "2025-11-30",
      "2025-12-31",
    ];
    let value = 100000;
    for (const date of dates) {
      seedSnapshot(db, ACCT_1, date, value);
      value *= 1.01; // 1% growth each month
    }

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // 11 months of 1% = (1.01)^11 - 1 ≈ 11.57%
    expect(acct.totalReturn).toBeCloseTo(Math.pow(1.01, 11) - 1, 4);
    // Annualized should be close to 12.68% ((1.01)^12 - 1 ≈ 12.68%)
    expect(acct.annualizedReturn).not.toBeNull();
    expect(acct.annualizedReturn!).toBeGreaterThan(0.11);
    expect(acct.annualizedReturn!).toBeLessThan(0.14);
  });

  it("returns null annualized return for short periods", () => {
    // Only 2 months = ~30 days = borderline
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 105000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    // totalDays is 28 (Jan 31 → Feb 28), should be < 30
    const acct = result!.perAccount[0];
    // With only 28 days, annualized return should be null
    expect(acct.totalDays).toBeLessThan(30);
    expect(acct.annualizedReturn).toBeNull();
  });

  it("measures totalDays from the displayed START anchor (month-end), not the month-start of the first included snapshot", () => {
    // Anchor snapshot before the requested window so a priorRow exists —
    // this is the case that previously diverged: totalDays was measured
    // from monthStartDate(firstDate) (a synthetic "day 1 of the month")
    // while the UI always displays firstDate itself (the month-END anchor)
    // as START. Mirrors the QA repro: 6M window, Jan 31 2026 → Jun 30 2026.
    seedSnapshot(db, ACCT_1, "2025-12-31", 100000);
    const months = [
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ];
    let v = 100000;
    for (const m of months) {
      v *= 1.01;
      seedSnapshot(db, ACCT_1, m, v);
    }

    const result = computeTwr(db, {
      startDate: "2026-01-01",
      endDate: "2026-06-30",
    });
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    expect(acct.startDate).toBe("2026-01-31");
    expect(acct.endDate).toBe("2026-06-30");
    // Jan 31 → Jun 30 2026 (non-leap) = 28 + 31 + 30 + 31 + 30 = 150 days,
    // NOT 180 (which is what Jan 1 → Jun 30 — the old month-start anchor —
    // would give). START/END/DAYS must reconcile for the same displayed
    // window.
    expect(acct.totalDays).toBe(150);
  });

  it("measures portfolio-wide totalDays from the same displayed START/END anchors as the per-account result", () => {
    // Same shape as above but exercised through the portfolio-wide
    // (multi-account) aggregation branch, which has its own independent
    // totalDays computation.
    const ACCT_2 = 2;
    for (const acctId of [ACCT_1, ACCT_2]) {
      seedSnapshot(db, acctId, "2025-12-31", 100000);
      let v = 100000;
      for (const m of [
        "2026-01-31",
        "2026-02-28",
        "2026-03-31",
        "2026-04-30",
        "2026-05-31",
        "2026-06-30",
      ]) {
        v *= 1.01;
        seedSnapshot(db, acctId, m, v);
      }
    }

    const result = computeTwr(db, {
      startDate: "2026-01-01",
      endDate: "2026-06-30",
    });
    expect(result).not.toBeNull();
    expect(result!.startDate).toBe("2026-01-31");
    expect(result!.endDate).toBe("2026-06-30");
    expect(result!.totalDays).toBe(150);
  });

  it("handles negative returns correctly", () => {
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 90000); // -10%

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    expect(acct.totalReturn).toBeCloseTo(-0.1, 6);
  });

  it("handles withdrawal (negative cash flow) correctly", () => {
    // V_start = $100,000
    // Withdrawal of $10,000 on Feb 15 (13 days remaining out of 28)
    // V_end = $92,000
    // r = (92000 - 100000 - (-10000)) / (100000 + (-10000) * (13/28))
    //   = 2000 / (100000 - 4642.857) = 2000 / 95357.143 ≈ 0.02097
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 92000);
    seedExternalFlow(db, ACCT_1, "2025-02-15", -10000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    expect(acct.totalReturn).toBeCloseTo(0.02097, 3);
  });

  // ─── New tests: TWS exclusion, TWR format, December handling ─────

  it("excludes TWS mid-month snapshots from TWR computation", () => {
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);
    // TWS snapshot mid-month — should be excluded
    seedSnapshot(db, ACCT_1, "2025-03-15", 112000, { source: "tws" });
    seedSnapshot(db, ACCT_1, "2025-03-31", 121000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    // Should have 2 sub-periods (Jan→Feb, Feb→Mar), NOT 3
    const acct = result!.perAccount[0];
    expect(acct.monthsIncluded).toBe(2);
    expect(acct.totalReturn).toBeCloseTo(0.21, 4);
  });

  it("does not crash portfolio TWR when TWS snapshot covers only one account", () => {
    const ACCT_2 = 2;
    // Both accounts at month-end
    seedSnapshot(db, ACCT_1, "2025-02-28", 1000000);
    seedSnapshot(db, ACCT_2, "2025-02-28", 500000);
    seedSnapshot(db, ACCT_1, "2025-03-31", 1020000);
    seedSnapshot(db, ACCT_2, "2025-03-31", 510000);
    // TWS snapshot only for ACCT_2 in April — should be excluded
    seedSnapshot(db, ACCT_2, "2025-04-06", 515000, { source: "tws" });
    seedSnapshot(db, ACCT_1, "2025-04-30", 1040000);
    seedSnapshot(db, ACCT_2, "2025-04-30", 520000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();
    // Portfolio should show reasonable positive return, not a crash from partial data
    expect(result!.totalReturn).toBeGreaterThan(0);
    expect(result!.totalReturn).toBeLessThan(0.10);
  });

  it("handles canonical TWR format (decimal fractions, not percentages)", () => {
    // Canonical stores TWR as decimal: -0.05 = -5%, 0.08 = 8%
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000, { twr: -0.05, source: "canonical" });
    seedSnapshot(db, ACCT_1, "2025-02-28", 108000, { twr: 0.08, source: "canonical" });

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // (1 + -0.05) * (1 + 0.08) - 1 = 0.95 * 1.08 - 1 = 0.026
    expect(acct.totalReturn).toBeCloseTo(0.026, 4);
  });

  it("uses deposits_withdrawals from snapshots for Modified Dietz", () => {
    // No external flow transactions — only snapshot deposits_withdrawals
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 115000, { depositsWithdrawals: 10000 });

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Modified Dietz: (115000 - 100000 - 10000) / (100000 + 10000*0.5)
    // = 5000 / 105000 ≈ 0.04762
    expect(acct.totalReturn).toBeCloseTo(0.04762, 3);
  });

  it("detects and handles December annual summary rows", () => {
    // Seed full year of monthly snapshots
    seedSnapshot(db, ACCT_1, "2025-10-31", 340000);
    seedSnapshot(db, ACCT_1, "2025-11-30", 350000);
    // December annual row: starting_value is year-start (300k), NOT Nov total (350k)
    // twr is annual TWR, should be IGNORED
    seedSnapshot(db, ACCT_1, "2025-12-31", 355000, {
      startingValue: 300000,
      depositsWithdrawals: 20000,
      twr: -0.10, // annual TWR — should not be used
      source: "canonical",
    });
    // Seed Jan deposits so Dec-only can be computed
    seedSnapshot(db, ACCT_1, "2025-01-31", 310000, { depositsWithdrawals: 5000 });

    const result = computeTwr(db, { startDate: "2025-11-01", endDate: "2025-12-31" });
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Should NOT use the annual twr of -10%
    // Dec return: vStart = 350000, vEnd = 355000
    // Dec-only deposits = 20000 - 5000 = 15000
    // Modified Dietz: (355000 - 350000 - 15000) / (350000 + 15000*0.5) = -10000/357500 ≈ -0.02797
    // Chain-linked with Nov: (350000-340000)/340000 = 0.02941
    // (1.02941)(1-0.02797) - 1 ≈ 0.00063
    expect(acct.totalReturn).not.toBeCloseTo(-0.10, 1);
    expect(acct.totalReturn).toBeGreaterThan(-0.05);
    expect(acct.totalReturn).toBeLessThan(0.05);
  });

  // ─── Scope-aware top-level result (headline per scope) ────────────
  //
  // Bug (2026-06-10): the top-level totalReturn/annualizedReturn were ALWAYS
  // computed from the all-accounts aggregate, even when accountId was passed —
  // the option only filtered perAccount[]. The Performance view headline
  // therefore showed the combined portfolio number for every scope.
  //
  // Ground truth: chained statement TWRs verified against the IBKR
  // PortfolioAnalyst PDF to the basis point.
  describe("scope-aware top-level TWR", () => {
    const MONTHS = ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"];
    const MONTHLY_RETURNS: Record<number, number[]> = {
      1: [-0.010212, -0.026796, -0.055982, 0.1464, 0.1191], // Vanguard Taxable (canonical, decimal)
      2: [0.020503, 0.010643, -0.048169, 0.2384, 0.0669], // Roth (canonical, decimal)
      3: [0.04988, -0.034033, 0.012633, 0.05239320524, 0.07706298396], // IBKR (Apr/May rows are ibkr-activity, stored as PERCENT)
    };
    const START_VALUES: Record<number, number> = { 1: 1000000, 2: 300000, 3: 500000 };

    const chain = (rs: number[]) => rs.reduce((p, r) => p * (1 + r), 1) - 1;

    function seedGroundTruth(): void {
      for (const acctId of [1, 2, 3]) {
        seedSnapshot(db, acctId, "2025-12-31", START_VALUES[acctId]);
        let v = START_VALUES[acctId];
        MONTHLY_RETURNS[acctId].forEach((r, i) => {
          v = v * (1 + r);
          // IBKR Apr+May came in via the ibkr-activity parser, which stores
          // twr as a PERCENT (5.239320524 = 5.24%); everything else decimal.
          const isIbkrPct = acctId === 3 && i >= 3;
          seedSnapshot(db, acctId, MONTHS[i], v, {
            twr: isIbkrPct ? r * 100 : r,
            source: isIbkrPct ? "ibkr-activity" : "canonical",
          });
        });
      }
    }

    it("returns Vanguard Taxable's own chained TWR for accountId=1 (~+16.66% YTD)", () => {
      seedGroundTruth();
      const result = computeTwr(db, { startDate: "2026-01-01", accountId: 1 });
      expect(result).not.toBeNull();
      expect(result!.totalReturn).toBeCloseTo(chain(MONTHLY_RETURNS[1]), 6); // 0.166625…
      expect(result!.totalReturn).toBeCloseTo(0.1666, 4);
    });

    it("returns Roth's own chained TWR for accountId=2 (~+29.70% YTD)", () => {
      seedGroundTruth();
      const result = computeTwr(db, { startDate: "2026-01-01", accountId: 2 });
      expect(result).not.toBeNull();
      expect(result!.totalReturn).toBeCloseTo(chain(MONTHLY_RETURNS[2]), 6); // 0.297049…
      expect(result!.totalReturn).toBeCloseTo(0.2970, 4);
    });

    it("returns IBKR's own chained TWR for accountId=3, honoring ibkr-activity percent rows (~+16.41% YTD)", () => {
      seedGroundTruth();
      const result = computeTwr(db, { startDate: "2026-01-01", accountId: 3 });
      expect(result).not.toBeNull();
      expect(result!.totalReturn).toBeCloseTo(chain(MONTHLY_RETURNS[3]), 6); // 0.164054…
      expect(result!.totalReturn).toBeCloseTo(0.1641, 4);
    });

    it("top-level fields mirror perAccount[0] when scoped to a single account", () => {
      seedGroundTruth();
      const result = computeTwr(db, { startDate: "2026-01-01", accountId: 2 });
      expect(result).not.toBeNull();
      const acct = result!.perAccount[0];
      expect(result!.totalReturn).toBe(acct.totalReturn);
      expect(result!.annualizedReturn).toBe(acct.annualizedReturn);
      expect(result!.startDate).toBe(acct.startDate);
      expect(result!.endDate).toBe(acct.endDate);
      expect(result!.totalDays).toBe(acct.totalDays);
    });

    it("unscoped call still returns the combined aggregate (and it differs from each scope)", () => {
      seedGroundTruth();

      // Expected combined: Modified Dietz on summed month-end values (no flows
      // seeded, so each sub-period is a simple aggregate ratio).
      const values: Record<number, number[]> = {};
      for (const acctId of [1, 2, 3]) {
        let v = START_VALUES[acctId];
        values[acctId] = [v];
        for (const r of MONTHLY_RETURNS[acctId]) {
          v = v * (1 + r);
          values[acctId].push(v);
        }
      }
      const sums = [0, 1, 2, 3, 4, 5].map(
        (i) => values[1][i] + values[2][i] + values[3][i],
      );
      const expectedCombined = chain(
        sums.slice(1).map((s, i) => s / sums[i] - 1),
      );

      const combined = computeTwr(db, { startDate: "2026-01-01" });
      expect(combined).not.toBeNull();
      expect(combined!.totalReturn).toBeCloseTo(expectedCombined, 6);
      expect(combined!.perAccount).toHaveLength(3);

      for (const acctId of [1, 2, 3]) {
        const scoped = computeTwr(db, { startDate: "2026-01-01", accountId: acctId });
        expect(scoped!.totalReturn).not.toBeCloseTo(combined!.totalReturn, 3);
      }
    });
  });

  // ─── Task 2: aggregate isPartial disclosure + accountIds scoping ─────
  //
  // portfolioPartial was already computed internally (full-coverage filter,
  // see the "does not crash portfolio TWR when TWS snapshot covers only one
  // account" test above) but DROPPED at the return — PortfolioTwrResult had
  // no way to tell the Performance view "this headline skipped a
  // statement-lag month." isPartial surfaces that flag.
  //
  // accountIds lets a multi-account named scope (e.g. a "vanguard" scope
  // that resolves to 2+ account ids once a second Vanguard account exists)
  // hit the aggregate path directly, instead of PerformanceView collapsing
  // it to a single id via resolveScopeToSingleId (which would silently
  // drop every account past the first from the chain).
  describe("aggregate isPartial + accountIds scoping", () => {
    const ANCHOR = "2025-12-31";
    const MONTHS = ["2026-01-31", "2026-02-28", "2026-03-31"];

    // A Dec-2025 anchor row per account gives the aggregate a V_start for
    // January (mirrors seedGroundTruth() above) — without it, January
    // itself would read as partial (no prior aggregate) regardless of how
    // clean the rest of the fixture is, confounding the assertions below.
    function seedCleanAccounts(
      targetDb: Database.Database,
      acctIds: number[]
    ): void {
      for (const acctId of acctIds) {
        let v = 100000 * acctId;
        seedSnapshot(targetDb, acctId, ANCHOR, v);
        for (const date of MONTHS) {
          v *= 1.01;
          seedSnapshot(targetDb, acctId, date, v);
        }
      }
    }

    it("aggregate isPartial is false on a clean 3-account fixture", () => {
      seedCleanAccounts(db, [1, 2, 3]);

      const result = computeTwr(db, { startDate: "2026-01-01" });
      expect(result).not.toBeNull();
      expect(result!.isPartial).toBe(false);
    });

    it("aggregate isPartial is true when one account's month is missing (present < expected skip)", () => {
      seedCleanAccounts(db, [1, 2, 3]);
      // Account 3 is already "born" (its Dec-2025 anchor predates Feb), so a
      // missing Feb row is statement lag, not a legitimate absence.
      db.prepare(
        "DELETE FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ?"
      ).run(3, "2026-02-28");

      const result = computeTwr(db, { startDate: "2026-01-01" });
      expect(result).not.toBeNull();
      expect(result!.isPartial).toBe(true);
    });

    it("accountIds:[1,2] on a 3-account fixture equals the aggregate of a 2-account DB with the same rows", () => {
      seedCleanAccounts(db, [1, 2, 3]);

      const scoped = computeTwr(db, {
        startDate: "2026-01-01",
        accountIds: [1, 2],
      });
      expect(scoped).not.toBeNull();
      expect(scoped!.perAccount).toHaveLength(2);
      expect(scoped!.perAccount.map((a) => a.accountId).sort()).toEqual([1, 2]);

      // Independent DB with ONLY accounts 1 and 2's rows seeded (account 3
      // still exists in the `accounts` table via migration 002, but has no
      // monthly_snapshots rows, so it never enters the per-account loop or
      // the aggregate). The unscoped aggregate over this DB must equal the
      // scoped call above — account 3's data must not leak into the scope.
      const db2 = new Database(":memory:");
      db2.pragma("foreign_keys = ON");
      runMigrations(db2);
      seedCleanAccounts(db2, [1, 2]);

      const unscoped = computeTwr(db2, { startDate: "2026-01-01" });
      expect(unscoped).not.toBeNull();

      expect(scoped!.totalReturn).toBeCloseTo(unscoped!.totalReturn, 10);
      expect(scoped!.annualizedReturn).toBeCloseTo(unscoped!.annualizedReturn!, 10);
      expect(scoped!.startDate).toBe(unscoped!.startDate);
      expect(scoped!.endDate).toBe(unscoped!.endDate);
      expect(scoped!.totalDays).toBe(unscoped!.totalDays);
      expect(scoped!.isPartial).toBe(unscoped!.isPartial);

      db2.close();
    });

    it("accountIds of length 1 behaves identically to accountId (byte-for-byte)", () => {
      seedCleanAccounts(db, [1, 2, 3]);

      const viaAccountId = computeTwr(db, { startDate: "2026-01-01", accountId: 2 });
      const viaAccountIds = computeTwr(db, {
        startDate: "2026-01-01",
        accountIds: [2],
      });

      expect(viaAccountIds).toEqual(viaAccountId);
    });

    it("an empty accountIds array does NOT widen to the unscoped result (explicit no-accounts guard)", () => {
      seedCleanAccounts(db, [1, 2, 3]);

      const empty = computeTwr(db, { startDate: "2026-01-01", accountIds: [] });
      const unscoped = computeTwr(db, { startDate: "2026-01-01" });

      // Same shape as "no snapshots exist" (see the very first test in this
      // file) — an explicitly empty scope means zero accounts, not "no
      // filter." It must never fall through to the all-accounts branch.
      expect(empty).toBeNull();
      expect(unscoped).not.toBeNull();
    });

    // ─── Scoping must cover EVERY aggregate query site, not just the ─────
    // obvious SUM/COUNT ones. The three tests above only ever produce an
    // EMPTY result from the allFlowStmt fallback query (every seeded
    // snapshot carries deposits_withdrawals, so the aggregate never falls
    // through to it) and never seed a December annual-summary-shaped row,
    // so dropping either scopeAnd("account_id") there — or on the
    // decemberSnaps query — would pass all of them silently. This fixture
    // forces both paths to actually run with real cross-account data.
    describe("accountIds scoping covers the flow-fallback and December-correction query sites", () => {
      function seedFallbackAndDecemberFixture(
        targetDb: Database.Database,
        acctIds: number[]
      ): void {
        for (const acctId of acctIds) {
          const v0 = 100000 * acctId; // Dec-2025 anchor
          seedSnapshot(targetDb, acctId, "2025-12-31", v0);

          // January: a real snapshot-level deposit (single-mid-month-flow
          // branch — already covered elsewhere) so December's janNovDeps
          // subquery has something nonzero to subtract.
          const janDeposit = 1000 * acctId;
          const v1 = v0 * 1.02;
          seedSnapshot(targetDb, acctId, "2026-01-31", v1, {
            depositsWithdrawals: janDeposit,
          });

          // February: deposits_withdrawals left NULL on purpose — the
          // aggregate's effectiveDeposits is then 0 for this month, forcing
          // it through allFlowStmt (the scoped cash-flow fallback, twr.ts
          // ~453-460 / bind ~571) instead of the snapshot-level shortcut.
          const v2 = v1 * 1.02;
          seedSnapshot(targetDb, acctId, "2026-02-28", v2);
          seedExternalFlow(targetDb, acctId, "2026-02-15", 200 * acctId);

          // December: annual-summary-shaped row (starting_value is a
          // year-start figure, nowhere near Feb's total — well past the
          // 10% gap threshold — and deposits_withdrawals is the CUMULATIVE
          // annual figure). Triggers both the per-account isAnnualSummary
          // branch and the aggregate's decemberSnaps correction (twr.ts
          // ~467-519), which must itself be scoped to the account list.
          const decCumulativeDeposits = janDeposit + 500 * acctId;
          seedSnapshot(targetDb, acctId, "2026-12-31", v2 * 1.03, {
            startingValue: v0 * 3,
            depositsWithdrawals: decCumulativeDeposits,
          });
        }
      }

      it("scoped 2-of-3 aggregate equals an independent 2-account DB seeded with the same rows", () => {
        seedFallbackAndDecemberFixture(db, [1, 2, 3]);

        const scoped = computeTwr(db, {
          startDate: "2026-01-01",
          accountIds: [1, 2],
        });
        expect(scoped).not.toBeNull();

        // Independent DB with ONLY accounts 1 and 2's rows AND transactions
        // — account 3 has its own distinct flow (twr.ts ~200*3=600 on
        // 2026-02-15) and its own distinct December correction (based on
        // 1000*3/500*3), so if either scopeAnd got dropped, account 3's
        // data would leak into the scoped SUM and this comparison would
        // fail, not silently pass.
        const db2 = new Database(":memory:");
        db2.pragma("foreign_keys = ON");
        runMigrations(db2);
        seedFallbackAndDecemberFixture(db2, [1, 2]);

        const unscoped = computeTwr(db2, { startDate: "2026-01-01" });
        expect(unscoped).not.toBeNull();

        expect(scoped!.totalReturn).toBeCloseTo(unscoped!.totalReturn, 10);
        expect(scoped!.annualizedReturn).toBeCloseTo(unscoped!.annualizedReturn!, 10);
        expect(scoped!.startDate).toBe(unscoped!.startDate);
        expect(scoped!.endDate).toBe(unscoped!.endDate);
        expect(scoped!.totalDays).toBe(unscoped!.totalDays);
        expect(scoped!.isPartial).toBe(unscoped!.isPartial);

        db2.close();
      });
    });
  });
});
