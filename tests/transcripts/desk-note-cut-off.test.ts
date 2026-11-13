/**
 * The AI desk note is not stored when the reply stopped at the output cap
 * (2026-11-13). transcriptSummary runs on the workhorse tier, whose current
 * model thinks by default; the thinking counts against the cap, which was
 * 900. A note cut off after its first bold section label still passed
 * isValidDeskNote and was stored as complete. The cap now leaves room for
 * thinking (the 300-word length is set by the prompt), and a cut-off keeps
 * the extractive summary, the same path as a rejected note.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { summarizeTranscript } from "@/lib/transcripts/same-day";
import { generateTextForFeature } from "@/lib/ai/generate";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import type { EarningsTranscript } from "@/lib/types";

vi.mock("@/lib/ai/generate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/generate")>()),
  generateTextForFeature: vi.fn(),
}));
vi.mock("@/lib/mutations/transcripts", () => ({ upsertTranscript: vi.fn() }));

const mockedGenerate = vi.mocked(generateTextForFeature);
const mockedUpsert = vi.mocked(upsertTranscript);

const NOTE = "**Guidance**\n- raised\n\n**Tone**\n- confident";

function transcript(): EarningsTranscript {
  return {
    id: 1,
    security_id: 1,
    ticker: "ZZAA",
    year: 2026,
    quarter: 3,
    call_date: "2026-10-01",
    source: "alpha_vantage",
    transcript: "Operator: welcome. ".repeat(400),
    summary: "extractive",
    guidance: null,
    risk_factors: null,
    sentiment_score: null,
    sentiment_label: null,
    participants: null,
    accession_number: null,
    filing_url: null,
    source_key: "k",
    fetched_at: "2026-10-01 00:00:00",
    created_at: "2026-10-01 00:00:00",
  } as EarningsTranscript;
}

const db = {} as Database.Database;

beforeEach(() => {
  mockedGenerate.mockReset();
  mockedUpsert.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("transcriptSummary: a desk note cut off at the output cap", () => {
  it("asks for an output cap with room for default-on thinking", async () => {
    mockedGenerate.mockResolvedValue({ text: NOTE, finishReason: "stop" } as never);
    await summarizeTranscript(db, transcript());
    const opts = mockedGenerate.mock.calls[0][1] as { maxOutputTokens?: number };
    expect(opts.maxOutputTokens).toBeGreaterThanOrEqual(16_000);
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
  });

  it("does not store a desk-note-shaped reply that stopped at the cap", async () => {
    mockedGenerate.mockResolvedValue({ text: NOTE, finishReason: "length" } as never);
    await summarizeTranscript(db, transcript());
    expect(mockedUpsert).not.toHaveBeenCalled();
  });
});
