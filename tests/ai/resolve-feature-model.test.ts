import { describe, it, expect, beforeEach } from "vitest";
import { resolveFeatureModel } from "@/lib/ai/models";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";

describe("resolveFeatureModel tier expansion", () => {
  beforeEach(() => {
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
  });

  it("expands $frontier to the newest top-family model", () => {
    expect(resolveFeatureModel("chat")).toEqual({ provider: "anthropic", modelId: "claude-fable-5" });
  });
  it("expands $workhorse to Sonnet", () => {
    expect(resolveFeatureModel("newsletterProcessing")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
  });
  it("expands $cheap to Haiku", () => {
    expect(resolveFeatureModel("researchMentionVerification")).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5" });
  });
  it("frontier falls to Opus when Fable is absent from the catalog", () => {
    setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(resolveFeatureModel("chat").modelId).toBe("claude-opus-4-8");
  });
  it("empty catalog → static fallback", () => {
    setModelCatalogSource(() => []);
    expect(resolveFeatureModel("chat").modelId).toBe("claude-opus-4-8");
  });
  it("explicit non-tier spec passes through untouched", () => {
    expect(resolveFeatureModel("alertSuggestion").provider).toBe("workers-ai");
  });
  it("user override beats the tier token", () => {
    setFeatureModelOverrideSource(() => ({ chat: "anthropic/claude-opus-4-7" }));
    expect(resolveFeatureModel("chat").modelId).toBe("claude-opus-4-7");
  });
  it("malformed override falls back to the tier default", () => {
    setFeatureModelOverrideSource(() => ({ chat: "garbage-no-slash" }));
    expect(resolveFeatureModel("chat").modelId).toBe("claude-fable-5");
  });
});
