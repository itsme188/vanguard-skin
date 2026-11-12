/**
 * Request options that differ by model GENERATION (2026-11-12): every call
 * site must be valid on the ids the tiers resolve to today (Sonnet 4.6,
 * Opus 4.8, Haiku 4.5 static fallbacks) AND on the 5.5 ids. Both branches of
 * every rule are pinned here. Rules from the Claude API reference (thinking
 * & effort table, checked 2026-11-12).
 */
import { describe, it, expect } from "vitest";
import {
  fastStructuredRequestOptions,
  supportsEffort,
  effortOption,
} from "@/lib/claude-request-options";

describe("fastStructuredRequestOptions — no thinking, lowest latency, valid per generation", () => {
  it("Sonnet 5.5 and later: between_tools (disabled is a 400 there), no effort", () => {
    expect(fastStructuredRequestOptions("claude-sonnet-5-5")).toEqual({ thinking: { type: "between_tools" } });
    expect(fastStructuredRequestOptions("claude-sonnet-6")).toEqual({ thinking: { type: "between_tools" } });
  });
  it("Sonnet 4.6 and Sonnet 5: disabled, as before", () => {
    expect(fastStructuredRequestOptions("claude-sonnet-4-6")).toEqual({ thinking: { type: "disabled" } });
    expect(fastStructuredRequestOptions("claude-sonnet-5")).toEqual({ thinking: { type: "disabled" } });
  });
  it("Opus 5.5 and later: thinking cannot be turned off, so no thinking field and effort low", () => {
    expect(fastStructuredRequestOptions("claude-opus-5-5")).toEqual({ effort: "low" });
  });
  it("Opus 4.8 and Opus 5: disabled (accepted at the default effort)", () => {
    expect(fastStructuredRequestOptions("claude-opus-4-8")).toEqual({ thinking: { type: "disabled" } });
    expect(fastStructuredRequestOptions("claude-opus-5")).toEqual({ thinking: { type: "disabled" } });
  });
  it("Haiku 4.5 and 5.5: disabled (5.5 accepts it at its default medium effort)", () => {
    expect(fastStructuredRequestOptions("claude-haiku-4-5-20251001")).toEqual({ thinking: { type: "disabled" } });
    expect(fastStructuredRequestOptions("claude-haiku-5-5")).toEqual({ thinking: { type: "disabled" } });
  });
  it("Fable and Mythos (thinking always on): effort low, no thinking field", () => {
    expect(fastStructuredRequestOptions("claude-fable-5-2")).toEqual({ effort: "low" });
    expect(fastStructuredRequestOptions("claude-mythos-5-1")).toEqual({ effort: "low" });
  });
  it("an id it cannot read keeps the old request (disabled)", () => {
    expect(fastStructuredRequestOptions("claude-custom-test-model")).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("supportsEffort / effortOption", () => {
  it("true where the effort parameter is accepted", () => {
    for (const id of [
      "claude-opus-4-8",
      "claude-opus-5-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-2",
    ]) {
      expect(supportsEffort(id), id).toBe(true);
    }
  });
  it("false where it errors (Haiku 4.5, Sonnet 4.5) or the id is unreadable", () => {
    for (const id of ["claude-haiku-4-5-20251001", "claude-sonnet-4-5", "gpt-6-astra", "not-a-model"]) {
      expect(supportsEffort(id), id).toBe(false);
    }
  });
  it("effortOption returns the field only when it is accepted", () => {
    expect(effortOption("claude-opus-5-5", "high")).toEqual({ effort: "high" });
    expect(effortOption("claude-opus-4-8", "high")).toEqual({ effort: "high" });
    expect(effortOption("claude-haiku-4-5", "high")).toEqual({});
  });
});
