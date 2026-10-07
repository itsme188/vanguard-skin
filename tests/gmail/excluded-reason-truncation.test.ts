import { describe, it, expect } from "vitest";
import { truncateExcludedReason } from "@/lib/gmail/process";

describe("truncateExcludedReason (QA B50)", () => {
  it("leaves a short reason untouched", () => {
    expect(truncateExcludedReason("Off topic.")).toBe("Off topic.");
  });
  it("cuts a long reason at a word boundary with an ellipsis, within 280 chars", () => {
    const long = "alpha beta gamma ".repeat(40);
    const out = truncateExcludedReason(long);
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith("…")).toBe(true);
    const body = out.slice(0, -1);
    expect(body.endsWith("alpha") || body.endsWith("beta") || body.endsWith("gamma")).toBe(true);
  });
  it("hard-cuts a single unbroken run and still marks the cut", () => {
    const out = truncateExcludedReason("x".repeat(500));
    expect(out.length).toBe(280);
    expect(out.endsWith("…")).toBe(true);
  });
});
