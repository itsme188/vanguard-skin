/**
 * Rich preview-based worksheet (2026-08-05 spec) — pure markdown extraction,
 * monospace table rendering, page composition. No DB, no IO.
 */
import { describe, it, expect } from "vitest";
import {
  parseMarkdownTable,
  extractFirstTable,
  extractPreviewSections,
  wrapText,
  mdToPlainText,
  renderMonospaceTable,
} from "@/lib/earnings/worksheet-rich";

const PREVIEW_MD = `## Line-by-line bogies

| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
| Revenue | Street ~$196.9B vs. company guide $194–199B; Finnhub sync shows $200.3B (outlier — flag the gap) | — | — |
| **EPS (GAAP)** | $1.82–1.86 Street; Visible Alpha $1.99 | — | — |
| AWS revenue | $40.5B, implying ~31% y/y growth | — | — |

## The setup

AMZN goes into the print up 4% over 30 days. [BofA note](https://example.com/x) flags capex.

## Bull case / bear case

- **Bull:** AWS reacceleration above 31%
- **Bear:** FY26 capex guide above $218B

## Sources

- TMT Breakout 8/1 — [link](https://example.com/y)
`;

describe("parseMarkdownTable", () => {
  it("parses header + rows, trims cells, strips bold markers", () => {
    const lines = PREVIEW_MD.split("\n").slice(2, 7);
    const t = parseMarkdownTable(lines);
    expect(t).not.toBeNull();
    expect(t!.header).toEqual(["Metric", "Consensus / Prior", "Actual", "Δ"]);
    expect(t!.rows).toHaveLength(3);
    expect(t!.rows[1][0]).toBe("EPS (GAAP)"); // ** stripped
    expect(t!.rows[0][2]).toBe("—");
  });

  it("returns null when the first line is not a table row", () => {
    expect(parseMarkdownTable(["not a table"])).toBeNull();
  });

  it("tolerates a missing separator row and ragged column counts", () => {
    const t = parseMarkdownTable(["| A | B |", "| 1 |", "| 1 | 2 | 3 |"]);
    expect(t!.header).toEqual(["A", "B"]);
    expect(t!.rows).toEqual([["1"], ["1", "2", "3"]]);
  });
});

describe("extractFirstTable", () => {
  it("returns the table plus the markdown after it", () => {
    const { table, after } = extractFirstTable(PREVIEW_MD);
    expect(table!.rows).toHaveLength(3);
    expect(after).toContain("## The setup");
    expect(after).not.toContain("| Revenue |");
  });

  it("returns null table + full input when no table exists", () => {
    const { table, after } = extractFirstTable("just prose\n\nmore prose");
    expect(table).toBeNull();
    expect(after).toBe("just prose\n\nmore prose");
  });
});

describe("extractPreviewSections", () => {
  it("extracts the bogies table and the commentary span, excluding Sources", () => {
    const s = extractPreviewSections(PREVIEW_MD);
    expect(s.bogiesTable!.rows).toHaveLength(3);
    expect(s.commentary).toContain("## The setup");
    expect(s.commentary).toContain("## Bull case / bear case");
    expect(s.commentary).not.toContain("## Sources");
    expect(s.commentary).not.toContain("TMT Breakout 8/1");
    expect(s.commentary).not.toContain("| Revenue |");
  });

  it("tolerates a drifted bogies heading (case/word variations)", () => {
    const md = PREVIEW_MD.replace("## Line-by-line bogies", "## Line-by-Line Bogeys");
    expect(extractPreviewSections(md).bogiesTable).not.toBeNull();
  });

  it("no bogies heading → null table, whole doc (minus Sources) is commentary", () => {
    const md = "## The setup\n\nprose here\n\n## Sources\n\n- x";
    const s = extractPreviewSections(md);
    expect(s.bogiesTable).toBeNull();
    expect(s.commentary).toContain("## The setup");
    expect(s.commentary).not.toContain("## Sources");
  });

  it("bogies heading present but table malformed → null table, commentary preserved", () => {
    const md = "## Line-by-line bogies\n\nno table came out\n\n## The setup\n\nprose";
    const s = extractPreviewSections(md);
    expect(s.bogiesTable).toBeNull();
    expect(s.commentary).toContain("## The setup");
  });

  it("never throws on empty input", () => {
    const s = extractPreviewSections("");
    expect(s.bogiesTable).toBeNull();
    expect(s.commentary).toBe("");
  });
});

