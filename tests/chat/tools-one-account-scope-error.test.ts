/**
 * Eight chat tools read one account at a time. Handed a scope word that
 * covers two or more accounts they refuse rather than pick one, and the
 * refusal must be something the model can act on: one top-level `{ error }`
 * sentence, naming the accounts and telling the model to call once per exact
 * account name. The system prompt carries the matching instruction (call
 * once per account, combine the answers).
 *
 * Seven of the eight end the sentence the same way: omitting account_name
 * gives every account. query_trade_reviews is the exception, because for it
 * omitting the name gives its DEFAULT account (IBKR), never every account,
 * so its sentence says that instead (2026-10-09).
 *
 * The account names are the ones migration 002 seeds, plus one synthetic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";

const ONE_ACCOUNT_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["query_holdings", {}],
  ["query_allocation", { group_by: "sector" }],
  ["query_tax_lots", {}],
  ["query_transactions", {}],
  ["query_performance", {}],
  ["query_income_summary", {}],
  ["query_market_snapshot", {}],
  ["query_trade_reviews", {}],
];

/** The engines of these two take an id list, so they answer a wide scope whole. */
const SCOPE_LIST_TOOLS = ["query_twr", "query_options_greeks"];

const THE_SENTENCE =
  '"ibkr" names 2 accounts ("IBKR", "IBKR Two") and this tool reads one account at a time. ' +
  "Call it once per account with the exact account name, or omit account_name for every account.";

/** query_trade_reviews: omitting the name gives its default account, not every account. */
const TRADE_REVIEWS_SENTENCE =
  '"ibkr" names 2 accounts ("IBKR", "IBKR Two") and this tool reads one account at a time. ' +
  "Call it once per account with the exact account name, or omit account_name for the IBKR account.";

const sentenceFor = (tool: string): string =>
  tool === "query_trade_reviews" ? TRADE_REVIEWS_SENTENCE : THE_SENTENCE;

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Migration 002 seeds Vanguard Taxable, Vanguard Roth IRA and IBKR.
  db.prepare("INSERT INTO accounts (name) VALUES ('IBKR Two')").run();
});

describe("a one-account chat tool handed a scope of several accounts", () => {
  it("the eight tools plus the two list tools are every tool that declares account_name", () => {
    const declared = CHAT_TOOLS.filter(
      (t) => (t.input_schema.properties as Record<string, unknown> | undefined)?.account_name,
    ).map((t) => t.name);
    expect(declared.sort()).toEqual(
      [...ONE_ACCOUNT_TOOLS.map(([name]) => name), ...SCOPE_LIST_TOOLS].sort(),
    );
  });

  it("all eight answer with one sentence, at the top level, and no data", async () => {
    for (const [tool, base] of ONE_ACCOUNT_TOOLS) {
      const result = await executeTool(db, tool, { ...base, account_name: "ibkr" });
      expect(result, tool).toEqual({ error: sentenceFor(tool) });
    }
  });

  it("query_trade_reviews never says that omitting the name gives every account", async () => {
    for (const scope of ["ibkr", "vanguard"]) {
      if (scope === "vanguard") db.prepare("INSERT INTO accounts (name) VALUES ('Vanguard Taxable Two')").run();
      const result = (await executeTool(db, "query_trade_reviews", { account_name: scope })) as { error: string };
      expect(result.error).not.toContain("every account");
      expect(result.error).toMatch(/or omit account_name for the IBKR account\.$/);
    }
    // And the advice is true: with no name the tool reads the IBKR account.
    const omitted = (await executeTool(db, "query_trade_reviews", {})) as { error?: string };
    expect(omitted.error).toBeUndefined();
  });

  it("query_trade_reviews does not advise omitting the name when its default is itself ambiguous", async () => {
    // No account is named exactly "IBKR": the default falls to the ibkr scope,
    // which holds two accounts, so "omit account_name" would loop.
    db.prepare("UPDATE accounts SET name = 'IBKR One' WHERE name = 'IBKR'").run();
    const expected =
      '"ibkr" names 2 accounts ("IBKR One", "IBKR Two") and this tool reads one account at a time. ' +
      "Call it once per account with the exact account name.";
    expect(await executeTool(db, "query_trade_reviews", { account_name: "ibkr" })).toEqual({ error: expected });
  });

  it("the sentence names every account of the scope, whatever the scope word", async () => {
    db.prepare("INSERT INTO accounts (name) VALUES ('Vanguard Taxable Two')").run();
    const texts = new Set<string>();
    for (const [tool, base] of ONE_ACCOUNT_TOOLS) {
      if (tool === "query_trade_reviews") continue; // its own ending, pinned above
      const result = (await executeTool(db, tool, { ...base, account_name: "vanguard" })) as {
        error?: string;
        data?: unknown;
      };
      expect(result.data, tool).toBeUndefined();
      texts.add(result.error ?? "");
    }
    expect([...texts]).toEqual([
      '"vanguard" names 2 accounts ("Vanguard Taxable", "Vanguard Taxable Two") and this tool reads one account at a time. ' +
        "Call it once per account with the exact account name, or omit account_name for every account.",
    ]);
  });

  it("each exact account name the sentence lists is then accepted", async () => {
    for (const name of ["IBKR", "IBKR Two"]) {
      for (const [tool, base] of ONE_ACCOUNT_TOOLS) {
        if (tool === "query_market_snapshot") continue; // would fetch live quotes
        const result = (await executeTool(db, tool, { ...base, account_name: name })) as {
          error?: string;
        };
        expect(result.error, `${tool} / ${name}`).toBeUndefined();
      }
    }
  });
});

describe("the system prompt tells the model what to do with that error", () => {
  const RULE =
    "When a tool answers with an error saying a name covers several accounts and the tool reads one account at a time, call that tool once per account, using each exact account name the error lists, and combine the answers yourself.";

  it("every portfolio scope carries the instruction", () => {
    for (const scope of ["all", "ibkr", "vanguard-taxable", "vanguard-roth-ira"] as const) {
      expect(buildSystemPrompt("## Portfolio Summary", "2026-03-17", scope), scope).toContain(RULE);
    }
  });

  it("the instruction quotes the words the tool error uses", () => {
    expect(THE_SENTENCE).toContain("reads one account at a time");
    expect(RULE).toContain("reads one account at a time");
    expect(RULE).toContain("once per account");
    expect(THE_SENTENCE).toContain("once per account");
  });
});
