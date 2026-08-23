import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { runIntegrityChecks } from "@/lib/queries/integrity-checks";
import { stampTaxLotsConvention } from "@/lib/compute/tax-convention";

/**
 * Tests for the number-trust integrity scan (spec: number-trust durable
 * fixes, task 17). Uses the full migrated schema (runMigrations seeds
 * Vanguard Taxable=1, Vanguard Roth IRA=2, IBKR=3).
 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertSecurity(
  db: Database.Database,
  id: number,
  symbol: string,
  securityType: string | null = null
): void {
  db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (?, ?, ?)`).run(id, symbol, securityType);
}

function insertHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate = "2026-08-20"
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, `test:holding:${accountId}:${securityId}:${asOfDate}`);
}

function insertBuys(db: Database.Database, accountId: number, securityId: number, count: number): void {
  const stmt = db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
     VALUES (?, ?, '2026-01-05', 'BUY', 10, -100)`
  );
  for (let i = 0; i < count; i++) stmt.run(accountId, securityId);
}

function insertLot(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantityRemaining: number,
  isShort = 0
): void {
  db.prepare(
    `INSERT INTO tax_lots
       (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
     VALUES (?, ?, '2026-01-05', 10, ?, ?, 100, ?)`
  ).run(accountId, securityId, quantityRemaining, quantityRemaining, isShort);
}

function insertValuation(
  db: Database.Database,
  accountId: number,
  date: string,
  cashBalance: number,
  totalValue: number
): void {
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, date, cashBalance, totalValue - cashBalance, totalValue);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("runIntegrityChecks — check 1: type-identity contradictions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("critical: held bond-typed security with equity fills (the U class)", () => {
    insertSecurity(db, 910, "ZZZ", "Bond");
    insertBuys(db, 1, 910, 12);
    insertHolding(db, 1, 910, 100);

    const { critical, warnings } = runIntegrityChecks(db);
    expect(critical).toEqual([
      { key: "type-contradiction:910", severity: "critical", reason: "ZZZ: Bond type contradicts 12 equity fills" },
    ]);
    expect(warnings).toEqual([]);
  });

  it("warning only: the same contradiction on a non-held security", () => {
    insertSecurity(db, 910, "ZZZ", "Bond");
    insertBuys(db, 1, 910, 12);
    // no holdings row at all — never held, or fully closed out

    const { critical, warnings } = runIntegrityChecks(db);
    expect(critical).toEqual([]);
    expect(warnings).toEqual([
      { key: "type-contradiction:910", severity: "warning", reason: "ZZZ: Bond type contradicts 12 equity fills" },
    ]);
  });

  it("a closed-out position (latest holding quantity = 0) is treated as not held", () => {
    insertSecurity(db, 910, "ZZZ", "Bond");
    insertBuys(db, 1, 910, 12);
    insertHolding(db, 1, 910, 0);

    const { critical, warnings } = runIntegrityChecks(db);
    expect(critical).toEqual([]);
    expect(warnings.map((w) => w.key)).toEqual(["type-contradiction:910"]);
  });
});

describe("runIntegrityChecks — check 2: unexplained negative cash-flow residual", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("critical: unexplained negative residual beyond floors, within the last 30 valuation days", () => {
    insertValuation(db, 1, "2026-08-01", 200_000, 500_000);
    insertValuation(db, 1, "2026-08-02", 150_000, 500_000); // -50,000 jump, zero transactions

    const { critical } = runIntegrityChecks(db);
    expect(critical).toEqual([
      {
        key: "cash-residual:1:2026-08-02",
        severity: "critical",
        reason: "Vanguard Taxable: unexplained cash residual of -50000.00 on 2026-08-02",
      },
    ]);
  });

  it("does not hit when the residual is positive (cash increased unexplained)", () => {
    insertValuation(db, 1, "2026-08-01", 150_000, 500_000);
    insertValuation(db, 1, "2026-08-02", 200_000, 500_000); // +50,000 jump

    const { critical } = runIntegrityChecks(db);
    expect(critical.filter((c) => c.key.startsWith("cash-residual:"))).toEqual([]);
  });

  it("does not hit when the point is classified source-seam, even though it clears the floors", () => {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (1, '2026-06-30', 500000, 'statement')`
    ).run();
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (1, '2026-08-02', 500000, 'plaid')`
    ).run();
    insertValuation(db, 1, "2026-08-01", 200_000, 500_000);
    insertValuation(db, 1, "2026-08-02", 150_000, 500_000); // source changed → seam at 2026-08-02

    const { critical } = runIntegrityChecks(db);
    expect(critical.filter((c) => c.key.startsWith("cash-residual:"))).toEqual([]);
  });

  it("does not hit when the point is classified live-anchor-residual, even though it clears the floors", () => {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (1, '2026-08-02', 500000, 'tws')`
    ).run();
    insertValuation(db, 1, "2026-08-01", 200_000, 500_000);
    insertValuation(db, 1, "2026-08-02", 150_000, 500_000); // 2026-08-02 is a live TWS anchor date

    const { critical } = runIntegrityChecks(db);
    expect(critical.filter((c) => c.key.startsWith("cash-residual:"))).toEqual([]);
  });

  it("does not hit when the residual is older than the account's last 30 valuation days", () => {
    const start = "2026-01-01";
    insertValuation(db, 1, start, 200_000, 500_000);
    insertValuation(db, 1, addDays(start, 1), 150_000, 500_000); // -50,000 jump, would otherwise qualify
    // 33 more flat days push the jump's date outside the most-recent-30 window
    for (let i = 2; i <= 34; i++) {
      insertValuation(db, 1, addDays(start, i), 150_000, 500_000);
    }

    const { critical } = runIntegrityChecks(db);
    expect(critical.filter((c) => c.key.startsWith("cash-residual:"))).toEqual([]);
  });

  it("orders multiple hits worst-first (most recent date first, then largest |residual|)", () => {
    insertValuation(db, 1, "2026-08-01", 200_000, 500_000);
    insertValuation(db, 1, "2026-08-02", 150_000, 500_000); // -50,000 on 08-02
    insertValuation(db, 2, "2026-08-05", 300_000, 500_000);
    insertValuation(db, 2, "2026-08-06", 200_000, 500_000); // -100,000 on 08-06 (more recent)

    const { critical } = runIntegrityChecks(db);
    const residualHits = critical.filter((c) => c.key.startsWith("cash-residual:"));
    expect(residualHits.map((h) => h.key)).toEqual(["cash-residual:2:2026-08-06", "cash-residual:1:2026-08-02"]);
  });
});

describe("runIntegrityChecks — check 3: position ↔ tax-lot drift", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    stampTaxLotsConvention(db); // marker current — the check is armed
  });

  it("critical: signed drift > 5% with lots present", () => {
    insertSecurity(db, 100, "AAA");
    insertHolding(db, 1, 100, 100);
    insertLot(db, 1, 100, 90); // 10/100 = 10% drift

    const { critical } = runIntegrityChecks(db);
    expect(critical).toEqual([
      { key: "lot-drift:1:100", severity: "critical", reason: "AAA (Vanguard Taxable): position/lot drift 10.0%" },
    ]);
  });

  it("critical: signed drift correctly negates short lots (is_short=1)", () => {
    insertSecurity(db, 101, "BBB");
    insertHolding(db, 1, 101, -100); // short position
    insertLot(db, 1, 101, 80, 1); // signed = -80; diff = -100 - (-80) = -20, ratio = 20%

    const { critical } = runIntegrityChecks(db);
    expect(critical.map((c) => c.key)).toContain("lot-drift:1:101");
  });

  it("a short position whose lots reconcile exactly produces no hit", () => {
    insertSecurity(db, 102, "CCC");
    insertHolding(db, 1, 102, -50);
    insertLot(db, 1, 102, 50, 1); // signed = -50, matches exactly

    const { critical, warnings } = runIntegrityChecks(db);
    expect(critical.map((c) => c.key)).not.toContain("lot-drift:1:102");
    expect(warnings.map((w) => w.key)).not.toContain("lot-drift:1:102");
  });

  it("warning: zero-transaction zero-lot position (known Data-Health class)", () => {
    insertSecurity(db, 103, "DDD");
    insertHolding(db, 1, 103, 50); // no lots, no transactions at all

    const { critical, warnings } = runIntegrityChecks(db);
    expect(critical.map((c) => c.key)).not.toContain("lot-drift:1:103");
    expect(warnings).toEqual([
      {
        key: "lot-drift:1:103",
        severity: "warning",
        reason: "DDD (Vanguard Taxable): position has zero lots and zero transactions",
      },
    ]);
  });

  it("critical: position with fills but zero lots", () => {
    insertSecurity(db, 104, "EEE");
    insertHolding(db, 1, 104, 50);
    insertBuys(db, 1, 104, 3); // real trading history, but computeTaxLots produced nothing

    const { critical } = runIntegrityChecks(db);
    expect(critical).toEqual([
      {
        key: "lot-drift:1:104",
        severity: "critical",
        reason: "EEE (Vanguard Taxable): position has 3 fills but zero tax lots",
      },
    ]);
  });

  it("warning: open tax lots with no matching position", () => {
    insertSecurity(db, 105, "FFF");
    insertLot(db, 1, 105, 30); // no holdings row for this (account, security)

    const { critical, warnings } = runIntegrityChecks(db);
    expect(critical.map((c) => c.key)).not.toContain("lot-drift:1:105");
    expect(warnings).toEqual([
      {
        key: "lot-drift:1:105",
        severity: "warning",
        reason: "FFF (Vanguard Taxable): open tax lots with no matching position",
      },
    ]);
  });

  it("epsilon 1e-4 suppresses float dust", () => {
    insertSecurity(db, 106, "GGG");
    insertHolding(db, 1, 106, 100.00005);
    insertLot(db, 1, 106, 100); // diff = 0.00005, below the 1e-4 epsilon

    const { critical, warnings } = runIntegrityChecks(db);
    expect(critical.map((c) => c.key)).not.toContain("lot-drift:1:106");
    expect(warnings.map((w) => w.key)).not.toContain("lot-drift:1:106");
  });

  it("drift <= 5% with lots present is not flagged at all", () => {
    insertSecurity(db, 107, "HHH");
    insertHolding(db, 1, 107, 100);
    insertLot(db, 1, 107, 97); // 3/100 = 3% drift, under the 5% bar

    const { critical, warnings } = runIntegrityChecks(db);
    expect(critical.map((c) => c.key)).not.toContain("lot-drift:1:107");
    expect(warnings.map((w) => w.key)).not.toContain("lot-drift:1:107");
  });
});

describe("runIntegrityChecks — check 3 is DARK while the tax-convention marker is stale", () => {
  it("returns no lot-drift hits when getTaxConventionState(db).recomputeCurrent is false (default, unstamped)", () => {
    const db = createTestDb();
    // Deliberately NOT calling stampTaxLotsConvention — marker stays stale.
    insertSecurity(db, 100, "AAA");
    insertHolding(db, 1, 100, 100);
    insertLot(db, 1, 100, 90); // would be a 10% critical drift hit if armed

    const { critical, warnings } = runIntegrityChecks(db);
    expect(critical.map((c) => c.key)).not.toContain("lot-drift:1:100");
    expect(warnings.map((w) => w.key)).not.toContain("lot-drift:1:100");
  });
});

describe("runIntegrityChecks — check 4: corporate-action reconcile delta", () => {
  it("warning: non-null reconcile_delta", () => {
    const db = createTestDb();
    insertSecurity(db, 200, "SPLIT");
    db.prepare(
      `INSERT INTO corporate_actions
         (id, security_id, action_type, effective_date, ratio_numerator, ratio_denominator, reconcile_delta)
       VALUES (5, 200, 'SPLIT', '2026-06-15', 2, 1, 3.5)`
    ).run();

    const { warnings, critical } = runIntegrityChecks(db);
    expect(critical.map((c) => c.key)).not.toContain("reconcile-delta:5");
    expect(warnings).toEqual([
      { key: "reconcile-delta:5", severity: "warning", reason: "SPLIT: corporate action reconcile delta 3.5 on 2026-06-15" },
    ]);
  });

  it("a clean (NULL reconcile_delta) corporate action produces no hit", () => {
    const db = createTestDb();
    insertSecurity(db, 201, "CLEAN");
    db.prepare(
      `INSERT INTO corporate_actions
         (id, security_id, action_type, effective_date, ratio_numerator, ratio_denominator)
       VALUES (6, 201, 'SPLIT', '2026-06-15', 2, 1)`
    ).run();

    const { warnings } = runIntegrityChecks(db);
    expect(warnings.map((w) => w.key)).not.toContain("reconcile-delta:6");
  });
});

describe("runIntegrityChecks — empty database", () => {
  it("returns no hits at all on a freshly migrated, empty database", () => {
    const db = createTestDb();
    expect(runIntegrityChecks(db)).toEqual({ critical: [], warnings: [] });
  });
});
