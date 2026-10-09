/**
 * How a chat tool reads the model-supplied `account_name`.
 *
 * Defect: the tools took the FIRST substring match. With two accounts that
 * share a brand word, one of them a Roth, the bare word "vanguard" resolved
 * to the Roth, so a question about "my Vanguard account" in an all-accounts
 * chat was answered with Roth figures. The project rule is that the scope
 * word "vanguard" EXCLUDES the Roth.
 *
 * Order of precedence now: an exact account name; a scope word, read as the
 * dashboard's scope selector reads it; a fragment that matches exactly one
 * account; otherwise a plain error that lists what the model may pass.
 *
 * Synthetic tickers and round invented figures only. The account names are
 * the ones migration 002 seeds (two sharing a brand word, one a Roth).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, resolveAccountName, CHAT_TOOLS } from "@/lib/chat/tools";
import { resolveChatAccounts, CHAT_SCOPE_WORDS } from "@/lib/chat/account-scope";
import { getHoldingsForChat } from "@/lib/queries/chat-tools";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";
import { resolveScope } from "@/lib/queries/accounts";
import { todayET } from "@/lib/calendar/date-utils";

// Migration 002 seeds Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).
const TAXABLE = 1;
const ROTH = 2;
const IBKR = 3;

let db: Database.Database;

function seedStock(symbol: string): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier)
       VALUES (?, ?, 'stock', 'equity', 'USD', 1)`,
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, quantity: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(accountId, securityId, quantity, todayET(), `h-${accountId}-${securityId}`);
  db.prepare(
    `INSERT OR IGNORE INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'test')`,
  ).run(securityId, todayET());
}

function seedSnapshot(
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  deposits: number | null = null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, source, deposits_withdrawals)
     VALUES (?, ?, ?, 'canonical', ?)`,
  ).run(accountId, monthEndDate, totalValue, deposits);
}

function addAccount(name: string): number {
  return db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name).lastInsertRowid as number;
}

type Rows = { error?: string; data?: Array<{ symbol: string; account_name: string }> };

async function holdingSymbols(accountName?: string): Promise<string[]> {
  const input: Record<string, unknown> = {};
  if (accountName !== undefined) input.account_name = accountName;
  const result = (await executeTool(db, "query_holdings", input)) as Rows;
  expect(result.error).toBeUndefined();
  return result.data!.map((h) => h.symbol).sort();
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // One distinct ticker per account, so a result names its account.
  seedHolding(TAXABLE, seedStock("ZZA"), 10);
  seedHolding(ROTH, seedStock("ZZB"), 20);
  seedHolding(IBKR, seedStock("ZZC"), 30);

  seedSnapshot(TAXABLE, "2025-03-31", 70000);
  seedSnapshot(TAXABLE, "2025-04-30", 70700, 500);
  seedSnapshot(ROTH, "2025-03-31", 20000);
  seedSnapshot(ROTH, "2025-04-30", 20400);
  seedSnapshot(IBKR, "2025-03-31", 100000);
  seedSnapshot(IBKR, "2025-04-30", 134640, 30000);
});

describe("resolveChatAccounts: precedence", () => {
  const ids = (name: string | undefined) => {
    const r = resolveChatAccounts(db, name);
    return r.kind === "accounts" ? r.accounts.map((a) => a.id) : r.kind;
  };

  it("no name, a blank name and the word 'all' are every account", () => {
    expect(ids(undefined)).toBe("all");
    expect(ids("")).toBe("all");
    expect(ids("  ")).toBe("all");
    expect(ids("all")).toBe("all");
    expect(ids("ALL")).toBe("all");
  });

  it("an exact account name is that one account, in any letter case", () => {
    expect(ids("Vanguard Roth IRA")).toEqual([ROTH]);
    expect(ids("vanguard roth ira")).toEqual([ROTH]);
    expect(ids("Vanguard Taxable")).toEqual([TAXABLE]);
    expect(ids("VANGUARD TAXABLE")).toEqual([TAXABLE]);
    expect(ids("IBKR")).toEqual([IBKR]);
  });

  it("a scope word resolves exactly as the dashboard's scope selector does", () => {
    for (const word of CHAT_SCOPE_WORDS) {
      if (word === "all") continue;
      expect(ids(word)).toEqual(resolveScope(db, word));
      expect(ids(word.toUpperCase())).toEqual(resolveScope(db, word));
    }
    expect(ids("vanguard")).toEqual([TAXABLE]);
    expect(ids("Vanguard")).toEqual([TAXABLE]);
    expect(ids("roth")).toEqual([ROTH]);
    expect(ids("ibkr")).toEqual([IBKR]);
  });

  it("a scope word keeps its whole list when it names two accounts", () => {
    const two = addAccount("IBKR Two");
    expect(ids("ibkr")).toEqual([IBKR, two]);
    // The exact name still means that one account.
    expect(ids("IBKR")).toEqual([IBKR]);
    expect(ids("IBKR Two")).toEqual([two]);
  });

  it("a fragment is accepted only when it matches exactly one account", () => {
    expect(ids("taxable")).toEqual([TAXABLE]);
    expect(ids("Roth IRA")).toEqual([ROTH]);
    expect(ids("guard")).toBe("error");
    expect(ids("a")).toBe("error");
  });

  it("an ambiguous or unknown name is an error that lists what may be passed", () => {
    for (const name of ["guard", "no such account"]) {
      const r = resolveChatAccounts(db, name);
      expect(r.kind).toBe("error");
      if (r.kind !== "error") continue;
      expect(r.error).toContain(name);
      for (const account of ["Vanguard Taxable", "Vanguard Roth IRA", "IBKR"]) {
        expect(r.error).toContain(account);
      }
      for (const word of CHAT_SCOPE_WORDS) expect(r.error).toContain(word);
    }
    const ambiguous = resolveChatAccounts(db, "guard");
    expect(ambiguous.kind === "error" && ambiguous.error).toMatch(/more than one account/);
    const unknown = resolveChatAccounts(db, "no such account");
    expect(unknown.kind === "error" && unknown.error).toMatch(/No account/);
  });

  it("a scope word that names no account is an error, never the whole book", () => {
    db.prepare("DELETE FROM holdings WHERE account_id = ?").run(IBKR);
    db.prepare("DELETE FROM monthly_snapshots WHERE account_id = ?").run(IBKR);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(IBKR);
    expect(ids("ibkr")).toBe("error");
  });
});

describe("resolveAccountName (the scoped chat's resolver)", () => {
  it("returns the exact name for the three scope hints the chat route passes", () => {
    expect(resolveAccountName(db, "IBKR")).toBe("IBKR");
    expect(resolveAccountName(db, "Vanguard Taxable")).toBe("Vanguard Taxable");
    expect(resolveAccountName(db, "Vanguard Roth IRA")).toBe("Vanguard Roth IRA");
    expect(resolveAccountName(db, undefined)).toBeUndefined();
  });

  it("the bare brand word is the non-Roth account, never the first match", () => {
    expect(resolveAccountName(db, "vanguard")).toBe("Vanguard Taxable");
    expect(resolveAccountName(db, "roth")).toBe("Vanguard Roth IRA");
  });

  it("an ambiguous or unknown name comes back unchanged, so it matches no account downstream", () => {
    expect(resolveAccountName(db, "guard")).toBe("guard");
    expect(resolveAccountName(db, "no such account")).toBe("no such account");
  });
});

describe("tools that take account_name", () => {
  it("'vanguard' never returns Roth figures", async () => {
    expect(await holdingSymbols("vanguard")).toEqual(["ZZA"]);
    expect(await holdingSymbols("Vanguard")).toEqual(["ZZA"]);
  });

  it("'roth' returns only the Roth, 'ibkr' only IBKR, an exact name that account", async () => {
    expect(await holdingSymbols("roth")).toEqual(["ZZB"]);
    expect(await holdingSymbols("ibkr")).toEqual(["ZZC"]);
    expect(await holdingSymbols("Vanguard Roth IRA")).toEqual(["ZZB"]);
    expect(await holdingSymbols("Vanguard Taxable")).toEqual(["ZZA"]);
  });

  it("no name and 'all' are the whole book", async () => {
    expect(await holdingSymbols()).toEqual(["ZZA", "ZZB", "ZZC"]);
    expect(await holdingSymbols("all")).toEqual(["ZZA", "ZZB", "ZZC"]);
  });

  it("an exact name returns byte-identical rows to the direct single-account query", async () => {
    for (const name of ["Vanguard Taxable", "Vanguard Roth IRA", "IBKR"]) {
      const result = (await executeTool(db, "query_holdings", { account_name: name })) as {
        data: Array<Record<string, unknown>>;
      };
      const direct = getHoldingsForChat(db, { account_name: name, includeShorts: true }).map(
        (h) => ({ ...h, position_side: h.quantity < 0 ? "short" : "long" }),
      );
      expect(JSON.stringify(result.data)).toBe(JSON.stringify(direct));
    }
  });

  const ACCOUNT_TOOLS: Array<[string, Record<string, unknown>]> = [
    ["query_holdings", {}],
    ["query_allocation", { group_by: "sector" }],
    ["query_tax_lots", {}],
    ["query_transactions", {}],
    ["query_performance", {}],
    ["query_income_summary", {}],
    ["query_twr", { period: "inception" }],
    ["query_trade_reviews", {}],
    ["query_options_greeks", {}],
    ["query_market_snapshot", {}],
  ];

  it("the list above is every tool that declares account_name", () => {
    const declared = CHAT_TOOLS.filter(
      (t) => (t.input_schema.properties as Record<string, unknown> | undefined)?.account_name,
    ).map((t) => t.name);
    expect(declared.sort()).toEqual(ACCOUNT_TOOLS.map(([name]) => name).sort());
  });

  it("every one of them answers an ambiguous or unknown name with the error, not with data", async () => {
    for (const [tool, base] of ACCOUNT_TOOLS) {
      for (const name of ["guard", "no such account"]) {
        const result = (await executeTool(db, tool, { ...base, account_name: name })) as {
          error?: string;
          data?: unknown;
        };
        expect(result.error, `${tool} / ${name}`).toBeDefined();
        expect(result.data, `${tool} / ${name}`).toBeUndefined();
        expect(result.error).toContain("Vanguard Taxable");
        expect(result.error).toContain("vanguard");
      }
    }
  });

  it("every parameter description tells the model it may pass an exact name or a scope word", () => {
    for (const [tool] of ACCOUNT_TOOLS) {
      const schema = CHAT_TOOLS.find((t) => t.name === tool)!.input_schema.properties as Record<
        string,
        { description: string }
      >;
      const text = schema.account_name.description;
      expect(text, tool).toContain("exact account name");
      for (const word of CHAT_SCOPE_WORDS) expect(text, tool).toContain(`'${word}'`);
    }
  });

  it("a one-account tool given a scope of two accounts names them and picks neither", async () => {
    addAccount("IBKR Two");
    const oneAccountTools = ACCOUNT_TOOLS.filter(
      ([tool]) => tool !== "query_twr" && tool !== "query_options_greeks",
    );
    for (const [tool, base] of oneAccountTools) {
      const result = (await executeTool(db, tool, { ...base, account_name: "ibkr" })) as {
        error?: string;
        data?: unknown;
      };
      expect(result.error, tool).toContain("IBKR Two");
      expect(result.error, tool).toMatch(/one account at a time/);
      expect(result.data, tool).toBeUndefined();
    }
    // The exact name still works.
    expect(await holdingSymbols("IBKR")).toEqual(["ZZC"]);
  });

  it("query_trade_reviews given a name that resolves to no single account answers with a top-level error listing the names", async () => {
    for (const name of ["all", "ALL"]) {
      const result = (await executeTool(db, "query_trade_reviews", { account_name: name })) as {
        error?: string;
        data?: unknown;
      };
      expect(result.data, name).toBeUndefined();
      expect(result.error, name).toMatch(/one account at a time/);
      expect(result.error, name).toContain('"Vanguard Taxable"');
      expect(result.error, name).toContain('"IBKR"');
    }
  });

  it("query_trade_reviews without a name still defaults to the IBKR account", async () => {
    const result = (await executeTool(db, "query_trade_reviews", {})) as {
      error?: string;
      data?: { reviews: unknown[]; totalReviews: number };
    };
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ reviews: [], totalReviews: 0 });
  });
});

describe("query_twr: both returns and the window describe the same scope", () => {
  interface TwrAnswer {
    error?: string;
    data: {
      window: { end_date: string };
      twr: ReturnType<typeof computeTwr>;
      xirr: ReturnType<typeof computeXirr>;
    };
  }
  const run = async (name?: string) =>
    (await executeTool(db, "query_twr", {
      period: "inception",
      ...(name === undefined ? {} : { account_name: name }),
    })) as TwrAnswer;

  it("'vanguard' is the taxable account for both returns, never the Roth", async () => {
    const got = await run("vanguard");
    expect(JSON.stringify(got.data.twr)).toBe(JSON.stringify(computeTwr(db, { accountId: TAXABLE })));
    expect(JSON.stringify(got.data.xirr)).toBe(
      JSON.stringify(computeXirr(db, { accountId: TAXABLE })),
    );
    expect(got.data.twr!.perAccount.map((a) => a.accountId)).toEqual([TAXABLE]);
  });

  it("an exact name returns exactly what the single-id engines return", async () => {
    for (const [name, id] of [
      ["Vanguard Taxable", TAXABLE],
      ["Vanguard Roth IRA", ROTH],
      ["IBKR", IBKR],
      ["roth", ROTH],
    ] as Array<[string, number]>) {
      const got = await run(name);
      expect(JSON.stringify(got.data.twr)).toBe(JSON.stringify(computeTwr(db, { accountId: id })));
      expect(JSON.stringify(got.data.xirr)).toBe(JSON.stringify(computeXirr(db, { accountId: id })));
    }
  });

  it("a scope of two accounts gives one time-weighted and one money-weighted return over both", async () => {
    const two = addAccount("IBKR Two");
    seedSnapshot(two, "2025-03-31", 50000);
    seedSnapshot(two, "2025-04-30", 48675);

    const got = await run("ibkr");
    const scope = [IBKR, two];
    expect(JSON.stringify(got.data.twr)).toBe(JSON.stringify(computeTwr(db, { accountIds: scope })));
    expect(JSON.stringify(got.data.xirr)).toBe(
      JSON.stringify(computeXirr(db, { accountIds: scope })),
    );
    expect(got.data.twr!.perAccount.map((a) => a.accountId)).toEqual(scope);
    expect(got.data.xirr!.perAccount.map((a) => a.accountId)).toEqual(scope);
    // Not the first account alone.
    expect(got.data.twr!.totalReturn).not.toBeCloseTo(
      computeTwr(db, { accountId: IBKR })!.totalReturn,
      6,
    );
  });

  it("an unknown name is an error, never the whole portfolio's return", async () => {
    const got = await run("no such account");
    expect(got.error).toMatch(/No account/);
    expect(got.data).toBeUndefined();
  });
});

describe("query_options_greeks reads the whole named scope", () => {
  it("an unknown name is an error, never the whole book's Greeks", async () => {
    const result = (await executeTool(db, "query_options_greeks", {
      account_name: "no such account",
    })) as { error?: string; data?: unknown };
    expect(result.error).toMatch(/No account/);
    expect(result.data).toBeUndefined();
  });

  it("a scope of two accounts is accepted (the engine takes an id list)", async () => {
    addAccount("IBKR Two");
    const result = (await executeTool(db, "query_options_greeks", { account_name: "ibkr" })) as {
      error?: string;
      data?: unknown;
    };
    expect(result.error).toBeUndefined();
    expect(result.data).toBeDefined();
  });
});
