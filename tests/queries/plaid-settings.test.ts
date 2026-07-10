import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getPlaidConnection,
  setPlaidItem,
  setPlaidAccountMap,
  setPlaidAccountsCache,
  setPlaidConnectionStatus,
  setPlaidLastSyncAt,
  getPlaidReauthAlertedAt,
  setPlaidReauthAlertedAt,
} from "@/lib/queries/plaid-settings";

describe("plaid settings helpers", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns disconnected defaults when nothing stored", () => {
    const c = getPlaidConnection(db);
    expect(c).toEqual({
      accessToken: null,
      itemId: null,
      accountMap: {},
      connectionStatus: "disconnected",
      lastSyncAt: null,
      plaidAccounts: [],
    });
  });

  it("round-trips item, map, cache, status, lastSync", () => {
    setPlaidItem(db, "access-sandbox-123", "item-9");
    setPlaidAccountMap(db, { plaidA: 1, plaidB: 2 });
    setPlaidAccountsCache(db, [
      { id: "plaidA", name: "Brokerage", mask: "1234", subtype: "brokerage" },
    ]);
    setPlaidLastSyncAt(db, "2026-07-10T12:00:00.000Z");
    const c = getPlaidConnection(db);
    expect(c.accessToken).toBe("access-sandbox-123");
    expect(c.itemId).toBe("item-9");
    expect(c.accountMap).toEqual({ plaidA: 1, plaidB: 2 });
    expect(c.plaidAccounts[0].name).toBe("Brokerage");
    expect(c.connectionStatus).toBe("ok");
    expect(c.lastSyncAt).toBe("2026-07-10T12:00:00.000Z");
    setPlaidConnectionStatus(db, "reauth_required");
    expect(getPlaidConnection(db).connectionStatus).toBe("reauth_required");
  });

  it("tolerates malformed JSON map (falls back to empty)", () => {
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('plaid_account_map', 'not-json', datetime('now'))`,
    ).run();
    expect(getPlaidConnection(db).accountMap).toEqual({});
  });

  it("reauth alert stamp round-trips and clears", () => {
    expect(getPlaidReauthAlertedAt(db)).toBeNull();
    setPlaidReauthAlertedAt(db, "2026-07-10T13:00:00.000Z");
    expect(getPlaidReauthAlertedAt(db)).toBe("2026-07-10T13:00:00.000Z");
    setPlaidReauthAlertedAt(db, null);
    expect(getPlaidReauthAlertedAt(db)).toBeNull();
  });
});
