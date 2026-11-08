import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveFeatureModel, FEATURE_MODELS } from "@/lib/ai/models";
import {
  setFeatureModelOverrideSource,
  invalidateFeatureModelOverridesCache,
  getCachedFeatureModelOverrides,
} from "@/lib/ai/override-source";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { TIER_STATIC_FALLBACK } from "@/lib/ai/model-tiers";

// No real env keys / no real DB — the override source is a plain injected
// function (the production wiring in lib/db.ts registers the SQLite-backed
// reader; tests never import lib/db).
//
// FEATURE_MODELS now holds tier tokens (e.g. "anthropic/$workhorse") so
// `parseModelSpec(FEATURE_MODELS.chat)` would yield a literal "$workhorse"
// modelId — not the tier-expanded value. These tests use TIER_STATIC_FALLBACK
// as the expected resolved model when the catalog is empty (no source set).

afterEach(() => {
  setFeatureModelOverrideSource(null);
  setModelCatalogSource(null);
  vi.useRealTimers();
});

describe("resolveFeatureModel with overrides", () => {
  // `chat` is a $workhorse feature since the 2026-11-07 model-policy ruling.
  it("falls back to FEATURE_MODELS when no source is registered", () => {
    // With no catalog source, $workhorse resolves to TIER_STATIC_FALLBACK.workhorse.
    expect(resolveFeatureModel("chat")).toEqual({
      provider: "anthropic",
      modelId: TIER_STATIC_FALLBACK.workhorse,
    });
  });

  it("uses the override when the source provides one", () => {
    setFeatureModelOverrideSource(() => ({ chat: "openai/gpt-5-test" }));
    expect(resolveFeatureModel("chat")).toEqual({
      provider: "openai",
      modelId: "gpt-5-test",
    });
    // Sibling features stay on their defaults ($workhorse → static fallback when no catalog).
    expect(resolveFeatureModel("briefing")).toEqual({
      provider: "anthropic",
      modelId: TIER_STATIC_FALLBACK.workhorse,
    });
  });

  it("supports workers-ai overrides with slashes in the model id", () => {
    setFeatureModelOverrideSource(() => ({
      chat: "workers-ai/@cf/meta/llama-3.3-70b-instruct",
    }));
    expect(resolveFeatureModel("chat")).toEqual({
      provider: "workers-ai",
      modelId: "@cf/meta/llama-3.3-70b-instruct",
    });
  });

  it("falls back to the default when the override spec is malformed", () => {
    setFeatureModelOverrideSource(() => ({ chat: "gibberish-no-provider" }));
    // Malformed override falls through to tier expansion ($workhorse → static fallback).
    expect(resolveFeatureModel("chat")).toEqual({
      provider: "anthropic",
      modelId: TIER_STATIC_FALLBACK.workhorse,
    });
  });

  it("falls back to the default when the override names an unknown provider", () => {
    setFeatureModelOverrideSource(() => ({ chat: "gemini/gemini-pro" }));
    expect(resolveFeatureModel("chat")).toEqual({
      provider: "anthropic",
      modelId: TIER_STATIC_FALLBACK.workhorse,
    });
  });

  it("falls back silently when the source throws (missing settings table)", () => {
    setFeatureModelOverrideSource(() => {
      throw new Error("no such table: settings");
    });
    expect(resolveFeatureModel("chat")).toEqual({
      provider: "anthropic",
      modelId: TIER_STATIC_FALLBACK.workhorse,
    });
  });

  // Verify FEATURE_MODELS still exports valid tier-token specs (not concrete ids).
  it("FEATURE_MODELS still contains valid tier-token specs", () => {
    expect(FEATURE_MODELS.chat).toBe("anthropic/$workhorse");
    expect(FEATURE_MODELS.printWatchFirstPass).toBe("anthropic/$frontier");
    expect(FEATURE_MODELS.newsletterProcessing).toBe("anthropic/$workhorse");
    expect(FEATURE_MODELS.researchMentionVerification).toBe("anthropic/$cheap");
    expect(FEATURE_MODELS.alertSuggestion).toBe("workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct");
  });
});

describe("override cache", () => {
  it("reads the source once within the TTL window", () => {
    const source = vi.fn(() => ({ chat: "anthropic/claude-test-1" }));
    setFeatureModelOverrideSource(source);
    resolveFeatureModel("chat");
    resolveFeatureModel("chat");
    resolveFeatureModel("briefing");
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the TTL expires", () => {
    vi.useFakeTimers();
    const source = vi.fn(() => ({}));
    setFeatureModelOverrideSource(source);
    resolveFeatureModel("chat");
    vi.advanceTimersByTime(31_000);
    resolveFeatureModel("chat");
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("re-reads immediately after invalidateFeatureModelOverridesCache()", () => {
    const source = vi.fn(() => ({}));
    setFeatureModelOverrideSource(source);
    resolveFeatureModel("chat");
    invalidateFeatureModelOverridesCache();
    resolveFeatureModel("chat");
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("registering a new source resets the cache", () => {
    setFeatureModelOverrideSource(() => ({ chat: "anthropic/claude-test-1" }));
    expect(resolveFeatureModel("chat").modelId).toBe("claude-test-1");
    setFeatureModelOverrideSource(() => ({ chat: "anthropic/claude-test-2" }));
    expect(resolveFeatureModel("chat").modelId).toBe("claude-test-2");
  });

  it("getCachedFeatureModelOverrides returns {} with no source", () => {
    expect(getCachedFeatureModelOverrides()).toEqual({});
  });
});
