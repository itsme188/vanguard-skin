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
  it("ladder is fable, opus, sonnet", () => {
    expect([...SUMMARY_FAMILY_LADDER]).toEqual(["fable", "opus", "sonnet"]);
  });

  it("returns the newest id of the chosen family, no fallback", () => {
    expect(resolveFamilyModel("fable", CATALOG)).toEqual({
      modelId: "claude-fable-5-1",
      family: "fable",
      fellBackFrom: null,
    });
    expect(resolveFamilyModel("opus", CATALOG)).toEqual({
      modelId: "claude-opus-5-5",
      family: "opus",
      fellBackFrom: null,
    });
  });

  it("auto-follows a newer version in the family", () => {
    expect(resolveFamilyModel("fable", [...CATALOG, "claude-fable-5-5"])?.modelId).toBe(
      "claude-fable-5-5",
    );
  });

  it("walks DOWN the ladder when the family has no id", () => {
    const noFable = CATALOG.filter((id) => !id.startsWith("claude-fable"));
    expect(resolveFamilyModel("fable", noFable)).toEqual({
      modelId: "claude-opus-5-5",
      family: "opus",
      fellBackFrom: "fable",
    });
  });

  it("never walks UP: sonnet with no sonnet id is null", () => {
    const noSonnet = CATALOG.filter((id) => !id.startsWith("claude-sonnet"));
    expect(resolveFamilyModel("sonnet", noSonnet)).toBeNull();
  });

  it("honours the excluded set", () => {
    expect(resolveFamilyModel("opus", CATALOG, new Set(["claude-opus-5-5"]))?.modelId).toBe(
      "claude-opus-5",
    );
    expect(
      resolveFamilyModel("opus", CATALOG, new Set(["claude-opus-5-5", "claude-opus-5"])),
    ).toEqual({ modelId: "claude-sonnet-5-5", family: "sonnet", fellBackFrom: "opus" });
  });

  it("returns null on an empty catalog", () => {
    expect(resolveFamilyModel("fable", [])).toBeNull();
  });
});

describe("labels", () => {
  it("familyNowLabel names the version the family resolves to now", () => {
    expect(familyNowLabel("fable", CATALOG)).toBe("Fable · now 5.1");
    expect(familyNowLabel("opus", CATALOG)).toBe("Opus · now 5.5");
  });

  it("familyNowLabel says not available when the family has no id (no fallback)", () => {
    const noFable = CATALOG.filter((id) => !id.startsWith("claude-fable"));
    expect(familyNowLabel("fable", noFable)).toBe("Fable · not available");
  });

  it("modelLabel", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5")).toBe("Fable 5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });
});

describe("isSummaryChoice", () => {
  it("rejects a pair outside the five", () => {
    expect(isSummaryChoice({ family: "sonnet", effort: "high" })).toBe(false);
    expect(isSummaryChoice({ family: "opus", effort: "high" })).toBe(true);
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
