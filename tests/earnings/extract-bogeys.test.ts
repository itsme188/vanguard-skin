import { describe, it, expect, vi } from "vitest";
import { APIError } from "@anthropic-ai/sdk";
import {
  parseExtractionResponse,
  extractBogeysFromPdf,
  extractBogeysFromUpload,
  resolveBogeysUploadMediaType,
  BogeysExtractionError,
} from "@/lib/earnings/extract-bogeys";
import { getRawAnthropicClient } from "@/lib/ai/provider";

vi.mock("@/lib/ai/provider", () => ({ getRawAnthropicClient: vi.fn() }));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ modelId: "claude-test-model" })),
}));

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

// ── Screenshot / image upload support (2026-07-26 user report) ──────────────
// Bogeys pages often arrive as phone screenshots, not PDFs. The extraction
// must send an `image` content block for image uploads and keep the
// `document` block for PDFs.

describe("resolveBogeysUploadMediaType", () => {
  it("maps a PDF by MIME type", () => {
    expect(resolveBogeysUploadMediaType("weekly.pdf", "application/pdf")).toBe(
      "application/pdf",
    );
  });

  it("maps a PNG screenshot by extension when the MIME type is empty", () => {
    expect(resolveBogeysUploadMediaType("IMG_1234.PNG", "")).toBe("image/png");
  });

  it("maps JPEG and WebP by MIME type", () => {
    expect(resolveBogeysUploadMediaType("shot.jpg", "image/jpeg")).toBe("image/jpeg");
    expect(resolveBogeysUploadMediaType("shot.webp", "image/webp")).toBe("image/webp");
  });

  it("returns null for unsupported types (docx, HEIC photos)", () => {
    expect(resolveBogeysUploadMediaType("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(null);
    expect(resolveBogeysUploadMediaType("IMG_5678.HEIC", "image/heic")).toBe(null);
  });
});

describe("extractBogeysFromUpload content blocks", () => {
  function mockStreamCapturing() {
    const calls: Array<Record<string, unknown>> = [];
    vi.mocked(getRawAnthropicClient).mockReturnValue({
      messages: {
        stream: (args: Record<string, unknown>) => {
          calls.push(args);
          return {
            finalMessage: () =>
              Promise.resolve({ content: [{ type: "text", text: "[]" }] }),
          };
        },
      },
    } as never);
    return calls;
  }

  it("sends an image content block for a PNG screenshot", async () => {
    const calls = mockStreamCapturing();
    await extractBogeysFromUpload(new Uint8Array([1, 2, 3]), "image/png");

    const content = (calls[0].messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    const block = content[0] as { type: string; source: { type: string; media_type: string } };
    expect(block.type).toBe("image");
    expect(block.source.media_type).toBe("image/png");
  });

  it("sends a document block for a PDF (back-compat via extractBogeysFromPdf)", async () => {
    const calls = mockStreamCapturing();
    await extractBogeysFromPdf(new Uint8Array([1, 2, 3]));

    const content = (calls[0].messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    const block = content[0] as { type: string; source: { type: string; media_type: string } };
    expect(block.type).toBe("document");
    expect(block.source.media_type).toBe("application/pdf");
  });

  it("upstream 400 on an image maps to a user-safe message naming images, not PDFs", async () => {
    const rawPayload = {
      type: "error",
      error: { type: "invalid_request_error", message: "image could not be processed" },
      request_id: "req_011Cd5TEST9",
    };
    vi.mocked(getRawAnthropicClient).mockReturnValue({
      messages: {
        stream: () => ({
          finalMessage: () =>
            Promise.reject(
              new APIError(400, rawPayload, `400 ${JSON.stringify(rawPayload)}`, new Headers()),
            ),
        }),
      },
    } as never);

    const err = await extractBogeysFromUpload(new Uint8Array([1]), "image/jpeg").catch((e) => e);
    expect(err).toBeInstanceOf(BogeysExtractionError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/image/i);
    expect(err.message).not.toContain("req_011Cd5TEST9");
  });
});

describe("extractBogeysFromPdf upstream error mapping", () => {
  function mockStreamRejecting(err: unknown) {
    vi.mocked(getRawAnthropicClient).mockReturnValue({
      messages: { stream: () => ({ finalMessage: () => Promise.reject(err) }) },
    } as never);
  }

  // Regression pin (qa 2026-07-16): the raw Anthropic 400 payload — which
  // embeds request_id and API internals — must never reach the caller's
  // error message; an invalid document maps to a friendly 400.
  it("maps an upstream 400 (invalid PDF) to a user-safe 400 without the raw payload", async () => {
    const rawPayload = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "messages.0.content.0.pdf: The PDF specified was not valid.",
      },
      request_id: "req_011Cd5TEST",
    };
    mockStreamRejecting(
      new APIError(400, rawPayload, `400 ${JSON.stringify(rawPayload)}`, new Headers()),
    );

    const err = await extractBogeysFromPdf(new Uint8Array([1, 2, 3])).catch((e) => e);
    expect(err).toBeInstanceOf(BogeysExtractionError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_pdf");
    expect(err.message).not.toContain("request_id");
    expect(err.message).not.toContain("req_011Cd5TEST");
    expect(err.message).not.toContain("invalid_request_error");
  });

  it("maps other upstream API errors to a sanitized 502", async () => {
    const rawPayload = {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
      request_id: "req_011Cd5TEST2",
    };
    mockStreamRejecting(
      new APIError(529, rawPayload, `529 ${JSON.stringify(rawPayload)}`, new Headers()),
    );

    const err = await extractBogeysFromPdf(new Uint8Array([1, 2, 3])).catch((e) => e);
    expect(err).toBeInstanceOf(BogeysExtractionError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("upstream");
    expect(err.message).toContain("upstream 529");
    expect(err.message).not.toContain("req_011Cd5TEST2");
  });

  it("maps connection failures to a sanitized 502", async () => {
    mockStreamRejecting(new Error("ECONNRESET"));

    const err = await extractBogeysFromPdf(new Uint8Array([1, 2, 3])).catch((e) => e);
    expect(err).toBeInstanceOf(BogeysExtractionError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("connection error");
  });
});
