/**
 * QA 2026-09-07 —
 * security-detail-research-mentions--blank-reader-pane-preheader-only-html-
 * regression-1.
 *
 * The Research Mentions "read" expander chose its body with a bare truthiness
 * test — `article.raw_html ? <NewsletterArticleFrame/> : raw_text` — so a
 * Substack-style email whose stored HTML is nothing but invisible preheader
 * padding rendered a ~490px blank iframe while the whole article sat in
 * raw_text (182 rows in the live book have raw_text > 1.5x raw_html).
 *
 * The Feeds reader next door already made the right choice, through
 * htmlHidesStoredText in lib/gmail/sanitize.ts. This pins BOTH readers to
 * that one helper rather than adding a second copy of the rule — the repo's
 * single-source convention.
 *
 * Source-scan: no jsdom/RTL harness in this repo (see
 * tests/dashboard/narrative-block-refresh.test.ts). The helper's own
 * behaviour is unit-tested in tests/gmail/sanitize-normalize.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const mentions = readFileSync("app/dashboard/components/ResearchMentionsSection.tsx", "utf8");
const feeds = readFileSync("app/dashboard/components/ResearchFeedsView.tsx", "utf8");

describe("Research Mentions reader falls back to raw_text on content-less HTML", () => {
  it("imports the shared helper instead of testing raw_html for truthiness", () => {
    expect(mentions).toMatch(
      /import \{[^}]*htmlHidesStoredText[^}]*\} from "@\/lib\/gmail\/sanitize"/,
    );
    expect(mentions).not.toMatch(/\{article\.raw_html \? \(/);
  });

  it("trims the footer and runs the same fallback the Feeds reader runs", () => {
    expect(mentions).toMatch(/trimEmailFooter\(article\.raw_html\)/);
    expect(mentions).toMatch(/trimEmailFooter\(article\.raw_text\)/);
    expect(mentions).toMatch(/htmlHidesStoredText\(\s*\w+,\s*\w+\s*\)\s*\?\s*null\s*:/);
    // Both surfaces call the one helper — nobody re-implements the rule.
    expect(feeds).toContain("htmlHidesStoredText(");
  });

  it("never injects the email HTML into the page — sandboxed iframe only", () => {
    // The word appears in a comment explaining why the frame exists; what
    // must never appear is the PROP.
    expect(mentions).not.toMatch(/dangerouslySetInnerHTML=/);
    expect(mentions).toContain("<NewsletterArticleFrame");
  });

  it("says so rather than rendering an empty pane when neither body is stored", () => {
    expect(mentions).toMatch(/No article body was stored/i);
  });
});
