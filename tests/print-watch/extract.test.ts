// Extraction model call (task-4, 2026-08-20) - ported from
// scripts/spike-bakeoff-parse.ts. Every test injects a mocked AnthropicLike
// client (opts.anthropic) so this suite makes ZERO live API calls - same
// mocking convention as tests/securities/verify-sector-tags.test.ts, but via
// direct constructor injection rather than mocking lib/ai/provider (this
// module has no db and no feature-key wiring).

import { describe, it, expect, vi } from "vitest";
import {
  extractCandidates,
  extractCandidatesFromPdf,
  type AnthropicLike,
} from "@/lib/print-watch/extract";
import { SONNET_MODEL } from "@/lib/claude-models";
import { fastStructuredRequestOptions } from "@/lib/claude-request-options";
import type { LineContract, ExpectedValue } from "@/lib/print-watch/types";

const REVENUE_CONTRACT: LineContract = {
  metric_id: "revenue_q",
  label: "Revenue",
  definition: "Total quarterly revenue.",
  basis: "na",
  period: "Q",
  currency: "USD",
  unit: "usd",
  kind: "point",
  segment: null,
};

const EPS_CONTRACT: LineContract = {
  metric_id: "eps_adj_q",
  label: "EPS (Adj.)",
  definition: "Adjusted (non-GAAP) diluted earnings per share for the quarter.",
  basis: "non_gaap",
  period: "Q",
  currency: "USD",
  unit: "per_share",
  kind: "point",
  segment: null,
};

const GUIDANCE_CONTRACT: LineContract = {
  metric_id: "revenue_guide_next",
  label: "Revenue Guidance (Next Q)",
  definition: "Next-quarter revenue guidance range (the UPDATED range if prior and updated appear side by side).",
  basis: "na",
  period: "NQ_guide",
  currency: "USD",
  unit: "usd",
  kind: "range",
  segment: null,
};

const DOC_TEXT = "=== TABLE 1 ===\nTotal revenue: $1,234\nAdjusted EPS: $2.10\n=== END ===";

/** Build a mocked AnthropicLike whose messages.create is the given vi.fn. */
function mockClient(create: ReturnType<typeof vi.fn>): AnthropicLike {
  return { messages: { create } } as unknown as AnthropicLike;
}

