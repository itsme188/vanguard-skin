/**
 * A cloud newsletter enrichment reply cut off at the output cap (2026-11-13)
 * is never stored, and it reads as an article-level failure, never as an AI
 * outage (which would stop the run and record ai-unavailable).
 */
import { describe, it, expect } from "vitest";
import { throwIfCutOffAtCap } from "../src/cut-off-at-cap";
import { accountFailureOf } from "../src/ai-outage";
import { classifyEnrichmentError } from "../src/enrichment-failure";

describe("throwIfCutOffAtCap", () => {
  it("passes a reply that ended normally", () => {
    expect(() => throwIfCutOffAtCap("fallbackNewsletterProcessing", "stop")).not.toThrow();
    expect(() => throwIfCutOffAtCap("fallbackNewsletterProcessing", undefined)).not.toThrow();
  });

  it("throws on a reply that stopped at the cap; the error is article-level, not an outage", () => {
    let caught: unknown;
    try {
      throwIfCutOffAtCap("fallbackNewsletterProcessing", "length");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(classifyEnrichmentError(caught)).toMatchObject({ scope: "article", kind: "malformed_output" });
    expect(accountFailureOf(caught)).toBeNull();
  });
});
