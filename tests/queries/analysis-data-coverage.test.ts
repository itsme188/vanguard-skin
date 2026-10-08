import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAnalysisDataCoverage } from "@/lib/queries/analysis";
import {
  coverageBannerNotes,
  coveragePercentBasis,
} from "@/app/dashboard/components/AnalysisView";

/**
 * Data-coverage figure behind the Analysis banner (review of 5553916a).
 *
 * The two sides must sit on ONE basis. Taking the snapshot's cash balance off
 * the snapshot side only, while a sweep fund still counted as a holding, let
 * that sweep row stand in for a genuinely missing position of the same size.
 * All figures here are invented round numbers.
 */

let db: Database.Database;

function account(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function holding(
  accountId: number,
  symbol: string,
  value: number,
  opts: { security_type?: string; fund_category?: string | null } = {}
) {
  const securityId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, fund_category) VALUES (?, ?, ?, ?)")
    .run(symbol, `${symbol} Inc`, opts.security_type ?? "Stock", opts.fund_category ?? null)
    .lastInsertRowid as number;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, '2026-06-30', ?)`
  ).run(accountId, securityId, value, `coverage:${accountId}:${securityId}`);
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 1, '2026-06-30', 'test')"
  ).run(securityId);
}

function snapshot(accountId: number, total: number, cash: number | null, source: string) {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
     VALUES (?, '2026-06-30', ?, ?, ?)`
  ).run(accountId, total, cash, source);
}

const SWEEP = { security_type: "Mutual Fund", fund_category: "Cash Equivalent" };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getAnalysisDataCoverage — one basis on both sides", () => {
  it("a sweep fund held as a holding cannot hide a missing position of the same size", () => {
    // Stock 1000 held; sweep fund 800 held as a holdings row; a real 800
    // position is MISSING. The Plaid snapshot folds the sweep into cash.
    const acct = account("Plaid Account");
    holding(acct, "STKX", 1000);
    holding(acct, "SWPX", 800, SWEEP);
    snapshot(acct, 2600, 800, "plaid");

    const coverage = getAnalysisDataCoverage(db, [acct]);
    expect(coverage.holdingsTotal).toBe(1000);
    expect(coverage.snapshotTotal).toBe(1800);
    expect(coverage.coveragePct).toBe(55.6);
    expect(coverage.coveragePct).toBeLessThan(90); // the banner shows
    expect(coverage.cashExcluded).toBe(true);
    expect(coverage.unknownCashAccounts).toEqual([]);
  });

  it("identifies the sweep fund by classification, including the money_market type", () => {
    const acct = account("Plaid Account");
    holding(acct, "STKX", 1000);
    holding(acct, "MMKX", 800, { security_type: "money_market" });
    snapshot(acct, 2600, 800, "plaid");
    expect(getAnalysisDataCoverage(db, [acct]).coveragePct).toBe(55.6);
  });

  it("pure cash with a real gap still shows the gap", () => {
    const acct = account("Live Account");
    holding(acct, "STKX", 1000);
    snapshot(acct, 3000, 500, "tws");

    const coverage = getAnalysisDataCoverage(db, [acct]);
    expect(coverage.holdingsTotal).toBe(1000);
    expect(coverage.snapshotTotal).toBe(2500);
    expect(coverage.coveragePct).toBe(40);
  });

  it("a fully covered book reads 100%, with or without a sweep row", () => {
    const acct = account("Plaid Account");
    holding(acct, "STKX", 1000);
    holding(acct, "SWPX", 800, SWEEP);
    snapshot(acct, 1800, 800, "plaid");

    const coverage = getAnalysisDataCoverage(db, [acct]);
    expect(coverage.holdingsTotal).toBe(1000);
    expect(coverage.snapshotTotal).toBe(1000);
    expect(coverage.coveragePct).toBe(100);
  });

  it("a snapshot with no cash balance keeps the whole-value basis and names the account", () => {
    // Statement snapshots store NULL cash. The sweep row is the cash, so it
    // must stay on the holdings side or a covered book would read as a gap.
    const acct = account("Statement Account");
    holding(acct, "STKX", 1000);
    holding(acct, "SWPX", 800, SWEEP);
    snapshot(acct, 1800, null, "statement");

    const coverage = getAnalysisDataCoverage(db, [acct]);
    expect(coverage.holdingsTotal).toBe(1800);
    expect(coverage.snapshotTotal).toBe(1800);
    expect(coverage.coveragePct).toBe(100);
    expect(coverage.cashExcluded).toBe(false);
    expect(coverage.unknownCashAccounts).toEqual(["Statement Account"]);
  });

  it("a statement account holding plain cash is not guessed at: old basis, account named", () => {
    const acct = account("Statement Account");
    holding(acct, "STKX", 1000);
    snapshot(acct, 1500, null, "statement");

    const coverage = getAnalysisDataCoverage(db, [acct]);
    expect(coverage.holdingsTotal).toBe(1000);
    expect(coverage.snapshotTotal).toBe(1500);
    expect(coverage.coveragePct).toBe(66.7);
    expect(coverage.unknownCashAccounts).toEqual(["Statement Account"]);
  });

  it("each account is measured on its own basis in a mixed scope", () => {
    const plaid = account("Plaid Account");
    holding(plaid, "STKX", 1000);
    holding(plaid, "SWPX", 800, SWEEP);
    snapshot(plaid, 1800, 800, "plaid"); // 1000 of 1000
    const statement = account("Statement Account");
    holding(statement, "STKY", 500);
    holding(statement, "SWPY", 300, SWEEP);
    snapshot(statement, 800, null, "statement"); // 800 of 800

    const coverage = getAnalysisDataCoverage(db);
    expect(coverage.holdingsTotal).toBe(1800);
    expect(coverage.snapshotTotal).toBe(1800);
    expect(coverage.coveragePct).toBe(100);
    expect(coverage.cashExcluded).toBe(true);
    expect(coverage.unknownCashAccounts).toEqual(["Statement Account"]);
  });
});

describe("coverage banner wording", () => {
  it("says what the percentage is a percentage of", () => {
    expect(coveragePercentBasis({ cashExcluded: false, unknownCashAccounts: [] })).toBe(
      "of the snapshot value"
    );
    expect(coveragePercentBasis({ cashExcluded: true, unknownCashAccounts: [] })).toBe(
      "of the snapshot value outside cash"
    );
    expect(coveragePercentBasis({ cashExcluded: true, unknownCashAccounts: ["Statement Account"] })).toContain(
      "where the snapshot states it"
    );
  });

  it("never claims missing holdings when an unknown cash balance could explain the gap", () => {
    const notes = coverageBannerNotes({
      cashExcluded: false,
      unknownCashAccounts: ["Statement Account"],
      missingAccounts: [],
    }).join(" ");
    expect(notes).toContain("Statement Account");
    expect(notes).toContain("may be cash, not missing holdings");
    expect(notes).toContain("If the gap is not cash");
    expect(notes).not.toContain("missing holdings data");
  });

  it("says cash and cash-equivalent funds are left out of both figures when they are", () => {
    const notes = coverageBannerNotes({
      cashExcluded: true,
      unknownCashAccounts: [],
      missingAccounts: ["Empty Account"],
    });
    expect(notes[0]).toContain("cash and cash-equivalent funds are left out of both figures");
    expect(notes.join(" ")).toContain("Empty Account: no holdings on file.");
    expect(notes[notes.length - 1]).toBe(
      "Import holdings files or re-import statements to close the gap."
    );
  });
});
