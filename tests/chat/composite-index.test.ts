/**
 * The composite tool registry (Portfolio Assistant plan, Task 6).
 *
 * Protects: Task 8 can register the six tools without changing them. Bound:
 * exactly six names, each with a label, an `account_name` field (so the scope
 * clamp applies) and an API-valid schema (no maxItems, no minItems above 1);
 * the scope-list set holds exactly the four list engines.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  COMPOSITE_CHAT_TOOLS,
  COMPOSITE_SCOPE_LIST_TOOLS,
  isCompositeTool,
  runCompositeTool,
} from "@/lib/chat/composite";
import { CHAT_TOOL_LABELS } from "@/lib/chat/tool-labels";

const NAMES = [
  "query_risk",
  "query_scenarios",
  "query_performance_vs_benchmark",
  "query_realized_gains",
  "query_options_book",
  "query_data_confidence",
];

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

describe("composite tool registry", () => {
  it("defines the six tools, each labelled and carrying account_name", () => {
    expect(COMPOSITE_CHAT_TOOLS.map((t) => t.name)).toEqual(NAMES);
    for (const t of COMPOSITE_CHAT_TOOLS) {
      expect(CHAT_TOOL_LABELS[t.name], t.name).toBeTruthy();
      expect((t.input_schema.properties as Record<string, unknown>).account_name, t.name).toBeTruthy();
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(200);
      expect(isCompositeTool(t.name)).toBe(true);
    }
  });

  it("schemas are valid for the Anthropic API (no maxItems, minItems at most 1)", () => {
    for (const t of COMPOSITE_CHAT_TOOLS) {
      walk(t.input_schema, (o) => {
        expect(o.maxItems, t.name).toBeUndefined();
        if (o.minItems !== undefined) expect(o.minItems as number).toBeLessThanOrEqual(1);
      });
      expect(t.input_schema.type).toBe("object");
    }
  });

  it("marks the list engines, and the whole-portfolio data confidence, as scope-list tools", () => {
    expect([...COMPOSITE_SCOPE_LIST_TOOLS].sort()).toEqual(
      ["query_data_confidence", "query_options_book", "query_performance_vs_benchmark", "query_risk", "query_scenarios"].sort(),
    );
  });

  it("every tool answers an empty scope with the same error, and an unknown name is an error", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    for (const name of NAMES) {
      expect(runCompositeTool(name, db, {}, { accountIds: [], today: "2026-03-02" }), name).toEqual({
        error: "No account is in this chat's scope.",
      });
    }
    expect(runCompositeTool("query_nope", db, {}, { accountIds: undefined, today: "2026-03-02" })).toEqual({
      error: "Unknown composite tool: query_nope",
    });
  });

  it("an engine that throws comes back as a plain error result, never a throw (R6-9)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.close();
    for (const name of NAMES) {
      const out = runCompositeTool(name, db, {}, { accountIds: undefined, today: "2026-03-02" }) as { error?: string };
      expect(out.error, name).toMatch(new RegExp(`^${name} could not run: `));
      expect((out.error ?? "").length, name).toBeLessThanOrEqual(260);
    }
  });
});
