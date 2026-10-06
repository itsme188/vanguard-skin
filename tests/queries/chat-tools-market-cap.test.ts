// tests/queries/chat-tools-market-cap.test.ts
//
// Pins the READ-side fix for getAllocationBreakdown('market_cap_category')
// (lib/queries/chat-tools.ts), a sibling of the Analysis Diagnostics fix in
// tests/queries/analysis-market-cap-vocabulary.test.ts
// [qa:analysis-market-cap--duplicate-size-buckets-and-tilts]. Before this
// fix, standardColumns.market_cap_category read the raw column
// (`COALESCE(s.market_cap_category, 'Unknown')`) with no normalization and
// no `NULLIF(..., 'null')` guard, so the chat allocation tool answered with
// "Large" as a bucket separate from "Large Cap" (same exposure, split in
// two) AND a security carrying the literal string "null" became its own
// "null" bucket instead of folding into "Unknown".
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationBreakdown } from "@/lib/queries/chat-tools";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSecurity(symbol: string, marketCap: string | null): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, market_cap_category)
       VALUES (?, ?, 'Stock', ?)`
    )
    .run(symbol, `${symbol} Inc`, marketCap).lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, quantity: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-06-01', 'test:' || ?)"
  ).run(accountId, securityId, quantity, securityId);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-06-01', 'test')"
  ).run(securityId, price);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getAllocationBreakdown('market_cap_category') normalizes vocabulary", () => {
  it("merges a legacy bare 'Small' label into the canonical 'Small Cap' bucket", () => {
    const account = seedAccount("Test");
    const canonical = seedSecurity("SMB", "Small Cap"); // $1000
    const legacy = seedSecurity("SMA", "Small"); // $500
    seedHolding(account, canonical, 10);
    seedHolding(account, legacy, 5);
    seedPrice(canonical, 100);
    seedPrice(legacy, 100);

    const result = getAllocationBreakdown(db, "market_cap_category");
    const byName = new Map(result.map((r) => [r.group_name, r]));

    expect(byName.has("Small")).toBe(false);
    expect(byName.get("Small Cap")?.total_market_value).toBeCloseTo(1500, 0);
    expect(byName.get("Small Cap")?.position_count).toBe(2);
  });

  it("folds the literal string 'null' into Unknown instead of its own 'null' bucket", () => {
    const account = seedAccount("Test");
    const literalNull = seedSecurity("NUL", "null");
    seedHolding(account, literalNull, 10);
    seedPrice(literalNull, 100);

    const result = getAllocationBreakdown(db, "market_cap_category");
    const byName = new Map(result.map((r) => [r.group_name, r]));

    expect(byName.has("null")).toBe(false);
    expect(byName.get("Unknown")?.total_market_value).toBeCloseTo(1000, 0);
  });

  it("a true NULL market_cap_category also folds into Unknown", () => {
    const account = seedAccount("Test");
    const trueNull = seedSecurity("UNK", null);
    seedHolding(account, trueNull, 10);
    seedPrice(trueNull, 100);

    const result = getAllocationBreakdown(db, "market_cap_category");
    const byName = new Map(result.map((r) => [r.group_name, r]));

    expect(byName.get("Unknown")?.total_market_value).toBeCloseTo(1000, 0);
  });
});

describe("whitespace-only market_cap_category (SQL twin agrees with the JS normalizer)", () => {
  it("folds '   ' and '' into Unknown, as normalizeMarketCapCategory returns null", () => {
    const account = seedAccount("Test");
    const ws = seedSecurity("WSP", "   ");
    const empty = seedSecurity("EMP", "");
    seedHolding(account, ws, 10);
    seedHolding(account, empty, 10);
    seedPrice(ws, 100);
    seedPrice(empty, 100);

    const result = getAllocationBreakdown(db, "market_cap_category");
    expect(result.map((r) => r.group_name)).toEqual(["Unknown"]);
    expect(result[0].total_market_value).toBeCloseTo(2000, 0);
  });
});

describe("getAllocationBreakdown('sector') agrees with the Analysis bucket SQL", () => {
  it("buckets a sector-less bond as Fixed Income and a blank sector via fund_category/Unknown", () => {
    const account = seedAccount("Test");
    const bond = db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('BND1', 'Bond', 'Bond')")
      .run().lastInsertRowid as number;
    seedHolding(account, bond, 10);
    seedPrice(bond, 100);

    const names = getAllocationBreakdown(db, "sector").map((r) => r.group_name);
    expect(names).toContain("Fixed Income");
    expect(names).not.toContain("Unknown");
  });
});
