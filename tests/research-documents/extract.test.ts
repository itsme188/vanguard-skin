import { describe, it, expect } from "vitest";
import {
  normalizeExtracted,
  parseClaudeResponse,
} from "@/lib/research-documents/extract";

describe("normalizeExtracted", () => {
  it("normalizes a well-formed Claude payload", () => {
    const raw = {
      title: "  Goldman NVDA deep dive  ",
      author: "  Jane Doe  ",
      source: "Goldman Sachs",
      document_type: "analyst_report",
      publication_date: "2026-03-15",
      summary: "  Buy rated, $1200 target.  ",
      key_points: ["DC rev +60%", "", "   ", "Blackwell on track"],
      mentioned_symbols: ["nvda", "AMD", "avgo", "nvda", "bad ticker with space"],
      sentiment: "bullish",
      target_prices: [
        { symbol: "nvda", price: 1200, horizon: "12mo" },
        { symbol: "", price: 100 },                 // empty symbol → drop
        { symbol: "AMD", price: "not a number" },    // bad price → drop
        { symbol: "AVGO", price: 1500 },             // no horizon → ok
      ],
      raw_text: "Full body of the report here...",
    };

    const out = normalizeExtracted(raw, "claude-sonnet-4-6");
    expect(out.title).toBe("Goldman NVDA deep dive");
    expect(out.author).toBe("Jane Doe");
    expect(out.document_type).toBe("analyst_report");
    expect(out.publication_date).toBe("2026-03-15");
    expect(out.sentiment).toBe("bullish");
    expect(out.key_points).toEqual(["DC rev +60%", "Blackwell on track"]);
    // Dedup + uppercase + reject space-containing garbage
    expect(out.mentioned_symbols).toEqual(["NVDA", "AMD", "AVGO"]);
    expect(out.target_prices).toEqual([
      { symbol: "NVDA", price: 1200, horizon: "12mo" },
      { symbol: "AVGO", price: 1500 },
    ]);
    expect(out.ai_model).toBe("claude-sonnet-4-6");
  });

  it("defaults document_type to 'other' when invalid", () => {
    const out = normalizeExtracted(
      {
        title: "T",
        raw_text: "body",
        document_type: "nonsense",
      },
      "m",
    );
    expect(out.document_type).toBe("other");
  });

  it("rejects invalid sentiment by setting null", () => {
    const out = normalizeExtracted(
      {
        title: "T",
        raw_text: "body",
        sentiment: "enthusiastic",
      },
      "m",
    );
    expect(out.sentiment).toBeNull();
  });

  it("rejects malformed publication_date", () => {
    const out = normalizeExtracted(
      {
        title: "T",
        raw_text: "body",
        publication_date: "March 2026",
      },
      "m",
    );
    expect(out.publication_date).toBeNull();
  });

  it("throws when raw_text is missing", () => {
    expect(() =>
      normalizeExtracted({ title: "T" }, "m"),
    ).toThrow(/raw_text/i);
  });

  it("throws when payload is not an object", () => {
    expect(() => normalizeExtracted("nope", "m")).toThrow(/object/i);
    expect(() => normalizeExtracted(null, "m")).toThrow(/object/i);
  });

  it("defaults title to 'Untitled' when missing", () => {
    const out = normalizeExtracted({ raw_text: "body" }, "m");
    expect(out.title).toBe("Untitled");
  });

  it("empty arrays pass through cleanly", () => {
    const out = normalizeExtracted(
      {
        title: "T",
        raw_text: "body",
        key_points: [],
        mentioned_symbols: [],
        target_prices: [],
      },
      "m",
    );
    expect(out.key_points).toEqual([]);
    expect(out.mentioned_symbols).toEqual([]);
    expect(out.target_prices).toEqual([]);
  });
});

describe("parseClaudeResponse (two-part format)", () => {
  const meta = `{
    "title": "Goldman NVDA Q1",
    "author": "Jane Doe",
    "source": "Goldman Sachs",
    "document_type": "analyst_report",
    "publication_date": "2026-03-15",
    "summary": "Buy rated.",
    "key_points": ["DC +60%"],
    "mentioned_symbols": ["NVDA"],
    "sentiment": "bullish",
    "target_prices": [{"symbol": "NVDA", "price": 1200, "horizon": "12mo"}]
  }`;
  const body = 'The full "document" body.\n\nWith paragraphs. And "quotes" that would normally break JSON. Plus newlines that would too.';

  it("parses a clean two-part response", () => {
    const raw = `${meta}\n---RAW_TEXT_BEGIN---\n${body}\n---RAW_TEXT_END---`;
    const out = parseClaudeResponse(raw, "claude-sonnet-4-6");
    expect(out.title).toBe("Goldman NVDA Q1");
    expect(out.raw_text).toBe(body);
    expect(out.mentioned_symbols).toEqual(["NVDA"]);
    expect(out.target_prices).toEqual([
      { symbol: "NVDA", price: 1200, horizon: "12mo" },
    ]);
  });

  it("tolerates missing END delimiter (uses rest of response)", () => {
    const raw = `${meta}\n---RAW_TEXT_BEGIN---\n${body}`;
    const out = parseClaudeResponse(raw, "m");
    expect(out.raw_text).toBe(body);
  });

  it("tolerates ```json fences around the metadata", () => {
    const raw = `\`\`\`json\n${meta}\n\`\`\`\n---RAW_TEXT_BEGIN---\n${body}\n---RAW_TEXT_END---`;
    const out = parseClaudeResponse(raw, "m");
    expect(out.title).toBe("Goldman NVDA Q1");
    expect(out.raw_text).toBe(body);
  });

  it("throws when the BEGIN delimiter is missing", () => {
    expect(() =>
      parseClaudeResponse(`${meta}\n(full body with no delimiter)`, "m"),
    ).toThrow(/RAW_TEXT_BEGIN/);
  });

  it("throws when the JSON half is malformed", () => {
    const raw = `{ not valid json \n---RAW_TEXT_BEGIN---\n${body}`;
    expect(() => parseClaudeResponse(raw, "m")).toThrow(/PART 1/);
  });

  it("throws when raw_text is empty after the delimiter", () => {
    const raw = `${meta}\n---RAW_TEXT_BEGIN---\n   \n---RAW_TEXT_END---`;
    expect(() => parseClaudeResponse(raw, "m")).toThrow(/empty/i);
  });

  it("body with embedded unescaped quotes + newlines works", () => {
    const ugly = `First "quote" here.\n\nSecond line with \\backslash\\ and multiple\n\n\nblank lines.`;
    const raw = `${meta}\n---RAW_TEXT_BEGIN---\n${ugly}\n---RAW_TEXT_END---`;
    const out = parseClaudeResponse(raw, "m");
    expect(out.raw_text).toBe(ugly);
  });
});
