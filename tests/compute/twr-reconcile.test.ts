import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileTwrAgainstStatements } from "@/lib/compute/twr-reconcile";

// ─── Independent Dietz cross-check (Task 13) ───────────────────────────────
//
// The old reconciler compared the statement TWR against `computeTwr`, which
// just echoes `snap.twr` back — a statement figure "agreeing" with an echo
// of itself always reads ~0bp divergence, whether the statement is right or
// wrong (see CLAUDE.md "TWR 'reconciliation' is statement-self-referential").
// This suite pins the sever: the reconciler now compares against the
// INDEPENDENT Modified Dietz return (Task 12), which never reads
// monthly_snapshots.twr at all.

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  opts: {
    startingValue?: number;
    twr?: number | null;
    depositsWithdrawals?: number;
    source?: string;
  } = {},
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value, twr, deposits_withdrawals, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    monthEndDate,
    totalValue,
    opts.startingValue ?? null,
    opts.twr === undefined ? null : opts.twr,
    opts.depositsWithdrawals ?? null,
    opts.source ?? "manual",
  );
}

function seedCashFlow(
  db: Database.Database,
  accountId: number,
  date: string,
  type: string,
  amount: number,
  key: string,
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(accountId, date, type, amount, key);
}

describe("reconcileTwrAgainstStatements", () => {
  let db: Database.Database;
  const ACCT = 1; // Vanguard Taxable (seeded by migration 002)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // accounts 1/2/3 pre-seeded by migration 002
  });

  it("SOURCE ASSERTION: twr-reconcile.ts never imports computeTwr (the circularity sever)", () => {
    const src = readFileSync(
      join(process.cwd(), "lib/compute/twr-reconcile.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["']\.\/twr["']/);
    expect(src).not.toMatch(/from\s+["']@\/lib\/compute\/twr["']/);
    expect(src).not.toMatch(/import\s*\{[^}]*computeTwr/);
  });

  it("CIRCULARITY GUARD: a statement TWR that disagrees with balances produces nonzero divergence", () => {
    // Snapshots: V_start 100k, V_end 110k, zero flows → Dietz = +10%.
    // Statement twr stored as 0.02 (+2%, vanguard-pdf = decimal). The OLD
    // reconciler (comparing against computeTwr, which echoes snap.twr) would
    // have read ~0bp here. The new one must read ~+800bp and flag investigate.
    seedSnapshot(db, ACCT, "2026-04-30", 100_000, { source: "vanguard-pdf" });
    seedSnapshot(db, ACCT, "2026-05-31", 110_000, {
      depositsWithdrawals: 0,
      twr: 0.02,
      source: "vanguard-pdf",
    });

    const r = reconcileTwrAgainstStatements(db, ACCT, "2026-05-31");

    expect(r).not.toBeNull();
    expect(r!.dietzReturn).toBeCloseTo(0.1, 6);
    expect(r!.statementTwr).toBeCloseTo(0.02, 6);
    expect(r!.divergenceBp).toBe(800);
    expect(Math.abs(r!.divergenceBp!)).toBeGreaterThan(700);
    expect(r!.band).toBe("investigate");
    expect(r!.rule).toBe("banded");
  });

  it("agreeing statement + Dietz within 125bp → consistent", () => {
    // Same shape as the dietz.test.ts day-weighted case: V_start 100,000,
    // V_end 103,000, deposit 2,000 on day 10 of April (30 days).
    // dietzReturn ≈ 0.0098684. Statement TWR set to the same figure.
    seedSnapshot(db, ACCT, "2026-03-31", 100_000, { source: "vanguard-pdf" });
    seedSnapshot(db, ACCT, "2026-04-30", 103_000, {
      depositsWithdrawals: 2_000,
      twr: 0.0098684,
      source: "vanguard-pdf",
    });
    seedCashFlow(db, ACCT, "2026-04-10", "DEPOSIT", 2_000, "dep-1");

    const r = reconcileTwrAgainstStatements(db, ACCT, "2026-04-30");

    expect(r).not.toBeNull();
    expect(r!.rule).toBe("banded");
    expect(Math.abs(r!.divergenceBp!)).toBeLessThanOrEqual(125);
    expect(r!.band).toBe("consistent");
  });

  it("normalizes ibkr-activity TWR from percentage to decimal", () => {
    seedSnapshot(db, ACCT, "2026-03-31", 100_000);
    seedSnapshot(db, ACCT, "2026-04-30", 105_210, {
      twr: 5.21,
      source: "ibkr-activity",
    });

    const r = reconcileTwrAgainstStatements(db, ACCT, "2026-04-30");

    expect(r).not.toBeNull();
    // Statement says 5.21% — must be normalized from 5.21 to 0.0521
    expect(r!.statementTwr).toBeCloseTo(0.0521, 6);
    expect(r!.statementSource).toBe("ibkr-activity");
  });

  it("returns null when no statement row exists for the period at all", () => {
    const result = reconcileTwrAgainstStatements(db, 3, "2026-04-30");
    expect(result).toBeNull();
  });

  it("returns null when a statement row exists but not for the queried period end (exact-match only)", () => {
    seedSnapshot(db, 3, "2026-04-30", 100_000, { twr: 5.21, source: "ibkr-activity" });
    const result = reconcileTwrAgainstStatements(db, 3, "2026-03-31");
    expect(result).toBeNull();
  });

  it("statement row present but twr IS NULL → band insufficient, rule missing-statement-twr, Dietz side still populated", () => {
    // Prior month present so the Dietz side actually bands (proves it's not
    // just null-propagated — the Dietz recompute runs independently of
    // whether the statement has a usable twr).
    seedSnapshot(db, ACCT, "2026-03-31", 100_000, { source: "vanguard-pdf" });
    seedSnapshot(db, ACCT, "2026-04-30", 103_000, {
      depositsWithdrawals: 0,
      twr: null,
      source: "vanguard-pdf",
    });

    const r = reconcileTwrAgainstStatements(db, ACCT, "2026-04-30");

    expect(r).not.toBeNull();
    expect(r!.statementTwr).toBeNull();
    expect(r!.band).toBe("insufficient");
    expect(r!.rule).toBe("missing-statement-twr");
    expect(r!.divergenceBp).toBeNull();
    // Dietz side populated: zero flows, V_start 100k → V_end 103k → +3%.
    expect(r!.dietzReturn).toBeCloseTo(0.03, 6);
  });

  it("Dietz non-banded rule (missing-v-start) passes through as the band, rule carried, divergenceBp null", () => {
    // No prior-month snapshot at all → Dietz can't compute V_start.
    seedSnapshot(db, ACCT, "2026-04-30", 103_000, {
      twr: 0.03,
      source: "vanguard-pdf",
    });

    const r = reconcileTwrAgainstStatements(db, ACCT, "2026-04-30");

    expect(r).not.toBeNull();
    expect(r!.statementTwr).toBeCloseTo(0.03, 6);
    expect(r!.dietzReturn).toBeNull();
    expect(r!.divergenceBp).toBeNull();
    expect(r!.band).toBe("insufficient");
    expect(r!.rule).toBe("missing-v-start");
  });

  it("Dietz non-banded rule (annual-summary-row) passes through as not_comparable", () => {
    seedSnapshot(db, ACCT, "2025-11-30", 350_000);
    seedSnapshot(db, ACCT, "2025-12-31", 355_000, {
      startingValue: 300_000, // >10% divergence from prior month's total → annual summary
      twr: 0.05,
      source: "vanguard-pdf",
    });

    const r = reconcileTwrAgainstStatements(db, ACCT, "2025-12-31");

    expect(r).not.toBeNull();
    expect(r!.dietzReturn).toBeNull();
    expect(r!.band).toBe("not_comparable");
    expect(r!.rule).toBe("annual-summary-row");
  });

  it("Dietz rule annual-summary-row wins over a null statement twr (finding 2 precedence fix)", () => {
    // Same annual-summary-row trigger as above (starting_value >10% off the
    // prior month's total), but the statement's own twr column is null this
    // time — a real December annual-summary row often carries no twr at all.
    // The buggy precedence checked `stmt.twr === null` FIRST and returned
    // band "insufficient" / rule "missing-statement-twr" (chain-breaking);
    // dietz.ts's spec precedence list puts annual-summary-row FIRST, so that
    // chain-preserving verdict (not_comparable) must win here too, exactly
    // as it does when twr is present (previous test).
    seedSnapshot(db, ACCT, "2025-11-30", 350_000);
    seedSnapshot(db, ACCT, "2025-12-31", 355_000, {
      startingValue: 300_000, // >10% divergence from prior month's total → annual summary
      twr: null,
      source: "vanguard-pdf",
    });

    const r = reconcileTwrAgainstStatements(db, ACCT, "2025-12-31");

    expect(r).not.toBeNull();
    expect(r!.dietzReturn).toBeNull();
    expect(r!.band).toBe("not_comparable");
    expect(r!.rule).toBe("annual-summary-row");
    expect(r!.statementTwr).toBeNull();
  });
});
