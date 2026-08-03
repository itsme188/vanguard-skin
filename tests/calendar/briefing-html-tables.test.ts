import { describe, expect, it } from "vitest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";

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
