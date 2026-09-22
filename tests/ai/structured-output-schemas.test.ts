import { describe, it, expect } from "vitest";
import { REVIEW_SCHEMA } from "@/lib/trade-review/generate";
import { FIRST_PASS_OUTPUT_SCHEMA } from "@/lib/print-watch/first-pass-prompt";

// QA: analysis-trade-reviews--generate-review-dies-raw-anthropic-tool-choice-error
//
// lib/ai/generate.ts now asks the Anthropic provider for NATIVE structured
// output (`output_config.format = {type:"json_schema", schema}`) instead of the
// synthetic-json-tool fallback that the Fable/Mythos 5 family rejects. Native
// structured output validates the schema server-side: every object node must
// carry `additionalProperties: false` or the request 400s (project memory:
// "Anthropic schema additionalProperties:false"). The json-tool path was
// lenient about it, so this became load-bearing the moment the mode changed.
//
// Both frontier-tier generateObject callers are pinned here — tradeReviewMain
// (REVIEW_SCHEMA) and printWatchFirstPass (FIRST_PASS_OUTPUT_SCHEMA).

type JsonNode = Record<string, unknown>;

/** Every `{"type": "object"}` node in the tree, with a dotted path for the failure message. */
function objectNodes(node: unknown, path = "$"): Array<{ path: string; node: JsonNode }> {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => objectNodes(child, `${path}[${i}]`));
  }
  if (node === null || typeof node !== "object") return [];
  const obj = node as JsonNode;
  const here = obj.type === "object" ? [{ path, node: obj }] : [];
  const children = Object.entries(obj).flatMap(([key, value]) =>
    objectNodes(value, `${path}.${key}`),
  );
  return [...here, ...children];
}

/** Unwrap the AI SDK `jsonSchema()` wrapper down to the raw JSON Schema. */
function rawSchema(schema: unknown): unknown {
  const wrapped = schema as { jsonSchema?: unknown };
  return wrapped?.jsonSchema ?? schema;
}

function nodesMissingFlag(schema: unknown): string[] {
  return objectNodes(rawSchema(schema))
    .filter(({ node }) => node.additionalProperties !== false)
    .map(({ path }) => path);
}

describe("structured-output schemas", () => {
  it("REVIEW_SCHEMA sets additionalProperties:false on every object node", () => {
    const nodes = objectNodes(rawSchema(REVIEW_SCHEMA));
    expect(nodes.length).toBeGreaterThan(1); // root + the trade_grades item
    expect(nodesMissingFlag(REVIEW_SCHEMA)).toEqual([]);
  });

  it("FIRST_PASS_OUTPUT_SCHEMA sets additionalProperties:false on every object node", () => {
    const nodes = objectNodes(FIRST_PASS_OUTPUT_SCHEMA);
    expect(nodes.length).toBeGreaterThan(1); // root + cited lines + callout items
    expect(nodesMissingFlag(FIRST_PASS_OUTPUT_SCHEMA)).toEqual([]);
  });

  it("the walker actually catches a missing flag (guards against a vacuous pass)", () => {
    const bad = {
      type: "object",
      additionalProperties: false,
      properties: { inner: { type: "object", properties: { a: { type: "string" } } } },
    };
    expect(nodesMissingFlag(bad)).toEqual(["$.properties.inner"]);
  });
});
