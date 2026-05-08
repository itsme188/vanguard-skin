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

  it("041_calendar_enrichment adds enrichment columns", () => {
    runMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(calendar_events)")
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("release_time");
    expect(names).toContain("actual_value");
    expect(names).toContain("consensus_value");
    expect(names).toContain("reaction_snapshot");
    expect(names).toContain("enriched_at");
  });

  it("041_calendar_enrichment creates sector_etf_gaps table", () => {
    runMigrations(db);
    const tbl = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sector_etf_gaps'",
      )
      .get();
    expect(tbl).toBeTruthy();

    // Verify upsert dedup via PRIMARY KEY(symbol, sector)
    db.prepare(
      "INSERT INTO sector_etf_gaps (symbol, sector) VALUES (?, ?)",
    ).run("ACME", "Industrials");
    db.prepare(
      `INSERT INTO sector_etf_gaps (symbol, sector, last_seen_at, count)
       VALUES (?, ?, datetime('now'), 1)
       ON CONFLICT(symbol, sector) DO UPDATE SET
         last_seen_at = datetime('now'),
         count = count + 1`,
    ).run("ACME", "Industrials");
    const row = db
      .prepare("SELECT count FROM sector_etf_gaps WHERE symbol = ?")
      .get("ACME") as { count: number };
    expect(row.count).toBe(2);
  });

  it("048_security_betas creates security_betas table with UNIQUE constraint", () => {
    runMigrations(db);
    const tbl = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='security_betas'",
      )
      .get();
    expect(tbl).toBeTruthy();

    // Verify columns exist
    const cols = db
      .prepare("PRAGMA table_info(security_betas)")
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("security_id");
    expect(names).toContain("lookback_days");
    expect(names).toContain("beta");
    expect(names).toContain("computed_at");

    // Insert a test security first
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)")
      .run("TEST", "Test Security", "Stock");
    const security = db
      .prepare("SELECT id FROM securities WHERE symbol = ?")
      .get("TEST") as { id: number };

    // Insert a beta row
    db.prepare(
      "INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, ?, ?, datetime('now'))",
    ).run(security.id, 60, 1.25);

    // Verify UNIQUE constraint fires on duplicate
    expect(() => {
      db.prepare(
        "INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, ?, ?, datetime('now'))",
      ).run(security.id, 60, 1.5);
    }).toThrow();
  });
});
