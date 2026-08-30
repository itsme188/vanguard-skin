import { describe, it, expect } from "vitest";
import { extractJsonArray, parseJsonArrayLenient } from "@/lib/ai/extract-json";

describe("extractJsonArray", () => {
  it("returns a bare JSON array unchanged", () => {
    expect(extractJsonArray('[{"a":1}]')).toBe('[{"a":1}]');
  });

  it("strips ```json fences", () => {
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]');
  });

  it("isolates the array when the model prepends prose preamble", () => {
    const text = 'I need to classify these. Here is the result:\n[{"symbol":"AVGO"}]';
    expect(extractJsonArray(text)).toBe('[{"symbol":"AVGO"}]');
  });

  it("isolates the array when prose follows it", () => {
    const text = '[{"symbol":"AVGO"}]\n\nLet me know if you need more detail.';
    expect(extractJsonArray(text)).toBe('[{"symbol":"AVGO"}]');
  });

  it("returns the stripped text unchanged when there is no array (so JSON.parse fails loudly)", () => {
    expect(extractJsonArray("The inputs appear to be timestamps, not securities.")).toBe(
      "The inputs appear to be timestamps, not securities."
    );
  });
});

describe("parseJsonArrayLenient", () => {
  it("passes through a bare JSON array", () => {
    expect(parseJsonArrayLenient('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it("passes through a fenced JSON array", () => {
    expect(parseJsonArrayLenient('```json\n[{"symbol":"AVGO"}]\n```')).toEqual([{ symbol: "AVGO" }]);
  });

  it("wraps a single object with a string symbol key in an array", () => {
    expect(parseJsonArrayLenient('{"symbol":"SILC","sector":"Financials"}')).toEqual([
      { symbol: "SILC", sector: "Financials" },
    ]);
  });

  it("unwraps a wrapper object's single array-valued property", () => {
    const text = '{"results":[{"symbol":"AVGO"},{"symbol":"SILC"}]}';
    expect(parseJsonArrayLenient(text)).toEqual([{ symbol: "AVGO" }, { symbol: "SILC" }]);
  });

  it("throws a plain-English error for a prose-only reply", () => {
    expect(() => parseJsonArrayLenient("The inputs appear to be timestamps, not securities.")).toThrow(
      "AI reply was not a JSON list of classifications"
    );
  });

  it("throws a plain-English error for an object with no symbol key and no list inside", () => {
    expect(() => parseJsonArrayLenient('{"foo":1}')).toThrow(
      "AI reply was not a JSON list of classifications"
    );
  });
});

// Adversarial-review regressions (2026-08-30). `parseJsonArrayLenient` used to
// call `extractJsonArray` FIRST, which slices first-`[` … last-`]` before any
// parse — so the object branches below were dead code reached only by accident,
// and a single object carrying a nested array silently collapsed to that nested
// array. It also lacked the C0-control-character retry every sibling parse site
// carries (CLAUDE.md: "extractJsonArray + the C0-control-char retry").
describe("parseJsonArrayLenient — shape handling and control-char retry", () => {
  it("still isolates a real array when an object and prose precede it and elements nest objects", () => {
    const text =
      'Context: {"note":"batch 1"}\nHere is the result:\n' +
      '[{"symbol":"AVGO","meta":{"confidence":"high"}},{"symbol":"SILC","meta":{"confidence":"low"}}]\n' +
      "Let me know if you need more.";
    expect(parseJsonArrayLenient(text)).toEqual([
      { symbol: "AVGO", meta: { confidence: "high" } },
      { symbol: "SILC", meta: { confidence: "low" } },
    ]);
  });

  it("unwraps a wrapper object through the OBJECT branch, not the bracket slice", () => {
    // The wrapper carries a `[` inside a string value BEFORE the real array and
    // nested arrays inside the elements, so the first-`[` … last-`]` slice
    // produces invalid JSON. Only whole-text parsing recovers this.
    const text =
      '{"note":"batch [1] of 2","results":[{"symbol":"AVGO","tags":["ai","semis"]},{"symbol":"SILC","tags":["smallcap"]}]}';
    expect(parseJsonArrayLenient(text)).toEqual([
      { symbol: "AVGO", tags: ["ai", "semis"] },
      { symbol: "SILC", tags: ["smallcap"] },
    ]);
  });

  it("wraps a single object that carries a nested array (never returns the nested array)", () => {
    const text = '{"symbol":"SILC","sector":"Technology","notes":["thin float","illiquid"]}';
    expect(parseJsonArrayLenient(text)).toEqual([
      { symbol: "SILC", sector: "Technology", notes: ["thin float", "illiquid"] },
    ]);
  });

  it("recovers from a raw C0 control character inside a string literal (array reply)", () => {
    const rawNewline = String.fromCharCode(10);
    const text = `[{"symbol":"XLE","industry":"Oil${rawNewline}& Gas"}]`;
    expect(parseJsonArrayLenient(text)).toEqual([{ symbol: "XLE", industry: "Oil & Gas" }]);
  });

  it("recovers from a raw C0 control character inside a string literal (single-object reply)", () => {
    const rawNewline = String.fromCharCode(10);
    const text = `{"symbol":"XLE","industry":"Oil${rawNewline}& Gas"}`;
    expect(parseJsonArrayLenient(text)).toEqual([{ symbol: "XLE", industry: "Oil & Gas" }]);
  });

  it("keeps the original parse error as `cause` when even the retry fails", () => {
    let caught: unknown;
    try {
      parseJsonArrayLenient('[{"symbol":"XLE","fund_category":"US Sector Equity (Ener');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("AI reply was not a JSON list of classifications");
    expect((caught as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("names the caller's domain in the error message", () => {
    expect(() => parseJsonArrayLenient("No sectors could be determined.", "sector classifications")).toThrow(
      "AI reply was not a JSON list of sector classifications"
    );
  });
});
