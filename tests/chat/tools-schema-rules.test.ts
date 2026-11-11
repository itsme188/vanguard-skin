/**
 * Tool schemas go to the Anthropic API (Portfolio Assistant plan, Task 5):
 * the provider rejects `maxItems` and any `minItems` above 1, so counts and
 * limits are enforced in code and stated in words. Every `limit` describes its
 * default and maximum; every date parameter names its format; Contract J's
 * income semantics are in the query_income_summary description.
 */
import { describe, it, expect } from "vitest";
import { CHAT_TOOLS } from "@/lib/chat/tools";

type Node = Record<string, unknown>;

function walk(node: unknown, visit: (n: Node, path: string) => void, path = ""): void {
  if (!node || typeof node !== "object") return;
  visit(node as Node, path);
  for (const [k, v] of Object.entries(node as Node)) walk(v, visit, `${path}.${k}`);
}

describe("chat tool schemas", () => {
  it("carry no maxItems and no minItems above 1", () => {
    const bad: string[] = [];
    for (const t of CHAT_TOOLS) {
      walk(t.input_schema, (n, p) => {
        if ("maxItems" in n) bad.push(`${t.name}${p}.maxItems`);
        if (typeof n.minItems === "number" && n.minItems > 1) bad.push(`${t.name}${p}.minItems`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("every limit states its default and maximum", () => {
    const bad: string[] = [];
    for (const t of CHAT_TOOLS) {
      const props = (t.input_schema.properties ?? {}) as Record<string, { description?: string }>;
      const d = props.limit?.description;
      if (d === undefined) continue;
      if (!/default/i.test(d) || !/max \d+/.test(d)) bad.push(`${t.name}: ${d}`);
    }
    expect(bad).toEqual([]);
  });

  it("every date parameter names the YYYY-MM-DD format", () => {
    const bad: string[] = [];
    for (const t of CHAT_TOOLS) {
      const props = (t.input_schema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [k, v] of Object.entries(props)) {
        if (/(_date|week_of)$/.test(k) && !/YYYY-MM-DD/.test(v.description ?? "")) bad.push(`${t.name}.${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("query_income_summary describes the income rules (Contract J)", () => {
    const d = CHAT_TOOLS.find((t) => t.name === "query_income_summary")!.description!;
    expect(d).not.toMatch(/REINVESTMENT transactions are counted as dividend income/);
    expect(d).toMatch(/counts once/);
    expect(d).toMatch(/interest_paid/);
    expect(d).toMatch(/net_income/);
  });
});
