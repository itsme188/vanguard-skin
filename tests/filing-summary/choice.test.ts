import { describe, it, expect } from "vitest";
import {
  DEFAULT_SUMMARY_CHOICE,
  SUMMARY_CHOICES,
  choiceLabel,
  isSummaryChoice,
} from "@/lib/filing-summary/choice";

describe("summary choices", () => {
  it("lists the five picker choices in order with Opus high as default", () => {
    expect(SUMMARY_CHOICES.map(choiceLabel)).toEqual([
      "Sonnet · medium",
      "Opus · medium",
      "Opus · high",
      "Fable · medium",
      "Fable · high",
    ]);
    expect(DEFAULT_SUMMARY_CHOICE).toEqual({ family: "opus", effort: "high" });
    expect(isSummaryChoice(DEFAULT_SUMMARY_CHOICE)).toBe(true);
  });

  it("accepts only the five choices", () => {
    expect(isSummaryChoice({ family: "sonnet", effort: "high" })).toBe(false);
    expect(isSummaryChoice({ family: "opus", effort: "low" })).toBe(false);
    expect(isSummaryChoice({ family: "opus" })).toBe(false);
    expect(isSummaryChoice(null)).toBe(false);
    expect(isSummaryChoice("opus")).toBe(false);
    expect(isSummaryChoice({ family: "fable", effort: "medium" })).toBe(true);
  });
});
