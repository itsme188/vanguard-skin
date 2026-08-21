// Ports the two HTML representations validated by the bake-off spike
// (scripts/spike-bakeoff-parse.ts) into product code. Behavior must be
// IDENTICAL to the spike — the golden test below proves it against the real
// XMTR corpus artifacts saved by that spike's pilot run.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { htmlToTablesRepresentation, htmlToRawText } from "@/lib/print-watch/representations";

const INLINE_HTML = `
<html><body>
<p>Acme Corp Reports Second Quarter 2026 Results</p>
<p>(In thousands, except per share amounts)</p>
<p>(Unaudited)</p>
<table>
  <tr>
    <th></th>
    <th colspan="2">Three Months Ended June 30,</th>
  </tr>
  <tr>
    <th>Line Item</th>
    <th>2026</th>
    <th>2025</th>
  </tr>
  <tr>
    <td style="padding-left:9pt">Net revenue</td>
    <td>$1,234</td>
    <td>$1,100</td>
  </tr>
  <tr>
    <td style="padding-left:9pt">Net loss</td>
    <td>(7,604</td>
    <td>)</td>
  </tr>
</table>
<p>Some closing narrative text.</p>
<pre>  RAW   PREFORMATTED
  TEXT BLOCK</pre>
</body></html>
`;

describe("htmlToTablesRepresentation (repA)", () => {
  it("attaches the 3 preceding non-trivial lines as the table heading", () => {
    const text = htmlToTablesRepresentation(INLINE_HTML);
    expect(text).toContain(
      "heading: Acme Corp Reports Second Quarter 2026 Results / (In thousands, except per share amounts) / (Unaudited)",
    );
  });

  it("expands the colspan header positionally: text lands in the first spanned column, rest blank", () => {
    const text = htmlToTablesRepresentation(INLINE_HTML);
    expect(text).toContain("| Three Months Ended June 30, |        |");
  });

  it("keeps a split negative-number cell pair ('(7,604' / ')') in adjacent columns, unmerged", () => {
    const text = htmlToTablesRepresentation(INLINE_HTML);
    expect(text).toContain("Net loss");
    expect(text).toContain("(7,604");
    // the closing paren stays its own cell — never re-joined into "(7,604)"
    expect(text).not.toContain("(7,604)");
  });

  it("indents row labels from padding-left, and drops non-table body text into a [TABLE n]-marked section", () => {
    const text = htmlToTablesRepresentation(INLINE_HTML);
    expect(text).toContain("  Net revenue");
    expect(text).toContain("[TABLE 1]");
    expect(text).toContain("Some closing narrative text.");
  });

  it("is a pure function: no side effects, same input -> same output", () => {
    expect(htmlToTablesRepresentation(INLINE_HTML)).toBe(htmlToTablesRepresentation(INLINE_HTML));
  });
});

describe("htmlToRawText (repB)", () => {
  it("decodes entities and strips tags to flowing text", () => {
    const html = "<p>Revenue grew &amp; margins held at 12.3%.</p>";
    const text = htmlToRawText(html);
    expect(text).toContain("Revenue grew & margins held at 12.3%.");
  });

  it("preserves <pre> blocks verbatim, including internal whitespace", () => {
    const text = htmlToRawText(INLINE_HTML);
    expect(text).toContain("  RAW   PREFORMATTED\n  TEXT BLOCK");
  });

  it("carries no table structure — the split negative-number cells read in reading order", () => {
    const text = htmlToRawText(INLINE_HTML);
    expect(text).toContain("Net loss");
    expect(text).toContain("(7,604");
    expect(text).toContain(")");
  });

  it("is a pure function: no side effects, same input -> same output", () => {
    expect(htmlToRawText(INLINE_HTML)).toBe(htmlToRawText(INLINE_HTML));
  });
});

describe("golden test vs the validated bake-off pilot output (XMTR-2026-08-04)", () => {
  const corpusDir = join(
    process.cwd(),
    "tests",
    "fixtures",
    "real",
    "bakeoff",
    "XMTR-2026-08-04",
  );
  const htmlPath = join(corpusDir, "edgar-ex99-1.htm");
  const goldenAPath = join(corpusDir, "parse-input-repA.txt");
  const goldenBPath = join(corpusDir, "parse-input-repB.txt");
  const hasFixtures = existsSync(htmlPath) && existsSync(goldenAPath) && existsSync(goldenBPath);

  it.skipIf(!hasFixtures)(
    "htmlToTablesRepresentation is byte-identical to the pilot's saved parse-input-repA.txt",
    () => {
      const html = readFileSync(htmlPath, "utf-8");
      const golden = readFileSync(goldenAPath, "utf-8");
      expect(htmlToTablesRepresentation(html)).toBe(golden);
    },
  );

  it.skipIf(!hasFixtures)(
    "htmlToRawText is byte-identical to the pilot's saved parse-input-repB.txt",
    () => {
      const html = readFileSync(htmlPath, "utf-8");
      const golden = readFileSync(goldenBPath, "utf-8");
      expect(htmlToRawText(html)).toBe(golden);
    },
  );

  if (!hasFixtures) {
    it("skips gracefully when the real bake-off corpus is not present in this checkout", () => {
      expect(hasFixtures).toBe(false);
    });
  }
});
