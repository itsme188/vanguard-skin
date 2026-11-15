import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { formatRSquared } from "@/lib/format/r-squared";
import { MIN_BETA_R_SQUARED } from "@/lib/compute/beta-confidence";
import { anchorIndex } from "../helpers/source-anchor";

describe("formatRSquared", () => {
  it.each([
    [0.0967, "0.097"],
    [0.0951, "0.095"],
    [0.1, "0.10"],
    [0.1049, "0.10"],
    [0.5, "0.50"],
    [0.04, "0.04"],
    [0, "0.00"],
  ])("%s -> %s", (v, expected) => {
    expect(formatRSquared(v)).toBe(expected);
  });

  it("never prints the gate for a value strictly below it", () => {
    const s = formatRSquared(0.09996);
    expect(Number(s)).toBeLessThan(MIN_BETA_R_SQUARED);
    expect(s).not.toBe("0.10");
    expect(s).not.toBe("0.100");
  });
});

describe("FactorProfileSection R-squared tile", () => {
  it("renders through formatRSquared", () => {
    const src = readFileSync(
      "app/dashboard/security/[id]/FactorProfileSection.tsx",
      "utf8",
    );
    const i = anchorIndex(src, 'label="R²"');
    expect(src.slice(i, i + 120)).toContain("formatRSquared(regression.rSquared)");
  });
});
