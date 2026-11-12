import { describe, it, expect } from "vitest";
import {
  compareFamilyVersions,
  SUMMARY_FAMILY_LADDER,
  resolveFamilyModel,
  familyNowLabel,
  modelLabel,
} from "@/lib/ai/model-families";
import { isSummaryChoice } from "@/lib/filing-summary/choice";

// Catalog fixtures: ids the live catalog could list. Never literals in lib code.
const CATALOG = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
  "claude-haiku-4-5-20251001",
];

describe("resolveFamilyModel", () => {
  it("ladder is opus, sonnet — Fable is not a rung (2026-11-07 ruling)", () => {
    expect([...SUMMARY_FAMILY_LADDER]).toEqual(["opus", "sonnet"]);
  });

  it("returns the newest id of the chosen family, no fallback", () => {
    expect(resolveFamilyModel("opus", CATALOG)).toEqual({
      modelId: "claude-opus-5-5",
      family: "opus",
      fellBackFrom: null,
    });
    expect(resolveFamilyModel("sonnet", CATALOG)).toEqual({
      modelId: "claude-sonnet-5-5",
      family: "sonnet",
      fellBackFrom: null,
    });
  });

  it("auto-follows a newer version in the family", () => {
    expect(resolveFamilyModel("opus", [...CATALOG, "claude-opus-5-9"])?.modelId).toBe(
      "claude-opus-5-9",
    );
  });

  it("walks DOWN the ladder when the family has no id", () => {
    const noOpus = CATALOG.filter((id) => !id.startsWith("claude-opus"));
    expect(resolveFamilyModel("opus", noOpus)).toEqual({
      modelId: "claude-sonnet-5-5",
      family: "sonnet",
      fellBackFrom: "opus",
    });
  });

  it("never reaches Fable, even when the catalog lists it", () => {
    // Fable is still in CATALOG on purpose: the ladder, not the catalog, is
    // what keeps a run off it. Opus is the top rung, so nothing resolves above.
    for (const family of SUMMARY_FAMILY_LADDER) {
      expect(resolveFamilyModel(family, CATALOG)?.modelId).not.toContain("fable");
    }
  });

  it("never walks UP: sonnet with no sonnet id is null", () => {
    const noSonnet = CATALOG.filter((id) => !id.startsWith("claude-sonnet"));
    expect(resolveFamilyModel("sonnet", noSonnet)).toBeNull();
  });

  it("honours the excluded set, walking DOWN to the next family, never to an older version (2026-11-12)", () => {
    // Opus 5 is listed but is an older generation of the Opus class: with
    // Opus 5.5 excluded the run goes to the current Sonnet, not to Opus 5.
    expect(resolveFamilyModel("opus", CATALOG, new Set(["claude-opus-5-5"]))).toEqual({
      modelId: "claude-sonnet-5-5",
      family: "sonnet",
      fellBackFrom: "opus",
    });
  });

  it("never picks an older generation of a class while the list of current ids says otherwise", () => {
    const old = ["claude-opus-4-8", "claude-opus-5", "claude-sonnet-4-6", "claude-sonnet-5"];
    expect(resolveFamilyModel("opus", old)).toBeNull();
    expect(resolveFamilyModel("sonnet", old)).toBeNull();
    expect(resolveFamilyModel("opus", [...old, "claude-sonnet-5-5"])?.modelId).toBe("claude-sonnet-5-5");
    expect(familyNowLabel("opus", old)).toBe("Opus · not available");
  });

  it("returns null on an empty catalog", () => {
    expect(resolveFamilyModel("opus", [])).toBeNull();
  });
});

describe("labels", () => {
  it("familyNowLabel names the version the family resolves to now", () => {
    expect(familyNowLabel("sonnet", CATALOG)).toBe("Sonnet · now 5.5");
    expect(familyNowLabel("opus", CATALOG)).toBe("Opus · now 5.5");
  });

  it("familyNowLabel says not available when the family has no id (no fallback)", () => {
    const noOpus = CATALOG.filter((id) => !id.startsWith("claude-opus"));
    expect(familyNowLabel("opus", noOpus)).toBe("Opus · not available");
  });

  it("modelLabel still reads a stored Fable id (past runs keep their label)", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5")).toBe("Fable 5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });
});

describe("isSummaryChoice", () => {
  it("accepts the four offered pairs and rejects a retired family", () => {
    expect(isSummaryChoice({ family: "sonnet", effort: "high" })).toBe(true);
    expect(isSummaryChoice({ family: "opus", effort: "high" })).toBe(true);
    expect(isSummaryChoice({ family: "fable", effort: "high" })).toBe(false);
  });
});

describe("compareFamilyVersions (own comparator; model-tiers.ts stays Worker-identical)", () => {
  it("orders by each part numerically, a missing part counting as 0", () => {
    expect(compareFamilyVersions([5, 10], [5, 9])).toBeGreaterThan(0);
    expect(compareFamilyVersions([5, 9], [5, 10])).toBeLessThan(0);
    expect(compareFamilyVersions([6], [5, 9])).toBeGreaterThan(0);
    expect(compareFamilyVersions([5], [5, 0])).toBe(0);
    expect(compareFamilyVersions([5, 1], [5])).toBeGreaterThan(0);
  });
  it("sorts newest first when used as the resolver does", () => {
    const vs = [[5, 1], [5, 10], [4, 7], [5, 9]];
    vs.sort((a, b) => compareFamilyVersions(b, a));
    expect(vs).toEqual([[5, 10], [5, 9], [5, 1], [4, 7]]);
  });
});
