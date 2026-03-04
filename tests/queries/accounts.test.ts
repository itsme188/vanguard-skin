import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllAccounts, getAccountByName } from "@/lib/queries/accounts";

describe("account queries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns all three seeded accounts", () => {
    const accounts = getAllAccounts(db);
    expect(accounts).toHaveLength(3);
    expect(accounts.map((a) => a.name)).toEqual([
      "Vanguard Taxable",
      "Vanguard Roth IRA",
      "IBKR",
    ]);
  });

  it("finds account by name", () => {
    const account = getAccountByName(db, "IBKR");
    expect(account).toBeTruthy();
    expect(account!.name).toBe("IBKR");
  });

  it("returns null for unknown account", () => {
    const account = getAccountByName(db, "Unknown");
    expect(account).toBeNull();
  });
});
