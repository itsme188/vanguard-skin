/**
 * Regression pins for briefingToHtml's per-line paragraph behavior — this
 * is deliberately NOT a general CommonMark soft-line-break implementation.
 *
 * History: 2026-08-06 Task 1 of the earnings-print-prose-round plan first
 * added a general "merge any bare continuation line into the previous <p>
 * or <li>" rule here, to fix citation-fragmented earnings-preview prose
 * (web_search citations split a sentence across several physical lines
 * with no blank-line separator). Code review caught that this rule sits in
 * the SHARED renderer used by all four email composers (briefing, digest,
 * earnings preview/recap), and several of them deliberately rely on the
 * pre-existing "every non-blank line is its own paragraph" behavior for
 * correct visual structure:
 *
 *   - lib/calendar/briefing.ts's §6 macro section places the verbatim
 *     `**Holdings exposed:** SYM, SYM` cluster line at the END of a
 *     paragraph (HARD RULE 3, briefing.ts:394) on its OWN physical line, no
 *     blank line before it — the general merge rule buried it mid-sentence
 *     in the rendered email instead of showing it as a clean trailing line.
 *   - lib/digest/call-transcripts.ts and lib/earnings/debrief.ts push a
 *     `**Label**\nbody text` shape (bold label line immediately followed by
 *     prose, no blank line) — the general merge rule folded the label
 *     inline into the body ("**Guidance** Four straight beats...") instead
 *     of keeping it as a distinct heading-like line above the paragraph.
 *
 * The general merge rule was REVERTED (this file pins the restored,
 * original behavior). The citation-fragmentation problem it was solving is
 * real but earnings-preview-specific — it's now repaired at the READ
 * boundary only, via the pure `repairCitationLineBreaks` helper applied
 * where stored `ai_output_md` is displayed (see
 * lib/earnings/repair-citation-linebreaks.ts and its own test file), never
 * in the shared renderer every composer depends on.
 *
 * Root cause of the citation fragmentation itself (fixed independently,
 * unaffected by this revert): `joinClaudeTextBlocks` in
 * lib/digest/send-earnings-email.ts now joins Claude's web_search-split
 * TextBlocks with "" instead of "\n", so FUTURE sends never produce this
 * shape in the first place.
 */

import { describe, expect, it } from "vitest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";

// Body paragraphs carry the reader-cadence style (margin:22px 0) — the shell
// template's own chrome (source line, footer) also uses <p> but with a
// different margin, so this scopes matches to convertMarkdown's output only.
function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p style="margin:22px 0;[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
}

describe("briefingToHtml — bare continuation lines render as separate paragraphs (restored/original behavior)", () => {
  it("does NOT merge a citation-fragmented sentence — each bare-newline fragment is its own <p>", () => {
    const md = [
      "## The setup",
      "",
      "Flag this first: multiple sources, including",
      "Target Hospitality's own release stating it will release results Monday",
      ", with",
      "a conference call scheduled for 9:00 AM ET the same day",
      ". That press release is dated August 3, 2026.",
    ].join("\n");
    const html = briefingToHtml(md, "Test");
    const ps = paragraphs(html);
    // Original/restored behavior: one <p> per non-blank line, not merged.
    expect(ps.length).toBeGreaterThan(1);
  });

  it("keeps two genuinely blank-line-separated paragraphs as two <p> elements", () => {
    const md = [
      "First paragraph, complete sentence.",
      "",
      "Second paragraph, a totally separate thought.",
    ].join("\n");
    const html = briefingToHtml(md, "Test");
    const ps = paragraphs(html);
    expect(ps).toHaveLength(2);
    expect(ps[0]).toBe("First paragraph, complete sentence.");
    expect(ps[1]).toBe("Second paragraph, a totally separate thought.");
  });

  it("closes a list around a bare continuation line rather than continuing it (restored behavior)", () => {
    const md = [
      "## What to watch on the call",
      "",
      "1. **Novera recognition timing** — did the order convert.",
      "2. **UK 1,000+ qubit program** —",
      "investors await updates on the program",
      "3. **Commerce Department LOI** — status of the conversion.",
    ].join("\n");
    const html = briefingToHtml(md, "Test");
    // Original behavior: the orphan continuation line closes the list and
    // reopens a second one around it — this is the pre-existing shape the
    // shared renderer has always had. The earnings-specific fix for this
    // exact case lives at the read boundary (repairCitationLineBreaks),
    // not here.
    expect(html.match(/<ul /g)?.length).toBe(2);
  });

  it("still merges an em-dash continuation across a blank line (pre-existing behavior, unchanged)", () => {
    const md = ["First sentence stands alone.", "", "— and this continues it."].join("\n");
    const html = briefingToHtml(md, "Test");
    const ps = paragraphs(html);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toContain("First sentence stands alone. — and this continues it.");
  });

  it("CRITICAL regression pin: a bold-label line immediately followed by body text renders as TWO <p> elements, never merged", () => {
    // The exact shape lib/digest/call-transcripts.ts and
    // lib/earnings/debrief.ts push (`**Label**\nbody`), and the shape the
    // Sunday briefing's per-name commentary blocks use (bold header line +
    // commentary paragraph, no blank line between). A general merge rule
    // here would fold "**LLY — BMO 08:00**" inline into the body sentence —
    // exactly the bug code review caught (490-741-char run-on walls,
    // **Holdings exposed:** roster buried mid-sentence).
    const md = "**LLY — BMO 08:00**\nFour straight beats and a raised full-year outlook.";
    const html = briefingToHtml(md, "Test");
    const ps = paragraphs(html);
    expect(ps).toHaveLength(2);
    expect(ps[0]).toBe('<strong style="color:#0a0a0a;">LLY — BMO 08:00</strong>');
    expect(ps[1]).toBe("Four straight beats and a raised full-year outlook.");
  });

  it("CRITICAL regression pin: the §6 Holdings-exposed cluster line trailing a prose paragraph stays a distinct trailing line, not buried mid-sentence", () => {
    // briefing.ts HARD RULE 3: place the verbatim cluster at paragraph END,
    // on its own physical line, no blank line required before it.
    const md =
      "CPI printed hot and rates repriced higher into the open.\n**Holdings exposed:** AAPL, MSFT, GOOG";
    const html = briefingToHtml(md, "Test");
    const ps = paragraphs(html);
    expect(ps).toHaveLength(2);
    expect(ps[0]).toBe("CPI printed hot and rates repriced higher into the open.");
    expect(ps[1]).toBe('<strong style="color:#0a0a0a;">Holdings exposed:</strong> AAPL, MSFT, GOOG');
  });
});
