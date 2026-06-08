import { describe, it, expect } from "vitest";
import { extractJsonArray } from "@/lib/ai/extract-json";

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
