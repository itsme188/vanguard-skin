import { describe, it, expect } from "vitest";
import { parseExtractionResponse } from "@/lib/earnings/extract-bogeys";

describe("parseExtractionResponse", () => {
  it("parses a clean JSON array", () => {
    const raw = JSON.stringify([
      {
        symbol: "GLW",
        eps_consensus: 0.46,
        eps_whisper: 0.5,
        revenue_consensus_usd: 3_850_000_000,
        revenue_whisper_usd: 3_900_000_000,
        segment_breakdown: { Optical: { consensus: 1_500_000_000, whisper: 1_520_000_000 } },
        guidance_notes: "FY26 guide $19.5–20.0B",
        notes: null,
      },
    ]);
    const out = parseExtractionResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("GLW");
    expect(out[0].eps_consensus).toBe(0.46);
    expect(out[0].revenue_whisper_usd).toBe(3_900_000_000);
    expect(out[0].segment_breakdown).toEqual({
      Optical: { consensus: 1_500_000_000, whisper: 1_520_000_000 },
    });
  });

  it("strips ```json fences", () => {
    const raw = "```json\n[{\"symbol\": \"KO\", \"eps_consensus\": 0.78}]\n```";
    const out = parseExtractionResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("KO");
    expect(out[0].eps_consensus).toBe(0.78);
  });

  it("uppercases the symbol and trims whitespace", () => {
    const raw = JSON.stringify([{ symbol: "  ter  ", eps_consensus: 1.2 }]);
    const out = parseExtractionResponse(raw);
    expect(out[0].symbol).toBe("TER");
  });

  it("coerces stringified abbreviated revenues", () => {
    // Even though the prompt says raw numbers, defensive parsing rescues sloppy outputs.
    const raw = JSON.stringify([
      { symbol: "GLW", revenue_consensus_usd: "$3.85B", eps_consensus: "0.46" },
    ]);
    const out = parseExtractionResponse(raw);
    expect(out[0].revenue_consensus_usd).toBe(3_850_000_000);
    expect(out[0].eps_consensus).toBe(0.46);
  });

  it("skips entries with no symbol", () => {
    const raw = JSON.stringify([
      { eps_consensus: 0.5 },
      { symbol: "", eps_consensus: 0.6 },
      { symbol: "GLW", eps_consensus: 0.46 },
    ]);
    const out = parseExtractionResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("GLW");
  });

  it("returns null for missing numeric fields", () => {
    const raw = JSON.stringify([{ symbol: "GLW" }]);
    const out = parseExtractionResponse(raw);
    expect(out[0].eps_consensus).toBe(null);
    expect(out[0].revenue_consensus_usd).toBe(null);
    expect(out[0].segment_breakdown).toBe(null);
  });

  it("throws on non-JSON input", () => {
    expect(() => parseExtractionResponse("not json at all")).toThrow();
  });

  it("throws on non-array root", () => {
    expect(() => parseExtractionResponse('{"symbol": "GLW"}')).toThrow();
  });
});
