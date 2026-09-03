import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stripHtmlToText,
  documentText,
  evidenceSha256,
  parseValueText,
  numbersIn,
  contentWords,
  labelNorm,
  extractGuidanceMetrics,
  sheetLineKeys,
  verifyCallout,
  vsBogeyText,
  formatValue,
} from "@/lib/print-watch/callouts";
import { sha256Hex } from "@/lib/print-watch/delivery";

const TEXT =
  "Acme Corp today reported fourth quarter results. Annual recurring revenue (ARR) reached $3.74 billion, up 24% year over year. " +
  "Remaining performance obligations were $6.9 billion. Non-GAAP operating income was $207.2 million, or 23.1% of revenue. " +
  "Diluted net income per share was $1.12 on a non-GAAP basis. The company had 712 customers above $1 million in ARR.";

describe("parseValueText", () => {
  it("scales dollar amounts, keeps percentages, reads per-share and counts, and ranges", () => {
    expect(parseValueText("$3.74 billion")).toEqual({ value: 3.74e9, value_high: null, unit: "usd" });
    expect(parseValueText("$207.2M")).toEqual({ value: 207.2e6, value_high: null, unit: "usd" });
    expect(parseValueText("23.1%")).toEqual({ value: 23.1, value_high: null, unit: "percent" });
    expect(parseValueText("$1.12")).toEqual({ value: 1.12, value_high: null, unit: "per_share" });
    expect(parseValueText("$1.12 per diluted share")).toEqual({ value: 1.12, value_high: null, unit: "per_share" });
    expect(parseValueText("712")).toEqual({ value: 712, value_high: null, unit: "count" });
    expect(parseValueText("$875M to $878M")).toEqual({ value: 875e6, value_high: 878e6, unit: "usd" });
    expect(parseValueText("between 16% and 17%")).toEqual({ value: 16, value_high: 17, unit: "percent" });
    expect(parseValueText("16-17%")).toEqual({ value: 16, value_high: 17, unit: "percent" });
    expect(parseValueText("a lot")).toBeNull();
  });
  it("numbersIn finds every number of a unit inside a snippet, scaled the same way", () => {
    expect(numbersIn("ARR reached $3.74 billion, up 24% year over year", "usd")).toEqual([3.74e9]);
    expect(numbersIn("ARR reached $3.74 billion, up 24% year over year", "percent")).toEqual([24]);
    expect(numbersIn("$1.12 on a non-GAAP basis", "per_share")).toEqual([1.12]);
  });
  it("excludes a fiscal-year token from count, but not a real count (R-D17 minor)", () => {
    expect(numbersIn("backlog visibility into fiscal 2026 remains strong", "count")).toEqual([]);
    expect(numbersIn("The company had 712 customers", "count")).toEqual([712]);
  });
});

describe("contentWords", () => {
  it("drops stopwords and short tokens, lower-cases the rest", () => {
    expect(contentWords("Non-GAAP operating income")).toEqual(["operating", "income"]);
    expect(contentWords("ARR")).toEqual(["arr"]);
    expect(contentWords("Q4 FY26")).toEqual([]);
  });
});

