import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression pin for qa:import-pdf--temperature-deprecated-raw-anthropic-blob.
// `temperature` is removed on Opus 4.7+ (400 "`temperature` is deprecated for
// this model") — the tier-resolved pdfParsing model rejects it, which killed
// every Vanguard PDF import. The same bug was fixed 2026-07-07 at the three
// classify-* sites; vanguard-pdf.ts was missed because it is a
// getRawAnthropicClient exception outside the generateText wrappers.

const streamCalls: Array<Record<string, unknown>> = [];

vi.mock("@/lib/ai/provider", () => ({
  getRawAnthropicClient: () => ({
    messages: {
      stream: (params: Record<string, unknown>) => {
        streamCalls.push(params);
        return {
          finalMessage: async () => ({
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  account_name: "Roth IRA Brokerage Account",
                  period_start: "2025-01-01",
                  period_end: "2025-01-31",
                  total_value: 100,
                  holdings: [],
                  transactions: [],
                }),
              },
            ],
          }),
        };
      },
    },
  }),
}));

vi.mock("@/lib/ai/models", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/models")>();
  return {
    ...original,
    resolveFeatureModel: () => ({ provider: "anthropic", modelId: "claude-opus-4-8" }),
  };
});

import {
  callClaudeForPdfExtraction,
  extractHoldingsFromPdf,
} from "@/lib/import/parsers/vanguard-pdf";

beforeEach(() => {
  streamCalls.length = 0;
});

describe("vanguard-pdf Anthropic request params", () => {
  it("callClaudeForPdfExtraction sends no sampling params (temperature removed on Opus 4.7+)", async () => {
    await callClaudeForPdfExtraction(Buffer.from("%PDF-fake"));
    expect(streamCalls.length).toBe(1);
    expect(streamCalls[0]).not.toHaveProperty("temperature");
    expect(streamCalls[0]).not.toHaveProperty("top_p");
    expect(streamCalls[0]).not.toHaveProperty("top_k");
  });

  it("extractHoldingsFromPdf (callClaudeWithPdf path) sends no sampling params", async () => {
    await extractHoldingsFromPdf(Buffer.from("%PDF-fake"));
    expect(streamCalls.length).toBeGreaterThanOrEqual(1);
    for (const params of streamCalls) {
      expect(params).not.toHaveProperty("temperature");
      expect(params).not.toHaveProperty("top_p");
      expect(params).not.toHaveProperty("top_k");
    }
  });
});
