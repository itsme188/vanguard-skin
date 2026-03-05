import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";

describe("upsertSecurity", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("inserts new security and returns id", () => {
    const id = upsertSecurity(db, "VTI", "Vanguard Total Market", "etf", "US Equity");
    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(id) as any;
    expect(row.symbol).toBe("VTI");
    expect(row.name).toBe("Vanguard Total Market");
    expect(row.security_type).toBe("etf");
    expect(row.asset_class).toBe("US Equity");
  });

  it("returns existing id for duplicate symbol", () => {
    const id1 = upsertSecurity(db, "VTI", "Vanguard Total Market");
    const id2 = upsertSecurity(db, "VTI", "Vanguard Total Market");
    expect(id1).toBe(id2);

    // Should only have one row
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM securities WHERE symbol = 'VTI'").get() as any
    ).c;
    expect(count).toBe(1);
  });

  it("enriches metadata on re-insert (COALESCE behavior)", () => {
    // First insert with just symbol
    const id1 = upsertSecurity(db, "BND");

    const row1 = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(id1) as any;
    expect(row1.name).toBeNull();
    expect(row1.security_type).toBeNull();

    // Second insert adds name and type
    const id2 = upsertSecurity(db, "BND", "Vanguard Total Bond", "bond");
    expect(id2).toBe(id1);

    const row2 = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(id2) as any;
    expect(row2.name).toBe("Vanguard Total Bond");
    expect(row2.security_type).toBe("bond");
  });

  it("does not overwrite existing metadata with null", () => {
    upsertSecurity(db, "AAPL", "Apple Inc", "stock", "US Equity");
    // Re-insert with only symbol — should NOT clear existing data
    upsertSecurity(db, "AAPL");

    const row = db
      .prepare("SELECT * FROM securities WHERE symbol = 'AAPL'")
      .get() as any;
    expect(row.name).toBe("Apple Inc");
    expect(row.security_type).toBe("stock");
    expect(row.asset_class).toBe("US Equity");
  });
});