describe("labelNorm / extractGuidanceMetrics / sheetLineKeys", () => {
  it("normalises labels to their content words", () => {
    expect(labelNorm("Annual Recurring Revenue (ARR)")).toBe("annual recurring revenue arr");
    expect(labelNorm("Non-GAAP operating income")).toBe("operating income");
  });
  it("extracts one typed metric per guidance clause, with or without a figure", () => {
    const m = extractGuidanceMetrics([
      "Watch ARR growth (guide ~24%) and non-GAAP operating income of $206M–$208M.",
      "RPO commentary.",
      "FY27 framework 16-17%",
    ]);
    expect(m).toEqual([
      { key: "arr growth", unit: "percent", value: 24, value_high: null, source_index: 0 },
      { key: "operating income", unit: "usd", value: 206e6, value_high: 208e6, source_index: 0 },
      { key: "rpo commentary", unit: null, value: null, value_high: null, source_index: 1 },
      { key: "fy27 framework", unit: "percent", value: 16, value_high: 17, source_index: 2 },
    ]);
  });
  it("sheetLineKeys names every contract the sheet already covers", () => {
    expect(
      sheetLineKeys([
        { metric_id: "revenue_q", label: "Revenue", definition: "", basis: "na", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null },
      ]),
    ).toEqual(["revenue"]);
  });
  it("does not mangle a decimal figure, a spelled-out 'between X and Y' range, a fully spelled-out scale-word range, or a percent-with-decimal (R-D17)", () => {
    expect(extractGuidanceMetrics(["Operating income of $206.5M"])).toEqual([
      { key: "operating income", unit: "usd", value: 206.5e6, value_high: null, source_index: 0 },
    ]);
    expect(extractGuidanceMetrics(["Operating income between $206M and $208M"])).toEqual([
      { key: "operating income", unit: "usd", value: 206e6, value_high: 208e6, source_index: 0 },
    ]);
    expect(extractGuidanceMetrics(["Revenue of $875 million to $878 million"])).toEqual([
      { key: "revenue", unit: "usd", value: 875e6, value_high: 878e6, source_index: 0 },
    ]);
    expect(extractGuidanceMetrics(["Revenue growth of 24.5%"])).toEqual([
      { key: "revenue growth", unit: "percent", value: 24.5, value_high: null, source_index: 0 },
    ]);
  });
  it("vsBogeyText against those clauses gives a sane comparison, never a nonsense delta (R-D17)", () => {
    const pointGuidance = extractGuidanceMetrics(["Operating income of $206.5M"]);
    expect(vsBogeyText("operating income", { value: 207e6, value_high: null, unit: "usd" }, pointGuidance)).toBe("vs guide $206.5M (in-line)");
    const rangeGuidance = extractGuidanceMetrics(["Operating income between $206M and $208M"]);
    expect(vsBogeyText("operating income", { value: 207.2e6, value_high: null, unit: "usd" }, rangeGuidance)).toBe("vs guide $206.0M–$208.0M (within range)");
  });
  it("splits a sentence-final period even when the sentence ends in a digit run (fix round 2 — CLAUSE_SPLIT's period guard was inverted)", () => {
    // "…for Q4." — the period is preceded by a digit but is NOT a decimal
    // point; round 1's (?<!\d)\.(?!\d) (an AND) wrongly required BOTH sides
    // non-digit to split, so this never split and "Margin…30%" was dropped.
    expect(extractGuidanceMetrics(["Revenue guide is $200M for Q4. Margin should be 30%."])).toEqual([
      { key: "revenue guide", unit: "usd", value: 200e6, value_high: null, source_index: 0 },
      { key: "margin should", unit: "percent", value: 30, value_high: null, source_index: 0 },
    ]);
    // The decimal case (round 1's own fixture, re-pinned) must keep working
    // now that the period guard is an OR, not an AND.
    expect(extractGuidanceMetrics(["Operating income of $206.5M. ARR growth 24%."])).toEqual([
      { key: "operating income", unit: "usd", value: 206.5e6, value_high: null, source_index: 0 },
      { key: "arr growth", unit: "percent", value: 24, value_high: null, source_index: 0 },
    ]);
    // A sentence-final period followed (after a space) by a digit-led
    // sentence still splits — and the leading clause carries no metric (it
    // has no figure of its own), so nothing here reads as `count: 2026`.
    expect(extractGuidanceMetrics(["Results were strong. 2026 outlook is cautious."])).toEqual([
      { key: "results were strong", unit: null, value: null, value_high: null, source_index: 0 },
    ]);
  });
  it("does not mint a bogus figure from a bare year that a lead word precedes (fix round 2 — adjacent gap)", () => {
    // extractGuidanceMetrics matches RANGE_TOKEN/POINT_TOKEN against the
    // clause directly, so numbersIn's year guard (which only ever sees the
    // isolated matched token) cannot catch this — the guard has to be
    // reapplied here against the clause text. "fiscal" is itself a
    // STOPWORD already (pre-existing, unrelated to this fix), so the pinned
    // key below is "expect strength", not "expect strength fiscal" —
    // contentWords drops "fiscal" and "2026" (pure digits) regardless of
    // the year guard.
    expect(extractGuidanceMetrics(["We expect strength in fiscal 2026."])).toEqual([
      { key: "expect strength", unit: null, value: null, value_high: null, source_index: 0 },
    ]);
  });
});

describe("verifyCallout", () => {
  const guidance = extractGuidanceMetrics([
    "Watch ARR growth (guide ~24%) and non-GAAP operating income of $206M–$208M.",
    "Annual recurring revenue commentary.",
  ]);
  const keys = ["revenue", "eps adj", "eps gaap"];
  it("accepts a proposal named by guidance, absent from the sheet, verbatim, same-unit, and anchored", () => {
    const r = verifyCallout({
      proposal: { label: "Annual recurring revenue", value_text: "$3.74B", snippet: "Annual recurring revenue (ARR) reached $3.74 billion", doc_id: 1 },
      text: TEXT,
      guidanceMetrics: guidance,
      sheetLineKeys: keys,
    });
    expect(r).toMatchObject({ ok: true, parsed: { value: 3.74e9, unit: "usd" }, labelNorm: "annual recurring revenue" });
  });
  it("refuses a metric the guidance never named", () => {
    const r = verifyCallout({
      proposal: { label: "Remaining performance obligations", value_text: "$6.9 billion", snippet: "Remaining performance obligations were $6.9 billion", doc_id: 1 },
      text: TEXT,
      guidanceMetrics: guidance,
      sheetLineKeys: keys,
    });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/guidance/) });
  });
  it("refuses a metric the sheet already has a line for", () => {
    const r = verifyCallout({
      proposal: { label: "Revenue", value_text: "$898.2M", snippet: "revenue of $898.2 million", doc_id: 1 },
      text: "Acme revenue of $898.2 million.",
      guidanceMetrics: extractGuidanceMetrics(["Revenue guide $890M"]),
      sheetLineKeys: keys,
    });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/sheet/) });
  });
  it("refuses a snippet that is not verbatim, a value not in the snippet in that unit, and accepts a label anchored only via guidance (R-D1)", () => {
    expect(
      verifyCallout({
        proposal: { label: "ARR growth", value_text: "24%", snippet: "ARR reached $3.74B, up 24%", doc_id: 1 },
        text: TEXT,
        guidanceMetrics: guidance,
        sheetLineKeys: keys,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/verbatim/) });
    expect(
      verifyCallout({
        proposal: { label: "ARR growth", value_text: "25%", snippet: "Annual recurring revenue (ARR) reached $3.74 billion, up 24%", doc_id: 1 },
        text: TEXT,
        guidanceMetrics: guidance,
        sheetLineKeys: keys,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/value/) });
    // R-D1: anchoring is an OR — "growth" is nowhere near this snippet, but
    // the guidance names "arr growth", so the guidance branch anchors it.
    expect(
      verifyCallout({
        proposal: { label: "ARR growth", value_text: "712", snippet: "The company had 712 customers above $1 million in ARR", doc_id: 1 },
        text: TEXT,
        guidanceMetrics: guidance,
        sheetLineKeys: keys,
      }),
    ).toMatchObject({ ok: true, labelNorm: "arr growth" });
  });
  it("refuses a label with no content words", () => {
    expect(
      verifyCallout({
        proposal: { label: "Q4", value_text: "712", snippet: "The company had 712 customers", doc_id: 1 },
        text: TEXT,
        guidanceMetrics: guidance,
        sheetLineKeys: keys,
      }).ok,
    ).toBe(false);
  });
});

