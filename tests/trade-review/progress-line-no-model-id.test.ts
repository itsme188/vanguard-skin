/**
 * [qa:dashboard-analysis-view-trade-reviews-generate-review-progress-line-trade-review-progress-line-shows-the-raw-m]
 *
 * The Generate Review progress line printed the raw provider model id
 * ("Analyzing 92 trade(s) with claude-sonnet-5-5..."). User copy names a
 * model by its family label ("Sonnet 5.5"), never by id. The progress
 * strings sit behind a paid AI call and there is no DOM harness, so the
 * call sites are source-pinned and the label helper is unit-tested.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { userFacingModelLabel } from "@/lib/ai/model-families";

describe("userFacingModelLabel", () => {
  it("names a parseable id by family and version", () => {
    expect(userFacingModelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(userFacingModelLabel("claude-opus-5-5")).toBe("Opus 5.5");
  });

  it("never echoes an id it cannot parse", () => {
    expect(userFacingModelLabel("some-vendor-model-x")).toBe("the AI model");
    expect(userFacingModelLabel("")).toBe("the AI model");
  });
});

describe("trade review progress lines carry no model id", () => {
  const src = readFileSync("lib/trade-review/generate.ts", "utf8");

  it("no onProgress message interpolates a raw model spec", () => {
    // Every onProgress call, up to its closing paren of the first argument.
    const calls = src.split("onProgress?.(").slice(1).map((c) => c.slice(0, 300));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toMatch(/\$\{\s*(modelSpec|fallbackSpec|modelUsedSpec)\s*\}/);
    }
  });

  it("the analyzing line names the model through the label helper", () => {
    expect(src).toMatch(/Analyzing \$\{tradeCount\} trade\(s\) with \$\{userFacingModelLabel\(modelSpec\)\}/);
  });
});
