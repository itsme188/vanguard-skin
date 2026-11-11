import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { scopeToAccountName, clampToolInputToScope, resolveChatScope } from "@/lib/chat/scope";

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
// A tool schema with no account_name (like query_fred). query_market_snapshot
// used to be listed here; since 2026-10-08 its rows carry account, quantity
// and value, so it takes an account_name and IS clamped (pinned against the
// real schema in tests/chat/tools-snapshot-scope-and-twr-window.test.ts).
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

// ─── Portfolio Assistant plan: scope as an id list (P1, P2, P10) ───────────


function ids(db: Database.Database, scope: Parameters<typeof resolveChatScope>[1]): number[] | string {
  const r = resolveChatScope(db, scope);
  return r.kind === "accounts" ? r.accounts.map((a) => a.id).sort((x, y) => x - y) : r.kind;
}

describe("resolveChatScope", () => {
  it("all and macro read every account", () => {
    expect(ids(db, "all")).toBe("all");
    expect(ids(db, "macro")).toBe("all");
  });

  it("each single-account scope resolves to its id list through its scope word", () => {
    expect(ids(db, "ibkr")).toEqual([3]);
    expect(ids(db, "vanguard-taxable")).toEqual([1]);
    expect(ids(db, "vanguard-roth-ira")).toEqual([2]);
  });

  it("accounts named IBKR and IBKR Two both stay in the IBKR scope", () => {
    // P10: resolveChatAccounts tries the exact name "IBKR" first, which would
    // collapse the scope to one account. The scope word must win here.
    const two = db.prepare("INSERT INTO accounts (name) VALUES ('IBKR Two')").run().lastInsertRowid as number;
    expect(ids(db, "ibkr")).toEqual([3, two]);
  });

  it("the taxable scope never includes the Roth", () => {
    expect(ids(db, "vanguard-taxable")).not.toContain(2);
  });

  it("an unresolvable scope reads no account", () => {
    db.prepare("DELETE FROM accounts WHERE name = 'IBKR'").run();
    expect(ids(db, "ibkr")).toBe("none");
    // never widened to the whole book
    expect(scopeToAccountName(db, "ibkr")).toBe("ibkr");
  });
});

describe("clampToolInputToScope with the scope's id list (P2)", () => {
  it("a two-account IBKR scope keeps a narrower account and forces any other", () => {
    const two = db.prepare("INSERT INTO accounts (name) VALUES ('IBKR Two')").run().lastInsertRowid as number;
    const scopeIds = [3, two];
    const clampName = scopeToAccountName(db, "ibkr");
    // Several accounts in scope: the forced value is the scope word, so a
    // one-account tool answers with the per-account error instead of
    // quietly reading one account.
    expect(clampName).toBe("ibkr");

    const narrower = clampToolInputToScope({ account_name: "IBKR Two" }, ACCOUNT_TOOL, clampName, {
      db,
      accountIds: scopeIds,
    });
    expect(narrower.account_name).toBe("IBKR Two");

    const other = clampToolInputToScope({ account_name: "Vanguard Taxable" }, ACCOUNT_TOOL, clampName, {
      db,
      accountIds: scopeIds,
    });
    expect(other.account_name).toBe("ibkr");

    const widened = clampToolInputToScope({ account_name: "all" }, ACCOUNT_TOOL, clampName, {
      db,
      accountIds: scopeIds,
    });
    expect(widened.account_name).toBe("ibkr");

    const ambiguous = clampToolInputToScope({ account_name: "Vanguard" }, ACCOUNT_TOOL, clampName, {
      db,
      accountIds: scopeIds,
    });
    expect(ambiguous.account_name).toBe("ibkr");

    const blank = clampToolInputToScope({}, ACCOUNT_TOOL, clampName, { db, accountIds: scopeIds });
    expect(blank.account_name).toBe("ibkr");
  });

  it("with one account in scope the clamp always forces (unchanged)", () => {
    const out = clampToolInputToScope({ account_name: "IBKR" }, ACCOUNT_TOOL, "Vanguard Taxable", {
      db,
      accountIds: [1],
    });
    expect(out.account_name).toBe("Vanguard Taxable");
  });
});
