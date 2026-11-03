/**
 * The PDF seam (design slice 3, §5) and its parity gate (§8). The seam ships
 * DISABLED; the live bogey path is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APIError } from "@anthropic-ai/sdk";

const { generateObjectMock, streamMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  streamMock: vi.fn(),
}));
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), generateObject: generateObjectMock }));
vi.mock("@/lib/ai/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/provider")>()),
  getRawAnthropicClient: () => ({ messages: { stream: streamMock } }),
}));

import {
  extractFromPdfAnthropic,
  extractFromPdfOpenAI,
  extractFromPdfWithFailover,
  isPdfFailoverEnabled,
  setPdfFailoverEnabledSource,
  PDF_FAILOVER_CEILING,
  PDF_FAILOVER_ENABLED_DEFAULT,
  PdfExtractionTruncatedError,
  type PdfExtractionRequest,
} from "@/lib/ai/pdf-extraction";
import { setFailoverRecorder, FAILOVER_PARKED, type FailoverEvent } from "@/lib/ai/failover";
import { extractBogeysFromPdfViaSeam, BOGEYS_OBJECT_SCHEMA } from "@/lib/earnings/extract-bogeys-seam";
import { parseExtractionResponse } from "@/lib/earnings/extract-bogeys";
import { compareBogeyParity } from "@/lib/earnings/bogey-parity";
import { CREDIT_BALANCE_MESSAGE } from "../helpers/ai-sdk-real-errors";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
const REQ: PdfExtractionRequest = {
  feature: "earningsBogeysExtraction",
  pdfBytes: PDF,
  schema: BOGEYS_OBJECT_SCHEMA,
  prompt: "extract",
};
const BASELINE = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "tests/fixtures/failover/earningsBogeysExtraction/synthetic-week/baseline.json"),
    "utf8",
  ),
);
const BASELINE_TEXT = JSON.stringify(BASELINE);

function rawBilling(): APIError {
  return APIError.generate(
    400,
    { type: "error", error: { type: "invalid_request_error", message: CREDIT_BALANCE_MESSAGE } },
    CREDIT_BALANCE_MESSAGE,
    new Headers(),
  ) as APIError;
}
function rawBadRequest(): APIError {
  return APIError.generate(
    400,
    { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 300000 tokens" } },
    "prompt is too long",
    new Headers(),
  ) as APIError;
}
function rawRateLimit(): APIError {
  return APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "slow" } }, "slow", new Headers()) as APIError;
}

let events: FailoverEvent[] = [];
beforeEach(() => {
  generateObjectMock.mockReset();
  streamMock.mockReset();
  events = [];
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-not-real");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-not-real");
  setFailoverRecorder((e) => events.push(e));
  setPdfFailoverEnabledSource(() => new Set(["earningsBogeysExtraction"]));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setPdfFailoverEnabledSource(null);
  setFailoverRecorder(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("rollout discipline", () => {
  it("ships disabled, bounded to bogey extraction, and no other PDF feature is in the ceiling", () => {
    expect(PDF_FAILOVER_ENABLED_DEFAULT.size).toBe(0);
    expect([...PDF_FAILOVER_CEILING]).toEqual(["earningsBogeysExtraction"]);
    for (const f of ["pdfParsing", "researchDocumentExtraction", "armedBogeyDeepRead"] as const) {
      expect(PDF_FAILOVER_CEILING.has(f)).toBe(false);
    }
    setPdfFailoverEnabledSource(null);
    expect(isPdfFailoverEnabled("earningsBogeysExtraction")).toBe(false);
  });

  it("the live bogey path does not import the seam", () => {
    const live = fs.readFileSync(path.join(process.cwd(), "lib/earnings/extract-bogeys.ts"), "utf8");
    expect(live).not.toMatch(/pdf-extraction|extract-bogeys-seam/);
    for (const f of ["app/api/earnings/bogeys/upload/route.ts"]) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src).not.toMatch(/pdf-extraction|extract-bogeys-seam/);
    }
  });

  it("the general executor still parks the bogey PDF feature (the seam is its own gate)", () => {
    expect(FAILOVER_PARKED.has("earningsBogeysExtraction")).toBe(true);
  });
});

describe("the legs", () => {
  it("anthropic leg sends a native document block and returns the text", async () => {
    streamMock.mockReturnValueOnce({
      finalMessage: async () => ({ content: [{ type: "text", text: BASELINE_TEXT }], stop_reason: "end_turn" }),
    });
    const r = await extractFromPdfAnthropic(REQ);
    expect(r.provider).toBe("anthropic");
    expect(r.text).toBe(BASELINE_TEXT);
    const body = streamMock.mock.calls[0][0];
    expect(body.messages[0].content[0]).toMatchObject({
      type: "document",
      source: { type: "base64", media_type: "application/pdf" },
    });
  });

  it("anthropic leg reports truncation", async () => {
    streamMock.mockReturnValueOnce({
      finalMessage: async () => ({ content: [{ type: "text", text: "[" }], stop_reason: "max_tokens" }),
    });
    await expect(extractFromPdfAnthropic(REQ)).rejects.toBeInstanceOf(PdfExtractionTruncatedError);
  });

  it("openai leg sends the PDF as a file part at the feature's tier (workhorse -> gpt-6.1-sol)", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { bogeys: BASELINE }, finishReason: "stop" });
    const r = await extractFromPdfOpenAI(REQ);
    expect(r.provider).toBe("openai");
    expect(r.modelId).toBe("gpt-6.1-sol");
    const call = generateObjectMock.mock.calls[0][0];
    expect(call.model.modelId).toBe("gpt-6.1-sol");
    const parts = call.messages[0].content;
    expect(parts[0]).toMatchObject({ type: "file", mediaType: "application/pdf" });
    expect(parts[0].data).toBe(PDF);
    expect(parts[1]).toMatchObject({ type: "text", text: "extract" });
    expect(call.providerOptions.openai.strictJsonSchema).toBe(false);
  });

  it("openai leg reports truncation", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: {}, finishReason: "length" });
    await expect(extractFromPdfOpenAI(REQ)).rejects.toBeInstanceOf(PdfExtractionTruncatedError);
  });
});

describe("failover: anthropic -> openai only", () => {
  const anthropicOk = async () => ({ text: BASELINE_TEXT, provider: "anthropic" as const, modelId: "claude-x" });
  const openaiOk = vi.fn(async () => ({ text: JSON.stringify({ bogeys: BASELINE }), provider: "openai" as const, modelId: "gpt-6.1-sol" }));

  beforeEach(() => openaiOk.mockClear());

  it("(a) billing on Anthropic is served by OpenAI and recorded", async () => {
    const r = await extractFromPdfWithFailover(REQ, { anthropic: async () => { throw rawBilling(); }, openai: openaiOk });
    expect(r.provider).toBe("openai");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ feature: "earningsBogeysExtraction", kind: "billing", to: { provider: "openai" } });
  });

  it("(b) a non-account error does not switch", async () => {
    for (const err of [rawBadRequest(), rawRateLimit(), new PdfExtractionTruncatedError("anthropic", "x")]) {
      await expect(
        extractFromPdfWithFailover(REQ, { anthropic: async () => { throw err; }, openai: openaiOk }),
      ).rejects.toBe(err);
    }
    expect(openaiOk).not.toHaveBeenCalled();
  });

  it("(c) the other PDF features never switch, even if forced into the rollout", async () => {
    setPdfFailoverEnabledSource(() => new Set(["pdfParsing", "researchDocumentExtraction", "armedBogeyDeepRead", "earningsBogeysExtraction"]));
    for (const feature of ["pdfParsing", "researchDocumentExtraction", "armedBogeyDeepRead"] as const) {
      const err = rawBilling();
      await expect(
        extractFromPdfWithFailover({ ...REQ, feature }, { anthropic: async () => { throw err; }, openai: openaiOk }),
      ).rejects.toBe(err);
    }
    expect(openaiOk).not.toHaveBeenCalled();
  });

  it("with the shipped default the primary's failure is simply rethrown", async () => {
    setPdfFailoverEnabledSource(null);
    const err = rawBilling();
    await expect(
      extractFromPdfWithFailover(REQ, { anthropic: async () => { throw err; }, openai: openaiOk }),
    ).rejects.toBe(err);
    expect(openaiOk).not.toHaveBeenCalled();
  });

  it("(d) both down: the ORIGINAL Anthropic error is rethrown, OpenAI tried once", async () => {
    const primary = rawBilling();
    const openaiDown = vi.fn(async () => { throw new Error("OpenAI exploded"); });
    await expect(
      extractFromPdfWithFailover(REQ, { anthropic: async () => { throw primary; }, openai: openaiDown }),
    ).rejects.toBe(primary);
    expect(openaiDown).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it("an unconfigured OpenAI leg is inert: original error, leg never called", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const primary = rawBilling();
    await expect(
      extractFromPdfWithFailover(REQ, { anthropic: async () => { throw primary; }, openai: openaiOk }),
    ).rejects.toBe(primary);
    expect(openaiOk).not.toHaveBeenCalled();
  });

  it("a missing Anthropic key (config) also switches", async () => {
    const r = await extractFromPdfWithFailover(REQ, {
      anthropic: async () => { throw new Error('ANTHROPIC_API_KEY is required for feature "earningsBogeysExtraction"'); },
      openai: openaiOk,
    });
    expect(r.provider).toBe("openai");
    expect(events[0].kind).toBe("config");
  });

  it("anthropic success never touches OpenAI", async () => {
    const r = await extractFromPdfWithFailover(REQ, { anthropic: anthropicOk, openai: openaiOk });
    expect(r.provider).toBe("anthropic");
    expect(openaiOk).not.toHaveBeenCalled();
  });
});

describe("bogey extraction over the seam", () => {
  it("both legs reach the same parser: the OpenAI object wrapper and the bare array yield identical bogeys", async () => {
    const viaAnthropic = await extractBogeysFromPdfViaSeam(PDF, {
      anthropic: async () => ({ text: BASELINE_TEXT, provider: "anthropic", modelId: "claude-x" }),
      openai: async () => { throw new Error("unused"); },
    });
    const viaOpenAi = await extractBogeysFromPdfViaSeam(PDF, {
      anthropic: async () => { throw rawBilling(); },
      openai: async () => ({ text: JSON.stringify({ bogeys: BASELINE }), provider: "openai", modelId: "gpt-6.1-sol" }),
    });
    expect(viaOpenAi.provider).toBe("openai");
    expect(viaOpenAi.bogeys).toEqual(viaAnthropic.bogeys);
    expect(compareBogeyParity(viaAnthropic.bogeys, viaOpenAi.bogeys).pass).toBe(true);
  });

  it("truncation maps to the same user-facing error as the live path", async () => {
    await expect(
      extractBogeysFromPdfViaSeam(PDF, {
        anthropic: async () => { throw new PdfExtractionTruncatedError("anthropic", "x"); },
        openai: async () => { throw new Error("unused"); },
      }),
    ).rejects.toMatchObject({ name: "BogeysExtractionError", code: "truncated", status: 422 });
  });
});

describe("§8 figure parity (hard gate)", () => {
  const base = parseExtractionResponse(BASELINE_TEXT);
  const clone = () => structuredClone(base);

  it("identical extractions pass and count their figures", () => {
    const r = compareBogeyParity(base, clone());
    expect(r.pass).toBe(true);
    expect(r.figuresCompared).toBeGreaterThan(8);
  });

  it("a one-cent EPS difference fails", () => {
    const c = clone();
    c[0].eps_consensus = 1.26;
    const r = compareBogeyParity(base, c);
    expect(r.pass).toBe(false);
    expect(r.mismatches).toEqual([{ symbol: "ACME", field: "eps_consensus", baseline: 1.25, candidate: 1.26 }]);
  });

  it("a dropped figure fails; a figure the baseline lacked does not", () => {
    const dropped = clone();
    dropped[0].revenue_whisper_usd = null;
    expect(compareBogeyParity(base, dropped).pass).toBe(false);
    const extra = clone();
    extra[1].eps_whisper = -0.05; // baseline had null: not a baseline claim
    expect(compareBogeyParity(base, extra).pass).toBe(true);
  });

  it("a segment figure is compared", () => {
    const c = clone();
    c[0].segment_breakdown = { Widgets: { consensus: 2_500_000_000, whisper: 2_600_000_000 } };
    expect(compareBogeyParity(base, c).mismatches[0].field).toBe("segment:widgets:whisper");
  });

  it("a missing company and an invented company both fail", () => {
    const missing = clone().slice(0, 1);
    expect(compareBogeyParity(base, missing)).toMatchObject({ pass: false, missingSymbols: ["ZETA"] });
    const invented = [...clone(), { ...clone()[1], symbol: "FAKE" }];
    expect(compareBogeyParity(base, invented)).toMatchObject({ pass: false, extraSymbols: ["FAKE"] });
  });
});
