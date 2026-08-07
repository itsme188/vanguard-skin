/**
 * Read-boundary repair for citation-fragmented earnings preview/recap
 * prose. See docs/superpowers/plans/2026-08-06-artifact-catalog.md for the
 * full root-cause writeup and
 * tests/calendar/briefing-html-continuation-lines.test.ts for why this
 * repair is scoped to the earnings display read boundary rather than the
 * shared briefingToHtml renderer (other composers rely on the renderer's
 * original per-line paragraph behavior).
 *
 * joinClaudeTextBlocks (lib/digest/send-earnings-email.ts) already fixes
 * this at the SOURCE for future sends — this function exists only to repair
 * already-stored ai_output_md rows (pre-fix sends) when they're displayed
 * or printed.
 */

import { describe, expect, it } from "vitest";
import { repairCitationLineBreaks } from "@/lib/earnings/repair-citation-linebreaks";

describe("repairCitationLineBreaks", () => {
  it("rejoins the exact live citation-split fragment into one flowing paragraph", () => {
    const md = [
      "## The setup",
      "",
      "Flag this first: multiple sources, including",
      "[Company]'s own release stating it will release its [quarter] financial results before the market opens on [date]",
      ", with",
      "a conference call scheduled for 9:00 AM ET the same day",
      ". That press release is dated August 3, 2026.",
    ].join("\n");
    const repaired = repairCitationLineBreaks(md);
    expect(repaired).toBe(
      [
        "## The setup",
        "",
        "Flag this first: multiple sources, including [Company]'s own release stating it will release its [quarter] financial results before the market opens on [date], with a conference call scheduled for 9:00 AM ET the same day. That press release is dated August 3, 2026.",
      ].join("\n"),
    );
  });

  it("does not insert a stray space before a comma/period-leading continuation fragment", () => {
    const md = ["Stock closed at $14.50", ", a new 52-week high.", "Volume was elevated."].join(
      "\n",
    );
    const repaired = repairCitationLineBreaks(md);
    expect(repaired).toBe("Stock closed at $14.50, a new 52-week high. Volume was elevated.");
  });

  it("leaves genuinely blank-line-separated paragraphs untouched (no over-merge)", () => {
    const md = [
      "First paragraph, complete sentence.",
      "",
      "Second paragraph, a totally separate thought.",
    ].join("\n");
    expect(repairCitationLineBreaks(md)).toBe(md);
  });

  it("rejoins a numbered-list item split by a citation fragment, without disturbing the next item", () => {
    const md = [
      "## What to watch on the call",
      "",
      "1. **Novera recognition timing** — did the order convert.",
      "2. **UK 1,000+ qubit program** —",
      "investors await updates on the program",
      ", a milestone that has gone quiet.",
      "3. **Commerce Department LOI** — status of the conversion.",
    ].join("\n");
    const repaired = repairCitationLineBreaks(md);
    expect(repaired).toBe(
      [
        "## What to watch on the call",
        "",
        "1. **Novera recognition timing** — did the order convert.",
        "2. **UK 1,000+ qubit program** — investors await updates on the program, a milestone that has gone quiet.",
        "3. **Commerce Department LOI** — status of the conversion.",
      ].join("\n"),
    );
  });

  it("leaves already-clean markdown byte-identical (idempotent on well-formed input)", () => {
    const md = [
      "## Line-by-line bogies",
      "",
      "| Metric | Consensus / Prior | Actual | Δ |",
      "|---|---|---|---|",
      "| Revenue | $1.2B | — | — |",
      "",
      "## The setup",
      "",
      "[Company] goes into the print with the stock up sharply this month.",
      "",
      "**Bull case:** The WHS segment continues to scale.",
    ].join("\n");
    expect(repairCitationLineBreaks(md)).toBe(md);
  });

  it("does not merge into a bold-label-only line or a header/table/blockquote line", () => {
    const md = ["**Guidance**", "Four straight beats and a raised full-year outlook."].join("\n");
    // A bold-label-only line is a structural marker, not mergeable prose —
    // stays two lines (defensive parity with lib/ai/strip-preamble.ts's
    // BOLD_LABEL_LINE_RE, even though earnings prose doesn't currently
    // produce this shape).
    expect(repairCitationLineBreaks(md)).toBe(md);
  });

  it("handles empty input", () => {
    expect(repairCitationLineBreaks("")).toBe("");
  });
});
