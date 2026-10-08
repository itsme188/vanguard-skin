/**
 * QA unit C23 — a model refusal is never stored as a document's full text
 * (research-documents--stored-full-text-is-ai-refusal-message-not-the-article).
 *
 * Asked to copy out a document, the model sometimes answers with a refusal
 * ("I'm not able to reproduce the complete verbatim text..."). That answer
 * was stored as the document's full text and indexed for chat search. The
 * guard runs on the model's OUTPUT only; the request is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import {
  isRefusalShapedExtraction,
  extractResearchRawText,
  extractResearchPdf,
  RESEARCH_FULL_TEXT_REFUSED_PLACEHOLDER,
  parseClaudeResponse,
  ResearchPdfExtractionError,
  RESEARCH_FULL_TEXT_REFUSED_MESSAGE,
  RESEARCH_PDF_NO_READABLE_OUTPUT_MESSAGE,
} from "@/lib/research-documents/extract";
import { extractFromText, extractFromUrl } from "@/lib/research-documents/extract-forwarded";
import { getRawAnthropicClient } from "@/lib/ai/provider";

vi.mock("@/lib/ai/provider", () => ({ getRawAnthropicClient: vi.fn() }));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ modelId: "claude-test-model" })),
}));

// Synthetic, in the shape of the stored case.
const REFUSAL =
  "I'm not able to reproduce the complete verbatim text of this article, as it constitutes copyrighted written content (an earnings-recap report). I can, however, confirm that the full substance has been captured in the summary above.\n\nIf it would help, I'm happy to:\n- expand any section\n- quote short passages";

const ARTICLE =
  "AAA Corp reported second-quarter revenue ahead of its guide.\n\nManagement said it cannot reproduce last year's margin without price increases, and raised the full-year outlook.\n\nI can't say the quarter was clean: verbatim, the CFO called it \"noisy\".";

const META = JSON.stringify({
  title: "AAA Corp Q2 recap",
  document_type: "article",
  summary: "Revenue ahead of guide.",
  key_points: ["Guide raised"],
  mentioned_symbols: ["AAA"],
});

function mockModelText(...texts: string[]) {
  vi.mocked(getRawAnthropicClient).mockReturnValue({
    messages: {
      stream: () => ({
        finalMessage: () =>
          Promise.resolve({ content: texts.map((text) => ({ type: "text", text })) }),
      }),
    },
  } as never);
}

describe("isRefusalShapedExtraction", () => {
  it("recognises a refusal to copy the text out", () => {
    expect(isRefusalShapedExtraction(REFUSAL)).toBe(true);
    for (const text of [
      "I cannot provide the full text of this document because it is copyrighted material.",
      "I apologize, but I can't reproduce this article verbatim.",
      "Sorry, but I am unable to transcribe the entire document.",
      "I’m not able to reproduce the complete text of this report. Here is a summary instead:\n\nRevenue rose.",
      "  \n```\nI won't be able to output the full text of this copyrighted article.",
    ]) {
      expect(isRefusalShapedExtraction(text), text).toBe(true);
    }
  });

  it("leaves real document text alone, including first-person prose", () => {
    expect(isRefusalShapedExtraction(ARTICLE)).toBe(false);
    for (const text of [
      "",
      "I cannot recommend the shares at this price. The valuation already assumes a full recovery.",
      "I am unable to attend the annual meeting this year, so this letter is longer than usual.",
      "Copyright 2026 AAA Research. Reproduction of the full text is prohibited.\n\nWe initiate at Buy.",
      "Dear partners,\n\nI can't remember a quarter like this one.",
      // The refusal wording appears, but far into a real document.
      `${"The fund returned to its benchmark this quarter. ".repeat(20)}I cannot reproduce the full text of the filing here.`,
    ]) {
      expect(isRefusalShapedExtraction(text), text).toBe(false);
    }
  });
});

describe("extractResearchRawText (uploaded PDF)", () => {
  it("fails with a plain sentence instead of returning a refusal as the body", async () => {
    mockModelText(REFUSAL);
    const err = await extractResearchRawText(new Uint8Array([1, 2, 3])).catch((e) => e);
    expect(err).toBeInstanceOf(ResearchPdfExtractionError);
    expect(err.message).toBe(RESEARCH_FULL_TEXT_REFUSED_MESSAGE);
    expect(err.kind).toBe("unusable_output");
    // The refusal itself is never passed along as a snippet.
    expect(err.rawSnippet).toBe("");
  });

  it("returns a real body unchanged", async () => {
    mockModelText(ARTICLE);
    await expect(extractResearchRawText(new Uint8Array([1, 2, 3]))).resolves.toBe(ARTICLE);
  });
});

describe("extractResearchPdf (forwarded PDF, metadata and body together)", () => {
  // One client, two requests: answer each by the prompt it carries.
  function mockByPrompt(bodyAnswer: string | Error) {
    vi.mocked(getRawAnthropicClient).mockReturnValue({
      messages: {
        stream: (args: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) => ({
          finalMessage: () => {
            const prompt = args.messages[0].content.find((b) => b.type === "text")?.text ?? "";
            if (!prompt.includes("Extract the FULL plain-text body")) {
              return Promise.resolve({ content: [{ type: "text", text: META }] });
            }
            return bodyAnswer instanceof Error
              ? Promise.reject(bodyAnswer)
              : Promise.resolve({ content: [{ type: "text", text: bodyAnswer }] });
          },
        }),
      },
    } as never);
  }

  it("keeps the document and says why there is no full text", async () => {
    mockByPrompt(REFUSAL);
    const doc = await extractResearchPdf(new Uint8Array([1, 2, 3]));
    expect(doc.title).toBe("AAA Corp Q2 recap");
    expect(doc.raw_text).toBe(RESEARCH_FULL_TEXT_REFUSED_PLACEHOLDER);
    expect(doc.raw_text).not.toContain("I'm not able to");
    // The placeholder must never itself read as a refusal.
    expect(isRefusalShapedExtraction(RESEARCH_FULL_TEXT_REFUSED_PLACEHOLDER)).toBe(false);
  });

  it("returns a real body unchanged", async () => {
    mockByPrompt(ARTICLE);
    const doc = await extractResearchPdf(new Uint8Array([1, 2, 3]));
    expect(doc.raw_text).toBe(ARTICLE);
  });

  it("still fails on any other body failure", async () => {
    mockByPrompt(new Error("socket hang up"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(extractResearchPdf(new Uint8Array([1, 2, 3]))).rejects.toThrow("socket hang up");
    quiet.mockRestore();
  });
});

describe("parseClaudeResponse (forwarded link or screenshot)", () => {
  it("refuses a response whose body half is a refusal", () => {
    const raw = `${META}\n---RAW_TEXT_BEGIN---\n${REFUSAL}`;
    let err: unknown;
    try {
      parseClaudeResponse(raw, "claude-test-model");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResearchPdfExtractionError);
    expect((err as ResearchPdfExtractionError).message).toBe(RESEARCH_FULL_TEXT_REFUSED_MESSAGE);
    expect((err as ResearchPdfExtractionError).kind).toBe("unusable_output");
    expect((err as ResearchPdfExtractionError).rawSnippet).toBe("");
  });

  it("still parses a real body", () => {
    const out = parseClaudeResponse(`${META}\n---RAW_TEXT_BEGIN---\n${ARTICLE}`, "claude-test-model");
    expect(out.raw_text).toBe(ARTICLE);
    expect(out.title).toBe("AAA Corp Q2 recap");
  });

  it("a refused link rejects, which is what sends the inbox to its own page fetch", async () => {
    const deps = {
      modelId: "claude-test-model",
      callClaude: async () => `${META}\n---RAW_TEXT_BEGIN---\n${REFUSAL}`,
    };
    await expect(extractFromUrl("https://example.com/a", deps)).rejects.toBeInstanceOf(
      ResearchPdfExtractionError,
    );
  });
});

describe("forwarded extraction: a model answer with no text", () => {
  it("is a plain sentence with no snippet, classed as unusable output", async () => {
    vi.mocked(getRawAnthropicClient).mockReturnValue({
      messages: {
        stream: () => ({
          finalMessage: () =>
            Promise.resolve({ content: [{ type: "server_tool_use", id: "t", name: "web_fetch" }] }),
        }),
      },
    } as never);
    const err = await extractFromText("Some forwarded text.").catch((e) => e);
    expect(err).toBeInstanceOf(ResearchPdfExtractionError);
    expect(err.message).toBe(RESEARCH_PDF_NO_READABLE_OUTPUT_MESSAGE);
    expect(err.message).not.toMatch(/text block|[\[\]{}]/i);
    expect(err.rawSnippet).toBe("");
    expect(err.kind).toBe("unusable_output");
  });
});
