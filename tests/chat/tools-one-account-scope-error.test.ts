/**
 * Eight chat tools read one account at a time. Handed a scope word that
 * covers two or more accounts they refuse rather than pick one, and the
 * refusal must be something the model can act on: one identical top-level
 * `{ error }` sentence for all eight, naming the accounts and telling the
 * model to call once per exact account name. The system prompt carries the
 * matching instruction (call once per account, combine the answers).
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

  it("all eight answer with the same one sentence, at the top level, and no data", async () => {
    for (const [tool, base] of ONE_ACCOUNT_TOOLS) {
      const result = await executeTool(db, tool, { ...base, account_name: "ibkr" });
      expect(result, tool).toEqual({ error: THE_SENTENCE });
    }
  });

  it("the sentence names every account of the scope, whatever the scope word", async () => {
    db.prepare("INSERT INTO accounts (name) VALUES ('Vanguard Taxable Two')").run();
    const texts = new Set<string>();
    for (const [tool, base] of ONE_ACCOUNT_TOOLS) {
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
