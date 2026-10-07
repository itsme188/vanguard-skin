// Two chat read rules:
//  1. getHoldingsForChat drops an option past its expiration day (ET), in
//     both stored date spellings, through the shared option-expiry helper.
//  2. The open-lots long-term flag agrees with the engine's
//     isLongTermHolding for a lot acquired on Feb 29.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsForChat, getTaxLotsForChat } from "@/lib/queries/chat-tools";
import { isLongTermHolding } from "@/lib/compute/tax-lots";

let db: Database.Database;
let acct: number;

beforeEach(() => {
  vi.useFakeTimers();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run();
  acct = (db.prepare("SELECT id FROM accounts WHERE name='Test'").get() as { id: number }).id;
});

afterEach(() => {
  vi.useRealTimers();
});

function seedSecurity(symbol: string, type: string, expiration: string | null, multiplier = 1): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date) VALUES (?, ?, ?, ?, ?)"
    )
    .run(symbol, symbol, type, multiplier, expiration).lastInsertRowid as number;
}

function seedHolding(securityId: number, quantity: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, 100, '2026-06-08', ?)`
  ).run(acct, securityId, quantity, `test:${securityId}`);
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-06-08', 10, 't')").run(
    securityId
  );
}

describe("getHoldingsForChat — expired options", () => {
  beforeEach(() => {
    // 2026-06-10 16:00Z == 2026-06-10 12:00 ET.
    vi.setSystemTime(new Date("2026-06-10T16:00:00Z"));
    seedHolding(seedSecurity("AAA", "Stock", null), 10);
    seedHolding(seedSecurity("AAA 260609C00100000", "Option", "2026-06-09", 100), 1);
    seedHolding(seedSecurity("AAA 260609P00100000", "OPTION", "20260609", 100), 1);
    seedHolding(seedSecurity("AAA 260610C00100000", "Option", "2026-06-10", 100), 1);
    seedHolding(seedSecurity("AAA 260610P00100000", "option", "20260610", 100), 1);
    seedHolding(seedSecurity("AAA 260619C00100000", "Option", "2026-06-19", 100), -1);
  });

  it("excludes an option that expired yesterday, in the dashed and the compact spelling", () => {
    const symbols = getHoldingsForChat(db, { includeShorts: true }).map((h) => h.symbol);
    expect(symbols).not.toContain("AAA 260609C00100000");
    expect(symbols).not.toContain("AAA 260609P00100000");
  });

  it("keeps an option expiring today, a later one, and the stock", () => {
    const symbols = getHoldingsForChat(db, { includeShorts: true }).map((h) => h.symbol);
    expect(symbols).toContain("AAA");
    expect(symbols).toContain("AAA 260610C00100000");
    expect(symbols).toContain("AAA 260610P00100000");
    expect(symbols).toContain("AAA 260619C00100000");
  });

  it("leaves the expired contracts out of the weight denominator", () => {
    const rows = getHoldingsForChat(db);
    // Long book: stock 10 x 10 = 100, two live long options 1 x 10 x 100 each.
    const total = rows.reduce((sum, h) => sum + (h.position_weight_pct ?? 0), 0);
    expect(rows).toHaveLength(3);
    expect(total).toBeCloseTo(100, 5);
  });

  it("uses the ET calendar day, not the UTC day", () => {
    // 2026-06-10 02:00Z is still 2026-06-09 in New York: yesterday's
    // contracts are on their expiration day and stay listed.
    vi.setSystemTime(new Date("2026-06-10T02:00:00Z"));
    const symbols = getHoldingsForChat(db, { includeShorts: true }).map((h) => h.symbol);
    expect(symbols).toContain("AAA 260609C00100000");
    expect(symbols).toContain("AAA 260609P00100000");
  });
});

describe("getTaxLotsForChat — a lot acquired on Feb 29", () => {
  function seedLeapLot(): void {
    const sec = seedSecurity("ZZZ", "Stock", null);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2025-02-27', 10, 't')").run(sec);
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, '2024-02-29', 10, 5, 5, 50)`
    ).run(acct, sec);
  }

  // The engine's rule is the reference: each day's flag must equal it.
  for (const today of ["2025-02-28", "2025-03-01", "2025-03-02"]) {
    it(`is_long_term on ${today} matches isLongTermHolding`, () => {
      vi.setSystemTime(new Date(`${today}T17:00:00Z`));
      seedLeapLot();
      const [lot] = getTaxLotsForChat(db, { status: "open" });
      expect(lot.is_long_term).toBe(isLongTermHolding("2024-02-29", today));
    });
  }

  it("turns long-term on March 1 and names that day as the long-term date", () => {
    vi.setSystemTime(new Date("2025-03-01T17:00:00Z"));
    seedLeapLot();
    const [lot] = getTaxLotsForChat(db, { status: "open" });
    expect(lot.is_long_term).toBe(true);
    expect(lot.long_term_date).toBe("2025-03-01");
  });

  it("an ordinary date keeps the day after the anniversary", () => {
    vi.setSystemTime(new Date("2025-03-01T17:00:00Z"));
    const sec = seedSecurity("YYY", "Stock", null);
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, '2024-03-01', 10, 5, 5, 50)`
    ).run(acct, sec);
    const [lot] = getTaxLotsForChat(db, { status: "open" });
    expect(lot.is_long_term).toBe(false);
    expect(lot.long_term_date).toBe("2025-03-02");
  });
});
