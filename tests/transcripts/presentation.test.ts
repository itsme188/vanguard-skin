/**
 * Single-source transcript presentation helpers (lib/transcripts/presentation.ts).
 *
 * `earnings_transcripts` holds two different things under one table:
 *   - a real earnings-CALL transcript (api_ninjas / alpha_vantage / motley_fool)
 *   - an SEC 8-K earnings press release (source = 'edgar_8k')
 * and its `summary` column holds two different things too:
 *   - a real AI desk note (summarizeTranscript, lib/transcripts/same-day.ts)
 *   - a mechanical extractive excerpt (generateSummary, lib/transcripts/fetch.ts)
 *
 * Every render surface (Research wall card, security detail, notes wall,
 * morning digest, earnings debrief) has to make the same two calls, so the
 * rules live here once. The desk-note rule mirrors the STORE-time gate
 * `isValidDeskNote` exactly — that gate is what decides whether an AI note is
 * ever written over the extractive summary, so agreeing with it is the
 * definition of "this summary is a desk note". The parity test below pins the
 * two implementations together.
 */

import { describe, it, expect } from "vitest";
import {
  transcriptKind,
  hasDeskNote,
  kindLabel,
  kindHeadingLabel,
  sourceLabel,
  transcriptCountLabel,
} from "@/lib/transcripts/presentation";
import { isValidDeskNote } from "@/lib/transcripts/same-day";

const DESK_NOTE = [
  "**Guidance**",
  "- Reaffirmed, not raised. Q3 +12% reported.",
  "",
  "**Tone**",
  "Confident, controlled, on-message throughout.",
].join("\n");

const EXTRACTIVE =
  "Item 2.02 Results of Operations and Financial Condition. On May 1, 2026, the Company issued a press release announcing its results for the quarter, a copy of which is furnished as Exhibit 99.1.";

describe("transcriptKind", () => {
  it("classifies edgar_8k as a filing and every transcript source as a call", () => {
    expect(transcriptKind({ source: "edgar_8k" })).toBe("filing");
    expect(transcriptKind({ source: "alpha_vantage" })).toBe("call");
    expect(transcriptKind({ source: "api_ninjas" })).toBe("call");
    expect(transcriptKind({ source: "motley_fool" })).toBe("call");
  });

  it("is case-insensitive on the stored source token", () => {
    expect(transcriptKind({ source: "EDGAR_8K" })).toBe("filing");
  });
});

describe("hasDeskNote", () => {
  it("is true for an AI desk note and false for a mechanical excerpt", () => {
    expect(hasDeskNote({ summary: DESK_NOTE })).toBe(true);
    expect(hasDeskNote({ summary: EXTRACTIVE })).toBe(false);
  });

  it("is false for an empty, whitespace-only or missing summary", () => {
    expect(hasDeskNote({ summary: null })).toBe(false);
    expect(hasDeskNote({ summary: "" })).toBe(false);
    expect(hasDeskNote({ summary: "   \n  " })).toBe(false);
    expect(hasDeskNote({})).toBe(false);
  });

  it("is false for a legacy stored soft refusal (pre-2026-07-23 rows predate the store gate)", () => {
    expect(
      hasDeskNote({
        summary: "- **Guidance**: please provide the transcript and I'll produce the desk note.",
      }),
    ).toBe(false);
  });

  it("does not care about the source — a fat 8-K carries a real desk note", () => {
    expect(hasDeskNote({ source: "edgar_8k", summary: DESK_NOTE })).toBe(true);
  });

  /**
   * The store gate is the authority: a summary is a desk note exactly when
   * `isValidDeskNote` would have accepted it for storage. If that gate ever
   * moves, this test fails and the presentation rule has to move with it.
   */
  it("agrees with the store-time gate isValidDeskNote on every sample", () => {
    const samples = [
      DESK_NOTE,
      EXTRACTIVE,
      "**Tone**: cautious.",
      "**Surprises**: none.",
      "**Key Quotes**\n- \"We manage to the full year.\"",
      "**Guidance**: raised.",
      "Guidance was raised but nothing is bolded.",
      "- **Guidance**: please provide the transcript.",
      "## Guidance\nHeading-styled note with no bold labels.",
      "",
    ];
    for (const s of samples) {
      expect({ sample: s, deskNote: hasDeskNote({ summary: s }) }).toEqual({
        sample: s,
        deskNote: isValidDeskNote(s),
      });
    }
  });
});

describe("labels", () => {
  it("kindLabel names the artifact honestly", () => {
    expect(kindLabel({ source: "edgar_8k" })).toBe("8-K filing");
    expect(kindLabel({ source: "alpha_vantage" })).toBe("transcript");
  });

  it("kindHeadingLabel gives the email/section noun — never 'call' for a filing", () => {
    expect(kindHeadingLabel({ source: "edgar_8k" })).toBe("8-K press release");
    expect(kindHeadingLabel({ source: "motley_fool" })).toBe("call");
  });

  it("sourceLabel never returns the raw stored token", () => {
    expect(sourceLabel({ source: "edgar_8k" })).toBe("8-K");
    expect(sourceLabel({ source: "alpha_vantage" })).toBe("AV");
    expect(sourceLabel({ source: "motley_fool" })).toBe("MF");
    expect(sourceLabel({ source: "api_ninjas" })).toBe("API");
    // Unknown future source: humanized, never the raw snake_case token.
    expect(sourceLabel({ source: "seeking_alpha" })).toBe("SEEKING ALPHA");
    expect(sourceLabel({ source: "" })).toBe("UNKNOWN");
  });
});

describe("transcriptCountLabel", () => {
  it("counts calls and filings separately instead of calling everything a transcript", () => {
    expect(
      transcriptCountLabel([{ source: "alpha_vantage" }, { source: "api_ninjas" }]),
    ).toBe("2 transcripts");
    expect(transcriptCountLabel([{ source: "edgar_8k" }])).toBe("1 filing");
    expect(
      transcriptCountLabel([{ source: "edgar_8k" }, { source: "edgar_8k" }]),
    ).toBe("2 filings");
    expect(
      transcriptCountLabel([{ source: "alpha_vantage" }, { source: "edgar_8k" }]),
    ).toBe("1 transcript, 1 filing");
    expect(transcriptCountLabel([])).toBe("");
  });
});
