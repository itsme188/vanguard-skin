import { describe, it, expect } from "vitest";
import { normalizeExtracted } from "@/lib/research-documents/extract";

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
