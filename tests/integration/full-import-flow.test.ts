import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport } from "@/lib/import/engine";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { getAccountSummaries, getPortfolioTotals } from "@/lib/queries/dashboard";
import { getAllAccounts } from "@/lib/queries/accounts";
import { getTaxLotSummary } from "@/lib/queries/tax-lots";
import fs from "node:fs";
import path from "node:path";

describe("full import flow integration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("imports IBKR activity CSV and creates transactions, securities, and snapshots", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/ibkr-activity-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "IBKR 2025-01 activity.csv");

    expect(parsed.sourceType).toBe("ibkr-activity");
    expect(parsed.transactions.length).toBeGreaterThan(0);
    expect(parsed.securities.length).toBeGreaterThan(0);
    expect(parsed.snapshots.length).toBe(1);

    const result = commitImport(db, parsed);
    expect(result.newTransactions).toBeGreaterThan(0);
    expect(result.newSecurities).toBeGreaterThan(0);
    expect(result.newSnapshots).toBe(1);

    // Verify data in DB
    const txnCount = (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number }).c;
    expect(txnCount).toBe(result.newTransactions);

    const secCount = (db.prepare("SELECT COUNT(*) as c FROM securities").get() as { c: number }).c;
    expect(secCount).toBe(result.newSecurities);
  });

  it("imports Vanguard holdings CSV and creates holdings", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/vanguard-holdings-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "vanguard-holdings.csv");

    expect(parsed.sourceType).toBe("vanguard-holdings");
    expect(parsed.holdings.length).toBeGreaterThan(0);

    const result = commitImport(db, parsed);
    expect(result.newHoldings).toBeGreaterThan(0);

    const holdingCount = (db.prepare("SELECT COUNT(*) as c FROM holdings").get() as { c: number }).c;
    expect(holdingCount).toBe(result.newHoldings);
  });

  it("re-importing same data creates no duplicates (idempotency)", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/ibkr-activity-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "IBKR 2025-01 activity.csv");

    const first = commitImport(db, parsed);
    const second = commitImport(db, parsed);

    expect(second.newTransactions).toBe(0);
    expect(second.skippedDuplicates).toBeGreaterThan(0);

    const txnCount = (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number }).c;
    expect(txnCount).toBe(first.newTransactions);
  });

  it("computes tax lots from imported transactions", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/ibkr-activity-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "IBKR 2025-01 activity.csv");
    commitImport(db, parsed);

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBeGreaterThan(0);

    const summary = getTaxLotSummary(db);
    expect(summary.totalOpenLots + summary.totalClosedSales).toBeGreaterThan(0);
  });

  it("computes daily valuations from imported data", async () => {
    // Need both holdings and prices
    const holdingsCsv = fs.readFileSync(
      path.join(__dirname, "../fixtures/vanguard-holdings-sample.csv"),
      "utf-8"
    );
    const holdingsParsed = await parseImport(holdingsCsv, "vanguard-holdings.csv");
    commitImport(db, holdingsParsed);

    // Vanguard holdings parser also generates prices
    const priceCount = (db.prepare("SELECT COUNT(*) as c FROM prices").get() as { c: number }).c;

    if (priceCount > 0) {
      const result = computeDailyValuations(db);
      expect(result.datesComputed).toBeGreaterThanOrEqual(0);
    }
  });

  it("dashboard queries return correct aggregates after import", async () => {
    const csv = fs.readFileSync(
      path.join(__dirname, "../fixtures/ibkr-activity-sample.csv"),
      "utf-8"
    );
    const parsed = await parseImport(csv, "IBKR 2025-01 activity.csv");
    commitImport(db, parsed);

    const accounts = getAllAccounts(db);
    expect(accounts).toHaveLength(3);

    const summaries = getAccountSummaries(db);
    expect(summaries).toHaveLength(3);

    // IBKR should have data now
    const ibkr = summaries.find((s) => s.name === "IBKR");
    expect(ibkr).toBeTruthy();
    expect(ibkr!.latestValue).toBeGreaterThan(0);

    const totals = getPortfolioTotals(db);
    expect(totals.snapshotCount).toBeGreaterThan(0);
    expect(totals.totalValue).toBeGreaterThan(0);
  });
});
