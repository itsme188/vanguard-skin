import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTRACTOR_VERSION, blockText, extractDocText } from "@/lib/filing-summary/doc-text";

const FIXTURE = readFileSync(
  join(__dirname, "..", "fixtures", "filing-summary", "synthetic-8k.htm"),
  "utf8",
);

describe("extractDocText — synthetic 8-K", () => {
  const doc = extractDocText(FIXTURE);

  it("stamps the extractor version", () => {
    expect(EXTRACTOR_VERSION).toBe(2);
    expect(doc.extractorVersion).toBe(2);
  });

  it("counts three pages from two breaks; a trailing break opens no empty page", () => {
    expect(doc.pageBreaksReliable).toBe(true);
    expect(doc.pageCount).toBe(3);
  });

  it("numbers the first paragraph after the first break page 2, paragraph 1", () => {
    const b = doc.blocks.find((x) => x.text === "Example Widgets Reports Third Quarter 2026 Results");
    expect(b).toBeDefined();
    expect(b).toMatchObject({ page: 2, para: 1, tableId: null, rowIndex: null });
  });

  it("puts the cover page on page 1 with innermost blocks only", () => {
    const page1 = doc.blocks.filter((b) => b.page === 1).map((b) => b.text);
    expect(page1).toEqual([
      "UNITED STATES",
      "SECURITIES AND EXCHANGE COMMISSION",
      "FORM 8-K",
      "Example Widgets, Inc.",
    ]);
  });

  it("starts page 3 at a page-break-before element", () => {
    const b = doc.blocks.find((x) => x.text === "Forward-Looking Statements");
    expect(b).toMatchObject({ page: 3, para: 1 });
    const last = doc.blocks[doc.blocks.length - 1];
    expect(last).toMatchObject({ page: 3, para: 2 });
  });

  it("indexes blocks in document order", () => {
    doc.blocks.forEach((b, i) => expect(b.index).toBe(i));
  });

  it("drops inline-XBRL hidden header text and the head", () => {
    for (const b of doc.blocks) {
      expect(b.text).not.toContain("HIDDEN-XBRL-CANARY");
      expect(b.text).not.toContain("HIDDEN-CONTEXT-CANARY");
      expect(b.text).not.toContain("Synthetic 8-K (test fixture)");
    }
  });

  it("reads the results table as a grid with colspan spread across covered columns", () => {
    expect(doc.tables).toHaveLength(1);
    const t = doc.tables[0];
    expect(t.id).toBe(1);
    expect(t.page).toBe(2);
    expect(t.columnHeaders[2]).toBe("Three Months Ended September 30, / 2026");
    expect(t.columnHeaders[4]).toBe("Three Months Ended September 30, / 2025");
    expect(t.columnHeaders[6]).toBe("Nine Months Ended September 30, / 2026");
    expect(t.columnHeaders[0]).toBe("");
    expect(t.rowLabels).toEqual(["Revenue", "Restructuring", "Diluted earnings per share"]);
    expect(t.rows[0]).toEqual(["Revenue", "$", "4,601", "$", "3,242", "$", "12,880", "$", "9,915"]);
    expect(t.rows[1][2]).toBe("(1,234");
    expect(t.rows[2][2]).toBe("7.25");
  });

  it("finds the scale note in the text just above the table", () => {
    expect(doc.tables[0].scaleNote).toMatch(/in millions, except per share amounts/i);
    expect(doc.tables[0].scaleNote).not.toContain(")");
    expect(doc.documentScaleNote).toMatch(/in millions, except per share amounts/i);
  });

  it("makes each table row one block; body rows carry their grid row index", () => {
    const rows = doc.blocks.filter((b) => b.tableId === 1);
    // two header rows + three body rows (the empty spacer row is not a block)
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ rowIndex: null, text: "Three Months Ended September 30, | Nine Months Ended September 30," });
    expect(rows[2]).toMatchObject({ rowIndex: 0, text: "Revenue | $ | 4,601 | $ | 3,242 | $ | 12,880 | $ | 9,915" });
    expect(rows[4].rowIndex).toBe(2);
    // paragraph numbering continues across the table on page 2
    expect(rows[0].para).toBe(5);
    expect(rows[4].para).toBe(9);
    const after = doc.blocks.find((b) => b.text === "2");
    expect(after).toMatchObject({ page: 2, para: 10 });
  });

  it("renders the model text with table-row prefixes", () => {
    const text = blockText(doc);
    const lines = text.split("\n");
    expect(lines).toHaveLength(doc.blocks.length);
    expect(lines).toContain("[table 1 row 1] Revenue | $ | 4,601 | $ | 3,242 | $ | 12,880 | $ | 9,915");
    expect(lines).toContain("[table 1 header] 2026 | 2025 | 2026 | 2025");
    expect(lines[0]).toBe("UNITED STATES");
  });
});

