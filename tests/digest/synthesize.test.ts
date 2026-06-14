import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CompanyBucket } from "@/lib/digest/group-by-company";
import type { SynthesisInput } from "@/lib/digest/synthesize";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {
    constructor(public feature: string, public modelId: string) {
      super(`AI refused request for feature "${feature}" (model ${modelId})`);
      this.name = "AIRefusalError";
    }
  },
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { generateTextForFeature } from "@/lib/ai/generate";
import { synthesize, SynthesisEmptyError } from "@/lib/digest/synthesize";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal article with required ArticleLike fields. */
function makeArticle(
  id: number,
  sourceName: string,
  sentiment: string | null = "bullish",
  summary = "Some article summary text.",
  sourceUrl: string | null = null,
): CompanyBucket["articles"][number] {
  return {
    id,
    source_name: sourceName,
    subject: "Test Article Subject",
    summary,
    sentiment,
    mentioned_symbols: null,
    portfolio_relevance: null,
    key_themes: null,
    source_url: sourceUrl,
    website_url: null,
  };
}

/** Build a minimal CompanyBucket with sensible defaults. */
function makeBucket(
  symbol: string,
  companyName: string | null = null,
  articles: CompanyBucket["articles"] = [],
): CompanyBucket {
  return { symbol, companyName, articles };
}

/** Pad a string to be at least minLen chars. */
function pad(text: string, minLen = 220): string {
  return text.padEnd(minLen, " x");
}

