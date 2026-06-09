import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveFeatureModel, FEATURE_MODELS, parseModelSpec } from "@/lib/ai/models";
import {
  setFeatureModelOverrideSource,
  invalidateFeatureModelOverridesCache,
  getCachedFeatureModelOverrides,
} from "@/lib/ai/override-source";

// No real env keys / no real DB — the override source is a plain injected
// function (the production wiring in lib/db.ts registers the SQLite-backed
// reader; tests never import lib/db).

afterEach(() => {
  setFeatureModelOverrideSource(null);
  vi.useRealTimers();
});

describe("resolveFeatureModel with overrides", () => {
  it("falls back to FEATURE_MODELS when no source is registered", () => {
    expect(resolveFeatureModel("chat")).toEqual(parseModelSpec(FEATURE_MODELS.chat));
  });

  it("uses the override when the source provides one", () => {
    setFeatureModelOverrideSource(() => ({ chat: "openai/gpt-5-test" }));
    expect(resolveFeatureModel("chat")).toEqual({
      provider: "openai",
      modelId: "gpt-5-test",
    });
    // Sibling features stay on their defaults.
    expect(resolveFeatureModel("briefing")).toEqual(
      parseModelSpec(FEATURE_MODELS.briefing),
    );
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
    expect(resolveFeatureModel("chat")).toEqual(parseModelSpec(FEATURE_MODELS.chat));
  });

  it("falls back to the default when the override names an unknown provider", () => {
    setFeatureModelOverrideSource(() => ({ chat: "gemini/gemini-pro" }));
    expect(resolveFeatureModel("chat")).toEqual(parseModelSpec(FEATURE_MODELS.chat));
  });

  it("falls back silently when the source throws (missing settings table)", () => {
    setFeatureModelOverrideSource(() => {
      throw new Error("no such table: settings");
    });
    expect(resolveFeatureModel("chat")).toEqual(parseModelSpec(FEATURE_MODELS.chat));
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
