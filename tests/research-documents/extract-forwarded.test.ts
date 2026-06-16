import { describe, it, expect } from "vitest";
import {
  extractFromText,
  extractFromImage,
  extractFromUrl,
  type ForwardedExtractDeps,
} from "@/lib/research-documents/extract-forwarded";

function stubDeps(response: string): {
  deps: ForwardedExtractDeps;
  calls: Array<{ blocks: unknown; tools?: unknown; maxTokens: number }>;
} {
  const calls: Array<{ blocks: unknown; tools?: unknown; maxTokens: number }> = [];
  return {
    calls,
    deps: {
      modelId: "claude-test",
      callClaude: async (args) => {
        calls.push(args);
        return response;
      },
    },
  };
}

const META_JSON = JSON.stringify({
  title: "The AI Capex Supercycle",
  author: "Jane Analyst",
  source: "Stratechery",
  document_type: "article",
  publication_date: "2026-06-10",
  summary: "A long look at hyperscaler capex.",
  key_points: ["Capex is up", "Margins compress"],
  mentioned_symbols: ["NVDA", "msft"],
  suggested_tags: ["AI Infrastructure", "semiconductors"],
  sentiment: "bullish",
  target_prices: [{ symbol: "NVDA", price: 1500, horizon: "12mo" }],
});

describe("extractFromText", () => {
  it("parses metadata and uses the input as raw_text (no echo)", async () => {
    const { deps, calls } = stubDeps(META_JSON);
    const body = "Forwarded long read body ".repeat(20);
    const doc = await extractFromText(body, deps);

    expect(doc.title).toBe("The AI Capex Supercycle");
    expect(doc.document_type).toBe("article");
    expect(doc.mentioned_symbols).toEqual(["NVDA", "MSFT"]); // normalized uppercase
    expect(doc.tags).toContain("semiconductors");
    expect(doc.raw_text).toBe(body.trim()); // input used directly
    expect(doc.ai_model).toBe("claude-test");
    expect(calls).toHaveLength(1);
  });
});

// Sentinel-delimited combined response (metadata JSON + raw body), matching the
// PDF path's parseClaudeResponse format used by the image/url extractors.
function withBody(metaJson: string, body: string): string {
  return `${metaJson}\n---RAW_TEXT_BEGIN---\n${body}`;
}

describe("extractFromImage", () => {
  it("parses metadata + a transcription as raw_text and sends an image block", async () => {
    const { deps, calls } = stubDeps(withBody(META_JSON, "Transcribed screenshot text here."));
    const doc = await extractFromImage(new Uint8Array([1, 2, 3]), "image/png", deps);

    expect(doc.raw_text).toBe("Transcribed screenshot text here.");
    expect(doc.title).toBe("The AI Capex Supercycle");
    // first block is the image
    const blocks = calls[0].blocks as Array<{ type: string }>;
    expect(blocks[0].type).toBe("image");
  });
});

describe("extractFromUrl", () => {
  it("attaches the web_fetch tool and falls back source to the URL host", async () => {
    const metaNoSource = JSON.stringify({ ...JSON.parse(META_JSON), source: null });
    const { deps, calls } = stubDeps(withBody(metaNoSource, "Full fetched article body."));
    const doc = await extractFromUrl("https://www.example.com/posts/ai-capex", deps);

    expect(doc.raw_text).toBe("Full fetched article body.");
    expect(doc.source).toBe("example.com"); // host fallback, www stripped
    const tools = calls[0].tools as Array<{ name: string }>;
    expect(tools?.[0]?.name).toBe("web_fetch");
  });

  it("survives a truncated body (metadata JSON stays intact)", async () => {
    // No closing on the body — simulates an output-token cutoff mid-article.
    const truncated = withBody(META_JSON, "The article begins here and then gets cut off mid-sen");
    const { deps } = stubDeps(truncated);
    const doc = await extractFromUrl("https://example.com/x", deps);
    expect(doc.title).toBe("The AI Capex Supercycle");
    expect(doc.raw_text).toContain("cut off mid-sen");
  });
});
