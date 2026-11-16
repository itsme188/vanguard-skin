/**
 * The Auto-Classify toast (review round 3, Analysis tab fix wave 2026-11-15,
 * Z6). The AI step asks only about held names, so the toast reports what was
 * classified, which held names remain and why, and how many names not held
 * now were not sent to the AI, instead of a blended "N couldn't be
 * auto-classified" count no click can clear. Pure helpers plus a source pin
 * (no DOM harness). All counts are synthetic.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyNoOpSummary,
  classifyRunSummary,
} from "@/app/dashboard/components/analysis/ClassificationCard";
import { anchorIndex } from "@/tests/helpers/source-anchor";

describe("the run summary", () => {
  it("names held names still unclassified and why, and the names not held that were skipped", () => {
    const line = classifyRunSummary(
      { classified: 4, skipped: 900, heldUnresolvedCount: 3, notHeldSkippedCount: 60 },
      [],
      10,
    );
    expect(line).toContain("Classified 4 securities");
    expect(line).toContain("the AI is asked only about current holdings");
    expect(line).toContain("900 already classified");
    expect(line).toContain("3 held securities are still unclassified: the AI gave no usable answer for them");
    expect(line).toContain("60 securities you do not hold now were not sent to the AI");
    expect(line).not.toMatch(/couldn't be auto-classified/);
    expect(line).not.toContain("whole security list");
  });

  it("says the AI step hit an error when it did", () => {
    const line = classifyRunSummary(
      { classified: 0, skipped: 5, heldUnresolvedCount: 1, notHeldSkippedCount: 0 },
      ["the AI's reply was too long and was cut off before it finished, so nothing from it was saved"],
      4,
    );
    expect(line).toContain("1 held security is still unclassified: the AI step hit an error");
    expect(line).toContain("AI step failed: the AI's reply was too long");
    expect(line).not.toContain("not sent to the AI");
  });

  it("withholds the held count in privacy mode", () => {
    const line = classifyRunSummary(
      { classified: 0, skipped: 5, heldUnresolvedCount: 2, notHeldSkippedCount: 0 },
      [],
      null,
    );
    expect(line).toContain("some held securities are still unclassified");
    expect(line).not.toMatch(/\b2 held/);
  });

  it("survives a malformed response", () => {
    const line = classifyRunSummary({ classified: "x", skipped: null, heldUnresolvedCount: undefined }, [], 4);
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("NaN");
    expect(line).not.toContain("still unclassified");
  });
});

describe("the no-op line", () => {
  it("explains the no-op and names the skipped names not held", () => {
    expect(classifyNoOpSummary(0)).toBe(
      "Nothing to classify — every held security already has sector/fund classifications.",
    );
    expect(classifyNoOpSummary(62)).toBe(
      "Nothing to classify — every held security already has sector/fund classifications. 62 securities you do not hold now were not sent to the AI.",
    );
    expect(classifyNoOpSummary(1)).toContain("1 security you do not hold now was not sent to the AI.");
  });

  it("the card treats 'only not-held names left' as a no-op, and the tone follows held names only", () => {
    const src = readFileSync("app/dashboard/components/analysis/ClassificationCard.tsx", "utf8");
    const at = anchorIndex(src, "async function runAutoClassify()");
    const body = src.slice(at, at + 2400);
    expect(body).toContain("classifyNoOpSummary(");
    expect(body).toContain("heldUnresolvedCount");
    expect(body).not.toContain("unresolvedCount:");
    expect(body).not.toMatch(/data\.unresolvedCount/);
  });
});
