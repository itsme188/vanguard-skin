import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isAlphaVantageConfigured,
  getEarningsTranscript,
} from "@/lib/transcripts/alpha-vantage";

// Fixture mirroring the live demo response shape for
// EARNINGS_CALL_TRANSCRIPT&symbol=IBM&quarter=2024Q1&apikey=demo.
// Sentiment arrives as a string per segment.
const FIXTURE = {
  symbol: "IBM",
  quarter: "2024Q1",
  transcript: [
    {
      speaker: "Operator",
      title: "Operator",
      content: "Welcome to the IBM earnings call.",
      sentiment: "0.5",
    },
    {
      speaker: "James Kavanaugh",
      title: "CFO",
      content: "Revenue grew nicely. We expect continued momentum.",
      sentiment: "0.9",
    },
    {
      speaker: "James Kavanaugh",
      title: "CFO",
      content: "Margins expanded across segments.",
      sentiment: "0.7",
    },
  ],
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("ALPHA_VANTAGE_API_KEY", "test-key");
  fetchMock = vi.fn(async () => jsonResponse(FIXTURE));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("isAlphaVantageConfigured", () => {
  it("is true when ALPHA_VANTAGE_API_KEY is set", () => {
    expect(isAlphaVantageConfigured()).toBe(true);
  });

  it("is false when ALPHA_VANTAGE_API_KEY is unset or empty", () => {
    vi.stubEnv("ALPHA_VANTAGE_API_KEY", "");
    expect(isAlphaVantageConfigured()).toBe(false);
  });
});

describe("getEarningsTranscript — response mapping", () => {
  it("joins segments into speaker-attributed paragraphs", async () => {
    const result = await getEarningsTranscript("IBM", 2024, 1);
    expect(result).not.toBeNull();
    expect(result!.transcript).toBe(
      [
        "Operator (Operator): Welcome to the IBM earnings call.",
        "James Kavanaugh (CFO): Revenue grew nicely. We expect continued momentum.",
        "James Kavanaugh (CFO): Margins expanded across segments.",
      ].join("\n\n"),
    );
  });

  it("derives distinct participants from speakers", async () => {
    const result = await getEarningsTranscript("IBM", 2024, 1);
    expect(result!.participants).toEqual([
      { name: "Operator", title: "Operator" },
      { name: "James Kavanaugh", title: "CFO" },
    ]);
  });

  it("averages segment sentiments into overall_sentiment", async () => {
    const result = await getEarningsTranscript("IBM", 2024, 1);
    expect(result!.overall_sentiment).toBeCloseTo((0.5 + 0.9 + 0.7) / 3, 5);
  });

  it("builds the documented query URL with a fiscal YYYYQN quarter", async () => {
    await getEarningsTranscript("IBM", 2024, 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("https://www.alphavantage.co/query?");
    expect(url).toContain("function=EARNINGS_CALL_TRANSCRIPT");
    expect(url).toContain("symbol=IBM");
    expect(url).toContain("quarter=2024Q1");
    expect(url).toContain("apikey=test-key");
  });

  it("omits the title parenthetical when a segment has no title", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        symbol: "IBM",
        quarter: "2024Q1",
        transcript: [
          { speaker: "Analyst", title: "", content: "Question one.", sentiment: "0.1" },
        ],
      }),
    );
    const result = await getEarningsTranscript("IBM", 2024, 1);
    expect(result!.transcript).toBe("Analyst: Question one.");
    expect(result!.participants).toEqual([{ name: "Analyst", title: null }]);
  });

  it("returns null overall_sentiment when no segment sentiment is numeric", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        symbol: "IBM",
        quarter: "2024Q1",
        transcript: [{ speaker: "CEO", title: "CEO", content: "Hello." }],
      }),
    );
    const result = await getEarningsTranscript("IBM", 2024, 1);
    expect(result!.transcript).toBe("CEO (CEO): Hello.");
    expect(result!.overall_sentiment).toBeNull();
  });
});

describe("getEarningsTranscript — graceful no-op (never throws)", () => {
  it("returns null without fetching when the API key is unset", async () => {
    vi.stubEnv("ALPHA_VANTAGE_API_KEY", "");
    const result = await getEarningsTranscript("IBM", 2024, 1);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500));
    await expect(getEarningsTranscript("IBM", 2024, 1)).resolves.toBeNull();
  });

  it("returns null on an empty transcript array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ symbol: "IBM", quarter: "2024Q1", transcript: [] }),
    );
    await expect(getEarningsTranscript("IBM", 2024, 1)).resolves.toBeNull();
  });

  it("returns null on a rate-limit / info payload with no transcript array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Information:
          "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.",
      }),
    );
    await expect(getEarningsTranscript("IBM", 2024, 1)).resolves.toBeNull();
  });

  it("returns null when fetch rejects (network error)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(getEarningsTranscript("IBM", 2024, 1)).resolves.toBeNull();
  });

  it("returns null when the body is not valid JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    });
    await expect(getEarningsTranscript("IBM", 2024, 1)).resolves.toBeNull();
  });

  it("returns null when every segment has empty content", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        symbol: "IBM",
        quarter: "2024Q1",
        transcript: [{ speaker: "Operator", title: "Operator", content: "  " }],
      }),
    );
    await expect(getEarningsTranscript("IBM", 2024, 1)).resolves.toBeNull();
  });
});
