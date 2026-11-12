import { describe, it, expect } from "vitest";
import {
  resolveTier,
  parseModelId,
  isCurrentGeneration,
  upgradeToCurrentGeneration,
  CURRENT_CLASS_MODELS,
  FAMILY_LADDERS,
  TIER_STATIC_FALLBACK,
  type Tier,
} from "@/lib/ai/model-tiers";

const TIERS: Tier[] = ["frontier", "workhorse", "cheap"];

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

describe("the current model of each class (owner ruling 2026-11-12)", () => {
  it("names the latest id of every class a ladder uses", () => {
    expect(CURRENT_CLASS_MODELS).toEqual({
      opus: "claude-opus-5-5",
      sonnet: "claude-sonnet-5-5",
      haiku: "claude-haiku-5-5",
    });
    for (const tier of TIERS) {
      for (const family of FAMILY_LADDERS[tier]) {
        expect(CURRENT_CLASS_MODELS[family], `${tier}/${family}`).toBeDefined();
      }
    }
  });

  it("the static fallback (fresh database, empty Worker snapshot) is the current id of each tier's top class", () => {
    expect(TIER_STATIC_FALLBACK).toEqual({
      frontier: "claude-opus-5-5",
      workhorse: "claude-sonnet-5-5",
      cheap: "claude-haiku-5-5",
    });
    for (const tier of TIERS) {
      expect(TIER_STATIC_FALLBACK[tier]).toBe(CURRENT_CLASS_MODELS[FAMILY_LADDERS[tier][0]]);
      expect(resolveTier(tier, [])).toBe(TIER_STATIC_FALLBACK[tier]);
    }
  });

  it("isCurrentGeneration: older versions of a listed class are not current; newer ones are", () => {
    expect(isCurrentGeneration("claude-sonnet-4-6")).toBe(false);
    expect(isCurrentGeneration("claude-sonnet-5")).toBe(false);
    expect(isCurrentGeneration("claude-opus-4-8")).toBe(false);
    expect(isCurrentGeneration("claude-opus-5")).toBe(false);
    expect(isCurrentGeneration("claude-haiku-4-5-20251001")).toBe(false);
    expect(isCurrentGeneration("claude-sonnet-5-5")).toBe(true);
    expect(isCurrentGeneration("claude-haiku-5-5-20261101")).toBe(true);
    expect(isCurrentGeneration("claude-sonnet-6")).toBe(true);
    expect(isCurrentGeneration("claude-opus-5-10")).toBe(true);
    // Not a class this file tracks, or not a Claude id: left alone.
    expect(isCurrentGeneration("claude-mythos-5")).toBe(true);
    expect(isCurrentGeneration("gpt-6-astra")).toBe(true);
    expect(isCurrentGeneration("claude-constructor-1")).toBe(true);
  });

  it("upgradeToCurrentGeneration maps an older id to its class's current id and leaves the rest", () => {
    expect(upgradeToCurrentGeneration("claude-sonnet-4-6")).toBe("claude-sonnet-5-5");
    expect(upgradeToCurrentGeneration("claude-opus-4-8")).toBe("claude-opus-5-5");
    expect(upgradeToCurrentGeneration("claude-haiku-4-5-20251001")).toBe("claude-haiku-5-5");
    expect(upgradeToCurrentGeneration("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(upgradeToCurrentGeneration("claude-sonnet-6")).toBe("claude-sonnet-6");
    expect(upgradeToCurrentGeneration("@cf/meta/llama-4-scout")).toBe("@cf/meta/llama-4-scout");
  });
});

describe("resolveTier", () => {
  // A catalog the way /v1/models lists it: every generation still served.
  const catalog = [
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-5-5",
    "claude-haiku-4-5-20251001",
  ];

  it("frontier picks the current Opus, never Fable (2026-11-07 ruling)", () => {
    expect(resolveTier("frontier", catalog)).toBe("claude-opus-5-5");
  });
  it("workhorse picks the current Sonnet", () => {
    expect(resolveTier("workhorse", catalog)).toBe("claude-sonnet-5-5");
  });
  it("cheap picks the current Haiku", () => {
    expect(resolveTier("cheap", catalog)).toBe("claude-haiku-5-5");
  });
  it("frontier falls to the current Sonnet when Opus is pulled (last rung, not the static id)", () => {
    const pulled = catalog.filter((m) => !m.startsWith("claude-opus"));
    expect(resolveTier("frontier", pulled)).toBe("claude-sonnet-5-5");
  });
  it("still follows a NEWER version of a class automatically", () => {
    expect(resolveTier("frontier", ["claude-opus-5-5", "claude-opus-5-10"])).toBe("claude-opus-5-10");
    expect(resolveTier("workhorse", [...catalog, "claude-sonnet-6"])).toBe("claude-sonnet-6");
  });
  it("never selects an older generation, even when the catalog lists only older ones", () => {
    // A stale catalog cached before the current generation was listed.
    const stale = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    expect(resolveTier("frontier", stale)).toBe("claude-opus-5-5");
    expect(resolveTier("workhorse", stale)).toBe("claude-sonnet-5-5");
    expect(resolveTier("cheap", stale)).toBe("claude-haiku-5-5");
  });
  it("reactive failover moves to the next class, never to an older version of the same class", () => {
    expect(resolveTier("frontier", catalog, new Set(["claude-opus-5-5"]))).toBe("claude-sonnet-5-5");
    expect(resolveTier("workhorse", catalog, new Set(["claude-sonnet-5-5"]))).toBe("claude-haiku-5-5");
  });
  it("no tier, with any single id excluded, resolves to an older generation", () => {
    for (const tier of TIERS) {
      for (const dropped of [undefined, ...catalog]) {
        const id = resolveTier(tier, catalog, new Set(dropped ? [dropped] : []));
        expect(isCurrentGeneration(id), `${tier} minus ${dropped}`).toBe(true);
      }
    }
  });
});
