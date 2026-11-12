import { describe, it, expect, beforeEach } from "vitest";
import { resolveFeatureModel } from "@/lib/ai/models";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";

// A catalog the way /v1/models lists it: every generation still served.
const CATALOG = [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
];

describe("resolveFeatureModel tier expansion", () => {
  beforeEach(() => {
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => CATALOG);
  });

  // `printWatchFirstPass` is a $frontier feature; `chat` moved to $workhorse
  // with the 2026-11-07 model-policy ruling.
  it("expands $frontier to the current Opus, never the Fable the catalog lists", () => {
    expect(resolveFeatureModel("printWatchFirstPass")).toEqual({ provider: "anthropic", modelId: "claude-opus-5-5" });
  });
  it("expands a feature that moved to $workhorse to the current Sonnet", () => {
    expect(resolveFeatureModel("chat")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
  });
  it("expands $workhorse to the current Sonnet", () => {
    expect(resolveFeatureModel("newsletterProcessing")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
  });
  it("expands $cheap to the current Haiku", () => {
    expect(resolveFeatureModel("researchMentionVerification")).toEqual({ provider: "anthropic", modelId: "claude-haiku-5-5" });
  });
  it("frontier falls to the current Sonnet when Opus is absent from the catalog", () => {
    setModelCatalogSource(() => ["claude-sonnet-5-5", "claude-sonnet-4-6"]);
    expect(resolveFeatureModel("printWatchFirstPass").modelId).toBe("claude-sonnet-5-5");
  });
  it("empty catalog (fresh database) → the current id of each class", () => {
    setModelCatalogSource(() => []);
    expect(resolveFeatureModel("printWatchFirstPass").modelId).toBe("claude-opus-5-5");
    expect(resolveFeatureModel("chat").modelId).toBe("claude-sonnet-5-5");
    expect(resolveFeatureModel("researchMentionVerification").modelId).toBe("claude-haiku-5-5");
  });
  it("a stale catalog listing only older generations still resolves to the current ids", () => {
    setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
    expect(resolveFeatureModel("printWatchFirstPass").modelId).toBe("claude-opus-5-5");
    expect(resolveFeatureModel("chat").modelId).toBe("claude-sonnet-5-5");
  });
  it("explicit non-tier spec passes through untouched", () => {
    expect(resolveFeatureModel("alertSuggestion").provider).toBe("workers-ai");
  });
  it("user override beats the tier token", () => {
    setFeatureModelOverrideSource(() => ({ chat: "anthropic/claude-opus-5-5" }));
    expect(resolveFeatureModel("chat").modelId).toBe("claude-opus-5-5");
  });
  it("a stored override naming an OLDER generation runs on that class's current id (2026-11-12)", () => {
    setFeatureModelOverrideSource(() => ({
      chat: "anthropic/claude-opus-4-7",
      briefing: "anthropic/claude-sonnet-4-6",
      overnightCommentary: "anthropic/claude-haiku-4-5-20251001",
    }));
    expect(resolveFeatureModel("chat").modelId).toBe("claude-opus-5-5");
    expect(resolveFeatureModel("briefing").modelId).toBe("claude-sonnet-5-5");
    expect(resolveFeatureModel("overnightCommentary").modelId).toBe("claude-haiku-5-5");
  });
  it("a stored override naming a newer generation or a non-Claude model is kept as written", () => {
    setFeatureModelOverrideSource(() => ({
      chat: "anthropic/claude-sonnet-6",
      briefing: "openai/gpt-6-astra",
    }));
    expect(resolveFeatureModel("chat").modelId).toBe("claude-sonnet-6");
    expect(resolveFeatureModel("briefing")).toEqual({ provider: "openai", modelId: "gpt-6-astra" });
  });
  it("malformed override falls back to the tier default", () => {
    setFeatureModelOverrideSource(() => ({ chat: "garbage-no-slash" }));
    expect(resolveFeatureModel("chat").modelId).toBe("claude-sonnet-5-5");
  });
});
