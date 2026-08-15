import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression pin for qa:import-failed--corrupt-pdf-raw-anthropic-envelope.
//
// A corrupt/unparseable PDF makes Claude answer in prose instead of the
// requested JSON schema. `callClaudeWithPdf` (the code path actually used by
// the live import UI via extractHoldingsFromPdf/extractTransactionsFromPdf/
// parseVanguardPdf) called a bare `JSON.parse(jsonText)` with no try/catch,
// so the raw V8 SyntaxError propagated all the way to the import API route
// and out to the UI verbatim. The sibling call site in
// callClaudeForPdfExtraction (used only by scripts/generate-pdf-fixture.ts)
// already wraps this in a clean try/catch — this suite pins that
// callClaudeWithPdf now matches it.
//
// Separately, a well-formed-but-incomplete JSON response missing
// `total_value` null-derefed on `response.total_value.toLocaleString()`
// inside extractHoldingsFromPdf's progress logging, throwing a raw
// TypeError instead of a clean, human-readable error.

const streamText = { value: "" };

vi.mock("@/lib/ai/provider", () => ({
  getRawAnthropicClient: () => ({
    messages: {
      stream: () => ({
        finalMessage: async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: streamText.value }],
        }),
      }),
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
  streamText.value = "";
});

describe("vanguard-pdf error handling — corrupt/unparseable PDF responses", () => {
  describe("non-JSON prose response", () => {
    const prose =
      "I'm sorry, but I'm unable to read this PDF. It appears to be corrupted or empty, and I cannot extract any statement data from it.";

    it("callClaudeForPdfExtraction throws a clean error (existing guarded call site)", async () => {
      streamText.value = prose;
      await expect(
        callClaudeForPdfExtraction(Buffer.from("%PDF-fake"))
      ).rejects.toThrow(/Failed to parse Claude response as JSON/);
    });

    it("extractHoldingsFromPdf throws a clean, human-readable error instead of a raw SyntaxError", async () => {
      streamText.value = prose;

      let caught: unknown;
      try {
        await extractHoldingsFromPdf(Buffer.from("%PDF-fake"));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;

      // Clean, mirrors the sibling try/catch pattern — not a raw V8
      // SyntaxError ("Unexpected token ... is not valid JSON").
      expect(message).toMatch(/Failed to parse Claude response as JSON/);
      expect(message).not.toMatch(/Unexpected token/i);
      expect(message).not.toMatch(/^SyntaxError/);
      expect(message).not.toMatch(/is not valid JSON$/);
    });

    it("wraps a markdown-fenced prose refusal the same way", async () => {
      // Even after fence-stripping, this still isn't valid JSON.
      streamText.value = "```\nSorry, I can't process this file.\n```";

      await expect(
        extractHoldingsFromPdf(Buffer.from("%PDF-fake"))
      ).rejects.toThrow(/Failed to parse Claude response as JSON/);
    });
  });

  describe("valid JSON missing total_value", () => {
    it("extractHoldingsFromPdf throws a clean error, not a TypeError", async () => {
      streamText.value = JSON.stringify({
        account_type: "Individual brokerage account",
        account_number_masked: "XXXX1234",
        statement_date: "2025-01-31",
        // total_value intentionally omitted
        prior_value: null,
        cash_balance: 0,
        income_summary: { dividends: 0, interest: 0 },
        holdings: [],
        transactions: [],
      });

      let caught: unknown;
      try {
        await extractHoldingsFromPdf(Buffer.from("%PDF-fake"));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(TypeError);
      const message = (caught as Error).message;
      // Not the raw runtime TypeError text.
      expect(message).not.toMatch(/Cannot read propert/i);
      expect(message).not.toMatch(/undefined is not an object/i);
      // Clean, human-readable explanation instead.
      expect(message.toLowerCase()).toContain("total");
    });
  });
});
