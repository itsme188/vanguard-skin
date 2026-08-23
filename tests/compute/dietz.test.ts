import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeMonthlyDietz } from "@/lib/compute/dietz";

// ─── Independent monthly Modified Dietz (Task 12) ─────────────────────────
//
// TDD per the task-12 brief: hand-computed months exercising the equation
// (spec WS2: r = (V_end − V_start − F) / (V_start + Σ w_i·F_i)) and the
// precedence chain (annual-summary FIRST, then insufficiency rules, then
// seam, then banded).

// ─── Seed helpers ───────────────────────────────────────────────────

function seedSecurity(db: Database.Database, id: number, symbol: string): void {
  db.prepare(`INSERT INTO securities (id, symbol) VALUES (?, ?)`).run(id, symbol);
}

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

/** A dated cash flow (no security_id) — DEPOSIT/WITHDRAWAL/etc. */
function seedCashFlow(
  db: Database.Database,
  accountId: number,
  date: string,
  type: string,
  amount: number,
  key: string
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(accountId, date, type, amount, key);
}

/** An in-kind transfer leg: security_id set, FMV stored positive (type
 *  carries direction — SIGNED_EXTERNAL_FLOW_SQL signs TRANSFER_OUT negative). */
function seedInKindTransfer(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  type: "TRANSFER_IN" | "TRANSFER_OUT",
  fmv: number,
  key: string
): void {
  db.prepare(
    `INSERT INTO transactions
       (account_id, security_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(accountId, securityId, date, type, fmv, key);
}

describe("computeMonthlyDietz", () => {
  let db: Database.Database;
  const ACCT = 1; // Vanguard Taxable (seeded by migration 002)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("computes day-weighted Dietz exactly", () => {
    // V_start 100,000 (prior month), V_end 103,000, one deposit 2,000 on day 10 of a 30-day month.
    // w = (30-10)/30 = 2/3. r = (103000-100000-2000)/(100000 + 2000*2/3) = 1000/101333.33 = 0.009868...
    seedSnapshot(db, ACCT, "2026-03-31", 100_000);
    seedSnapshot(db, ACCT, "2026-04-30", 103_000, { depositsWithdrawals: 2_000 });
    seedCashFlow(db, ACCT, "2026-04-10", "DEPOSIT", 2_000, "dep-1");

    const r = computeMonthlyDietz(db, 1, "2026-04-30");
    expect(r.dietzReturn).toBeCloseTo(0.0098684, 6);
    expect(r.rule).toBe("banded");
  });

  it("month-end flow gets weight 0 (end-of-day convention)", () => {
    // A flow dated exactly on the month-end date contributes fully to the
    // numerator (F) but nothing to the weighted denominator (w = 0).
    seedSnapshot(db, ACCT, "2026-03-31", 100_000);
    seedSnapshot(db, ACCT, "2026-04-30", 110_000, { depositsWithdrawals: 5_000 });
    seedCashFlow(db, ACCT, "2026-04-30", "DEPOSIT", 5_000, "dep-eom");

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    // denominator = 100,000 + 5,000*0 = 100,000
    // numerator   = 110,000 - 100,000 - 5,000 = 5,000
    // r = 5,000 / 100,000 = 0.05 exactly
    expect(r.rule).toBe("banded");
    expect(r.dietzReturn).toBeCloseTo(0.05, 10);
  });

  it("in-kind TRANSFER legs count as flows (compared separately from the statement total)", () => {
    seedSecurity(db, 1, "AAPL");
    seedSnapshot(db, ACCT, "2026-03-31", 100_000);
    // No cash flows this month — deposits_withdrawals stays 0, matching the
    // cash-only ledger sum of 0 ("zero-vs-zero passes").
    seedSnapshot(db, ACCT, "2026-04-30", 97_500, { depositsWithdrawals: 0 });
    seedInKindTransfer(db, ACCT, 1, "2026-04-15", "TRANSFER_OUT", 3_000, "inkind-out-1");

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    const totalDays = 30;
    const weight = (totalDays - 15) / totalDays; // day 15 => 0.5
    const netFlow = -3_000; // TRANSFER_OUT signed negative
    const vStart = 100_000;
    const vEnd = 97_500;
    const denominator = vStart + netFlow * weight;
    const numerator = vEnd - vStart - netFlow;
    const expectedR = numerator / denominator;

    expect(r.rule).toBe("banded");
    expect(r.netFlow).toBeCloseTo(-3_000, 6);
    expect(r.dietzReturn).toBeCloseTo(expectedR, 10);
  });

  it("flow ledger vs statement deposits_withdrawals mismatch > $1 → insufficient/flow-total-mismatch", () => {
    seedSnapshot(db, ACCT, "2026-03-31", 100_000);
    // Statement says 1,000 but the ledger's dated cash flows sum to 2,000 —
    // off by $1,000, far past the $1 tolerance.
    seedSnapshot(db, ACCT, "2026-04-30", 102_000, { depositsWithdrawals: 1_000 });
    seedCashFlow(db, ACCT, "2026-04-10", "DEPOSIT", 2_000, "dep-mismatch");

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    expect(r.rule).toBe("flow-total-mismatch");
    expect(r.dietzReturn).toBeNull();
  });

  it("null deposits_withdrawals → insufficient/flow-total-unavailable", () => {
    seedSnapshot(db, ACCT, "2026-03-31", 100_000);
    seedSnapshot(db, ACCT, "2026-04-30", 103_000); // deposits_withdrawals left NULL
    seedCashFlow(db, ACCT, "2026-04-10", "DEPOSIT", 2_000, "dep-1");

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    expect(r.rule).toBe("flow-total-unavailable");
    expect(r.dietzReturn).toBeNull();
  });

  it("annual-summary December → not_comparable BEFORE any flow adjudication (precedence pin)", () => {
    // December row with cumulative starting_value divergence AND a null
    // deposits_withdrawals: must yield annual-summary-row, NOT
    // flow-total-unavailable.
    seedSnapshot(db, ACCT, "2025-11-30", 350_000);
    seedSnapshot(db, ACCT, "2025-12-31", 355_000, { startingValue: 300_000 }); // depositsWithdrawals left NULL

    const r = computeMonthlyDietz(db, ACCT, "2025-12-31");

    expect(r.rule).toBe("annual-summary-row");
    expect(r.dietzReturn).toBeNull();
  });

  it("seam inside month → not_comparable/seam-straddled (after insufficiency checks)", () => {
    // Two anchors with DIFFERENT sources — the seam lands on the current
    // month's anchor date, which falls inside (priorMonthEnd, monthEndDate].
    seedSnapshot(db, ACCT, "2026-03-31", 100_000, { source: "manual" });
    seedSnapshot(db, ACCT, "2026-04-30", 103_000, { depositsWithdrawals: 0, source: "canonical" });
    // No dated flows: cash sum 0 matches deposits_withdrawals 0, and the
    // denominator stays at V_start (positive) — every insufficiency check
    // passes, so the seam check is what actually fires.

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    expect(r.rule).toBe("seam-straddled");
    expect(r.dietzReturn).toBeNull();
    expect(r.seamStraddled).toBe(true);
  });

  it("missing prior month → insufficient/missing-v-start", () => {
    seedSnapshot(db, ACCT, "2026-04-30", 103_000, { depositsWithdrawals: 0 });
    // No "2026-03-31" row at all.

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    expect(r.rule).toBe("missing-v-start");
    expect(r.vStart).toBeNull();
    expect(r.dietzReturn).toBeNull();
  });

  it("nonpositive denominator → insufficient", () => {
    seedSnapshot(db, ACCT, "2026-03-31", 1_000);
    seedSnapshot(db, ACCT, "2026-04-30", -900, { depositsWithdrawals: -2_000 });
    // A big withdrawal early in the month (day 1, weight 29/30) drags the
    // weighted denominator negative: 1,000 + (-2,000 * 29/30) ≈ -933.33.
    seedCashFlow(db, ACCT, "2026-04-01", "WITHDRAWAL", -2_000, "big-withdrawal");

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    expect(r.rule).toBe("nonpositive-denominator");
    expect(r.dietzReturn).toBeNull();
  });

  it("collision: null deposits_withdrawals AND a nonpositive denominator → nonpositive-denominator wins (spec list order)", () => {
    // Same nonpositive-denominator shape as above, but this time
    // deposits_withdrawals is left NULL too — which would ALSO qualify as
    // flow-total-unavailable. The spec's edge-precedence list is binding in
    // its LISTED order (missing-v-start, nonpositive-denominator,
    // flow-total-mismatch, flow-total-unavailable), so nonpositive-
    // denominator must win, not flow-total-unavailable.
    seedSnapshot(db, ACCT, "2026-03-31", 1_000);
    seedSnapshot(db, ACCT, "2026-04-30", -900); // deposits_withdrawals left NULL
    seedCashFlow(db, ACCT, "2026-04-01", "WITHDRAWAL", -2_000, "big-withdrawal-null-dw");

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    expect(r.rule).toBe("nonpositive-denominator");
    expect(r.dietzReturn).toBeNull();
  });

  it("$1 tolerance boundary: exactly $1.00 diff passes (banded), strict > semantics", () => {
    // Ledger cash flow sums to 2,000; statement reports 1,999.00 — a diff of
    // exactly $1.00, which is NOT > DIETZ_FLOW_TOL_USD (1.0), so the
    // mismatch check does not fire and the month bands normally. The return
    // itself is computed from the LEDGER's actual flow (2,000), not the
    // statement figure — same math as the first "day-weighted" test.
    seedSnapshot(db, ACCT, "2026-03-31", 100_000);
    seedSnapshot(db, ACCT, "2026-04-30", 103_000, { depositsWithdrawals: 1_999.0 });
    seedCashFlow(db, ACCT, "2026-04-10", "DEPOSIT", 2_000, "dep-boundary-pass");

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    expect(r.rule).toBe("banded");
    expect(r.dietzReturn).toBeCloseTo(0.0098684, 6);
  });

  it("$1 tolerance boundary: $1.01 diff fails (flow-total-mismatch), strict > semantics", () => {
    // Same ledger flow (2,000), but the statement now reports 1,998.99 — a
    // diff of $1.01, which IS > DIETZ_FLOW_TOL_USD (1.0), so the mismatch
    // check fires.
    seedSnapshot(db, ACCT, "2026-03-31", 100_000);
    seedSnapshot(db, ACCT, "2026-04-30", 103_000, { depositsWithdrawals: 1_998.99 });
    seedCashFlow(db, ACCT, "2026-04-10", "DEPOSIT", 2_000, "dep-boundary-fail");

    const r = computeMonthlyDietz(db, ACCT, "2026-04-30");

    expect(r.rule).toBe("flow-total-mismatch");
    expect(r.dietzReturn).toBeNull();
  });
});