const VALID_SYNTHESIS = pad("## NVDA\nKey threads across sources: bullish momentum confirmed by multiple analysts.");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("synthesize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path mock: valid markdown text
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: VALID_SYNTHESIS,
      finishReason: "stop",
    });
  });

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------
  it("calls Sonnet with dailyDigestSynthesis feature key + returns rendered markdown", async () => {
    const buckets = [
      makeBucket("NVDA", "NVIDIA Corp", [makeArticle(1, "Vital Knowledge")]),
    ];

    const result = await synthesize({
      buckets,
      heldSymbols: ["NVDA"],
      watchlist: [],
      anomalies: [],
    });

    // Wrapper is called with the feature key as first arg + options containing maxOutputTokens
    expect(generateTextForFeature).toHaveBeenCalledWith(
      "dailyDigestSynthesis",
      expect.objectContaining({ maxOutputTokens: 8192 }),
    );

    // Returned text is the valid synthesis (trimmed)
    expect(result.trim()).toBe(VALID_SYNTHESIS.trim());
  });

  // -------------------------------------------------------------------------
  // 2. Preamble stripping
  // -------------------------------------------------------------------------
  it("strips model preamble before returning", async () => {
    const preamble = "Good, I now have enough context. Let me synthesize.\n\n";
    const body = pad("## NVDA\nCore body of the synthesis here with enough text.");
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: preamble + body,
      finishReason: "stop",
    });

    const result = await synthesize({
      buckets: [makeBucket("NVDA", "NVIDIA Corp", [makeArticle(1, "VK")])],
      heldSymbols: ["NVDA"],
      watchlist: [],
      anomalies: [],
    });

    // Preamble should be stripped — result starts with the ## header
    expect(result).not.toContain("Good, I now have enough context");
    expect(result.trimStart()).toMatch(/^##/);
  });

  // -------------------------------------------------------------------------
  // 3. Too short after stripping
  // -------------------------------------------------------------------------
  it("throws SynthesisEmptyError when result < 200 chars after stripping", async () => {
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: "## Empty",  // 8 chars — well under 200
      finishReason: "stop",
    });

    await expect(
      synthesize({
        buckets: [makeBucket("NVDA", null, [makeArticle(1, "VK")])],
        heldSymbols: ["NVDA"],
        watchlist: [],
        anomalies: [],
      }),
    ).rejects.toThrow(SynthesisEmptyError);

    await expect(
      synthesize({
        buckets: [makeBucket("NVDA", null, [makeArticle(1, "VK")])],
        heldSymbols: ["NVDA"],
        watchlist: [],
        anomalies: [],
      }),
    ).rejects.toThrow(/too short/);
  });

  // -------------------------------------------------------------------------
  // 4. finishReason === "length"
  // -------------------------------------------------------------------------
  it("throws SynthesisEmptyError when finishReason === 'length'", async () => {
    // Even long text should fail when truncated
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: pad("## NVDA\nSome very long synthesis text that got cut off", 500),
      finishReason: "length",
    });

    await expect(
      synthesize({
        buckets: [makeBucket("NVDA", null, [makeArticle(1, "VK")])],
        heldSymbols: ["NVDA"],
        watchlist: [],
        anomalies: [],
      }),
    ).rejects.toThrow(SynthesisEmptyError);

    await expect(
      synthesize({
        buckets: [makeBucket("NVDA", null, [makeArticle(1, "VK")])],
        heldSymbols: ["NVDA"],
        watchlist: [],
        anomalies: [],
      }),
    ).rejects.toThrow(/truncated/);
  });

  // -------------------------------------------------------------------------
  // 5. No markdown headers (preamble pass-through bypass)
  // -------------------------------------------------------------------------
  it("throws SynthesisEmptyError when result has no markdown headers", async () => {
    // 300+ chars of prose with no # markers — stripModelPreamble passes this through
    // because there's no leading markdown marker to trigger the break,
    // so firstReal=0 and the full text is returned unchanged.
    const pureNarration =
      "I have carefully reviewed all the articles provided and synthesized the key themes " +
      "across sources. The main takeaways are that NVDA continues to see bullish momentum " +
      "while macro factors remain uncertain. This text has no markdown headers at all and " +
      "is long enough to pass the 200-char check.";
    expect(pureNarration.length).toBeGreaterThan(200);  // confirm it's long enough

    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: pureNarration,
      finishReason: "stop",
    });

    await expect(
      synthesize({
        buckets: [makeBucket("NVDA", null, [makeArticle(1, "VK")])],
        heldSymbols: ["NVDA"],
        watchlist: [],
        anomalies: [],
      }),
    ).rejects.toThrow(SynthesisEmptyError);

    await expect(
      synthesize({
        buckets: [makeBucket("NVDA", null, [makeArticle(1, "VK")])],
        heldSymbols: ["NVDA"],
        watchlist: [],
        anomalies: [],
      }),
    ).rejects.toThrow(/no markdown headers/);
  });

  // -------------------------------------------------------------------------
  // 6. Prompt includes held tickers, watchlist, and anomaly tickers
  // -------------------------------------------------------------------------
  it("includes held tickers, watchlist, and anomaly tickers in the prompt", async () => {
    let capturedPrompt = "";
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockImplementation(
      async (_feature: string, args: { prompt?: string; system?: string; messages?: unknown }) => {
        // Capture both prompt and system in a single string for assertion
        capturedPrompt = [args.system ?? "", args.prompt ?? ""].join("\n");
        return { text: VALID_SYNTHESIS, finishReason: "stop" };
      },
    );

    await synthesize({
      buckets: [makeBucket("NVDA", "NVIDIA Corp", [makeArticle(1, "VK")])],
      heldSymbols: ["NVDA", "AAPL"],
      watchlist: ["TSM"],
      anomalies: [{ symbol: "GOOG", companyName: "Alphabet" }],
    });

    expect(capturedPrompt).toContain("NVDA");
    expect(capturedPrompt).toContain("AAPL");
    expect(capturedPrompt).toContain("TSM");
    expect(capturedPrompt).toContain("GOOG");
  });

  // -------------------------------------------------------------------------
  // 7. Coverage-characterization rules in the system prompt (regression for
  //    2026-05-12 APP "only mentioned indirectly by TMTB" confabulation)
  // -------------------------------------------------------------------------
  it("instructs Sonnet to NOT characterize coverage as 'indirect'/'in passing'", async () => {
    let capturedSystem = "";
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockImplementation(
      async (_feature: string, args: { prompt?: string; system?: string; messages?: unknown }) => {
        capturedSystem = args.system ?? "";
        return { text: VALID_SYNTHESIS, finishReason: "stop" };
      },
    );

    await synthesize({
      buckets: [makeBucket("APP", "AppLovin", [makeArticle(1, "TMTB")])],
      heldSymbols: ["APP"],
      watchlist: [],
      anomalies: [],
    });

    // The new HARD rule block must appear in the system prompt, with the
    // specific forbidden phrasings called out so future contributors can't
    // silently drop the guardrail.
    expect(capturedSystem).toContain("COVERAGE-CHARACTERIZATION RULES");
    expect(capturedSystem).toContain("only mentioned indirectly");
    expect(capturedSystem).toContain("mentioned in passing");
    expect(capturedSystem).toContain(
      "Do NOT label any source as having mentioned a symbol",
    );
  });

  it("instructs Sonnet to give held tickers their own section, not 'Also covered'", async () => {
    let capturedSystem = "";
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockImplementation(
      async (_feature: string, args: { prompt?: string; system?: string; messages?: unknown }) => {
        capturedSystem = args.system ?? "";
        return { text: VALID_SYNTHESIS, finishReason: "stop" };
      },
    );

    await synthesize({
      buckets: [makeBucket("APP", "AppLovin", [makeArticle(1, "TMTB")])],
      heldSymbols: ["APP"],
      watchlist: [],
      anomalies: [],
    });

    expect(capturedSystem).toContain("HELD-TICKER PRIORITIZATION");
    expect(capturedSystem).toContain(
      "Every held ticker",
    );
    expect(capturedSystem).toContain("MUST get its own");
  });

  // -------------------------------------------------------------------------
  // 9. Timeframe / thread-coherence rules (regression for 2026-06-05 Goldman
  //    Sachs passage: a single bucket spanning Thursday-up + Friday-down +
  //    an IPO-fee catalyst got fused into one self-contradictory paragraph).
  // -------------------------------------------------------------------------
  it("instructs Sonnet to separate trading days and keep distinct threads apart", async () => {
    let capturedSystem = "";
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockImplementation(
      async (_feature: string, args: { prompt?: string; system?: string; messages?: unknown }) => {
        capturedSystem = args.system ?? "";
        return { text: VALID_SYNTHESIS, finishReason: "stop" };
      },
    );

    await synthesize({
      buckets: [makeBucket("GS", "Goldman Sachs", [makeArticle(1, "Vital Knowledge")])],
      heldSymbols: ["GS"],
      watchlist: [],
      anomalies: [],
    });

    // The new HARD rule block must appear so future contributors can't drop it.
    expect(capturedSystem).toContain("TIMEFRAME & THREAD COHERENCE");
    expect(capturedSystem).toContain("attribute each price move");
    expect(capturedSystem).toContain("is NOT a contradiction");
    expect(capturedSystem).toContain("do not assert an unsourced reason");
  });
});

