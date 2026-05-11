import { describe, it, expect } from "vitest";
import {
  buildSelfAdmissionRegex,
  findSelfAdmissions,
  buildSelfAdmissionAddendum,
} from "@/lib/calendar/briefing-self-admission";

describe("buildSelfAdmissionRegex", () => {
  it("returns a FRESH regex on every call (avoids lastIndex carryover)", () => {
    const re1 = buildSelfAdmissionRegex();
    const re2 = buildSelfAdmissionRegex();
    expect(re1).not.toBe(re2);
    expect(re1.flags).toContain("g");
    expect(re1.flags).toContain("i");
    expect(re1.lastIndex).toBe(0);
  });
});

describe("findSelfAdmissions — positive cases", () => {
  it("matches 'data looks corrupted'", () => {
    const txt = "The data looks corrupted in the latest snapshot.";
    expect(findSelfAdmissions(txt)).toContain("data looks corrupted");
  });

  it("matches 'data isn't available'", () => {
    const txt = "Unfortunately the data isn't available for this segment.";
    const matches = findSelfAdmissions(txt);
    expect(matches.length).toBe(1);
    expect(matches[0].toLowerCase()).toContain("isn");
  });

  it("matches 'I cannot verify'", () => {
    const txt = "I cannot verify the latest print against consensus.";
    expect(findSelfAdmissions(txt).length).toBeGreaterThan(0);
  });

  it("matches 'without access to'", () => {
    const txt = "Without access to live prices, I'll have to estimate.";
    const matches = findSelfAdmissions(txt);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].toLowerCase()).toContain("without access to");
  });

  it("matches 'I don't have current'", () => {
    const txt = "I don't have current pricing for this name.";
    expect(findSelfAdmissions(txt).length).toBeGreaterThan(0);
  });

  it("matches 'unable to verify'", () => {
    const txt = "I am unable to verify the most recent earnings figure.";
    expect(findSelfAdmissions(txt).length).toBeGreaterThan(0);
  });

  it("returns multiple distinct matches deduped", () => {
    const txt =
      "The data looks corrupted. I cannot verify the actuals. " +
      "Without access to fresh prices, this is a guess. " +
      "The data looks corrupted again.";
    const matches = findSelfAdmissions(txt);
    // 3 distinct patterns; the duplicate "data looks corrupted" should dedup
    expect(matches.length).toBe(3);
  });
});

describe("findSelfAdmissions — negative cases (no false positives)", () => {
  it("does not match benign references to 'data'", () => {
    const txt = "The data shows AAPL beat consensus on EPS.";
    expect(findSelfAdmissions(txt)).toEqual([]);
  });

  it("does not match 'verify the print against consensus'", () => {
    const txt = "We can verify the print against consensus next quarter.";
    expect(findSelfAdmissions(txt)).toEqual([]);
  });

  it("does not match standalone 'cannot' or 'access'", () => {
    const txt =
      "Investors cannot ignore the macro picture. Access to credit remains tight.";
    expect(findSelfAdmissions(txt)).toEqual([]);
  });

  it("handles empty input gracefully", () => {
    expect(findSelfAdmissions("")).toEqual([]);
  });

  it("does not loop infinitely on tricky input", () => {
    // Deliberately repeat a near-match; the dedup + zero-width guard
    // should keep this bounded.
    const txt = "verify ".repeat(100);
    const result = findSelfAdmissions(txt);
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("buildSelfAdmissionAddendum", () => {
  it("returns empty string when no matches", () => {
    expect(buildSelfAdmissionAddendum([])).toBe("");
  });

  it("quotes each matched phrase explicitly", () => {
    const addendum = buildSelfAdmissionAddendum([
      "data looks corrupted",
      "cannot verify",
    ]);
    expect(addendum).toContain('"data looks corrupted"');
    expect(addendum).toContain('"cannot verify"');
  });

  it("includes the do-not-narrate-absence guidance", () => {
    const addendum = buildSelfAdmissionAddendum(["data looks corrupted"]);
    expect(addendum.toLowerCase()).toContain("skip");
    expect(addendum.toLowerCase()).toContain("correct and complete");
    expect(addendum.toLowerCase()).toContain("do not");
  });

  it("starts with a clear RETRY marker so model recognizes the intent", () => {
    const addendum = buildSelfAdmissionAddendum(["cannot verify"]);
    expect(addendum).toContain("RETRY");
    expect(addendum).toContain("SELF-ADMISSION");
  });
});
