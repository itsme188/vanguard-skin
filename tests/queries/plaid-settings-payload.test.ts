import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildPlaidSettingsPayload } from "@/lib/queries/plaid-settings-payload";
import { setPlaidItem, setPlaidAccountsCache } from "@/lib/queries/plaid-settings";

describe("buildPlaidSettingsPayload", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // Migration 002 already seeds 3 default accounts (Vanguard Taxable,
    // Vanguard Roth IRA, IBKR) — OR IGNORE so this stays a no-op collision
    // rather than a UNIQUE constraint failure, matching the convention used
    // across tests/queries/*.test.ts.
    db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
  });

  it("reports disconnected shape with local accounts", () => {
    const p = buildPlaidSettingsPayload(db);
    expect(p.connected).toBe(false);
    expect(p.connectionStatus).toBe("disconnected");
    expect(p.localAccounts.length).toBeGreaterThanOrEqual(1);
    expect(p.localAccounts[0]).toHaveProperty("id");
    expect(p.localAccounts[0]).toHaveProperty("name");
    expect(p.accountMap).toEqual({});
    expect(p.plaidAccounts).toEqual([]);
    expect(typeof p.configured).toBe("boolean");
  });

  it("reports connected shape", () => {
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountsCache(db, [{ id: "pA", name: "Brokerage", mask: null, subtype: null }]);
    const p = buildPlaidSettingsPayload(db);
    expect(p.connected).toBe(true);
    expect(p.plaidAccounts[0].name).toBe("Brokerage");
  });
});
