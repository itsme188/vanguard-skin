import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration system", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  it("creates schema_migrations table", () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    expect(tables).toBeTruthy();
  });

  it("applies all migrations", () => {
    runMigrations(db);
    const applied = db
      .prepare("SELECT COUNT(*) as count FROM schema_migrations")
      .get() as { count: number };
    expect(applied.count).toBeGreaterThanOrEqual(2);
  });

  it("creates all expected tables", () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("accounts");
    expect(names).toContain("securities");
    expect(names).toContain("transactions");
    expect(names).toContain("holdings");
    expect(names).toContain("prices");
    expect(names).toContain("monthly_snapshots");
    expect(names).toContain("tax_lots");
    expect(names).toContain("import_batches");
  });

  it("seeds three accounts", () => {
    runMigrations(db);
    const accounts = db.prepare("SELECT name FROM accounts ORDER BY id").all() as { name: string }[];
    expect(accounts).toEqual([
      { name: "Vanguard Taxable" },
      { name: "Vanguard Roth IRA" },
      { name: "IBKR" },
    ]);
  });

  it("is idempotent — running twice does not fail", () => {
    runMigrations(db);
    runMigrations(db);
    const applied = db
      .prepare("SELECT COUNT(*) as count FROM schema_migrations")
      .get() as { count: number };
    expect(applied.count).toBeGreaterThanOrEqual(2);
  });
});