/** What native structured output returns: one text block holding the JSON object. */
function structuredResponse(candidates: unknown[], stopReason = "end_turn") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: SONNET_MODEL,
    content: [{ type: "text", text: JSON.stringify({ candidates }) }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe("extractCandidates", () => {
  it("parses candidates from a native structured-output response", async () => {
    const create = vi.fn().mockResolvedValue(
      structuredResponse([
        {
          metric_id: "revenue_q",
          not_disclosed: false,
          value: 1234000000,
          raw_text: "$1,234",
          snippet: "Total revenue: $1,234",
          location_hint: "TABLE 1 row Total revenue",
        },
        {
          metric_id: "eps_adj_q",
          not_disclosed: true,
        },
      ]),
    );

    const result = await extractCandidates(
      [REVENUE_CONTRACT, EPS_CONTRACT],
      DOC_TEXT,
      { anthropic: mockClient(create) },
    );

    expect(result).toEqual([
      {
        metric_id: "revenue_q",
        not_disclosed: false,
        value: 1234000000,
        value_high: null,
        raw_text: "$1,234",
        snippet: "Total revenue: $1,234",
        location_hint: "TABLE 1 row Total revenue",
      },
      {
        metric_id: "eps_adj_q",
        not_disclosed: true,
        value: null,
        value_high: null,
        raw_text: null,
        snippet: null,
        location_hint: null,
      },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("normalizes a parenthesized string value to a negative number (defensive numeric parsing)", async () => {
    const create = vi.fn().mockResolvedValue(
      structuredResponse([
        { metric_id: "revenue_q", not_disclosed: false, value: "(7,604)", raw_text: "(7,604)" },
      ]),
    );
    const result = await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, {
      anthropic: mockClient(create),
    });
    expect(result[0].value).toBe(-7604);
  });

  it("caps snippet at 200 characters even if the model over-produces", async () => {
    const longSnippet = "x".repeat(250);
    const create = vi.fn().mockResolvedValue(
      structuredResponse([
        { metric_id: "revenue_q", not_disclosed: false, value: 1, snippet: longSnippet },
      ]),
    );
    const result = await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, {
      anthropic: mockClient(create),
    });
    expect(result[0].snippet).toHaveLength(200);
  });

  it("retries ONCE when the first response is malformed, then returns the valid retry", async () => {
    const create = vi
      .fn()
      // Attempt 1: forced tool call came back with an empty candidates array
      // (malformed for our purposes - nothing usable).
      .mockResolvedValueOnce(structuredResponse([]))
      // Attempt 2: valid.
      .mockResolvedValueOnce(
        structuredResponse([{ metric_id: "revenue_q", not_disclosed: false, value: 999 }]),
      );

    const result = await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, {
      anthropic: mockClient(create),
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        metric_id: "revenue_q",
        not_disclosed: false,
        value: 999,
        value_high: null,
        raw_text: null,
        snippet: null,
        location_hint: null,
      },
    ]);
  });

  it("retries ONCE across the outer loop when the first response has unparseable text", async () => {
    const garbageResponse = {
      id: "msg_garbage",
      type: "message",
      role: "assistant",
      model: SONNET_MODEL,
      content: [{ type: "text", text: "I could not find the figures you asked for." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
    };
    const create = vi
      .fn()
      .mockResolvedValueOnce(garbageResponse)
      .mockResolvedValueOnce(
        structuredResponse([{ metric_id: "revenue_q", not_disclosed: false, value: 777 }]),
      );

    const result = await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, {
      anthropic: mockClient(create),
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result[0].value).toBe(777);
  });

  it("recovers a C0-control-character-corrupted text fallback via the retry-parse precedent", async () => {
    // No tool_use block at all - the model answered in prose with a raw
    // unescaped control character inside a string literal, which a plain
    // JSON.parse rejects ("Bad control character in string literal"). Built
    // via String.fromCharCode at runtime rather than typing a raw control
    // byte in this source file (typed control bytes have corrupted files
    // written by these tools before - verify with `od -c` after any edit
    // touching this test).
    const marker = "BREAKHERE";
    const baseText = JSON.stringify([
      { metric_id: "revenue_q", not_disclosed: false, value: 42, snippet: "line1" + marker + "line2" },
    ]);
    const rawNewline = String.fromCharCode(10);
    const corruptText = baseText.split(marker).join(rawNewline);
    const response = {
      id: "msg_text",
      type: "message",
      role: "assistant",
      model: SONNET_MODEL,
      content: [{ type: "text", text: corruptText }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const create = vi.fn().mockResolvedValue(response);

    const result = await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, {
      anthropic: mockClient(create),
    });

    expect(create).toHaveBeenCalledTimes(1); // recovered without a second API call
    expect(result[0].value).toBe(42);
  });

  it("throws when both attempts return zero parseable candidates", async () => {
    const create = vi.fn().mockResolvedValue(structuredResponse([]));
    await expect(
      extractCandidates([REVENUE_CONTRACT], DOC_TEXT, { anthropic: mockClient(create) }),
    ).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("asks for native structured output (no tool, no forced tool_choice), no temperature, and resolves the workhorse model when opts.model is absent", async () => {
    const create = vi.fn().mockResolvedValue(
      structuredResponse([{ metric_id: "revenue_q", not_disclosed: false, value: 1 }]),
    );
    await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, { anthropic: mockClient(create) });

    const params = create.mock.calls[0][0];
    // Forced tool_choice ("tool"/"any") is a 400 on Sonnet 5.5 / Opus 5.5.
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("tools");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.model).toBe(SONNET_MODEL);
    expect(params).not.toHaveProperty("temperature");
    expect(params.thinking).toEqual(fastStructuredRequestOptions(SONNET_MODEL).thinking);
  });

  // The fast parse must be a VALID request on both generations a tier can
  // resolve to: thinking disabled is a 400 on Sonnet 5.5, and Opus 5.5 cannot
  // turn thinking off at all.
  it.each([
    ["claude-sonnet-4-6", { type: "disabled" }, undefined],
    ["claude-sonnet-5-5", { type: "between_tools" }, undefined],
    ["claude-opus-4-8", { type: "disabled" }, undefined],
    ["claude-opus-5-5", undefined, "low"],
    ["claude-haiku-5-5", { type: "disabled" }, undefined],
  ])("%s: thinking %j, effort %s", async (model, thinking, effort) => {
    const create = vi.fn().mockResolvedValue(
      structuredResponse([{ metric_id: "revenue_q", not_disclosed: false, value: 1 }]),
    );
    await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, { anthropic: mockClient(create), model });
    const params = create.mock.calls[0][0];
    if (thinking) expect(params.thinking).toEqual(thinking);
    else expect(params).not.toHaveProperty("thinking");
    expect(params.output_config.effort).toBe(effort);
    expect(params.output_config.format.type).toBe("json_schema");
  });

  it("honors an explicit opts.model override instead of resolving a tier", async () => {
    const create = vi.fn().mockResolvedValue(
      structuredResponse([{ metric_id: "revenue_q", not_disclosed: false, value: 1 }]),
    );
    await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, {
      anthropic: mockClient(create),
      model: "claude-custom-test-model",
    });
    expect(create.mock.calls[0][0].model).toBe("claude-custom-test-model");
  });

  it("every object node in the output schema carries additionalProperties:false, and no count/range keyword native output rejects", async () => {
    const create = vi.fn().mockResolvedValue(
      structuredResponse([{ metric_id: "revenue_q", not_disclosed: false, value: 1 }]),
    );
    await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, { anthropic: mockClient(create) });

    const params = create.mock.calls[0][0];
    const schema = params.output_config.format.schema;
    const schemaText = JSON.stringify(schema);
    for (const keyword of ["minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern"]) {
      expect(schemaText).not.toContain(`"${keyword}"`);
    }

    let objectNodesWalked = 0;
    function walk(node: unknown): void {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "object") {
        objectNodesWalked++;
        expect(obj.additionalProperties).toBe(false);
      }
      for (const value of Object.values(obj)) {
        if (value && typeof value === "object") walk(value);
      }
    }
    walk(schema);
    // Sanity: the schema actually has nested object nodes to check (the
    // top-level input_schema AND the candidates[] item schema) - a walker
    // that silently visited zero nodes would make the assertion above
    // vacuously true.
    expect(objectNodesWalked).toBeGreaterThanOrEqual(2);
  });

  it("the system prompt states the UPDATED-range guidance-supersession rule (spec section 9 amendment 5, new vs. the spike)", async () => {
    const create = vi.fn().mockResolvedValue(
      structuredResponse([{ metric_id: "revenue_guide_next", not_disclosed: false, value: 1, value_high: 2 }]),
    );
    await extractCandidates([GUIDANCE_CONTRACT], DOC_TEXT, { anthropic: mockClient(create) });

    const params = create.mock.calls[0][0];
    expect(params.system).toContain("UPDATED");
    expect(params.system.toLowerCase()).toContain("prior");
    expect(params.system.toLowerCase()).toContain("side by side");
  });

  it("never sends expected/consensus/whisper values - the call signature has no slot for them", async () => {
    // A "parallel" ExpectedValue the way lib/print-watch/contracts.ts would
    // produce alongside `contracts` - deliberately NEVER passed into
    // extractCandidates. Distinctive numbers so a leak would be detectable
    // if it somehow occurred.
    const parallelExpected: Record<string, ExpectedValue> = {
      revenue_q: { value: 4224242, value_high: null, whisper: 4194949, source_label: "test-consensus" },
    };
    void parallelExpected; // proves the value exists in scope but has no path into the call below

    const create = vi.fn().mockResolvedValue(
      structuredResponse([{ metric_id: "revenue_q", not_disclosed: false, value: 1 }]),
    );

    // extractCandidates(contracts, representationText, opts) - TypeScript
    // itself has no parameter slot for `parallelExpected`; this call is the
    // runtime proof that whatever WAS sent never contains the consensus
    // numbers above.
    await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, { anthropic: mockClient(create) });

    const params = create.mock.calls[0][0];
    const sentText = JSON.stringify(params);
    expect(sentText).not.toContain("4224242");
    expect(sentText).not.toContain("4194949");
    expect(sentText).not.toContain("test-consensus");
  });

  it("the user message carries the contract lines and the document text, verbatim", async () => {
    const create = vi.fn().mockResolvedValue(
      structuredResponse([{ metric_id: "revenue_q", not_disclosed: false, value: 1 }]),
    );
    await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, { anthropic: mockClient(create) });

    const params = create.mock.calls[0][0];
    const userContent = params.messages[0].content as string;
    expect(userContent).toContain("revenue_q");
    expect(userContent).toContain(DOC_TEXT);
  });
});