describe("vsBogeyText — typed association only", () => {
  const guidance = extractGuidanceMetrics(["ARR growth (guide ~24%)", "non-GAAP operating income of $206M–$208M", "Operating income commentary", "Customers 700"]);
  it("point bogey → delta in code; range bogey → within/above/below, never a midpoint", () => {
    expect(vsBogeyText("arr growth", { value: 24.6, value_high: null, unit: "percent" }, guidance)).toBe("vs guide 24.0% (+2.5%)");
    expect(vsBogeyText("operating income", { value: 207.2e6, value_high: null, unit: "usd" }, guidance)).toBe("vs guide $206.0M–$208.0M (within range)");
    expect(vsBogeyText("operating income", { value: 209e6, value_high: null, unit: "usd" }, guidance)).toBe("vs guide $206.0M–$208.0M (above range)");
  });
  it("ambiguity or a unit mismatch is 'no bogey', never a guess", () => {
    expect(vsBogeyText("operating income", { value: 23.1, value_high: null, unit: "percent" }, guidance)).toBe("no bogey on file");
    expect(vsBogeyText("customers", { value: 712, value_high: null, unit: "count" }, guidance)).toBe("vs guide 700 (+1.7%)");
    expect(vsBogeyText("customers", { value: 712, value_high: null, unit: "count" }, [...guidance, ...extractGuidanceMetrics(["Customers 750"])])).toBe(
      "no bogey on file",
    );
    expect(vsBogeyText("headcount", { value: 1, value_high: null, unit: "count" }, guidance)).toBe("no bogey on file");
  });
  it("a range CALLOUT against a point bogey reports the range, no delta", () => {
    expect(vsBogeyText("arr growth", { value: 23, value_high: 25, unit: "percent" }, guidance)).toBe("vs guide 24.0% (range 23.0%–25.0%)");
  });
  it("formatValue renders each unit the way the panel does", () => {
    expect(formatValue(3.74e9, "usd")).toBe("$3.74B");
    expect(formatValue(207.2e6, "usd")).toBe("$207.2M");
    expect(formatValue(23.1, "percent")).toBe("23.1%");
    expect(formatValue(1.12, "per_share")).toBe("$1.12");
    expect(formatValue(712, "count")).toBe("712");
  });
});

describe("documentText", () => {
  it("strips HTML to text, reads txt as-is, and reads the poppler sidecar for pdf", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callouts-"));
    try {
      fs.writeFileSync(path.join(dir, "a.html"), "<p>ARR&nbsp;of <b>$3.74</b> billion</p>\n<script>x()</script>");
      fs.writeFileSync(path.join(dir, "b.txt"), "plain $1.12 text");
      fs.writeFileSync(path.join(dir, "c.pdf"), "%PDF-1.4 binary");
      fs.writeFileSync(path.join(dir, "c.pdftext.txt"), "poppler text $6.9 billion");
      expect(await documentText({ bytes_path: path.join(dir, "a.html") })).toBe("ARR of $3.74 billion");
      expect(await documentText({ bytes_path: path.join(dir, "b.txt") })).toBe("plain $1.12 text");
      expect(await documentText({ bytes_path: path.join(dir, "c.pdf") })).toBe("poppler text $6.9 billion");
      expect(stripHtmlToText("<div>a</div><div>b</div>")).toBe("a b");
      expect(evidenceSha256(await documentText({ bytes_path: path.join(dir, "a.html") }))).toBe(sha256Hex("ARR of $3.74 billion"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
