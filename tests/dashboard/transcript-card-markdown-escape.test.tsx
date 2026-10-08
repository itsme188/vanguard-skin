/**
 * QA findings
 *   research-transcripts-summaries--raw-markdown-bold-and-headings-render-as-text
 *   research-notes-transcript-modal--does-not-close-on-escape-regression-1
 *
 * The transcript summary is markdown by prompt design, and the card printed
 * it as plain text: a reader saw literal "**Guidance**" and a leading "#".
 * Render-level test through react-dom/server (the precedent is
 * tests/dashboard/transcript-card-8k-labeling.test.tsx); the Escape handler
 * is an effect, which server rendering never runs, so it is source-pinned.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TranscriptCard,
  collapseSummaryMarkdown,
} from "@/app/dashboard/components/TranscriptCard";
import type { TranscriptSummaryEntry } from "@/lib/queries/transcripts";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

function sampleTranscript(
  overrides: Partial<TranscriptSummaryEntry> = {},
): TranscriptSummaryEntry {
  return {
    id: 1,
    ticker: "TEST",
    security_name: "Test Co",
    year: 2026,
    quarter: 2,
    call_date: "2026-05-01",
    source: "alpha_vantage",
    summary: "Test Co reported revenue growth this quarter.",
    guidance: null,
    risk_factors: null,
    sentiment_label: null,
    sentiment_score: null,
    has_full_transcript: true,
    fetched_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}

const DESK_NOTE = [
  "# Test Co (TEST) Q2 2026 Desk Note",
  "",
  "**Guidance**",
  "- Full-year outlook raised.",
  "",
  "## Tone",
  "Confident on demand.",
].join("\n");

describe("TranscriptCard renders the summary as markdown", () => {
  it("a short desk note shows headings and bold, with no literal markers", () => {
    const html = renderToStaticMarkup(
      <TranscriptCard transcript={sampleTranscript({ summary: DESK_NOTE })} />,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("<h2");
    expect(html).toMatch(/<strong[^>]*>Guidance<\/strong>/);
    expect(html).toContain("Full-year outlook raised.");
    expect(html).not.toContain("**");
    expect(html).not.toMatch(/(^|>)#+ /);
  });

  it("the collapsed preview of a long note leaves no stray markers either", () => {
    // The 300-character cut lands inside the "**Surprises**" label.
    const long = `${"Opening sentence of the note. ".repeat(9)}Then the cut point **Surprises** follow here, with more detail after it.`;
    expect(long.slice(0, 300)).toMatch(/\*\*Surp[a-z]*$/);

    const html = renderToStaticMarkup(
      <TranscriptCard transcript={sampleTranscript({ summary: long })} />,
    );
    expect(html).toContain("Read more");
    expect(html).not.toContain("**");
    expect(html).not.toContain("more detail after it");
  });

  it("plain prose still renders as its own text", () => {
    const html = renderToStaticMarkup(<TranscriptCard transcript={sampleTranscript()} />);
    expect(html).toContain("Test Co reported revenue growth this quarter.");
    expect(html).not.toContain("Read more");
  });
});

describe("collapseSummaryMarkdown", () => {
  it("returns a summary within the limit unchanged", () => {
    expect(collapseSummaryMarkdown("Short note.", 300)).toBe("Short note.");
  });

  it("cuts at a word boundary and marks the cut", () => {
    expect(collapseSummaryMarkdown("alpha beta gamma delta", 13)).toBe("alpha beta…");
  });

  it("never ends inside a bold run", () => {
    const out = collapseSummaryMarkdown("Intro text **Guidance is strong** and more", 24);
    expect(out).toBe("Intro text…");
    expect((out.match(/\*\*/g) ?? []).length % 2).toBe(0);
  });

  it("keeps a bold run that closed before the cut", () => {
    expect(collapseSummaryMarkdown("**Tone** steady and calm today", 20)).toBe(
      "**Tone** steady and…",
    );
  });

  it("drops a heading or list marker that lost its text", () => {
    expect(collapseSummaryMarkdown("First line.\n## Guidance raised", 15)).toBe("First line.…");
    expect(collapseSummaryMarkdown("First line.\n- item one here", 14)).toBe("First line.…");
  });
});

describe("transcript viewer closes on Escape", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "app/dashboard/components/TranscriptCard.tsx"),
    "utf8",
  );

  it("listens for Escape only while the viewer is open, and removes the listener", () => {
    const effect = sliceBetween(src, "useEffect(() => {", "}, [showFullTranscript]);");
    expect(effect).toContain("if (!showFullTranscript) return;");
    expect(effect).toContain('if (e.key === "Escape") setShowFullTranscript(false);');
    expect(effect).toContain('window.addEventListener("keydown", onKeyDown)');
    expect(effect).toContain('window.removeEventListener("keydown", onKeyDown)');
  });

  it("the close button has an accessible name that fits the row's kind", () => {
    const modal = src.slice(anchorIndex(src, "{/* Full transcript modal */}"));
    expect(modal).toContain('aria-label={isFiling ? "Close filing" : "Close transcript"}');
    expect(modal).toContain('title="Close (Esc)"');
  });
});
