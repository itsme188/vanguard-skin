import { describe, expect, it } from "vitest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { anchorIndex } from "@/tests/helpers/source-anchor";

describe("briefingToHtml — markdown tables", () => {
  it("converts a basic markdown table into an email-safe HTML table", () => {
    const md = `# Hello

| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| EPS | 0.70 | 0.70 | in-line |
| Revenue | $4.31B | $4.345B | +0.9% |

Some prose afterward.`;
    const html = briefingToHtml(md, "Test");
    expect(html).toContain("<table");
    expect(html).toContain("<thead>");
    expect(html).toContain("Metric");
    expect(html).toContain("Consensus");
    expect(html).toContain("0.70");
    expect(html).toContain("$4.31B");
    expect(html).toContain("+0.9%");
    expect(html).toContain("font-variant-numeric:tabular-nums");
    // Prose after the table is still rendered.
    expect(html).toContain("Some prose afterward.");
    // Original headline survives as h1.
    expect(html).toMatch(/<h1[^>]*>Hello<\/h1>/);
  });

  it("renders empty / em-dash cells with extra padding for fill-by-hand", () => {
    const md = `| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| EPS | 0.70 | — | — |
| Revenue | $4.31B | — | — |`;
    const html = briefingToHtml(md, "Preview");
    // Fillable cells get 14px vertical padding (vs 8px for filled cells)
    expect(html).toMatch(/padding:14px 10px[^>]*>&nbsp;</);
    // The metric label column stays at standard padding.
    expect(html).toMatch(/padding:8px 10px[^>]*>EPS</);
  });

  it("skips a single-pipe sentence that's not a real table", () => {
    const md = `Just a paragraph with | a single pipe in the middle |.

Another paragraph.`;
    const html = briefingToHtml(md, "Test");
    expect(html).not.toContain("<table cellpadding");
    expect(html).toContain("Just a paragraph");
  });

  it("preserves bold inline within table cells", () => {
    const md = `| Metric | Value |
|---|---|
| **EPS** | $0.70 |`;
    const html = briefingToHtml(md, "Test");
    expect(html).toContain("<strong");
    expect(html).toContain("EPS");
  });
});

describe("briefingToHtml — multi-line table rows (qa:email-html--multiline-table-row-spills-raw-markdown-pipes)", () => {
  // The model intermittently emits ONE logical table row across several
  // physical lines. Pre-fix, the first non-pipe line closed the line-based
  // parser and every later |-line spilled as a literal pipe paragraph.

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
    // Every row lands inside ONE table; no raw pipe paragraphs escape.
    expect(html.match(/<thead>/g)?.length).toBe(1); // one content table (shell adds layout tables)
    expect(html).not.toMatch(/<p[^>]*>\s*\|/);
    expect(html).toContain("beat by 6% vs consensus");
    expect(html).toContain("Margin");
    expect(html).toContain("Prose after.");
  });

  it("glues a bare fragment line between complete rows onto the previous row's last cell", () => {
    const md = `| Metric | Value |
|---|---|
| EPS | 0.70 |
| Guidance | raised
6% |
| FCF | $2.1B |`;
    const html = briefingToHtml(md, "Test");
    expect(html.match(/<thead>/g)?.length).toBe(1); // one content table (shell adds layout tables)
    expect(html).not.toMatch(/<p[^>]*>\s*\|/);
    expect(html).toContain("FCF");
  });

  it("does not swallow trailing prose that follows the table without a blank line", () => {
    const md = `| Metric | Value |
|---|---|
| EPS | 0.70 |
Closing thoughts follow here.`;
    const html = briefingToHtml(md, "Test");
    expect(html).toContain("<table");
    // The prose line is NOT table content — it renders as its own paragraph.
    expect(html).toMatch(/<p[^>]*>Closing thoughts follow here\./);
  });
});

describe("briefingToHtml — escaped pipes in cell text (issue #43)", () => {
  // lib/digest/send-earnings-email.ts's escapeCell escapes a literal `|`
  // inside AI-extracted cell text (e.g. a bogey source_label like
  // "TMT | Breakout") as `\|` before assembling markdown. The renderer must
  // treat `\|` as part of the cell content, not a column boundary — else the
  // escaped pipe still splits the row and shifts every later column.

  it("keeps an escaped pipe in a HEADER cell as one cell, not two columns", () => {
    const md = `| Metric | TMT \\| Breakout (8/4) |
|---|---|
| EPS | 4.30 |`;
    const html = briefingToHtml(md, "Test");
    // Un-escaped, rendered as literal text inside a single header cell.
    expect(html).toContain("TMT | Breakout (8/4)");
    // No leftover backslash from the escape sequence.
    expect(html).not.toContain("TMT \\|");
    expect(html).not.toContain("TMT \\");
  });

  it("keeps an escaped pipe in a BODY cell as one cell, not two columns, and leaves later columns intact", () => {
    const md = `| Metric | Source | Consensus |
|---|---|---|
| EPS | TMT \\| Breakout | 4.30 |`;
    const html = briefingToHtml(md, "Test");
    expect(html).toContain("TMT | Breakout");
    expect(html).not.toContain("TMT \\|");
    // The column AFTER the escaped-pipe cell must not have shifted — 4.30
    // (Consensus) must still be present and distinct from the source cell.
    expect(html).toContain("4.30");
  });
});

