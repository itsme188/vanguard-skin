import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { suggestAllocation } from "@/lib/compute/cash-deploy";

const TODAY = "2026-10-07";

describe("cash-deploy allocator money contract", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedThreeHeldUnderweights() {
    const rows = [
      [1, "AAA", "Technology", 100, 10],
      [2, "BBB", "Healthcare", 80, 10],
      [3, "CCC", "Consumer Staples", 60, 10],
      [4, "OVER", "Financials", 500, 10],
    ] as const;
    for (const [id, symbol, sector, price, qty] of rows) {
      db.prepare(
        `INSERT INTO securities (id, symbol, security_type, sector)
         VALUES (?, ?, 'Stock', ?)`
      ).run(id, symbol, sector);
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`).run(id, TODAY, price);
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
         VALUES (1, ?, ?, ?, ?)`
      ).run(id, TODAY, qty, `h-${symbol}`);
    }
    db.prepare("UPDATE settings SET value = ? WHERE key = 'construction_caps_vanguard'").run(
      JSON.stringify({ top1_max: 1 })
    );
    db.prepare("DELETE FROM watchlist").run();
  }

  it("uses held-name fallback picks and allocates an awkward cash amount exactly to the cent", () => {
    seedThreeHeldUnderweights();

    const result = suggestAllocation(db, "vanguard", [1], 10_000.01);

    expect(result.picks.length).toBeGreaterThanOrEqual(3);
    expect(result.picks.every((p) => p.allocationDollars >= 0)).toBe(true);
    expect(new Set(result.picks.map((p) => p.symbol))).toEqual(new Set(["AAA", "BBB", "CCC"]));
    expect(result.picks.every((p) => /Held name/.test(p.rationale))).toBe(true);

    const allocatedCents = result.picks.reduce(
      (sum, p) => sum + Math.round(p.allocationDollars * 100),
      0
    );
    expect(allocatedCents).toBe(1_000_001);
    expect(Math.round(result.totalAllocated * 100)).toBe(1_000_001);
    expect(Math.round(result.cashRemaining * 100)).toBe(0);
  });

  it("does not propose held fallback names outside the selected scope", () => {
    seedThreeHeldUnderweights();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
       VALUES (3, 2, ?, 99, 'other-scope-bbb')`
    ).run(TODAY);
    db.prepare("DELETE FROM holdings WHERE account_id = 1 AND security_id = 2").run();

    const result = suggestAllocation(db, "vanguard", [1], 10_000.01);

    expect(result.picks.map((p) => p.symbol)).not.toContain("BBB");
  });
});
