import { describe, it, expect } from "vitest";
import { compareValues } from "@/lib/hooks/useSortParam";

describe("compareValues", () => {
  it("sorts numbers ascending", () => {
    expect(compareValues(1, 2, "asc")).toBeLessThan(0);
    expect(compareValues(2, 1, "asc")).toBeGreaterThan(0);
    expect(compareValues(5, 5, "asc")).toBe(0);
  });

  it("sorts numbers descending", () => {
    expect(compareValues(1, 2, "desc")).toBeGreaterThan(0);
    expect(compareValues(2, 1, "desc")).toBeLessThan(0);
  });

  it("sorts strings case-insensitively", () => {
    expect(compareValues("apple", "BANANA", "asc")).toBeLessThan(0);
    expect(compareValues("BANANA", "apple", "asc")).toBeGreaterThan(0);
  });

  it("sorts ISO date strings correctly as strings", () => {
    expect(compareValues("2026-01-15", "2026-03-20", "asc")).toBeLessThan(0);
    expect(compareValues("2026-01-15", "2026-03-20", "desc")).toBeGreaterThan(0);
  });

  it("always sorts null/undefined to the end regardless of direction", () => {
    expect(compareValues(null, 1, "asc")).toBeGreaterThan(0);
    expect(compareValues(1, null, "asc")).toBeLessThan(0);
    expect(compareValues(null, 1, "desc")).toBeGreaterThan(0);
    expect(compareValues(1, null, "desc")).toBeLessThan(0);
    expect(compareValues(undefined, 5, "asc")).toBeGreaterThan(0);
    expect(compareValues(null, null, "asc")).toBe(0);
  });

  it("handles mixed numeric sort of an array", () => {
    const arr = [3, 1, null, 2, null, 5];
    const sorted = [...arr].sort((a, b) => compareValues(a, b, "asc"));
    expect(sorted).toEqual([1, 2, 3, 5, null, null]);

    const desc = [...arr].sort((a, b) => compareValues(a, b, "desc"));
    expect(desc).toEqual([5, 3, 2, 1, null, null]);
  });

  it("coerces booleans via string path (false < true)", () => {
    expect(compareValues(false, true, "asc")).toBeLessThan(0);
    expect(compareValues(true, false, "asc")).toBeGreaterThan(0);
  });
});
