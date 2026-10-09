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
import { renderScoreboard } from "../src/fallback-earnings";
import { briefingToHtml as macBriefingToHtml } from "../../../lib/calendar/briefing-html";

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

  it("keeps a balanced bracket group inside the link label out of the href truncation (subject line with brackets)", () => {
    const url = "https://example.test/p/update";
    const html = briefingToHtml(
      `[Portfolio Update - [September 8 - September 11, 2026]](${url})`,
      "t",
    );

    expect(html).toContain(`href="${url}"`);
    expect(html).toMatch(
      /<a [^>]*>Portfolio Update - \[September 8 - September 11, 2026\]<\/a>/,
    );
    expect(html).not.toContain("2026]](");
  });

  it("still renders a plain bracket-free label as a link", () => {
    const url = "https://example.test/p/plain";
    const html = briefingToHtml(`[Weekly Briefing](${url})`, "t");

    expect(html).toContain(`href="${url}"`);
    expect(html).toMatch(/<a [^>]*>Weekly Briefing<\/a>/);
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

describe("briefingToHtml generatedAt (Worker mirror)", () => {
  it("stamps the provided generatedAt date, not render time", () => {
    const html = briefingToHtml("body", "t", undefined, new Date("2026-08-13T12:48:50Z"));
    expect(html).toContain("Generated Thursday, August 13, 2026");
  });

  it("defaults to render time when omitted", () => {
    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    expect(briefingToHtml("body", "t")).toContain(`Generated ${today}`);
  });
});

describe("briefingToHtml trailing-pipe short rows (Worker mirror) (qa:email-html--multiline-table-row-spills-raw-markdown-pipes-regression-1)", () => {
  // Regression shape (recap "Line-by-line metrics"): the model closes the
  // consensus cell with a trailing pipe, puts the ACTUAL on its own bare
  // line, and opens the delta cell on a line that starts with a pipe. The
  // trailing pipe made the first physical line parse as a COMPLETE (short)
  // row, the bare actual glued onto the consensus cell, and the delta line
  // opened a phantom one-cell row whose metric read as the delta.
  const md = `| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
| Organic growth | Street ~3-4% (model) | 
6%
 | +2pp beat |
| Unit volume | — (no bogey) | 
Up 5%, every segment grew
 | Beat vs. softness concern |
| Concentrate | — | 
4-point contribution
 | — |`;

  it("absorbs a trailing-pipe short row + bare actual + pipe-led delta into ONE logical row", () => {
    const html = briefingToHtml(md, "Test");
    expect(html.match(/<thead>/g)?.length).toBe(1);
    expect(html).not.toMatch(/<p[^>]*>\s*\|/);
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(body.match(/<tr/g)?.length).toBe(3); // three metrics, no phantom rows
    expect(body).toMatch(/<td[^>]*>\s*6%\s*<\/td>/); // the actual is its own cell
    expect(body).toMatch(/<td[^>]*>\s*\+2pp beat\s*<\/td>/); // the delta is its own cell
    expect(body).not.toMatch(/model\)\s*6%/); // the actual is NOT glued onto consensus
  });

  it("keeps a genuinely short row as its own row when a complete row follows", () => {
    const short = `| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| EPS | 0.70 |
| Revenue | $12.5B | $13.0B | +4% |`;
    const html = briefingToHtml(short, "Test");
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(body.match(/<tr/g)?.length).toBe(2);
    expect(body).toMatch(/<td[^>]*>\s*EPS\s*<\/td>/);
    expect(body).toMatch(/<td[^>]*>\s*Revenue\s*<\/td>/);
  });

  it("keeps two CONSECUTIVE genuinely short rows as two rows (pipe-led short line is not a continuation)", () => {
    const short = `| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| EPS | 0.70 |
| Revenue | 12.5B |`;
    const html = briefingToHtml(short, "Test");
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(body.match(/<tr/g)?.length).toBe(2);
    expect(body).toMatch(/<td[^>]*>\s*EPS\s*<\/td>/);
    expect(body).toMatch(/<td[^>]*>\s*Revenue\s*<\/td>/);
  });

  it("still merges a short row + bare fragment + pipe-led delta into one row", () => {
    const md = `| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| EPS | 0.70 |
0.72
| +3% |
| Revenue | 12.5B |`;
    const html = briefingToHtml(md, "Test");
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(body.match(/<tr/g)?.length).toBe(2);
    expect(body).toMatch(/<td[^>]*>\s*0\.72\s*<\/td>/);
    expect(body).toMatch(/<td[^>]*>\s*\+3%\s*<\/td>/);
    expect(body).toMatch(/<td[^>]*>\s*Revenue\s*<\/td>/);
  });
});

/**
 * Worker mirror of tests/calendar/briefing-html-tables.test.ts "recap
 * scoreboards show their dashes"
 * (qa:earnings-email-viewer--recap-scoreboard-blank-cells-contradict-legend).
 * The scoreboard legend says a dash on a recap means the figure was not
 * available; the renderer must not turn that dash into an empty fill-in box.
 * Previews keep their boxes. The last block pins the two renderers together.
 */
describe("briefingToHtml recap scoreboards show their dashes (Worker mirror)", () => {
  const board = (phaseLabel: string, epsActual: string) => `## ZZA scoreboard — ${phaseLabel}

| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| **EPS** | 1.35 | ${epsActual} | — |
| **Guidance (next quarter)** | — | — | — |

*Legend.*`;
  const cellsOf = (html: string): string[] =>
    [...html.matchAll(/<td style="border[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
  const tablesOf = (html: string): string[] =>
    [...html.matchAll(/<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse[\s\S]*?<\/table>/g)].map((m) => m[0]);

  it("a recap keeps every dash as a dash, at normal cell padding", () => {
    const html = briefingToHtml(board("post-print", "1.42"), "ZZA Earnings Recap");
    const cells = cellsOf(html);
    expect(cells.slice(1, 4)).toEqual(["1.35", "1.42", "—"]);
    expect(cells.slice(5, 8)).toEqual(["—", "—", "—"]);
    expect(html).not.toContain("padding:14px 10px");
  });

  it("a preview keeps its empty fill-in boxes", () => {
    const html = briefingToHtml(board("into the print", "—"), "ZZA Earnings Preview");
    const cells = cellsOf(html);
    expect(cells.slice(1, 4)).toEqual(["1.35", "&nbsp;", "&nbsp;"]);
    expect(html).toMatch(/padding:14px 10px[^>]*>&nbsp;</);
  });

  it("the Worker's own recap scoreboard renders dashes; its preview renders boxes", () => {
    const ev = {
      id: 1, symbol: "ZZA", event_date: "2026-08-13", event_type: "earnings",
      consensus_estimate: "EPS 1.35 · Rev 750M", actual_value: "EPS 1.42 · Rev 775M",
      consensus_value: null, reaction_snapshot: null,
    } as unknown as Parameters<typeof renderScoreboard>[0];
    const recap = briefingToHtml(renderScoreboard(ev, "recap", null, false), "ZZA Earnings Recap");
    expect(recap).not.toContain("padding:14px 10px");
    expect(cellsOf(recap)).not.toContain("&nbsp;");
    expect(cellsOf(recap).filter((c) => c === "—").length).toBeGreaterThan(5);
    const preview = briefingToHtml(renderScoreboard(ev, "preview", null, false), "ZZA Earnings Preview");
    expect(preview).toMatch(/padding:14px 10px[^>]*>&nbsp;</);
    expect(cellsOf(preview)).not.toContain("—");
  });

  it("a page with a preview scoreboard keeps its boxes; plain text and the title never switch them off", () => {
    const mixed = `${board("into the print", "—")}\n\n${board("post-print", "—")}`;
    expect(briefingToHtml(mixed, "Mixed")).toMatch(/padding:14px 10px[^>]*>&nbsp;</);
    const prose = `The ZZA scoreboard — post-print is below.\n\n| Event | Consensus | Actual |\n|---|---|---|\n| CPI | 0.3% | — |`;
    expect(briefingToHtml(prose, "ZZA scoreboard — post-print")).toMatch(/padding:14px 10px[^>]*>&nbsp;</);
  });

  it("parity: Mac and Worker render every table identically for recap, preview, mixed and plain pages", () => {
    const pages = [
      board("post-print", "1.42"),
      board("post-print", "—"),
      board("into the print", "—"),
      `${board("into the print", "—")}\n\n${board("post-print", "—")}`,
      `| Name | Result |\n|---|---|\n| ZZA | — |\n\n${board("post-print", "—")}\n\n| Metric | Value |\n|---|---|\n| Margin |  |\n| Cash | - |\n| Debt | – |`,
      `| Event | Consensus | Actual |\n|---|---|---|\n| CPI | 0.3% | — |`,
      `### ZZA scoreboard — post-print\n\n| A | B |\n|---|---|\n| x | — |`,
      `## ZZA Scoreboard — Post-Print\n\n| A | B |\n|---|---|\n| x | — |`,
    ];
    for (const md of pages) {
      const worker = tablesOf(briefingToHtml(md, "t"));
      expect(worker.length).toBeGreaterThan(0);
      expect(worker).toEqual(tablesOf(macBriefingToHtml(md, "t")));
    }
  });
});