describe("extractDocText — edge cases", () => {
  it("a document with no breaks is all page 1 and says breaks are unreliable", () => {
    const doc = extractDocText("<html><body><p>One</p><p>Two</p><div>Three</div></body></html>");
    expect(doc.pageBreaksReliable).toBe(false);
    expect(doc.pageCount).toBe(1);
    expect(doc.blocks.map((b) => [b.page, b.para, b.text])).toEqual([
      [1, 1, "One"],
      [1, 2, "Two"],
      [1, 3, "Three"],
    ]);
  });

  it("accepts break-before:page / break-after:page and collapses back-to-back breaks", () => {
    const html =
      '<p>A</p><div style="break-after: page"></div><hr style="page-break-before: always"/>' +
      '<p style="BREAK-BEFORE:PAGE">B</p><p>C</p>';
    const doc = extractDocText(html);
    expect(doc.pageCount).toBe(2);
    expect(doc.blocks.map((b) => [b.page, b.para])).toEqual([[1, 1], [2, 1], [2, 2]]);
  });

  it("an element with page-break-after breaks after its own text", () => {
    const doc = extractDocText('<div style="page-break-after:always"><p>A</p></div><p>B</p>');
    expect(doc.blocks.map((b) => [b.page, b.text])).toEqual([[1, "A"], [2, "B"]]);
  });

  it("joins inline markup into one block and decodes entities", () => {
    const doc = extractDocText("<div><div><p>Net&#160;income <b>rose</b> 5&#37; &amp; more</p></div></div>");
    expect(doc.blocks.map((b) => b.text)).toEqual(["Net income rose 5% & more"]);
  });

  it("a table with no numeric cell keeps every row as a body row", () => {
    const doc = extractDocText("<table><tr><td>Item 2.02</td><td>Results of Operations</td></tr></table>");
    expect(doc.tables[0].rows).toEqual([["Item 2.02", "Results of Operations"]]);
    expect(doc.tables[0].rowLabels).toEqual(["Item 2.02"]);
    expect(doc.blocks[0]).toMatchObject({ tableId: 1, rowIndex: 0, text: "Item 2.02 | Results of Operations" });
  });

  it("finds a scale note inside a header row and skips tables with no text", () => {
    const html =
      "<table><tr><td>&#160;</td></tr></table>" +
      "<table><tr><td>(Amounts in thousands)</td><td>2026</td></tr><tr><td>Sales</td><td>1,000</td></tr></table>";
    const doc = extractDocText(html);
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0].id).toBe(1);
    expect(doc.tables[0].scaleNote).toBe("Amounts in thousands");
  });

  it("flattens a nested table's text into the outer cell", () => {
    const doc = extractDocText(
      "<table><tr><td>Label</td><td><table><tr><td>inner a</td><td>inner b</td></tr></table></td><td>12</td></tr></table>",
    );
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0].rows[0]).toEqual(["Label", "inner a inner b", "12"]);
  });
});

describe("extractDocText — scale note per cell", () => {
  it("stops a header-cell scale note at the cell edge, in the table and the document", () => {
    const doc = extractDocText(
      "<table><tr><td>In millions, except percentages</td><td>2026</td><td>2025</td></tr>" +
        "<tr><td>Revenue</td><td>10</td><td>9</td></tr></table>",
    );
    expect(doc.tables[0].scaleNote).toBe("In millions, except percentages");
    expect(doc.documentScaleNote).toBe("In millions, except percentages");
  });
});

