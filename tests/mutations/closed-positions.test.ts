import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { purgeClosedOptionHoldings } from "@/lib/mutations/closed-positions";

function seedAccount(db: Database.Database, name: string): number {
  return (
    db
      .prepare(
        `INSERT INTO accounts (name) VALUES (?)
         ON CONFLICT(name) DO UPDATE SET name = name
         RETURNING id`,
      )
      .get(name) as { id: number }
  ).id;
}

function seedOptionSecurity(db: Database.Database, symbol: string): number {
  return (
    db
      .prepare(
        `INSERT INTO securities (symbol, security_type, expiration_date)
         VALUES (?, 'option', '2099-01-01') RETURNING id`,
      )
      .get(symbol) as { id: number }
  ).id;
}

function seedStockSecurity(db: Database.Database, symbol: string): number {
  return (
    db
      .prepare(
        `INSERT INTO securities (symbol, security_type)
         VALUES (?, 'stock') RETURNING id`,
      )
      .get(symbol) as { id: number }
  ).id;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, ?, date('now', '-30 days'))`,
  ).run(accountId, securityId, quantity);
}

function seedTxn(
  db: Database.Database,
  accountId: number,
  securityId: number,
  type: string,
  quantity: number,
  daysAgo: number,
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, type, quantity, trade_date, source_key)
     VALUES (?, ?, ?, ?, date('now', ?), ?)`,
  ).run(
    accountId,
    securityId,
    type,
    quantity,
    `-${daysAgo} days`,
    `t:${accountId}:${securityId}:${type}:${daysAgo}`,
  );
}

describe("purgeClosedOptionHoldings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("deletes the holdings row when long calls were fully closed via SELL_TO_CLOSE", () => {
    const acct = seedAccount(db, "ibkr");
    const sec = seedOptionSecurity(db, "SHOP  270115C00180000");
    seedHolding(db, acct, sec, 2);
    seedTxn(db, acct, sec, "BUY_TO_OPEN", 1, 200);
    seedTxn(db, acct, sec, "BUY_TO_OPEN", 1, 195);
    seedTxn(db, acct, sec, "SELL_TO_CLOSE", 2, 30);

    const purged = purgeClosedOptionHoldings(db);
    expect(purged).toBe(1);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("preserves the holdings row when the position is partially open", () => {
    const acct = seedAccount(db, "ibkr");
    const sec = seedOptionSecurity(db, "AAPL  270115C00200000");
    seedHolding(db, acct, sec, 2);
    seedTxn(db, acct, sec, "BUY_TO_OPEN", 3, 60);
    seedTxn(db, acct, sec, "SELL_TO_CLOSE", 1, 30);

    const purged = purgeClosedOptionHoldings(db);
    expect(purged).toBe(0);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("deletes when a written short call was bought to close", () => {
    const acct = seedAccount(db, "ibkr");
    const sec = seedOptionSecurity(db, "SPY   260620C00600000");
    seedHolding(db, acct, sec, -1);
    seedTxn(db, acct, sec, "SELL_TO_OPEN", 1, 60);
    seedTxn(db, acct, sec, "BUY_TO_CLOSE", 1, 30);

    const purged = purgeClosedOptionHoldings(db);
    expect(purged).toBe(1);
  });

  it("preserves still-open long puts (no closing transactions)", () => {
    const acct = seedAccount(db, "ibkr");
    const sec = seedOptionSecurity(db, "TLT   271231P00080000");
    seedHolding(db, acct, sec, 5);
    seedTxn(db, acct, sec, "BUY_TO_OPEN", 5, 60);

    const purged = purgeClosedOptionHoldings(db);
    expect(purged).toBe(0);
  });

  it("never touches non-option securities even with closing-shaped transactions", () => {
    const acct = seedAccount(db, "vanguard");
    const sec = seedStockSecurity(db, "PSTG");
    seedHolding(db, acct, sec, 100);
    seedTxn(db, acct, sec, "BUY", 100, 200);
    seedTxn(db, acct, sec, "SELL", 100, 30);

    const purged = purgeClosedOptionHoldings(db);
    expect(purged).toBe(0);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM holdings").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("scopes deletion to the (account, security) pair — same option in another account is preserved", () => {
    const ibkr = seedAccount(db, "ibkr");
    const roth = seedAccount(db, "roth");
    const sec = seedOptionSecurity(db, "QQQ   270618C00450000");

    // ibkr: opened + closed (should delete)
    seedHolding(db, ibkr, sec, 2);
    seedTxn(db, ibkr, sec, "BUY_TO_OPEN", 2, 60);
    seedTxn(db, ibkr, sec, "SELL_TO_CLOSE", 2, 30);

    // roth: still open (should preserve)
    seedHolding(db, roth, sec, 1);
    seedTxn(db, roth, sec, "BUY_TO_OPEN", 1, 60);

    const purged = purgeClosedOptionHoldings(db);
    expect(purged).toBe(1);
    const remaining = db
      .prepare("SELECT account_id FROM holdings ORDER BY account_id")
      .all() as Array<{ account_id: number }>;
    expect(remaining).toEqual([{ account_id: roth }]);
  });

  it("does NOT delete options with no transaction history (defensive guard against empty HAVING)", () => {
    const acct = seedAccount(db, "ibkr");
    const sec = seedOptionSecurity(db, "ORPHAN_OPT");
    seedHolding(db, acct, sec, 3);
    // No transactions at all.

    const purged = purgeClosedOptionHoldings(db);
    expect(purged).toBe(0);
  });
});
