import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { purgeExpiredOptionHoldings } from "@/lib/mutations/expired-options";

function seedHolding(
  db: Database.Database,
  symbol: string,
  securityType: string,
  expirationDate: string | null,
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
      `INSERT INTO securities (symbol, security_type, expiration_date)
       VALUES (?, ?, ?) RETURNING id`,
    ).get(symbol, securityType, expirationDate) as { id: number }
  ).id;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, ?, date('now'))`,
  ).run(accountId, securityId, 5);
  return securityId;
}

describe("purgeExpiredOptionHoldings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("deletes holdings for options past expiration with default 1-day grace", () => {
    seedHolding(db, "TLT_STALE", "option", "2026-04-24"); // long expired
    const purged = purgeExpiredOptionHoldings(db);
    expect(purged).toBe(1);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("preserves options whose expiration is in the future", () => {
    seedHolding(db, "AAPL_LIVE", "option", "2099-01-01");
    const purged = purgeExpiredOptionHoldings(db);
    expect(purged).toBe(0);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("preserves yesterday's expirations within the 1-day grace window", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    seedHolding(db, "FRESH_EXPIRE", "option", yesterday);
    const purged = purgeExpiredOptionHoldings(db);
    expect(purged).toBe(0);
  });

  it("never touches non-option securities even with past expiration_date", () => {
    seedHolding(db, "BOND_X", "bond", "2026-04-24");
    const purged = purgeExpiredOptionHoldings(db);
    expect(purged).toBe(0);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("respects a custom grace window", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    seedHolding(db, "OLD_OPT", "option", tenDaysAgo);
    expect(purgeExpiredOptionHoldings(db, 30)).toBe(0); // 30-day grace, still preserved
    expect(purgeExpiredOptionHoldings(db, 5)).toBe(1); // 5-day grace, purged
  });
});
