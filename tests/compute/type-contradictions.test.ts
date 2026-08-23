import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  isBondlikeIdentityOnEquityFills,
  scanTypeContradictions,
  type TypeIdentityCandidate,
} from "@/lib/compute/type-contradictions";

/**
 * Pin tests for the shared type-identity contradiction detector (spec:
 * number-trust durable fixes, task 17). scanTypeContradictions preserves
 * the OR-union semantics of scripts/repair-security-type-corruption.ts's
 * pre-extraction detector EXACTLY — these tests mirror that script's own
 * fixture (tests/scripts/repair-security-type-corruption.test.ts) so both
 * files can never drift apart. Uses the full migrated schema (runMigrations
 * seeds Vanguard Taxable=1, Vanguard Roth IRA=2, IBKR=3).
 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("isBondlikeIdentityOnEquityFills — candidate-level (import guard)", () => {
  const bondCandidate: TypeIdentityCandidate = {
    securityType: "Bond",
    name: "S TREASURY NOTE 0 CPN 9.999% DUE 01/15/40",
    derivedMaturity: "2040-01-15",
  };

  it("refuses a Bond identity onto a target with even 1 equity fill (threshold = 1)", () => {
    expect(isBondlikeIdentityOnEquityFills(bondCandidate, 1)).toBe(true);
  });

  it("refuses a Mutual Fund identity (case-insensitive) with fills", () => {
    const candidate: TypeIdentityCandidate = { securityType: "mutual fund", name: null, derivedMaturity: null };
    expect(isBondlikeIdentityOnEquityFills(candidate, 3)).toBe(true);
  });

  it("allows the identity when the target has zero equity fills (legit CUSIP retype)", () => {
    expect(isBondlikeIdentityOnEquityFills(bondCandidate, 0)).toBe(false);
  });

  it("never refuses a non-bondlike incoming type (Stock/ETF), regardless of fill count", () => {
    const stockCandidate: TypeIdentityCandidate = { securityType: "Stock", name: null, derivedMaturity: null };
    expect(isBondlikeIdentityOnEquityFills(stockCandidate, 50)).toBe(false);
    const etfCandidate: TypeIdentityCandidate = { securityType: "ETF", name: null, derivedMaturity: null };
    expect(isBondlikeIdentityOnEquityFills(etfCandidate, 50)).toBe(false);
  });

  it("treats a null incoming securityType as never bondlike", () => {
    const candidate: TypeIdentityCandidate = { securityType: null, name: "whatever", derivedMaturity: null };
    expect(isBondlikeIdentityOnEquityFills(candidate, 100)).toBe(false);
  });
});

describe("scanTypeContradictions — DB-wide audit (OR-union pin)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  function insertBuys(securityId: number, count: number): void {
    const stmt = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
       VALUES (1, ?, '2026-01-05', 'BUY', 10, -100)`
    );
    for (let i = 0; i < count; i++) stmt.run(securityId);
  }

  it("predicate 1: flags a bond-typed security dominated by equity fills; a genuine low-fill fund is not flagged", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type) VALUES (910, 'ZZZ', 'Bond')`
    ).run();
    insertBuys(910, 12);
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type) VALUES (911, 'REALFUND', 'Mutual Fund')`
    ).run();
    insertBuys(911, 1);

    const rows = scanTypeContradictions(db);
    expect(rows).toEqual([
      { securityId: 910, symbol: "ZZZ", securityType: "Bond", equityFills: 12, held: false },
    ]);
  });

  it("predicate 1 floor: exactly 10 fills is NOT flagged; 11 fills IS flagged", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (920, 'TEN', 'Bond')`).run();
    insertBuys(920, 10);
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (921, 'ELEVEN', 'Bond')`).run();
    insertBuys(921, 11);

    const rows = scanTypeContradictions(db);
    expect(rows.map((r) => r.symbol)).toEqual(["ELEVEN"]);
  });

  it("predicate 2: equity-shaped fund_category corroborates a Bond/Mutual Fund type even with zero/low fills; the same fund_category on an ETF is never flagged", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, fund_category)
       VALUES (930, 'MISTYPE', 'Mutual Fund', 'US Sector Equity (Technology)')`
    ).run();
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, fund_category)
       VALUES (931, 'XLZ', 'ETF', 'US Sector Equity (Energy)')`
    ).run();

    const rows = scanTypeContradictions(db);
    expect(rows).toEqual([
      { securityId: 930, symbol: "MISTYPE", securityType: "Mutual Fund", equityFills: 0, held: false },
    ]);
  });

  it("a row matching BOTH predicates appears once, keyed by security id", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, fund_category)
       VALUES (940, 'BOTH', 'Bond', 'US Sector Equity (Technology)')`
    ).run();
    insertBuys(940, 15);

    const rows = scanTypeContradictions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ securityId: 940, equityFills: 15 });
  });

  it("excludeIds removes a hit that would otherwise match either predicate", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (910, 'ZZZ', 'Bond')`).run();
    insertBuys(910, 12);

    expect(scanTypeContradictions(db, { excludeIds: [910] })).toEqual([]);
  });

  it("held: true when the security sits in ANY account's latest holdings with nonzero quantity", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (910, 'ZZZ', 'Bond')`).run();
    insertBuys(910, 12);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (1, 910, 100, '2026-08-20', 'test:holding:910')`
    ).run();

    const rows = scanTypeContradictions(db);
    expect(rows).toEqual([
      { securityId: 910, symbol: "ZZZ", securityType: "Bond", equityFills: 12, held: true },
    ]);
  });

  it("held: false when the security's latest holding row is zero-quantity (closed position)", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (910, 'ZZZ', 'Bond')`).run();
    insertBuys(910, 12);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (1, 910, 0, '2026-08-20', 'test:holding:910-closed')`
    ).run();

    const rows = scanTypeContradictions(db);
    expect(rows[0].held).toBe(false);
  });

  it("returns [] when nothing contradicts", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (950, 'CLEAN', 'Stock')`).run();
    expect(scanTypeContradictions(db)).toEqual([]);
  });
});
