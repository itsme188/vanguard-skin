import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveTier,
  parseModelId,
  isCurrentGeneration,
  upgradeToCurrentGeneration,
  CURRENT_CLASS_MODELS,
  FAMILY_LADDERS,
  TIER_STATIC_FALLBACK,
  TierUnavailableError,
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
  it("a catalog that lists only older ids: degrades to the newest of them, with a warning (2026-11-12 ruling, step 3)", () => {
    // A non-empty catalog is the account's own list; an id it does not list
    // is not assumed callable. Running one version behind beats being down.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stale = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    expect(resolveTier("frontier", stale)).toBe("claude-opus-4-8");
    expect(resolveTier("workhorse", stale)).toBe("claude-sonnet-4-6");
    expect(resolveTier("cheap", stale)).toBe("claude-haiku-4-5-20251001");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/below its current generation/);
    warn.mockRestore();
  });
  it("reactive failover moves to the next class's current id before any older version", () => {
    expect(resolveTier("frontier", catalog, new Set(["claude-opus-5-5"]))).toBe("claude-sonnet-5-5");
    expect(resolveTier("workhorse", catalog, new Set(["claude-sonnet-5-5"]))).toBe("claude-haiku-5-5");
  });
  it("while any current-generation id on the ladder is left, a single exclusion never lands on an older one", () => {
    for (const tier of TIERS) {
      for (const dropped of [undefined, ...catalog]) {
        const id = resolveTier(tier, catalog, new Set(dropped ? [dropped] : []));
        const currentLeft = catalog.some(
          (c) => c !== dropped && isCurrentGeneration(c) && FAMILY_LADDERS[tier].includes(parseModelId(c)!.family),
        );
        if (currentLeft) expect(isCurrentGeneration(id), `${tier} minus ${dropped}`).toBe(true);
      }
    }
  });
});

describe("a dead current id is never retried (review of 1d8d8517)", () => {
  const catalog = [
    "claude-opus-5-5",
    "claude-opus-4-8",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-5-5",
    "claude-haiku-4-5-20251001",
  ];
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("cheap, full catalog, Haiku 5.5 excluded: degrades to Haiku 4.5 (one-class ladder)", () => {
    expect(resolveTier("cheap", catalog, new Set(["claude-haiku-5-5"]))).toBe("claude-haiku-4-5-20251001");
  });
  it("workhorse, only older ids listed, Sonnet 5.5 excluded: an older listed id, never Sonnet 5.5 again", () => {
    const olderOnly = ["claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    expect(resolveTier("workhorse", olderOnly, new Set(["claude-sonnet-5-5"]))).toBe("claude-sonnet-5");
  });
  it("frontier, the next class has no current id, Opus 5.5 excluded: the newest older Opus, not Opus 5.5 again", () => {
    const cat = ["claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-4-6"];
    expect(resolveTier("frontier", cat, new Set(["claude-opus-5-5"]))).toBe("claude-opus-4-8");
  });
  it("the static fallback is used only when it is not excluded", () => {
    expect(resolveTier("cheap", [], new Set())).toBe("claude-haiku-5-5");
    expect(() => resolveTier("cheap", [], new Set(["claude-haiku-5-5"]))).toThrow(TierUnavailableError);
  });
  it("everything excluded: a clear tier-unavailable error, never an excluded id", () => {
    for (const tier of TIERS) {
      expect(() => resolveTier(tier, catalog, new Set([...catalog, ...Object.values(TIER_STATIC_FALLBACK)])), tier).toThrow(
        /tier "\w+" unavailable/,
      );
    }
  });
});
