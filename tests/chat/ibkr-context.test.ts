import { describe, it, expect } from "vitest";
import { computeBullishness } from "@/lib/chat/ibkr-context";

describe("computeBullishness", () => {
  it("returns 1 for very high cash (>=50%)", () => {
    expect(computeBullishness(60, null)).toBe(1);
    expect(computeBullishness(50, null)).toBe(1);
  });

  it("returns 2 for high cash (40-49%)", () => {
    expect(computeBullishness(45, null)).toBe(2);
    expect(computeBullishness(40, null)).toBe(2);
  });

  it("returns 3 for moderate cash (30-39%)", () => {
    expect(computeBullishness(35, null)).toBe(3);
    expect(computeBullishness(30, null)).toBe(3);
  });

  it("returns 4 for low cash (20-29%)", () => {
    expect(computeBullishness(25, null)).toBe(4);
    expect(computeBullishness(20, null)).toBe(4);
  });

  it("returns 5 for very low cash (<20%)", () => {
    expect(computeBullishness(10, null)).toBe(5);
    expect(computeBullishness(5, null)).toBe(5);
    expect(computeBullishness(0, null)).toBe(5);
  });

  it("adjusts down by 1 for low beta (<0.5)", () => {
    // 25% cash → 4, but beta 0.3 → 3
    expect(computeBullishness(25, 0.3)).toBe(3);
    // 10% cash → 5, but beta 0.4 → 4
    expect(computeBullishness(10, 0.4)).toBe(4);
  });

  it("adjusts up by 1 for high beta (>1.2)", () => {
    // 35% cash → 3, but beta 1.5 → 4
    expect(computeBullishness(35, 1.5)).toBe(4);
    // 45% cash → 2, but beta 1.3 → 3
    expect(computeBullishness(45, 1.3)).toBe(3);
  });

  it("clamps to minimum 1", () => {
    // 60% cash → 1, beta 0.3 would adjust to 0, clamped to 1
    expect(computeBullishness(60, 0.3)).toBe(1);
  });

  it("clamps to maximum 5", () => {
    // 5% cash → 5, beta 1.5 would adjust to 6, clamped to 5
    expect(computeBullishness(5, 1.5)).toBe(5);
  });

  it("no adjustment when beta is exactly 0.5", () => {
    expect(computeBullishness(25, 0.5)).toBe(4); // no adjustment
  });

  it("no adjustment when beta is exactly 1.2", () => {
    expect(computeBullishness(25, 1.2)).toBe(4); // no adjustment
  });

  it("handles null beta (no adjustment)", () => {
    expect(computeBullishness(25, null)).toBe(4);
  });

  it("handles 100% cash", () => {
    expect(computeBullishness(100, null)).toBe(1);
  });
});
