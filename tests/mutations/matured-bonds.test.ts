import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { purgeMaturedBondHoldings } from "@/lib/mutations/matured-bonds";

function seedHolding(
  db: Database.Database,
  symbol: string,
  securityType: string,
  maturityDate: string | null,
): number {
  const accountId = (
    db.prepare(
      `INSERT INTO accounts (name) VALUES (?)
       ON CONFLICT(name) DO UPDATE SET name = name
       RETURNING id`,
    ).get(`acct-${symbol}`) as { id: number }
  ).id;
  const securityId = (
    db.prepare(
      `INSERT INTO securities (symbol, security_type, maturity_date)
       VALUES (?, ?, ?) RETURNING id`,
    ).get(symbol, securityType, maturityDate) as { id: number }
  ).id;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, ?, date('now'))`,
  ).run(accountId, securityId, 10);
  return securityId;
}

describe("purgeMaturedBondHoldings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("deletes holdings for bonds past maturity with default 1-day grace", () => {
    seedHolding(db, "TBILL_STALE", "bond", "2026-04-14"); // long matured
    const purged = purgeMaturedBondHoldings(db);
    expect(purged).toBe(1);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("preserves bonds whose maturity is in the future", () => {
    seedHolding(db, "TBOND_LIVE", "bond", "2099-01-01");
    const purged = purgeMaturedBondHoldings(db);
    expect(purged).toBe(0);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("preserves yesterday's maturity within the 1-day grace window", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    seedHolding(db, "FRESH_MATURE", "bond", yesterday);
    const purged = purgeMaturedBondHoldings(db);
    expect(purged).toBe(0);
  });

  it("never touches non-bond securities even with past maturity_date", () => {
    seedHolding(db, "OPT_X", "option", "2026-04-14");
    const purged = purgeMaturedBondHoldings(db);
    expect(purged).toBe(0);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("respects a custom grace window", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    seedHolding(db, "OLD_BOND", "bond", tenDaysAgo);
    expect(purgeMaturedBondHoldings(db, 30)).toBe(0); // 30-day grace, still preserved
    expect(purgeMaturedBondHoldings(db, 5)).toBe(1); // 5-day grace, purged
  });

  it("preserves bonds with no maturity_date (defensive null guard)", () => {
    seedHolding(db, "NO_MATURITY", "bond", null);
    const purged = purgeMaturedBondHoldings(db);
    expect(purged).toBe(0);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(1);
  });
});