describe("briefingToHtml — trailing-pipe short rows (qa:email-html--multiline-table-row-spills-raw-markdown-pipes-regression-1)", () => {
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
    const body = html.slice(anchorIndex(html, "<tbody>"), anchorIndex(html, "</tbody>"));
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
    const body = html.slice(anchorIndex(html, "<tbody>"), anchorIndex(html, "</tbody>"));
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
    const body = html.slice(anchorIndex(html, "<tbody>"), anchorIndex(html, "</tbody>"));
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
    const body = html.slice(anchorIndex(html, "<tbody>"), anchorIndex(html, "</tbody>"));
    expect(body.match(/<tr/g)?.length).toBe(2);
    expect(body).toMatch(/<td[^>]*>\s*0\.72\s*<\/td>/);
    expect(body).toMatch(/<td[^>]*>\s*\+3%\s*<\/td>/);
    expect(body).toMatch(/<td[^>]*>\s*Revenue\s*<\/td>/);
  });
});

/**
 * qa:earnings-email-viewer--recap-scoreboard-blank-cells-contradict-legend.
 * The scoreboard's own legend says a dash on a recap means "data wasn't
 * available at send time". The renderer used to turn every dash cell into an
 * empty fill-in box, in recaps too, so the reader saw a blank where the
 * legend promised a dash. Fill-in boxes are for paper and previews only.
 */
describe("briefingToHtml — recap scoreboards show their dashes", () => {
  const board = (phaseLabel: string, epsActual: string) => `## ZZA scoreboard — ${phaseLabel}

| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| **EPS** | 1.35 | ${epsActual} | — |
| **Guidance (next quarter)** | — | — | — |

*Legend.*`;
  const cellsOf = (html: string): string[] =>
    [...html.matchAll(/<td style="border[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);

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
    expect(cells.slice(5, 8)).toEqual(["&nbsp;", "&nbsp;", "&nbsp;"]);
    expect(html).toMatch(/padding:14px 10px[^>]*>&nbsp;</);
  });

  it("every table in a recap shows its dashes, also one above the scoreboard", () => {
    const md = `| Name | Result |\n|---|---|\n| ZZA | — |\n\n${board("post-print", "—")}\n\n## Line-by-line\n\n| Metric | Bogey | Actual |\n|---|---|---|\n| Margin | 60% | - |`;
    const html = briefingToHtml(md, "Wrap");
    expect(html).not.toContain("padding:14px 10px");
    expect(cellsOf(html).filter((c) => c === "&nbsp;")).toEqual([]);
  });

  it("an empty cell in a recap stays empty and is not given a made-up dash", () => {
    const md = `${board("post-print", "1.42")}\n\n| Metric | Value |\n|---|---|\n| Margin |  |`;
    const cells = cellsOf(briefingToHtml(md, "Recap"));
    expect(cells[cells.length - 1]).toBe("&nbsp;");
  });

  it("a page with a preview scoreboard keeps its boxes even when a recap scoreboard is also present", () => {
    const md = `${board("into the print", "—")}\n\n${board("post-print", "—")}`;
    expect(briefingToHtml(md, "Mixed")).toMatch(/padding:14px 10px[^>]*>&nbsp;</);
  });

  it("the words in running text or in the title do not switch the boxes off", () => {
    const md = `The ZZA scoreboard — post-print is below.\n\n| Event | Consensus | Actual |\n|---|---|---|\n| CPI | 0.3% | — |`;
    const html = briefingToHtml(md, "ZZA scoreboard — post-print");
    expect(html).toMatch(/padding:14px 10px[^>]*>&nbsp;</);
  });

  it("a table with no scoreboard above it (briefing, digest) is unchanged", () => {
    const md = `| Event | Consensus | Actual |\n|---|---|---|\n| CPI | 0.3% | — |`;
    expect(briefingToHtml(md, "Briefing")).toMatch(/padding:14px 10px[^>]*>&nbsp;</);
  });
});
