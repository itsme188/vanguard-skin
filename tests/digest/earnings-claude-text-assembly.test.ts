/**
 * Root-cause fix for the "prose doesn't flow" complaint in earnings preview
 * emails (2026-08-06 catalog: docs/superpowers/plans/
 * 2026-08-06-artifact-catalog.md).
 *
 * When Claude's server-side web_search tool cites a source, Anthropic splits
 * the response's prose across several adjacent TextBlocks around the cited
 * span — the full text is reconstructed by concatenating those blocks IN
 * ORDER, with NO separator (whatever whitespace the model intended between
 * fragments already lives inside each block's own .text, e.g. a trailing
 * space before the citation). `callClaude` previously joined with "\n",
 * which manufactured a literal mid-sentence line break at every citation
 * boundary — briefingToHtml's paragraph parser then rendered each fragment
 * as its own one-line <p>, or (inside a numbered/bulleted list) closed the
 * list early and reopened a second one around the orphan fragment. Six live
 * preview emails all showed this pattern in every prose section.
 */

import { describe, expect, it } from "vitest";
import { joinClaudeTextBlocks } from "@/lib/digest/send-earnings-email";

describe("joinClaudeTextBlocks (web_search citation text-block reassembly)", () => {
  it("concatenates blocks with no separator — reproduces the live citation split", () => {
    // Exact fragment shape pulled from a live preview's stored
    // ai_output_md: three TextBlocks around two cited spans. Each block
    // already carries its own trailing/leading whitespace.
    const blocks = [
      { text: "Flag this first: multiple sources, including " },
      {
        text: "[Company]'s own release stating it will release its [quarter] financial results before the market opens on [date]",
      },
      { text: ", with " },
      { text: "a conference call scheduled for 9:00 AM ET the same day" },
      { text: ". That press release is dated August 3, 2026." },
    ];
    expect(joinClaudeTextBlocks(blocks)).toBe(
      "Flag this first: multiple sources, including [Company]'s own release stating it will release its [quarter] financial results before the market opens on [date], with a conference call scheduled for 9:00 AM ET the same day. That press release is dated August 3, 2026.",
    );
  });

  it("does NOT insert a bare newline between blocks (the pre-fix behavior)", () => {
    const blocks = [{ text: "First block." }, { text: " Second block." }];
    const joined = joinClaudeTextBlocks(blocks);
    expect(joined).not.toContain("\n");
    expect(joined).toBe("First block. Second block.");
  });

  it("preserves a real paragraph break when it lives inside one block's own text", () => {
    // The model's own structural formatting (## headers, blank-line
    // paragraph breaks) is never split across a block boundary by the
    // citation mechanism — it's already correct WITHIN a block's .text.
    const blocks = [{ text: "## The setup\n\nFirst paragraph." }, { text: " Continued." }];
    expect(joinClaudeTextBlocks(blocks)).toBe("## The setup\n\nFirst paragraph. Continued.");
  });

  it("trims leading/trailing whitespace off the assembled result", () => {
    expect(joinClaudeTextBlocks([{ text: "  ## Header\n" }])).toBe("## Header");
  });

  it("returns an empty string for no blocks", () => {
    expect(joinClaudeTextBlocks([])).toBe("");
  });
});
