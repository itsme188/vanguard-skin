/**
 * Inline-markdown rendering pins for briefingToHtml — specifically the
 * link/emphasis interaction that corrupted the 2026-07-20 morning digest.
 *
 * inlineFormat converts [title](url) to an anchor FIRST, then runs the
 * bold/italic passes over the whole line. Real-world hrefs (Stratechery
 * ?access_token=<JWT>, beehiiv link-redirect JWTs) contain underscores, so
 * the `_(.+?)_` italics regex injected <em> tags INSIDE the href attribute —
 * mail clients rejected the mangled anchor and the raw token leaked as
 * visible text in the email (cc'd recipients included).
 *
 * Worker mirror: workers/cron/test/html.test.ts pins the same behavior.
 */

import { describe, it, expect } from "vitest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";

// JWT-ish URL: multiple underscores, the exact class that broke.
const TOKEN_URL =
  "https://stratechery.com/2026/whos-afraid/?access_token=eyJhb_Gci_OiJSUzI1_NiIs.abc_def_ghi";

describe("briefingToHtml inline links", () => {
  it("keeps underscores inside a link URL out of the italics pass", () => {
    const html = briefingToHtml("A line with [Who's Afraid?](" + TOKEN_URL + ") in it.", "t");

    expect(html).toContain(`href="${TOKEN_URL}"`);
    expect(html).not.toContain("access<em>token");
    expect(html).not.toContain("<em>Gci</em>");
  });

  it("keeps asterisks inside a link URL out of the bold/italic passes", () => {
    const url = "https://example.com/a*b*c?x=1*2";
    const html = briefingToHtml(`[title](${url})`, "t");

    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain("a<em>b</em>c");
  });

  it("still formats bold inside a link label", () => {
    const html = briefingToHtml("[**Deep dive**](https://example.com/x_y_z)", "t");

    expect(html).toContain('href="https://example.com/x_y_z"');
    expect(html).toMatch(/<a [^>]*><strong[^>]*>Deep dive<\/strong><\/a>/);
  });

  it("still italicizes emphasis outside a link on the same line", () => {
    const html = briefingToHtml("_really_ [title](https://example.com/a_b_c) plain", "t");

    expect(html).toContain("<em>really</em>");
    expect(html).toContain('href="https://example.com/a_b_c"');
  });

  it("does not cross-corrupt two underscore-bearing links on one line", () => {
    const line =
      "[one](https://x.com/a_b) and [two](https://y.com/c_d) end";
    const html = briefingToHtml(line, "t");

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