describe("wrapText", () => {
  it("word-wraps at the width", () => {
    expect(wrapText("alpha beta gamma delta", 11)).toEqual(["alpha beta", "gamma delta"]);
  });
  it("hard-splits words longer than the width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("empty input → single empty line", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });
});

describe("mdToPlainText", () => {
  it("renders headings as uppercase titles and strips inline markers", () => {
    const lines = mdToPlainText("## The setup\n\nAMZN is **up** 4% ([note](https://x.com)).");
    expect(lines).toContain("THE SETUP");
    expect(lines.join("\n")).toContain("AMZN is up 4% (note).");
    expect(lines.join("\n")).not.toContain("**");
    expect(lines.join("\n")).not.toContain("https://x.com");
  });
  it("keeps bullets with hang indent on wrapped lines", () => {
    const lines = mdToPlainText("- " + "word ".repeat(30).trim(), 40);
    expect(lines[0].startsWith("- ")).toBe(true);
    expect(lines[1].startsWith("  ")).toBe(true);
  });
  it("collapses blank-line runs", () => {
    const lines = mdToPlainText("a\n\n\n\nb");
    expect(lines).toEqual(["a", "", "b"]);
  });
});

describe("renderMonospaceTable", () => {
  const TABLE = {
    header: ["Metric", "Consensus / Prior", "Actual", "Δ"],
    rows: [
      ["Revenue", "Street ~$196.9B vs. company guide $194–199B; Finnhub shows $200.3B", "—", "—"],
      ["EPS", "$1.82–1.86", "—", "—"],
    ],
  };
  const LAYOUT = { widths: [16, 41, 13, 6], fillIn: [2, 3] };

  it("every line is exactly the total table width", () => {
    const lines = renderMonospaceTable(TABLE, LAYOUT);
    const total = 16 + 41 + 13 + 6 + 3;
    for (const l of lines) expect(l.length).toBe(total);
  });

  it("wraps long cells across lines within their column", () => {
    const lines = renderMonospaceTable(TABLE, LAYOUT);
    const revenueLines = lines.filter((l) => l.includes("$196.9B") || l.includes("$200.3B"));
    expect(revenueLines.length).toBeGreaterThanOrEqual(2);
  });

  it("renders — as blank space in fill-in columns but keeps it elsewhere", () => {
    const t = {
      header: ["M", "C", "A", "D"],
      rows: [["x", "—", "—", "—"]],
    };
    const lines = renderMonospaceTable(t, LAYOUT);
    const rowLine = lines.find((l) => l.startsWith("x"))!;
    const cells = rowLine.split("│");
    expect(cells[1]).toContain("—"); // consensus col: not fill-in
    expect(cells[2].trim()).toBe(""); // actual: blank box
    expect(cells[3].trim()).toBe(""); // delta: blank box
  });

  it("draws a ruled separator between rows with ┼ at column joints", () => {
    const lines = renderMonospaceTable(TABLE, LAYOUT);
    const seps = lines.filter((l) => l.includes("┼"));
    // header separator + one after each row
    expect(seps.length).toBe(1 + TABLE.rows.length);
    expect(seps[0]).toBe("─".repeat(16) + "┼" + "─".repeat(41) + "┼" + "─".repeat(13) + "┼" + "─".repeat(6));
  });

  it("drops extra cells and blanks missing cells", () => {
    const t = { header: ["A", "B"], rows: [["1"], ["1", "2", "3"]] };
    const lines = renderMonospaceTable(t, { widths: [4, 4] });
    expect(lines.some((l) => l.includes("3"))).toBe(false);
    for (const l of lines) expect(l.length).toBe(9);
  });
});
