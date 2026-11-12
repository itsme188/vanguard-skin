/**
 * The sector sweep is a frontier feature on the raw client (2026-11-12):
 * high effort asked for explicitly (Opus 5.5 defaults to medium), room for
 * default-on thinking, and a reply cut off at max_tokens fails the batch
 * instead of being parsed. With no catalog the tier resolves to its static
 * fallback; the request must be valid on that id and on the 5.5 ids.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  return { ...actual, getRawAnthropicClient: vi.fn(() => ({ messages: { create: mockCreate } })) };
});

import { defaultFetchVerdicts } from "@/lib/securities/verify-sector-tags";
import { resolveFeatureModel } from "@/lib/ai/models";

const BATCH = [{ id: 1, symbol: "XMPL", name: "Exemplar Devices", industry: null, fund_category: null, sector: null }];

beforeEach(() => mockCreate.mockReset());

describe("defaultFetchVerdicts request", () => {
  it("asks for high effort with room for thinking", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" });
    await defaultFetchVerdicts(BATCH);
    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe(resolveFeatureModel("sectorVerification").modelId);
    expect(params.output_config).toEqual({ effort: "high" });
    expect(params.max_tokens).toBeGreaterThanOrEqual(16_000);
    expect(params.max_tokens).toBeLessThanOrEqual(21_000);
  });

  it("a reply cut off at max_tokens fails the batch", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[{\"symbol\":" }], stop_reason: "max_tokens" });
    await expect(defaultFetchVerdicts(BATCH)).rejects.toThrow(/max_tokens/);
  });
});
