import { describe, it, expect } from "vitest";
import { FEATURE_MODELS, resolveFeatureModel } from "@/lib/ai/models";

describe("printWatchFirstPass feature key", () => {
  it("is registered on the frontier tier and resolves to a concrete model id", () => {
    expect(FEATURE_MODELS.printWatchFirstPass).toBe("anthropic/$frontier");
    const r = resolveFeatureModel("printWatchFirstPass");
    expect(r.provider).toBe("anthropic");
    expect(r.modelId).toMatch(/^claude-/);
  });
});
