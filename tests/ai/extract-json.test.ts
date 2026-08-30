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
      "AI reply was not a list of classifications"
    );
  });

  it("throws a plain-English error for an object with no symbol key and no list inside", () => {
    expect(() => parseJsonArrayLenient('{"foo":1}')).toThrow(
      "AI reply was not a list of classifications"
    );
  });
});
