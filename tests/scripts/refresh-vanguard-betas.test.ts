import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { refreshVanguardBetas } from "@/scripts/refresh-vanguard-betas";
import { getCachedBeta } from "@/lib/queries/security-betas";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // runMigrations seeds accounts: 'Vanguard Taxable', 'Vanguard Roth IRA', 'IBKR'
  runMigrations(db);
  return db;
}

function getAccountId(db: Database.Database, name: string): number {
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }
  ).id;
}

/**
 * Generate synthetic prices that produce a non-trivial, deterministic beta.
 * Pattern: price[i] = base + i * trend + sin(i) * amplitude
 */
function seedPrices(
  db: Database.Database,
  securityId: number,
  days: number,
  base: number = 100,
  trend: number = 0.1,
  amplitude: number = 5
): void {
  const startDate = new Date("2025-01-01");
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const price = base + i * trend + Math.sin(i) * amplitude;
    db.prepare(
      "INSERT OR IGNORE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
    ).run(securityId, dateStr, price);
  }
}

describe("refreshVanguardBetas", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Migration 002 seeds: 'Vanguard Taxable', 'Vanguard Roth IRA', 'IBKR'
  });

  it("computes betas for held Vanguard securities with sufficient history", async () => {
    // Use the pre-seeded 'Vanguard Taxable' account (migration 002)
    const acctId = getAccountId(db, "Vanguard Taxable");

    // Insert VTI security and SPY (benchmark)
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('VTI', 'Vanguard Total Market ETF', 'ETF')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();

    const vtiId = (db.prepare("SELECT id FROM securities WHERE symbol = 'VTI'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    // Hold VTI in the Vanguard Taxable account
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 100)"
    ).run(acctId, vtiId, today);

    // 65 days of prices for both (65 days → 64 return pairs, well above the 30 minimum)
    seedPrices(db, vtiId, 65, 200, 0.15, 8); // VTI: correlated with SPY but with noise
    seedPrices(db, spyId, 65, 400, 0.1, 5);  // SPY: benchmark

    const result = await refreshVanguardBetas(db);

    expect(result.computed).toBe(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    const beta = getCachedBeta(db, vtiId, 60);
    expect(beta).not.toBeNull();
    expect(beta).toBeGreaterThan(0);
  });

  it("skips securities with fewer than 30 days of price history", async () => {
    const acctId = getAccountId(db, "Vanguard Taxable");

    // NEW security — will only get 20 days of prices (below 30 minimum)
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('NEW', 'New Security', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();

    const newId = (db.prepare("SELECT id FROM securities WHERE symbol = 'NEW'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 50)"
    ).run(acctId, newId, today);

    // 65 days SPY but only 20 days for NEW — far below the 30 minimum
    seedPrices(db, spyId, 65, 400, 0.1, 5);
    seedPrices(db, newId, 20, 50, 0.05, 2);

    const result = await refreshVanguardBetas(db);

    expect(result.computed).toBe(0);
    expect(result.skipped).toContain("NEW");
    expect(result.errors).toHaveLength(0);

    const beta = getCachedBeta(db, newId, 60);
    expect(beta).toBeNull();
  });

  it("skips IBKR and Roth holdings — only processes Vanguard Taxable", async () => {
    // Use pre-seeded 'IBKR' and 'Vanguard Roth IRA' accounts (migration 002)
    const ibkrId = getAccountId(db, "IBKR");
    const rothId = getAccountId(db, "Vanguard Roth IRA");

    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('TSLA', 'Tesla Inc', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();

    const tslaId = (db.prepare("SELECT id FROM securities WHERE symbol = 'TSLA'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    // TSLA held in both IBKR and Roth — neither is a Vanguard (non-Roth) account
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 10)"
    ).run(ibkrId, tslaId, today);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 5)"
    ).run(rothId, tslaId, today);

    // 65 days prices for both — sufficient history if the scope were wrong
    seedPrices(db, tslaId, 65, 250, 0.3, 12);
    seedPrices(db, spyId, 65, 400, 0.1, 5);

    const result = await refreshVanguardBetas(db);

    // No Vanguard (non-Roth) account holdings → nothing to process
    expect(result.computed).toBe(0);
    expect(result.errors).toHaveLength(0);

    const beta = getCachedBeta(db, tslaId, 60);
    expect(beta).toBeNull();
  });
});
