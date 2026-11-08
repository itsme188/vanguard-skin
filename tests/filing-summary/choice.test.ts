import { describe, it, expect } from "vitest";
import {
  DEFAULT_SUMMARY_CHOICE,
  SUMMARY_CHOICES,
  choiceLabel,
  isSummaryChoice,
  normalizeStoredChoice,
} from "@/lib/filing-summary/choice";

describe("summary choices", () => {
  it("lists the four picker choices cheapest-first with Sonnet high as default", () => {
    expect(SUMMARY_CHOICES.map(choiceLabel)).toEqual([
      "Sonnet · medium",
      "Sonnet · high",
      "Opus · medium",
      "Opus · high",
    ]);
    // Owner ruling 2026-11-07: Sonnet is the default; high effort carries over
    // from the old Opus · high default.
    expect(DEFAULT_SUMMARY_CHOICE).toEqual({ family: "sonnet", effort: "high" });
    expect(isSummaryChoice(DEFAULT_SUMMARY_CHOICE)).toBe(true);
  });

  it("accepts only the four choices", () => {
    expect(isSummaryChoice({ family: "sonnet", effort: "high" })).toBe(true);
    expect(isSummaryChoice({ family: "opus", effort: "low" })).toBe(false);
    expect(isSummaryChoice({ family: "opus" })).toBe(false);
    expect(isSummaryChoice(null)).toBe(false);
    expect(isSummaryChoice("opus")).toBe(false);
    expect(isSummaryChoice({ family: "fable", effort: "medium" })).toBe(false);
    expect(isSummaryChoice({ family: "fable", effort: "high" })).toBe(false);
  });

  it("normalizeStoredChoice: a retired stored family resolves to the default, a live one is kept", () => {
    // The stored row itself is never rewritten — this is read-time resolution.
    expect(normalizeStoredChoice({ family: "fable", effort: "high" })).toEqual({
      choice: DEFAULT_SUMMARY_CHOICE,
      retired: true,
    });
    expect(normalizeStoredChoice({ family: "fable", effort: "medium" })).toEqual({
      choice: DEFAULT_SUMMARY_CHOICE,
      retired: true,
    });
    expect(normalizeStoredChoice({ family: "opus", effort: "medium" })).toEqual({
      choice: { family: "opus", effort: "medium" },
      retired: false,
    });
  });

  it("normalizeStoredChoice returns a fresh object, so a caller cannot mutate the default", () => {
    const { choice } = normalizeStoredChoice({ family: "fable", effort: "high" });
    choice.family = "opus";
    expect(DEFAULT_SUMMARY_CHOICE).toEqual({ family: "sonnet", effort: "high" });
  });
});
