/**
 * Bogey intake 2026-11-18 (Task B): the extractor reads pasted text as well
 * as a file, can be told which one company to read, and is shown the lines
 * already on that company's sheet so it reuses their labels. An SDK error is
 * kept on `cause`, so a route can tell an account outage from a bad file.
 *
 * The SDK is mocked: no real AI call. Synthetic tickers and invented figures.
 */
import { describe, it, expect, vi } from "vitest";
import { APIError } from "@anthropic-ai/sdk";
import {
  buildExtractionPrompt,
  extractBogeys,
  extractBogeysFromUpload,
  BogeysExtractionError,
  EXTRACTION_PROMPT,
  MAX_PASTE_CHARS,
} from "@/lib/earnings/extract-bogeys";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { accountFailureOf } from "@/lib/earnings/ai-unavailable";

vi.mock("@/lib/ai/provider", () => ({ getRawAnthropicClient: vi.fn() }));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ modelId: "claude-test-model" })),
}));

type Block = { type: string; text?: string; source?: { media_type: string } };

function mockStream(final: Record<string, unknown> = { content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" }) {
  const calls: Array<{ messages: Array<{ content: Block[] }> }> = [];
  vi.mocked(getRawAnthropicClient).mockReturnValue({
    messages: {
      stream: (args: { messages: Array<{ content: Block[] }> }) => {
        calls.push(args);
        return { finalMessage: () => Promise.resolve(final) };
      },
    },
  } as never);
  return calls;
}

function mockReject(err: unknown) {
  vi.mocked(getRawAnthropicClient).mockReturnValue({
    messages: { stream: () => ({ finalMessage: () => Promise.reject(err) }) },
  } as never);
}

function billingError() {
  const payload = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
    request_id: "req_testBILLING",
  };
  return new APIError(400, payload, `400 ${JSON.stringify(payload)}`, new Headers());
}

describe("buildExtractionPrompt", () => {
  it("is the plain prompt with no context", () => {
    expect(buildExtractionPrompt()).toBe(EXTRACTION_PROMPT);
    expect(buildExtractionPrompt({})).toBe(EXTRACTION_PROMPT);
  });

  it("prompt_names_only_symbol_and_existing_lines", () => {
    const prompt = buildExtractionPrompt({
      onlySymbol: "ACME",
      existingLinesBySymbol: { ACME: ['"Net new ARR" [usd, Q, na]'], BETA: [] },
    });
    expect(prompt.startsWith(EXTRACTION_PROMPT)).toBe(true);
    expect(prompt).toContain("Only extract for ACME");
    expect(prompt).toContain('"Net new ARR" [usd, Q, na]');
    expect(prompt).toContain("reuse its label exactly");
    // A symbol with no lines adds nothing.
    expect(prompt).not.toMatch(/BETA:/);
  });

  it("lists lines per symbol for a multi-company page with no only-symbol block", () => {
    const prompt = buildExtractionPrompt({
      existingLinesBySymbol: { ACME: ['"Net new ARR" [usd, Q, na]'], BETA: ['"Gross margin" [pct, Q, non_gaap]'] },
    });
    expect(prompt).not.toContain("Only extract for");
    expect(prompt).toContain('ACME: "Net new ARR" [usd, Q, na]');
    expect(prompt).toContain('BETA: "Gross margin" [pct, Q, non_gaap]');
  });
});

describe("extractBogeys input kinds", () => {
  it("text_input_sends_text_block before the prompt", async () => {
    const calls = mockStream();
    await extractBogeys({ kind: "text", text: "ACME preview: revenue whisper 3.4B" }, { onlySymbol: "ACME" });
    const content = calls[0].messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("ACME preview: revenue whisper 3.4B");
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("Only extract for ACME");
  });

  it("a file input still sends a document block, with the context prompt", async () => {
    const calls = mockStream();
    await extractBogeys(
      { kind: "file", bytes: new Uint8Array([1, 2]), mediaType: "application/pdf" },
      { onlySymbol: "ACME" },
    );
    const content = calls[0].messages[0].content;
    expect(content[0].type).toBe("document");
    expect(content[1].text).toContain("Only extract for ACME");
  });

  it("extractBogeysFromUpload passes its context through", async () => {
    const calls = mockStream();
    await extractBogeysFromUpload(new Uint8Array([1]), "image/png", {
      existingLinesBySymbol: { ACME: ['"Net new ARR" [usd, Q, na]'] },
    });
    expect(calls[0].messages[0].content[1].text).toContain('"Net new ARR" [usd, Q, na]');
  });

  it("paste_too_long_refused without calling the model", async () => {
    const calls = mockStream();
    const err = await extractBogeys({ kind: "text", text: "x".repeat(MAX_PASTE_CHARS + 1) }).catch((e) => e);
    expect(err).toBeInstanceOf(BogeysExtractionError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/too long/i);
    expect(calls).toHaveLength(0);
  });

  it("blank pasted text is refused without calling the model", async () => {
    const calls = mockStream();
    const err = await extractBogeys({ kind: "text", text: "   \n " }).catch((e) => e);
    expect(err).toBeInstanceOf(BogeysExtractionError);
    expect(err.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("BogeysExtractionError keeps the SDK error", () => {
  it("a billing error is kept on cause and classifies as an account outage", async () => {
    const sdkErr = billingError();
    mockReject(sdkErr);
    const err = await extractBogeys({ kind: "text", text: "ACME preview" }).catch((e) => e);
    expect(err).toBeInstanceOf(BogeysExtractionError);
    expect(err.cause).toBe(sdkErr);
    expect(accountFailureOf(err)).toBe("billing");
  });

  it("a connection failure is kept on cause too", async () => {
    const raw = new Error("ECONNRESET");
    mockReject(raw);
    const err = await extractBogeys({ kind: "text", text: "ACME preview" }).catch((e) => e);
    expect(err).toBeInstanceOf(BogeysExtractionError);
    expect(err.cause).toBe(raw);
  });
});
