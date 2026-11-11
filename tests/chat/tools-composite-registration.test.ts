/**
 * Plan Task 8, part A: the six composite read tools are registered in
 * CHAT_TOOLS and run through the SAME dispatcher path as every other tool
 * (input check, account resolution, the single-account scope guard,
 * annotations, no escaping exception). The tool list is built once in a fixed
 * order, because the route's prompt-cache mark sits on the LAST tool by
 * position and must not move between requests.
 *
 * Synthetic in-memory database (migration 002 seeds Vanguard Taxable 1,
 * Vanguard Roth IRA 2, IBKR 3) with one small IBKR holding.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { COMPOSITE_CHAT_TOOLS } from "@/lib/chat/composite";
import { todayET } from "@/lib/calendar/date-utils";

const SIX = [
  "query_risk",
  "query_scenarios",
  "query_performance_vs_benchmark",
  "query_realized_gains",
  "query_options_book",
  "query_data_confidence",
];

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZQR', 'ZQR Corp', 'stock', 'USD')")
    .run().lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (3, ?, 10, 100, ?, 'r1')",
  ).run(id, todayET());
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 12)").run(id, todayET());
});

type Result = { error?: string; data?: unknown; data_freshness?: unknown; quality_warnings?: unknown };

describe("registration", () => {
  it("the six are in CHAT_TOOLS, after the base tools, in the composite module's order", () => {
    const names = CHAT_TOOLS.map((t) => t.name);
    expect(names.slice(-6)).toEqual(SIX);
    expect(COMPOSITE_CHAT_TOOLS.map((t) => t.name)).toEqual(SIX);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(33);
  });

  it("two builds of the tool list are identical in order and content", async () => {
    vi.resetModules();
    const again = (await import("@/lib/chat/tools")).CHAT_TOOLS;
    const shape = (list: typeof CHAT_TOOLS) =>
      JSON.stringify(list.map(({ toModelOutput: _t, ...rest }) => rest));
    expect(again.map((t) => t.name)).toEqual(CHAT_TOOLS.map((t) => t.name));
    expect(shape(again)).toBe(shape(CHAT_TOOLS));
    expect(again[again.length - 1].name).toBe("query_data_confidence");
  });
});

describe("each composite tool through executeTool", () => {
  for (const tool of SIX) {
    it(`${tool}: all accounts`, async () => {
      const r = (await executeTool(db, tool, {})) as Result;
      expect(r.error, tool).toBeUndefined();
      expect(r.data, tool).toBeDefined();
      expect(r.data_freshness, tool).toBeDefined();
    });

    it(`${tool}: clamped single-account chat`, async () => {
      const r = (await executeTool(db, tool, { account_name: "IBKR" }, { scopeAccountIds: [3] })) as Result;
      if (tool === "query_data_confidence") {
        // Whole-portfolio only (P3): never another account's reasons.
        expect(r.error).toBeDefined();
        expect(r.data).toBeUndefined();
      } else {
        expect(r.error, tool).toBeUndefined();
        expect(JSON.stringify(r.data)).not.toContain("Vanguard");
      }
    });

    it(`${tool}: a scope with no account`, async () => {
      const r = (await executeTool(db, tool, {}, { scopeAccountIds: [] })) as Result;
      expect(r).toEqual({ error: "No account is in this chat's scope." });
    });

    it(`${tool}: a model-supplied account outside the chat's scope is refused`, async () => {
      const r = (await executeTool(db, tool, { account_name: "Vanguard Taxable" }, { scopeAccountIds: [3] })) as Result;
      expect(r.error).toMatch(/outside this chat's scope/);
    });

    it(`${tool}: a wrong-typed input is an error naming the parameter`, async () => {
      const r = (await executeTool(db, tool, { account_name: 12345 })) as Result;
      expect(r.error).toMatch(/"account_name" must be a string/);
    });
  }

  it("an aborted call starts no composite", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await executeTool(db, "query_risk", {}, { abortSignal: ac.signal })).toEqual({ error: "Cancelled." });
  });
});
