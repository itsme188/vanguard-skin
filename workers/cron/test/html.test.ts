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
});
