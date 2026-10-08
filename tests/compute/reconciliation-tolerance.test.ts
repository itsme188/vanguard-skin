import { describe, it, expect } from "vitest";
import { reconciliationBand } from "@/lib/compute/reconciliation-tolerance";

describe("reconciliationBand", () => {
  it("has no band without a difference", () => {
    expect(reconciliationBand(null, 50_000)).toBeNull();
  });

  it("under one cent is a match, either sign", () => {
    expect(reconciliationBand(0, 50_000)).toBe("match");
    expect(reconciliationBand(-0.004, 50_000)).toBe("match");
  });

  it("a small share of a large statement is within tolerance, even above the flat floor", () => {
    // 160 on 2,000,000 is 0.008%.
    expect(reconciliationBand(160, 2_000_000)).toBe("within");
    expect(reconciliationBand(-160, 2_000_000)).toBe("within");
  });

  it("between a tenth and half a percent is close", () => {
    // 300 on 100,000 is 0.3%.
    expect(reconciliationBand(300, 100_000)).toBe("close");
  });

  it("over half a percent but not over the floor is close, not off", () => {
    // 50 on 2,000 is 2.5%, but only 50 dollars.
    expect(reconciliationBand(50, 2_000)).toBe("close");
  });

  it("over both the floor and half a percent is off", () => {
    // 600 on 100,000 is 0.6%.
    expect(reconciliationBand(600, 100_000)).toBe("off");
    expect(reconciliationBand(-600, 100_000)).toBe("off");
  });

  it("a statement value of zero or less falls back to the flat-dollar reading", () => {
    expect(reconciliationBand(50, 0)).toBe("close");
    expect(reconciliationBand(150, 0)).toBe("off");
    expect(reconciliationBand(150, Number.NaN)).toBe("off");
  });
});