describe("extractCandidatesFromPdf", () => {
  it("sends the PDF as a document block ahead of the contract text, same output schema + system prompt", async () => {
    const create = vi.fn().mockResolvedValue(
      structuredResponse([
        {
          metric_id: "revenue_q",
          not_disclosed: false,
          value: 1,
          raw_text: "1",
          snippet: "s",
          location_hint: null,
        },
      ]),
    );

    const pdfBytes = Buffer.from("%PDF-1.7 fake");
    const out = await extractCandidatesFromPdf([REVENUE_CONTRACT, EPS_CONTRACT], pdfBytes, {
      anthropic: mockClient(create),
    });
    expect(out).toHaveLength(1);

    const params = create.mock.calls[0][0];
    const content = params.messages[0].content as Array<{
      type: string;
      source?: { media_type: string; data: string };
      text?: string;
    }>;
    expect(content[0].type).toBe("document");
    expect(content[0].source?.media_type).toBe("application/pdf");
    expect(content[0].source?.data).toBe(pdfBytes.toString("base64"));
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("=== CONTRACT LINES");
    expect(content[1].text).not.toMatch(/expected|bogey|consensus/i);

    // Same output schema, thinking setting and system prompt as the text
    // road - the PDF reading differs ONLY in how the document reaches the model.
    const textCreate = vi.fn().mockResolvedValue(
      structuredResponse([{ metric_id: "revenue_q", not_disclosed: false, value: 1 }]),
    );
    await extractCandidates([REVENUE_CONTRACT], DOC_TEXT, { anthropic: mockClient(textCreate) });
    const textParams = textCreate.mock.calls[0][0];
    expect(params.output_config).toEqual(textParams.output_config);
    expect(params.thinking).toEqual(textParams.thinking);
    expect(params).not.toHaveProperty("tool_choice");
    expect(params.system).toContain("deterministic figure-extraction engine");
  });

  it("names ITSELF in the failure a caller records, not the text reading", async () => {
    // The message lands in parse_last_error and the panel's parse_failed copy,
    // so a PDF's native reading must not report under extractCandidates' name.
    const create = vi.fn().mockResolvedValue(structuredResponse([]));
    await expect(
      extractCandidatesFromPdf([REVENUE_CONTRACT], Buffer.from("%PDF-1.7 fake"), {
        anthropic: mockClient(create),
      }),
    ).rejects.toThrow(/^extractCandidatesFromPdf: no candidates parsed/);

    const textCreate = vi.fn().mockResolvedValue(structuredResponse([]));
    await expect(
      extractCandidates([REVENUE_CONTRACT], DOC_TEXT, { anthropic: mockClient(textCreate) }),
    ).rejects.toThrow(/^extractCandidates: no candidates parsed/);
  });
});
