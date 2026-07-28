import { describe, it, expect } from "vitest";
import { suggestOutcomeMessage } from "@/lib/alerts/suggest-message";

/**
 * qa: alerts-inbox--suggest-all-reports-noop-when-all-failed
 * A run that attempted 6 and failed 6 must say so — pre-fix the page branched
 * only on generated > 0, so {generated: 0, failed: 6} collapsed into
 * "No pending alerts needed a suggestion." (honest-button-feedback rule).
 */
describe("suggestOutcomeMessage", () => {
  it("reports the generated count", () => {
    expect(suggestOutcomeMessage(2, 0)).toBe("Generated 2 suggestions.");
    expect(suggestOutcomeMessage(1, 0)).toBe("Generated 1 suggestion.");
  });

  it("appends the failed count to a partial success", () => {
    expect(suggestOutcomeMessage(1, 2)).toBe("Generated 1 suggestion (2 failed).");
  });

  it("an all-failure run reports the failures, never the no-op message", () => {
    expect(suggestOutcomeMessage(0, 6)).toBe(
      "No suggestions generated — 6 failed. Existing suggestions are unaffected; see the server log for the cause."
    );
  });

  it("a true no-op says nothing needed doing", () => {
    expect(suggestOutcomeMessage(0, 0)).toBe("No pending alerts needed a suggestion.");
  });

  it("treats a missing failed count as zero", () => {
    expect(suggestOutcomeMessage(0, undefined)).toBe("No pending alerts needed a suggestion.");
  });
});
