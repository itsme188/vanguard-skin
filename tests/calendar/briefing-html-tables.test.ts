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
