// tests/queries/analysis-null-string-category.test.ts
//
// Pins the guard against the literal string "null" stored in classification
// columns. The AI classify prompt's enums include a `null` token
// ("Large|Mid|Small|null"), so the model sometimes returns the STRING "null";
// pre-fix it was written verbatim and getAllocationByDimension rendered a
// category row literally labeled "null" alongside "Unknown" (deep-QA finding
// analysis-classification--market-cap-style-renders-literal-null-row).
// Reader-side NULLIF folds those rows into 'Unknown'; the write boundary in
// classifyUnresolvedWithClaude normalizes new values via cleanEnumValue.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationByDimension } from "@/lib/queries/analysis";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSecurity(
  symbol: string,
  opts: {
    market_cap_category?: string | null;
    style?: string | null;
    geography?: string | null;
  } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities
         (symbol, name, security_type, market_cap_category, style, geography, multiplier)
       VALUES (?, ?, 'Stock', ?, ?, ?, 1)`
    )
    .run(
      symbol,
      `${symbol} Inc`,
      opts.market_cap_category ?? null,
      opts.style ?? null,
      opts.geography ?? null
    ).lastInsertRowid as number;
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

describe("literal 'null' string in classification columns", () => {
  it("buckets market_cap_category='null' rows into Unknown, never a 'null' row", () => {
    const acct = seedAccount("Test");
    const poisoned = seedSecurity("BAD", { market_cap_category: "null" });
    const classified = seedSecurity("AAPL", { market_cap_category: "Large" });
    seedHolding(acct, poisoned, 10);
    seedHolding(acct, classified, 10);
    seedPrice(poisoned, 59.5);
    seedPrice(classified, 100);

    const result = getAllocationByDimension(db, "market_cap_category");
    const groups = result.map((r) => r.group_name);
    expect(groups).not.toContain("null");
    expect(groups).toContain("Unknown");
    expect(groups).toContain("Large");
    const unknown = result.find((r) => r.group_name === "Unknown")!;
    expect(unknown.total_market_value).toBeCloseTo(595, 0);
  });

  it("buckets style='null' rows into Unknown", () => {
    const acct = seedAccount("Test");
    const poisoned = seedSecurity("BAD", { style: "null" });
    seedHolding(acct, poisoned, 1);
    seedPrice(poisoned, 100);

    const groups = getAllocationByDimension(db, "style").map((r) => r.group_name);
    expect(groups).not.toContain("null");
    expect(groups).toContain("Unknown");
  });

  it("buckets geography='null' rows into Unknown", () => {
    const acct = seedAccount("Test");
    const poisoned = seedSecurity("BAD", { geography: "null" });
    seedHolding(acct, poisoned, 1);
    seedPrice(poisoned, 100);

    const groups = getAllocationByDimension(db, "geography").map((r) => r.group_name);
    expect(groups).not.toContain("null");
    expect(groups).toContain("Unknown");
  });
});
