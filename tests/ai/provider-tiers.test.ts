/**
 * Provider tier tables + provider-aware tier expansion (provider-failover
 * slice 1, docs/superpowers/specs/2026-11-02-provider-failover-design.md).
 *
 * Before this change, expandSpec resolved EVERY provider's $tier token
 * against the Anthropic live catalog — an "openai/$frontier" override would
 * have handed a Claude model id to OpenAI. These tests pin the per-provider
 * tables and prove Anthropic resolution is untouched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FEATURE_MODELS, resolveFeatureModel } from "@/lib/ai/models";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { PROVIDER_TIER_MODELS, resolveProviderTierModel } from "@/lib/ai/model-tiers";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";

describe("PROVIDER_TIER_MODELS", () => {
  it("pins the OpenAI tier ids verified against platform.openai.com/docs/models", () => {
    expect(PROVIDER_TIER_MODELS["openai"]).toEqual({
      frontier: "gpt-6-astra",
      workhorse: "gpt-6.1-sol",
      cheap: "gpt-6-luna",
    });
  });

  it("pins the Workers AI tier ids verified against developers.cloudflare.com/workers-ai/models", () => {
    expect(PROVIDER_TIER_MODELS["workers-ai"]).toEqual({
      frontier: "@cf/openai/gpt-oss-120b",
      workhorse: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      cheap: "@cf/meta/llama-4-scout-17b-16e-instruct",
    });
  });

  it("resolveProviderTierModel resolves table entries and nothing else", () => {
    expect(resolveProviderTierModel("openai", "frontier")).toBe("gpt-6-astra");
    expect(resolveProviderTierModel("workers-ai", "workhorse")).toBe(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    );
    // Anthropic tiers live in the live catalog + ladders, never in the table.
    expect(resolveProviderTierModel("anthropic", "frontier")).toBeNull();
    expect(resolveProviderTierModel("no-such-provider", "cheap")).toBeNull();
  });
});

describe("resolveFeatureModel with non-Anthropic tier tokens", () => {
  beforeEach(() => {
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("openai/$frontier expands via the OpenAI table, not the Claude catalog", () => {
    setFeatureModelOverrideSource(() => ({ chat: "openai/$frontier" }));
    expect(resolveFeatureModel("chat")).toEqual({ provider: "openai", modelId: "gpt-6-astra" });
  });

  it("openai/$cheap expands to gpt-6-luna", () => {
    setFeatureModelOverrideSource(() => ({ chat: "openai/$cheap" }));
    expect(resolveFeatureModel("chat")).toEqual({ provider: "openai", modelId: "gpt-6-luna" });
  });

  it("workers-ai/$workhorse expands via the Workers AI table", () => {
    setFeatureModelOverrideSource(() => ({ chat: "workers-ai/$workhorse" }));
    expect(resolveFeatureModel("chat")).toEqual({
      provider: "workers-ai",
      modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
  });

  it("workers-ai/$cheap lands on the same model alertSuggestion pins explicitly", () => {
    setFeatureModelOverrideSource(() => ({ chat: "workers-ai/$cheap" }));
    expect(resolveFeatureModel("chat")).toEqual({
      provider: "workers-ai",
      modelId: "@cf/meta/llama-4-scout-17b-16e-instruct",
    });
  });

  it("anthropic tier tokens still expand via the live catalog", () => {
    setFeatureModelOverrideSource(() => ({ chat: "anthropic/$frontier" }));
    expect(resolveFeatureModel("chat")).toEqual({ provider: "anthropic", modelId: "claude-fable-5" });
  });

  it("feature defaults are unchanged: Anthropic everywhere except the alertSuggestion experiment", () => {
    for (const key of Object.keys(FEATURE_MODELS) as FeatureKey[]) {
      const resolved = resolveFeatureModel(key);
      if (key === "alertSuggestion") {
        expect(resolved).toEqual({
          provider: "workers-ai",
          modelId: "@cf/meta/llama-4-scout-17b-16e-instruct",
        });
      } else {
        expect(resolved.provider).toBe("anthropic");
        expect(resolved.modelId).toMatch(/^claude-/);
      }
    }
  });
});
