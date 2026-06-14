import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedModelCatalog,
  setModelCatalogSource,
  invalidateModelCatalogCache,
  dropModelFromCatalog,
} from "@/lib/ai/catalog-source";

describe("catalog-source", () => {
  beforeEach(() => setModelCatalogSource(null));

  it("returns [] when no source registered", () => {
    expect(getCachedModelCatalog()).toEqual([]);
  });
  it("reads from the registered source", () => {
    setModelCatalogSource(() => ["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(getCachedModelCatalog()).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
  });
  it("returns [] (not throw) when the source throws", () => {
    setModelCatalogSource(() => { throw new Error("no table"); });
    expect(getCachedModelCatalog()).toEqual([]);
  });
  it("dropModelFromCatalog removes an id from the in-memory working set", () => {
    setModelCatalogSource(() => ["claude-fable-5", "claude-opus-4-8"]);
    getCachedModelCatalog();           // prime cache
    dropModelFromCatalog("claude-fable-5");
    expect(getCachedModelCatalog()).toEqual(["claude-opus-4-8"]);
  });
  it("invalidate forces a re-read", () => {
    let v = ["claude-opus-4-8"];
    setModelCatalogSource(() => v);
    expect(getCachedModelCatalog()).toEqual(["claude-opus-4-8"]);
    v = ["claude-fable-5", "claude-opus-4-8"];
    invalidateModelCatalogCache();
    expect(getCachedModelCatalog()).toEqual(["claude-fable-5", "claude-opus-4-8"]);
  });
});
