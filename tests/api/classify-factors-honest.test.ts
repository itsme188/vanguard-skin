// tests/api/classify-factors-honest.test.ts
import { describe, it, expect } from "vitest";
import { isFactorClassifySuccess } from "@/lib/compute/classify-factors";

describe("factor classify success semantics", () => {
  it("is failure when nothing classified and errors occurred", () => {
    expect(isFactorClassifySuccess({ classified: 0, skipped: 0, errors: ["402"] })).toBe(false);
  });
  it("is success when something classified despite an error", () => {
    expect(isFactorClassifySuccess({ classified: 3, skipped: 1, errors: ["one batch failed"] })).toBe(true);
  });
  it("is success when nothing to do (no errors)", () => {
    expect(isFactorClassifySuccess({ classified: 0, skipped: 5, errors: [] })).toBe(true);
  });
});
