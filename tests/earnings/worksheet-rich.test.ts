/**
 * Rich preview-based worksheet (2026-08-05 spec) — pure markdown extraction,
 * monospace table rendering, page composition. No DB, no IO.
 */
import { describe, it, expect } from "vitest";
import {
  parseMarkdownTable,
  extractFirstTable,
  extractPreviewSections,
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
