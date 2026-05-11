import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration 051: security_regressions", () => {
  it("creates the security_regressions table with the expected schema + index", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(security_regressions)").all() as Array<{name: string, notnull: number, pk: number}>;
    expect(cols.map((c) => c.name).sort()).toEqual(
      ["benchmark_symbol", "beta", "computed_at_day", "correlation", "data_points", "r_squared", "security_id", "vol"]
    );
    // Composite PK: (security_id, benchmark_symbol, computed_at_day)
    const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pkCols).toEqual(["security_id", "benchmark_symbol", "computed_at_day"]);
    // Index exists
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='security_regressions'").all() as Array<{name: string}>;
    expect(indexes.some((i) => i.name === "idx_security_regressions_lookup")).toBe(true);
  });

  it("composite PK enforces uniqueness on (security_id, benchmark_symbol, computed_at_day)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare("INSERT INTO securities (id, symbol, security_type) VALUES (1, 'AAPL', 'Stock')").run();
    db.prepare("INSERT INTO security_regressions (security_id, benchmark_symbol, computed_at_day, beta) VALUES (1, 'SPY', '2026-05-10', 1.2)").run();
    expect(() =>
      db.prepare("INSERT INTO security_regressions (security_id, benchmark_symbol, computed_at_day, beta) VALUES (1, 'SPY', '2026-05-10', 1.3)").run()
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("allows different benchmark_symbol for same security/day", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare("INSERT INTO securities (id, symbol, security_type) VALUES (1, 'AAPL', 'Stock')").run();
    db.prepare("INSERT INTO security_regressions (security_id, benchmark_symbol, computed_at_day, beta) VALUES (1, 'SPY', '2026-05-10', 1.2)").run();
    db.prepare("INSERT INTO security_regressions (security_id, benchmark_symbol, computed_at_day, beta) VALUES (1, 'QQQ', '2026-05-10', 1.5)").run();
    const count = db.prepare("SELECT COUNT(*) AS n FROM security_regressions").get() as { n: number };
    expect(count.n).toBe(2);
  });
});
