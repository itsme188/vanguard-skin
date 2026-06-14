import { describe, it, expect } from "vitest";
import {
  resolveTier,
  parseModelId,
  TIER_STATIC_FALLBACK,
} from "@/lib/ai/model-tiers";

describe("parseModelId", () => {
  it("parses family + numeric version, ignoring date suffix", () => {
    expect(parseModelId("claude-opus-4-8")).toEqual({ family: "opus", version: [4, 8] });
    expect(parseModelId("claude-fable-5")).toEqual({ family: "fable", version: [5] });
    expect(parseModelId("claude-haiku-4-5-20251001")).toEqual({ family: "haiku", version: [4, 5] });
  });
  it("returns null for non-claude ids", () => {
    expect(parseModelId("@cf/meta/llama-4-scout")).toBeNull();
  });
});

describe("resolveTier", () => {
  const catalog = ["claude-fable-5", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

  it("frontier picks Fable when available", () => {
    expect(resolveTier("frontier", catalog)).toBe("claude-fable-5");
  });
  it("frontier falls to newest Opus when Fable is pulled", () => {
    const pulled = catalog.filter((m) => m !== "claude-fable-5");
    expect(resolveTier("frontier", pulled)).toBe("claude-opus-4-8");
  });
  it("picks the newest version within the top available family", () => {
    expect(resolveTier("frontier", ["claude-opus-4-7", "claude-opus-4-8"])).toBe("claude-opus-4-8");
    expect(resolveTier("frontier", ["claude-opus-4-10", "claude-opus-4-8"])).toBe("claude-opus-4-10");
  });
  it("workhorse prefers Sonnet over Haiku", () => {
    expect(resolveTier("workhorse", catalog)).toBe("claude-sonnet-4-6");
  });
  it("cheap resolves Haiku", () => {
    expect(resolveTier("cheap", catalog)).toBe("claude-haiku-4-5");
  });
  it("empty catalog → static fallback", () => {
    expect(resolveTier("frontier", [])).toBe(TIER_STATIC_FALLBACK.frontier);
    expect(resolveTier("workhorse", [])).toBe(TIER_STATIC_FALLBACK.workhorse);
    expect(resolveTier("cheap", [])).toBe(TIER_STATIC_FALLBACK.cheap);
  });
  it("frontier static fallback is Opus, not Fable (availability-safe)", () => {
    expect(TIER_STATIC_FALLBACK.frontier).toBe("claude-opus-4-8");
  });
  it("honours the excluded set (reactive failover)", () => {
    expect(resolveTier("frontier", catalog, new Set(["claude-fable-5"]))).toBe("claude-opus-4-8");
  });
});
