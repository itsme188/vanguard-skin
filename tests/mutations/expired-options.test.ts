import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { purgeExpiredOptionHoldings } from "@/lib/mutations/expired-options";

function seedHolding(
  db: Database.Database,
  symbol: string,
  securityType: string,
  expirationDate: string | null,
  opts: { accountName?: string; sourceKey?: string; asOfDate?: string } = {},
): number {
  const accountId = (
    db.prepare(
      `INSERT INTO accounts (name) VALUES (?)
       ON CONFLICT(name) DO UPDATE SET name = name
       RETURNING id`,
    ).get(opts.accountName ?? `acct-${symbol}`) as { id: number }
  ).id;
  const securityId = (
    db.prepare(
      `INSERT INTO securities (symbol, security_type, expiration_date)
       VALUES (?, ?, ?) RETURNING id`,
    ).get(symbol, securityType, expirationDate) as { id: number }
  ).id;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, 5, opts.asOfDate ?? "2026-07-10", opts.sourceKey ?? null);
  return securityId;
}

function accountId(db: Database.Database, name: string): number {
  return (db.prepare(`SELECT id FROM accounts WHERE name = ?`).get(name) as { id: number }).id;
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

  // A holdings row is a claim "on as_of_date, this account held Q of X". For a
  // contract that expired AFTER the snapshot date that claim is true history,
  // and the statement is its audit trail — the same principle
  // scripts/retire-expired-option-holdings.ts states ("statement rows stay as
  // the audit trail — unlike purgeExpiredOptionHoldings, an unscoped delete").
  // Live views do not need the delete to hide an expired contract: every
  // held-universe reader filters it at read time via liveOptionExpirationSql.
  // Regression: a monthly statement import run after one of its month-end
  // option positions had expired lost that position out of the month-end
  // snapshot (October 2026 IBKR import, run four days after month-end).
  it("never deletes a statement-sourced row for a contract that expired after that snapshot date", () => {
    seedHolding(db, "IWM   261102C00283000", "option", "2026-11-02", {
      accountName: "IBKR",
      sourceKey: "ibkr:pos:2026-10-31:IWM   261102C00283000",
      asOfDate: "2026-10-31",
    });

    const purged = purgeExpiredOptionHoldings(db, 1, { today: "2026-11-04" });

    expect(purged).toBe(0);
    const remaining = db
      .prepare(`SELECT as_of_date FROM holdings`)
      .all() as { as_of_date: string }[];
    expect(remaining.map((r) => r.as_of_date)).toEqual(["2026-10-31"]);
  });

  it("still deletes a live-sync row for an expired contract, statement row kept", () => {
    const securityId = seedHolding(db, "IWM   261102C00283001", "option", "2026-11-02", {
      accountName: "IBKR2",
      sourceKey: "ibkr:pos:2026-10-31:IWM   261102C00283001",
      asOfDate: "2026-10-31",
    });
    const acct = accountId(db, "IBKR2");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(acct, securityId, 5, "2026-11-03", "tws-IBKR2-2026-11-03");

    const purged = purgeExpiredOptionHoldings(db, 1, { today: "2026-11-04" });

    expect(purged).toBe(1);
    const remaining = db
      .prepare(`SELECT as_of_date, source_key FROM holdings ORDER BY as_of_date`)
      .all() as { as_of_date: string; source_key: string }[];
    expect(remaining).toEqual([
      { as_of_date: "2026-10-31", source_key: "ibkr:pos:2026-10-31:IWM   261102C00283001" },
    ]);
  });

  it("scoped Plaid mode deletes only live-origin rows in the synced account, using explicit ET today", () => {
    seedHolding(db, "ZZA   260703P00010000", "option", "2026-07-03", {
      accountName: "Taxable",
      sourceKey: "plaid:1:1:2026-07-10",
    });
    seedHolding(db, "ZZB   260703P00010000", "option", "2026-07-03", {
      accountName: "Other",
      sourceKey: "plaid:2:2:2026-07-10",
    });
    seedHolding(db, "ZZC   260703P00010000", "option", "2026-07-03", {
      accountName: "Taxable",
      sourceKey: "vanguard-pdf:holding:1:3:2026-06-30",
    });
    seedHolding(db, "ZZD   260710P00010000", "option", "2026-07-10", {
      accountName: "Taxable",
      sourceKey: "plaid:1:4:2026-07-10",
    });

    const purged = purgeExpiredOptionHoldings(db, 1, {
      accountId: accountId(db, "Taxable"),
      liveOnly: true,
      today: "2026-07-10",
    });

    expect(purged).toBe(1);
    const remaining = db
      .prepare(
        `SELECT s.symbol, h.source_key
           FROM holdings h JOIN securities s ON s.id = h.security_id
          ORDER BY s.symbol`,
      )
      .all() as { symbol: string; source_key: string }[];
    expect(remaining.map((r) => r.symbol)).toEqual([
      "ZZB   260703P00010000",
      "ZZC   260703P00010000",
      "ZZD   260710P00010000",
    ]);
  });
});
