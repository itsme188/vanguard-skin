import { describe, it, expect, beforeEach, vi } from "vitest";

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), generateText: generateTextMock }));

import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { setFeatureModelOverrideSource } from "@/lib/ai/override-source";

class FakeNotFound extends Error { statusCode = 404; constructor() { super("model not_found"); } }

describe("generateTextForFeature", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    setFeatureModelOverrideSource(null);
    setModelCatalogSource(() => ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]);
  });

  it("returns text on success", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "ok", finishReason: "stop" });
    const r = await generateTextForFeature("chat", { prompt: "hi" });
    expect(r.text).toBe("ok");
  });

  it("on not_found, drops the dead model and retries once with the next rung", async () => {
    generateTextMock
      .mockRejectedValueOnce(new FakeNotFound())                  // fable 404s
      .mockResolvedValueOnce({ text: "ok2", finishReason: "stop" }); // opus succeeds
    const r = await generateTextForFeature("chat", { prompt: "hi" });
    expect(r.text).toBe("ok2");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    // Prove the first call used Fable and the retry used the NEXT rung (Opus), not Fable again.
    expect(generateTextMock.mock.calls[0][0].model.modelId).toBe("claude-fable-5");
    expect(generateTextMock.mock.calls[1][0].model.modelId).toBe("claude-opus-4-8");
  });

  it("on refusal finishReason, throws AIRefusalError (graceful, named)", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "", finishReason: "content-filter" });
    await expect(generateTextForFeature("chat", { prompt: "hi" })).rejects.toBeInstanceOf(AIRefusalError);
  });
});
