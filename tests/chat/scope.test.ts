import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { scopeToAccountName, clampToolInputToScope } from "@/lib/chat/scope";

// Migration 002 seeds: Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// A tool schema that accepts an account_name (like query_holdings).
const ACCOUNT_TOOL = {
  properties: { account_name: { type: "string" }, symbol: { type: "string" } },
};
// A tool schema with no account_name (like query_fred / query_market_snapshot).
const GLOBAL_TOOL = { properties: { series_id: { type: "string" } } };

describe("scopeToAccountName", () => {
  it("resolves single-account scopes to their exact DB account name", () => {
    expect(scopeToAccountName(db, "ibkr")).toBe("IBKR");
    expect(scopeToAccountName(db, "vanguard-taxable")).toBe("Vanguard Taxable");
    expect(scopeToAccountName(db, "vanguard-roth-ira")).toBe("Vanguard Roth IRA");
  });

  it("returns undefined for the all/macro scopes (no clamp)", () => {
    expect(scopeToAccountName(db, "all")).toBeUndefined();
    expect(scopeToAccountName(db, "macro")).toBeUndefined();
  });
});

describe("clampToolInputToScope — hard boundary (U2c)", () => {
  it("OVERRIDES a model-supplied account_name when scoped (the leak fix)", () => {
    // Scoped to Vanguard Taxable, but the model tries to query IBKR.
    const out = clampToolInputToScope(
      { account_name: "Interactive Brokers", symbol: "QQQ" },
      ACCOUNT_TOOL,
      "Vanguard Taxable",
    );
    expect(out.account_name).toBe("Vanguard Taxable");
    expect(out.symbol).toBe("QQQ"); // other inputs preserved
  });

  it("fills a blank account_name with the scope", () => {
    const out = clampToolInputToScope({ symbol: "AAPL" }, ACCOUNT_TOOL, "IBKR");
    expect(out.account_name).toBe("IBKR");
  });

  it("leaves tools without an account_name param untouched", () => {
    const input = { series_id: "DGS10" };
    const out = clampToolInputToScope(input, GLOBAL_TOOL, "Vanguard Taxable");
    expect(out).toEqual({ series_id: "DGS10" });
    expect("account_name" in out).toBe(false);
  });

  it("does NOT clamp when scope is all/macro (scopeAccountName undefined)", () => {
    // In 'all' scope the model may legitimately query any account.
    const out = clampToolInputToScope(
      { account_name: "IBKR", symbol: "QQQ" },
      ACCOUNT_TOOL,
      undefined,
    );
    expect(out.account_name).toBe("IBKR");
  });

  it("does not mutate the original input object", () => {
    const input = { account_name: "IBKR" };
    clampToolInputToScope(input, ACCOUNT_TOOL, "Vanguard Taxable");
    expect(input.account_name).toBe("IBKR");
  });
});