describe("extractDocText — section labels and title rows (review fix 1)", () => {
  it("balance-sheet shape: title rows stay out of columnHeaders, section labels stay body rows", () => {
    const html =
      "<table>" +
      '<tr><td colspan="5">EXAMPLE WIDGETS, INC.</td></tr>' +
      '<tr><td colspan="5">CONDENSED CONSOLIDATED BALANCE SHEETS</td></tr>' +
      '<tr><td colspan="5">(In millions)</td></tr>' +
      '<tr><td></td><td colspan="2">September 30, 2026</td><td colspan="2">December 31, 2025</td></tr>' +
      "<tr><td>Assets</td><td></td><td></td><td></td><td></td></tr>" +
      "<tr><td>Current assets:</td><td></td><td></td><td></td><td></td></tr>" +
      "<tr><td>Cash and cash equivalents</td><td>$</td><td>1,250</td><td>$</td><td>1,100</td></tr>" +
      "<tr><td>Total current assets</td><td></td><td>2,400</td><td></td><td>2,050</td></tr>" +
      "</table>";
    const t = extractDocText(html).tables[0];
    expect(t.columnHeaders).toEqual([
      "",
      "September 30, 2026",
      "September 30, 2026",
      "December 31, 2025",
      "December 31, 2025",
    ]);
    expect(t.rowLabels).toEqual(["Assets", "Current assets:", "Cash and cash equivalents", "Total current assets"]);
    expect(t.rows[2]).toEqual(["Cash and cash equivalents", "$", "1,250", "$", "1,100"]);
    expect(t.scaleNote).toBe("In millions");
    for (const h of t.columnHeaders) {
      expect(h).not.toContain("EXAMPLE WIDGETS");
      expect(h).not.toContain("BALANCE SHEETS");
      expect(h).not.toContain("In millions");
    }
  });

  it("segment shape with a wide label cell: 'Revenue:' is a body row label", () => {
    const html =
      "<table>" +
      '<tr><td colspan="7">Segment Information</td></tr>' +
      '<tr><td colspan="7">(In millions)</td></tr>' +
      '<tr><td colspan="3"></td><td colspan="2">Three Months Ended September 30,</td><td colspan="2">Nine Months Ended September 30,</td></tr>' +
      '<tr><td colspan="3"></td><td>2026</td><td>2025(1)</td><td>2026</td><td>2025</td></tr>' +
      '<tr><td colspan="3">Revenue:</td><td></td><td></td><td></td><td></td></tr>' +
      '<tr><td colspan="3">Advertising</td><td>50,100</td><td>40,200</td><td>140,300</td><td>115,400</td></tr>' +
      "</table>";
    const doc = extractDocText(html);
    const t = doc.tables[0];
    expect(t.rowLabels).toEqual(["Revenue:", "Advertising"]);
    expect(t.columnHeaders[3]).toBe("Three Months Ended September 30, / 2026");
    expect(t.columnHeaders[4]).toBe("Three Months Ended September 30, / 2025(1)");
    expect(t.columnHeaders[0]).toBe("");
    expect(t.columnHeaders.join(" ")).not.toContain("Segment Information");
    expect(t.scaleNote).toBe("In millions");
    const revenueBlock = doc.blocks.find((b) => b.text === "Revenue:");
    expect(revenueBlock).toMatchObject({ tableId: 1, rowIndex: 0 });
  });

  it("a year with a footnote marker is not a numeric cell, so its row stays a header row", () => {
    const doc = extractDocText(
      "<table><tr><td></td><td>2026</td><td>2025(1)</td></tr><tr><td>Sales</td><td>10</td><td>9</td></tr></table>",
    );
    expect(doc.tables[0].columnHeaders).toEqual(["", "2026", "2025(1)"]);
    expect(doc.tables[0].rowLabels).toEqual(["Sales"]);
  });
});
