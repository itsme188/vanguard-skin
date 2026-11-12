/**
 * The morning debrief's model call (2026-11-12): an explicit cap with room
 * for default-on thinking (Sonnet 5.5 thinks by default at high effort and
 * the thinking counts against the cap), and a reply cut off at the cap is
 * a COMPOSE failure, never an email. A throw from the generator lands in
 * runMorningDebrief's compose catch: the fresh claims are released and the
 * members return to candidacy the next day (no resend today).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));

import { generateDebriefText } from "@/lib/earnings/debrief-send";

beforeEach(() => generateTextMock.mockReset());

describe("generateDebriefText", () => {
  it("asks earningsDebrief with room for thinking", async () => {
    generateTextMock.mockResolvedValue({ text: "Debrief body.", finishReason: "stop" });
    expect(await generateDebriefText("prompt")).toBe("Debrief body.");
    const [feature, opts] = generateTextMock.mock.calls[0];
    expect(feature).toBe("earningsDebrief");
    expect(opts.maxOutputTokens).toBeGreaterThanOrEqual(16_000);
  });

  it("a reply cut off at the cap throws instead of returning text to send", async () => {
    generateTextMock.mockResolvedValue({ text: "Debrief body that stops mid", finishReason: "length" });
    await expect(generateDebriefText("prompt")).rejects.toThrow(/cut off/);
  });
});
