import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveTier, TIER_STATIC_FALLBACK } from "../src/model-tiers";

describe("worker model-tiers parity", () => {
  it("is byte-identical to the Mac resolver below the header", () => {
    const mac = readFileSync(new URL("../../../lib/ai/model-tiers.ts", import.meta.url), "utf8");
    const wkr = readFileSync(new URL("../src/model-tiers.ts", import.meta.url), "utf8");
    const strip = (s: string) => s.slice(s.indexOf("export type Tier"));
    expect(strip(wkr)).toBe(strip(mac));
  });
  it("resolves frontier to newest available", () => {
    expect(resolveTier("frontier", ["claude-opus-4-8", "claude-sonnet-4-6"])).toBe("claude-opus-4-8");
    expect(resolveTier("frontier", [])).toBe(TIER_STATIC_FALLBACK.frontier);
  });
});
