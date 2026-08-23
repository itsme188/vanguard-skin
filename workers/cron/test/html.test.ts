/**
 * Worker mirror of tests/calendar/briefing-html-inline.test.ts (Mac side) —
 * the link/emphasis interaction that corrupted the 2026-07-20 morning digest.
 *
 * inlineFormat converts [title](url) to an anchor FIRST, then runs the
 * bold/italic passes over the whole line. Real-world hrefs (Stratechery
 * ?access_token=<JWT>, beehiiv link-redirect JWTs) contain underscores, so
 * `_(.+?)_` injected <em> INSIDE the href attribute — mail clients rejected
 * the mangled anchor and the raw token leaked as visible text.
 */

import { describe, it, expect } from "vitest";
import { briefingToHtml } from "../src/html";

const TOKEN_URL =
  "https://stratechery.com/2026/whos-afraid/?access_token=eyJhb_Gci_OiJSUzI1_NiIs.abc_def_ghi";

describe("briefingToHtml inline links (Worker mirror)", () => {
  it("keeps underscores inside a link URL out of the italics pass", () => {
    const html = briefingToHtml("A line with [Who's Afraid?](" + TOKEN_URL + ") in it.", "t");

    expect(html).toContain(`href="${TOKEN_URL}"`);
    expect(html).not.toContain("access<em>token");
  });

  it("still formats bold inside a link label", () => {
    const html = briefingToHtml("[**Deep dive**](https://example.com/x_y_z)", "t");

    expect(html).toContain('href="https://example.com/x_y_z"');
    expect(html).toMatch(/<a [^>]*><strong[^>]*>Deep dive<\/strong><\/a>/);
  });

  it("does not cross-corrupt two underscore-bearing links on one line", () => {
    const html = briefingToHtml("[one](https://x.com/a_b) and [two](https://y.com/c_d) end", "t");

    expect(html).toContain('href="https://x.com/a_b"');
    expect(html).toContain('href="https://y.com/c_d"');
    expect(html).not.toContain("<em>");
  });

  it("keeps a balanced paren group inside the URL out of the href truncation (quiverquant $TICKER links)", () => {
    const url =
      "https://quiverquant.com/news/MICROSOFT+($MSFT)+Releases+Q4+2026+Earnings,+Stock+Rises";
    const html = briefingToHtml(`[quiverquant.com](${url})`, "t");

    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain("Stock+Rises)</a>");
    expect(html).not.toMatch(/Stock\+Rises\)/);
  });

  it("leaves a plain URL without parens unchanged", () => {
    const url = "https://example.com/news/plain-article-title";
    const html = briefingToHtml(`[source](${url})`, "t");

    expect(html).toContain(`href="${url}"`);
  });

  it("handles a paren-bearing URL at the end of a list line", () => {
    const url = "https://quiverquant.com/news/APPLE+($AAPL)+Beats+Estimates";
    const html = briefingToHtml(`- Coverage: [quiverquant.com](${url})`, "t");

    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain("Beats+Estimates)</a>");
  });
});

describe("briefingToHtml multi-line table rows (Worker mirror)", () => {
  // Mirror of tests/calendar/briefing-html-tables.test.ts (Mac side) —
  // qa:email-html--multiline-table-row-spills-raw-markdown-pipes. The model
  // intermittently emits one logical table row across several physical lines;
  // the body parser must absorb them instead of spilling raw pipe paragraphs.

  it("absorbs an unterminated row + fragment lines into one logical row", () => {
    const md = `| Metric | Consensus | Actual |
|---|---|---|
| EPS | 0.70 | 0.72 |
| Revenue | $12.5B | beat by
6%
vs consensus |
| Margin | 32% | 33% |

Prose after.`;
    const html = briefingToHtml(md, "Test");
    expect(html.match(/<thead>/g)?.length).toBe(1);
    expect(html).not.toMatch(/<p[^>]*>\s*\|/);
    expect(html).toContain("beat by 6% vs consensus");
    expect(html).toContain("Prose after.");
  });

  it("glues a bare fragment between complete rows onto the previous row's last cell", () => {
    const md = `| Metric | Value |
|---|---|
| Guidance | raised
6% |
| FCF | $2.1B |`;
    const html = briefingToHtml(md, "Test");
    expect(html.match(/<thead>/g)?.length).toBe(1);
    expect(html).not.toMatch(/<p[^>]*>\s*\|/);
    expect(html).toContain("FCF");
  });

  it("does not swallow trailing prose after the table", () => {
    const md = `| Metric | Value |
|---|---|
| EPS | 0.70 |
Closing thoughts follow here.`;
    const html = briefingToHtml(md, "Test");
    expect(html.match(/<thead>/g)?.length).toBe(1);
    expect(html).toMatch(/<p[^>]*>Closing thoughts follow here\./);
  });
});