// ---------------------------------------------------------------------------
// Edition-aware prompt (digest redesign — Task 4)
// ---------------------------------------------------------------------------

describe("edition-aware prompt (digest redesign)", () => {
  /** Build an article with a custom subject (the edition classifier reads subject). */
  function makeArticleWithSubject(
    id: number,
    sourceName: string,
    subject: string,
    sentiment: string | null = "bullish",
    summary = "Some article summary text.",
    sourceUrl: string | null = null,
  ): CompanyBucket["articles"][number] {
    return {
      id,
      source_name: sourceName,
      subject,
      summary,
      sentiment,
      mentioned_symbols: null,
      portfolio_relevance: null,
      key_themes: null,
      source_url: sourceUrl,
      website_url: null,
    };
  }

  /**
   * Mock generateTextForFeature once to capture system + prompt, then call synthesize
   * with the given overrides merged onto a sensible base input.
   */
  async function captureSynthesisCall(
    over: Partial<SynthesisInput> = {},
  ): Promise<{ system: string; prompt: string }> {
    let capturedSystem = "";
    let capturedPrompt = "";

    (generateTextForFeature as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_feature: string, args: { system?: string; prompt?: string }) => {
        capturedSystem = args.system ?? "";
        capturedPrompt = args.prompt ?? "";
        return {
          text: "## Heading\n" + "x".repeat(300),
          finishReason: "stop" as const,
        };
      },
    );

    const baseInput: SynthesisInput = {
      buckets: [
        makeBucket("NVDA", "NVIDIA Corp", [
          makeArticleWithSubject(
            1,
            "Vital Knowledge",
            "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026",
          ),
        ]),
      ],
      heldSymbols: ["NVDA"],
      watchlist: [],
      anomalies: [],
    };

    await synthesize({ ...baseInput, ...over });
    return { system: capturedSystem, prompt: capturedPrompt };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("system prompt pins EDITION COLLAPSING and OUTPUT SECTION ORDER blocks", async () => {
    const { system } = await captureSynthesisCall();
    expect(system).toContain("EDITION COLLAPSING (HARD):");
    expect(system).toContain("Tell each session's story ONCE");
    expect(system).toContain("OUTPUT SECTION ORDER (HARD):");
    expect(system).toContain("## Also covered");
    expect(system).toContain("header MUST begin with the ticker symbol");
  });

  it("session heading flows into the system prompt", async () => {
    const { system } = await captureSynthesisCall({
      sessionHeading: "Overnight & Setup",
    });
    expect(system).toContain("## Overnight & Setup");
  });

  it("defaults sessionHeading to The Session", async () => {
    const { system } = await captureSynthesisCall();
    expect(system).toContain("## The Session");
  });

  it("bucket lines carry edition tags", async () => {
    const { prompt } = await captureSynthesisCall();
    expect(prompt).toContain("Vital Knowledge [recap]");
  });
});
