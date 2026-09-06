import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptCard } from "@/app/dashboard/components/TranscriptCard";
import type { TranscriptSummaryEntry } from "@/lib/queries/transcripts";

// QA finding: research-transcripts-list--8k-cover-pages-labelled-transcript-duplicate-quarter-cards-regression-1
//
// `source: 'edgar_8k'` rows are SEC Form 8-K cover pages (an earnings-release
// filing header — no "Operator", a signature block at the end), not a real
// earnings-call transcript. The card previously hard-coded a "transcript"
// badge/CTA/modal title for every source and rendered the mechanically
// truncated cover-page text as if it were an AI-analyzed summary, plus
// Guidance/Risk Factors sections extracted from that same boilerplate text.
// This is a render-level regression test (react-dom/server's
// renderToStaticMarkup — this repo has no @testing-library/react/jsdom; see
// the precedent note in tests/dashboard/nearby-levels-privacy.test.tsx).
// TranscriptCard is client-only state (useState, no effects) so it renders
// fine via SSR for assertion purposes even though it's a "use client" file.

function sampleTranscript(
  overrides: Partial<TranscriptSummaryEntry> = {}
): TranscriptSummaryEntry {
  return {
    id: 1,
    ticker: "TEST",
    security_name: "Test Co",
    year: 2026,
    quarter: 2,
    call_date: "2026-05-01",
    source: "alpha_vantage",
    summary: "Test Co reported strong revenue growth this quarter.",
    guidance: "Management raised full-year guidance.",
    risk_factors: "Supply chain risk was noted.",
    sentiment_label: "bullish",
    sentiment_score: 0.42,
    has_full_transcript: true,
    fetched_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("TranscriptCard — edgar_8k cover pages are labeled as filings, not transcripts", () => {
  it("shows an '8-K filing' kind badge and a 'View filing' CTA, never the word 'transcript' as a badge", () => {
    const html = renderToStaticMarkup(
      <TranscriptCard
        transcript={sampleTranscript({
          source: "edgar_8k",
          summary: "Item 2.02 Results of Operations and Financial Condition...",
          guidance: null,
          risk_factors: null,
          sentiment_label: null,
          sentiment_score: null,
        })}
      />
    );

    expect(html).toContain("8-K filing");
    expect(html).toContain("View filing");
    expect(html).not.toContain(">transcript<");
    expect(html).not.toContain("View Full Transcript");
  });

  it("hides the sentiment chip and the Guidance / Risk Factors sections, showing one honest line instead", () => {
    const html = renderToStaticMarkup(
      <TranscriptCard
        transcript={sampleTranscript({
          source: "edgar_8k",
          summary: "Item 2.02 Results of Operations and Financial Condition...",
          guidance: "full-year outlook raised",
          risk_factors: "some risk paragraph",
          sentiment_label: "bullish",
          sentiment_score: 0.5,
        })}
      />
    );

    expect(html).not.toContain("bullish");
    expect(html).not.toContain("Guidance");
    expect(html).not.toContain("Risk Factors");
    // The raw press-release excerpt must not be presented as an AI summary.
    expect(html).not.toContain("Item 2.02 Results of Operations");
    expect(html).toContain("no call transcript is available");
  });

  it("titles the full-filing modal honestly (rendered via showFullTranscript state is unreachable via SSR, so this pins the closed-modal card only)", () => {
    // The modal itself only mounts after a click handler sets state, which
    // renderToStaticMarkup can't exercise — pinned separately by the source
    // scan below.
    const html = renderToStaticMarkup(
      <TranscriptCard transcript={sampleTranscript({ source: "edgar_8k" })} />
    );
    expect(html).not.toContain("Earnings</span>");
  });

  it("source: the modal header renders '8-K Filing' (not 'Earnings') for edgar_8k rows", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/dashboard/components/TranscriptCard.tsx"),
      "utf8"
    );
    expect(source).toMatch(/8-K Filing/);
  });
});

describe("TranscriptCard — every other source keeps today's labels exactly", () => {
  it("shows the 'transcript' kind badge and 'View Full Transcript' CTA for alpha_vantage rows", () => {
    const html = renderToStaticMarkup(
      <TranscriptCard transcript={sampleTranscript({ source: "alpha_vantage" })} />
    );

    expect(html).toContain(">transcript<");
    expect(html).toContain("View Full Transcript");
    expect(html).not.toContain("8-K filing");
    expect(html).not.toContain("View filing<");
  });

  it("still renders the sentiment chip and Guidance / Risk Factors sections for alpha_vantage rows", () => {
    const html = renderToStaticMarkup(
      <TranscriptCard transcript={sampleTranscript({ source: "alpha_vantage" })} />
    );

    expect(html).toContain("bullish");
    expect(html).toContain("Guidance");
    expect(html).toContain("Risk Factors");
    expect(html).toContain("Test Co reported strong revenue growth this quarter.");
  });
});
