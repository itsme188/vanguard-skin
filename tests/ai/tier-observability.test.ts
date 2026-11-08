import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveFeatureModel, __resetTierLog } from "@/lib/ai/models";
import { setModelCatalogSource, invalidateModelCatalogCache } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";

describe("tier resolution observability", () => {
  beforeEach(() => {
    setFeatureModelOverrideSource(null);
    __resetTierLog();
  });
  it("logs once when a tier's resolved model changes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // `printWatchFirstPass` is the $frontier feature after the 2026-11-07 ruling.
    setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6"]);
    resolveFeatureModel("printWatchFirstPass"); // opus (first resolution — no log)
    setModelCatalogSource(() => ["claude-sonnet-4-6"]); invalidateModelCatalogCache();
    resolveFeatureModel("printWatchFirstPass"); // → sonnet, should log the change
    expect(log).toHaveBeenCalledWith(expect.stringContaining("frontier"));
    log.mockRestore();
  });
  it("does not log on the first resolution", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    setModelCatalogSource(() => ["claude-opus-4-8"]);
    resolveFeatureModel("printWatchFirstPass");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("tier"));
    log.mockRestore();
  });
});
