/**
 * The first-pass read is a frontier feature (2026-11-12): Opus 5.5 defaults
 * to medium effort where Opus 4.8 defaulted to high, so the app's default
 * generate seam asks for high effort explicitly, through the same transport
 * and cap as before.
 */
import { describe, it, expect, vi } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateObjectForFeature: (...a: unknown[]) => generateObjectMock(...a),
}));

import { generateFirstPassViaApp, FIRST_PASS_MAX_OUTPUT_TOKENS } from "@/lib/print-watch/read";

describe("generateFirstPassViaApp", () => {
  it("asks for high effort on the printWatchFirstPass feature, keeps the cap, reads back the answering model", async () => {
    generateObjectMock.mockResolvedValue({ object: { read: [] }, response: { modelId: "claude-opus-4-8" } });
    const abortSignal = new AbortController().signal;
    const out = await generateFirstPassViaApp({ system: "S", prompt: "P", schema: {}, abortSignal });

    const [feature, opts] = generateObjectMock.mock.calls[0];
    expect(feature).toBe("printWatchFirstPass");
    expect(opts.providerOptions).toEqual({ anthropic: { effort: "high" } });
    expect(opts.maxOutputTokens).toBe(FIRST_PASS_MAX_OUTPUT_TOKENS);
    expect(opts.abortSignal).toBe(abortSignal);
    expect(out).toEqual({ object: { read: [] }, modelId: "claude-opus-4-8" });
  });
});
