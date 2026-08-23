import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getDataConfidence } from "@/lib/queries/data-confidence";

/**
 * Covers the cashAccuracy dimension's unexplained-cash-flow extension (QA:
 * analysis-risk-decomposition--vol-drawdown-sharpe-count-cash-flows-as-
 * returns). Uses the full migrated schema (runMigrations seeds Vanguard
 * Taxable=1, Vanguard Roth IRA=2, IBKR=3) since getDataConfidence runs all
 * five dimension scorers together.
 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function recentDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function insertFreshAnchor(db: Database.Database, accountId: number, daysAgo: number, totalValue: number): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, 'manual')`
  ).run(accountId, recentDate(daysAgo), totalValue);
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

describe("cashAccuracy dimension — unexplained cash-flow extension", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("caps the score and names the account+date+classification for an external-flow-candidate jump", () => {
    insertFreshAnchor(db, 1, 2, 1_500_000); // fresh statement anchor — would otherwise score 100
    insertValuation(db, 1, "2026-07-10", 60_500.25, 1_350_000.55);
    insertValuation(db, 1, "2026-07-11", 210_500.25, 1_440_000.55); // unexplained +150,000.00 cash, +90,000.00 total_value, no transactions

    const { cashAccuracy } = getDataConfidence(db);

    expect(cashAccuracy.score).toBeLessThanOrEqual(40);
    expect(cashAccuracy.unexplainedFlow).not.toBeNull();
    expect(cashAccuracy.unexplainedFlow!.accountName).toBe("Vanguard Taxable");
    expect(cashAccuracy.unexplainedFlow!.date).toBe("2026-07-11");
    expect(cashAccuracy.unexplainedFlow!.residual).toBeCloseTo(150_000.00, 1);
    expect(cashAccuracy.unexplainedFlow!.classification).toBe("external-flow-candidate");
    expect(cashAccuracy.detail).toContain("Vanguard Taxable");
    expect(cashAccuracy.detail).toContain("2026-07-11");
    expect(cashAccuracy.detail).toContain("unexplained external-flow-shaped cash delta");
    expect(cashAccuracy.guidance).toContain("repair-missing-external-flows.ts");
  });

  it("caps the score and uses the internal-shift wording when total_value moved smoothly", () => {
    insertFreshAnchor(db, 1, 2, 1_548_600.40);
    // Mirrors the live 2026-07-30->07-31 finding: cash drops ~$231k but
    // total_value only drops ~$13.8k — a cash/holdings misattribution, not
    // a missing flow.
    insertValuation(db, 1, "2026-07-30", 205_000.40, 1_560_000.40);
    insertValuation(db, 1, "2026-07-31", 9_800.40, 1_548_600.40);

    const { cashAccuracy } = getDataConfidence(db);

    expect(cashAccuracy.score).toBeLessThanOrEqual(40);
    expect(cashAccuracy.unexplainedFlow).not.toBeNull();
    expect(cashAccuracy.unexplainedFlow!.classification).toBe("internal-shift");
    expect(cashAccuracy.detail).toContain("internal cash/holdings shift (valuation-source misattribution)");
    expect(cashAccuracy.detail).not.toContain("unexplained external-flow-shaped");
    expect(cashAccuracy.guidance).toContain("valuation source");
    expect(cashAccuracy.guidance).not.toContain("repair-missing-external-flows.ts");
  });

  it("leaves the score untouched and unexplainedFlow null when cash is clean", () => {
    insertFreshAnchor(db, 1, 2, 1_500_000);
    insertValuation(db, 1, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 1, "2026-07-11", 80_000, 1_400_000); // flat, no jump

    const { cashAccuracy } = getDataConfidence(db);

    expect(cashAccuracy.unexplainedFlow).toBeNull();
    expect(cashAccuracy.score).toBe(100);
  });

  it("does not flag a jump that's fully explained by a recorded deposit", () => {
    insertFreshAnchor(db, 1, 2, 1_670_000);
    insertValuation(db, 1, "2026-07-16", 130_250, 1_500_000);
    insertValuation(db, 1, "2026-07-17", 300_250, 1_670_000);
    db.prepare(
      `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
       VALUES (1, '2026-07-17', 'DEPOSIT', 170000, 1, 'test:1')`
    ).run();

    const { cashAccuracy } = getDataConfidence(db);
    expect(cashAccuracy.unexplainedFlow).toBeNull();
  });

  it("ignores an IBKR-account cash jump (excluded from the audit's account scope)", () => {
    insertFreshAnchor(db, 3, 2, 1_500_000);
    insertValuation(db, 3, "2026-07-10", 80_000, 1_400_000);
    insertValuation(db, 3, "2026-07-11", 260_000, 1_500_000); // would clear the bar on a non-IBKR account

    const { cashAccuracy } = getDataConfidence(db);
    expect(cashAccuracy.unexplainedFlow).toBeNull();
  });

  it("uses a more sensitive relative floor (2%) than the repair script's 5% bar", () => {
    // A $110k-scale account with a jump that clears 2% but not 5%.
    insertFreshAnchor(db, 2, 2, 110_000);
    insertValuation(db, 2, "2026-07-10", 10_000, 110_000);
    insertValuation(db, 2, "2026-07-11", 13_500, 113_500); // +3,500 = ~3.1% of account value

    const { cashAccuracy } = getDataConfidence(db);
    expect(cashAccuracy.unexplainedFlow).not.toBeNull();
    expect(cashAccuracy.unexplainedFlow!.accountName).toBe("Vanguard Roth IRA");
    // total_value moved exactly as much as cash here (holdings unchanged) — corroborated.
    expect(cashAccuracy.unexplainedFlow!.classification).toBe("external-flow-candidate");
  });

  // ── live-anchor-residual: suppress the cap, keep the label (task 9) ────

  it("labels an external-flow-shaped jump on a plaid-anchored day as a timing residual instead of capping the score", () => {
    insertFreshAnchor(db, 1, 2, 1_500_000); // fresh statement anchor — would otherwise score 100
    // The jump's landing date is itself a LIVE (Plaid) monthly_snapshots
    // anchor — daily-valuation.ts's cash_balance there is an intraday
    // snapshot-total-minus-close-priced-holdings plug, not literal cash.
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (1, '2026-07-11', 1440000.55, 'plaid')`
    ).run();
    insertValuation(db, 1, "2026-07-10", 60_500.25, 1_350_000.55);
    insertValuation(db, 1, "2026-07-11", 210_500.25, 1_440_000.55); // same external-flow-shaped jump as the legacy test

    const { cashAccuracy } = getDataConfidence(db);

    expect(cashAccuracy.score).toBe(100); // NOT capped
    expect(cashAccuracy.unexplainedFlow).toBeNull();
    expect(cashAccuracy.timingResidual).not.toBeNull();
    expect(cashAccuracy.timingResidual!.date).toBe("2026-07-11");
    expect(cashAccuracy.timingResidual!.accountName).toBe("Vanguard Taxable");
    expect(cashAccuracy.timingResidual!.amount).toBeCloseTo(150_000.0, 1);
    expect(cashAccuracy.detail).toContain("live-snapshot timing residual");
    expect(cashAccuracy.guidance).toContain("Live-snapshot (Plaid/TWS) days infer cash");
  });

  it("keeps the legacy cap + warning copy for the same jump on a canonical (non-live) anchored day", () => {
    insertFreshAnchor(db, 1, 2, 1_500_000);
    // A statement-sourced (non-live) anchor row lands on the SAME date as
    // the jump — must not be mistaken for a live anchor.
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (1, '2026-07-11', 1440000.55, 'canonical')`
    ).run();
    insertValuation(db, 1, "2026-07-10", 60_500.25, 1_350_000.55);
    insertValuation(db, 1, "2026-07-11", 210_500.25, 1_440_000.55);

    const { cashAccuracy } = getDataConfidence(db);

    expect(cashAccuracy.score).toBeLessThanOrEqual(40);
    expect(cashAccuracy.unexplainedFlow).not.toBeNull();
    expect(cashAccuracy.unexplainedFlow!.classification).toBe("external-flow-candidate");
    expect(cashAccuracy.detail).toContain("unexplained external-flow-shaped cash delta");
    expect(cashAccuracy.timingResidual).toBeNull();
  });

  it("stays fully silent (no unexplainedFlow, no timingResidual) on a source-seam day", () => {
    insertFreshAnchor(db, 1, 2, 1_500_000);
    // Anchor-source transition (canonical -> plaid) landing exactly on the
    // jump date — source-seam must win over live-anchor-residual even
    // though this date is ALSO a live (plaid) anchor.
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (1, '2026-07-05', 1300000, 'canonical')`
    ).run();
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (1, '2026-07-11', 1440000.55, 'plaid')`
    ).run();
    insertValuation(db, 1, "2026-07-10", 60_500.25, 1_350_000.55);
    insertValuation(db, 1, "2026-07-11", 210_500.25, 1_440_000.55);

    const { cashAccuracy } = getDataConfidence(db);

    expect(cashAccuracy.unexplainedFlow).toBeNull();
    expect(cashAccuracy.timingResidual).toBeNull();
    expect(cashAccuracy.score).toBe(100);
  });
});
