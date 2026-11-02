/**
 * A chat answer that stacks lines in one table cell with `<br>` printed the
 * tag as text, because the renderer escapes raw HTML on purpose
 * (qa:chat-overlay-mobile-390x844-answer-tables-all-accounts-chat-answer-table-prints-literal-br-tags-inside-its-cel).
 * The tag becomes a cell separator on table rows and is left alone elsewhere.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { isTableRowLine, softenTableBreaks, TABLE_CELL_SEPARATOR } from "@/lib/chat/markdown-table-breaks";

describe("softenTableBreaks", () => {
  it("turns <br> variants on a table row into the cell separator", () => {
    const row = "| AAA options | Held - 3 contracts:<br>• AAA 1/15/27 $45 Call: 1<BR/>• AAA $80 Put: 2<br />x |";
    const out = softenTableBreaks(row);
    expect(out).not.toMatch(/<br/i);
    expect(out).toBe(
      `| AAA options | Held - 3 contracts:${TABLE_CELL_SEPARATOR}• AAA 1/15/27 $45 Call: 1${TABLE_CELL_SEPARATOR}• AAA $80 Put: 2${TABLE_CELL_SEPARATOR}x |`,
    );
  });

  it("drops a separator left dangling at a cell edge", () => {
    expect(softenTableBreaks("| a<br> | <br>b | c<br>|")).toBe("| a | b | c |");
  });

  it("leaves prose, list items and fenced code untouched", () => {
    const md = ["Line one<br>line two", "- item<br>more", "```", "| not | a<br>table |", "```"].join("\n");
    expect(softenTableBreaks(md)).toBe(md);
  });

  it("returns the input unchanged when there is no tag", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(softenTableBreaks(md)).toBe(md);
  });

  it("recognises table rows with and without a leading pipe", () => {
    expect(isTableRowLine("| a | b |")).toBe(true);
    expect(isTableRowLine("a | b")).toBe(true);
    expect(isTableRowLine("plain prose")).toBe(false);
    expect(isTableRowLine("")).toBe(false);
  });
});

describe("MarkdownMessage applies softenTableBreaks", () => {
  const src = readFileSync("app/dashboard/components/MarkdownMessage.tsx", "utf8");
  it("imports the helper and renders the softened content", () => {
    expect(src).toContain('from "@/lib/chat/markdown-table-breaks"');
    const at = anchorIndex(src, "<Markdown remarkPlugins=", 0, "Markdown element");
    expect(src.slice(at, at + 260)).toContain("{softenTableBreaks(content)}");
  });
});
