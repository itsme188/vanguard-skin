import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getCrossAccountPositions } from "@/lib/digest/send-earnings-email";

/**
 * B7 revert-lock: `getCrossAccountPositions` filters holdings on
 * `h.quantity != 0` (not `h.quantity > 0`) so short positions surface in
 * earnings preview/recap emails. The prompt-level test
 * (earnings-prompt-no-dollar-leak.test.ts) constructs its context directly
 * and never calls this function, so a regex-level revert to `> 0` would
 * stay green there. This test is the DB-backed guard.
 */
describe("getCrossAccountPositions quantity filter (B7)", () => {
  let db: Database.Database;

  function seedAccount(name: string): number {
    return (
      db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(name) as {
        id: number;
      }
    ).id;
  }

  function seedStock(symbol: string): number {
    return (
      db
        .prepare(
          `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
           VALUES (?, 'stock', 'equity', 1) RETURNING id`,
        )
        .get(symbol) as { id: number }
    ).id;
  }

  function seedHolding(opts: {
    accountId: number;
    securityId: number;
    quantity: number;
    asOfDate: string;
  }): void {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      opts.accountId,
      opts.securityId,
      opts.quantity,
      opts.asOfDate,
      `test:${opts.accountId}:${opts.securityId}:${opts.asOfDate}`,
    );
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns short + long positions but excludes a zero-quantity holding", () => {
    const securityId = seedStock("TER");

    const shortAccount = seedAccount("ibkr");
    seedHolding({
      accountId: shortAccount,
      securityId,
      quantity: -300,
      asOfDate: "2026-07-01",
    });

    const longAccount = seedAccount("vanguard taxable");
    seedHolding({
      accountId: longAccount,
      securityId,
      quantity: 500,
      asOfDate: "2026-07-01",
    });

    const zeroAccount = seedAccount("roth");
    seedHolding({
      accountId: zeroAccount,
      securityId,
      quantity: 0,
      asOfDate: "2026-07-01",
    });

    const positions = getCrossAccountPositions(db, ["TER"]);

    expect(positions).toHaveLength(2);
    const byAccount = new Map(positions.map((p) => [p.account_name, p.quantity]));
    expect(byAccount.get("ibkr")).toBe(-300);
    expect(byAccount.get("vanguard taxable")).toBe(500);
    expect(byAccount.has("roth")).toBe(false);
  });
});
