/**
 * Print-sheet HTML composer (2026-08-06 print/prose round) — pure markdown
 * assembly + verbatim bogies-table extraction, rendered through the shared
 * email HTML renderer. No DB, no IO.
 */
import { describe, it, expect } from "vitest";
import { extractBogiesTableMarkdown, composePrintSheetHtml } from "@/lib/earnings/print-sheet";

const AI_MD = `## Line-by-line bogies

| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
| Revenue | $4.34B | — | — |
| Gross margin | 55% | — | — |

## The setup

Prose here.

## Sources

- ignored`;

describe("extractBogiesTableMarkdown", () => {
  it("returns heading + contiguous table lines verbatim", () => {
    const out = extractBogiesTableMarkdown(AI_MD)!;
    expect(out.startsWith("## Line-by-line bogies")).toBe(true);
    expect(out).toContain("| Revenue | $4.34B | — | — |");
    expect(out).not.toContain("The setup");
  });
  it("null when heading missing", () => {
    expect(extractBogiesTableMarkdown("## The setup\n\nProse.")).toBeNull();
  });
  it("null when no table before the next ## heading", () => {
    expect(extractBogiesTableMarkdown("## Line-by-line bogies\n\n## The setup\n\n| a | b |\n|---|---|")).toBeNull();
  });

  // Issue #41: a malformed model response (heading + a single incomplete
  // pipe row, no separator row) must not be accepted as a printable table —
  // it should fall back to the deterministic worksheet instead.
  it("null when the table block has only a header-shaped row and no separator row", () => {
    const md = "## Line-by-line bogies\n\n| Revenue | $4.34B | — | — |";
    expect(extractBogiesTableMarkdown(md)).toBeNull();
  });

  it("null when the second line doesn't match the separator-row shape", () => {
    const md = "## Line-by-line bogies\n\n| Metric | Consensus |\n| EPS | 4.30 |";
    expect(extractBogiesTableMarkdown(md)).toBeNull();
  });

  it("null when the separator's column count doesn't match the header's column count", () => {
    const md = "## Line-by-line bogies\n\n| Metric | Consensus | Actual | Δ |\n|---|---|---|\n| EPS | 4.30 | — | — |";
    expect(extractBogiesTableMarkdown(md)).toBeNull();
  });

  it("extracts verbatim when header/separator are valid even if a later data row has a different column count", () => {
    // Only header/separator gate acceptance — real model output sometimes
    // varies in data rows, and those are not column-validated.
    const md = "## Line-by-line bogies\n\n| Metric | Consensus | Actual | Δ |\n|---|---|---|---|\n| EPS | 4.30 | — |";
    const out = extractBogiesTableMarkdown(md)!;
    expect(out).not.toBeNull();
    expect(out).toContain("| EPS | 4.30 | — |");
  });

  it("column-count comparison ignores an escaped pipe inside a header cell (consistent with the split-on-unescaped-pipe rule)", () => {
    const md =
      "## Line-by-line bogies\n\n| Metric | TMT \\| Breakout | Actual | Δ |\n|---|---|---|---|\n| EPS | 4.30 | — | — |";
    const out = extractBogiesTableMarkdown(md)!;
    expect(out).not.toBeNull();
    expect(out).toContain("TMT \\| Breakout");
  });
});

function inputs(over: Partial<Parameters<typeof composePrintSheetHtml>[0]> = {}) {
  return {
    symbol: "APP", eventDate: "2026-08-06", eventTime: "AMC",
    scoreboardMd: "| Metric | Consensus | Actual | Δ |\n|---|---|---|---|\n| EPS | 4.30 | — | — |",
    sheetBogeysMd: "## Sheet bogeys — by source\n\n| Metric | TMTB (8/4) |\n|---|---|\n| EPS | 4.30 |",
    bogiesTableMd: extractBogiesTableMarkdown(AI_MD)!,
    notes: [{ date: "2026-08-01", noteType: "trade_thesis", symbol: "APP", content: "Long thesis ".repeat(300).trim() }],
    pastPrintsMd: "## Past prints\n\n| Reported | EPS act / est | Surprise | Next-day move |\n|---|---|---|---|\n| 2026-05-06 | 4.1 / 4.0 | +2.5% | +8% |",
    sentAt: "2026-08-06 14:02:00",
    ...over,
  };
}

describe("composePrintSheetHtml", () => {
  it("contains bogies table verbatim, complete notes, print CSS, section order", () => {
    const html = composePrintSheetHtml(inputs());
    expect(html).toContain("$4.34B");                    // bogies cell survived
    expect(html).toContain("Long thesis Long thesis");   // notes not truncated
    expect((html.match(/Long thesis/g) ?? []).length).toBeGreaterThanOrEqual(300);
    expect(html).toContain("@page");
    expect(html).toContain("break-inside");
    // order: scoreboard < sheet bogeys < bogies < notes < past prints
    // "Consensus" anchors the scoreboard section — it's a header cell unique
    // to scoreboardMd's own table (sheetBogeysMd's header is "TMTB (8/4)");
    // it also appears later inside bogiesTableMd's "Consensus / Prior" header,
    // but indexOf finds the FIRST occurrence, which is in scoreboardMd since
    // that section renders first — the literal "scoreboard" itself never
    // appears anywhere in the rendered HTML, so it can't anchor this test.
    const idx = (s: string) => html.indexOf(s);
    expect(idx("Consensus")).toBeLessThan(idx("Sheet bogeys"));
    expect(idx("Sheet bogeys")).toBeLessThan(idx("Line-by-line bogies"));
    expect(idx("Line-by-line bogies")).toBeLessThan(idx("Your notes"));
    expect(idx("Your notes")).toBeLessThan(idx("Past prints"));
  });
  it("omits past prints when includePastPrints=false", () => {
    const html = composePrintSheetHtml(inputs(), { includePastPrints: false });
    expect(html).not.toContain("Past prints");
  });
  it("omits empty sheet-bogeys block cleanly", () => {
    const html = composePrintSheetHtml(inputs({ sheetBogeysMd: "" }));
    expect(html).not.toContain("Sheet bogeys");
  });

  // FEEDBACK 1 (2026-08-07): "blank background, just black on white" — the
  // sheet must override every inline background the amber email envelope
  // emits, force text to black, and keep table borders untouched.
  it("forces a white background and black text with !important, leaving table borders untouched", () => {
    const html = composePrintSheetHtml(inputs());
    // Blanket override on every tag the envelope actually emits inline
    // colors on (body/tables/cells/headings/blockquote/code/links/lists).
    expect(html).toMatch(
      /body, table, thead, tbody, tr, td, th, div, p, ul, li,\s*\n\s*h1, h2, h3, blockquote, code, a, strong, em, span \{[^}]*background-color:\s*#ffffff\s*!important;[^}]*color:\s*#000000\s*!important;/,
    );
    // Header row keeps a light-gray tint, not pure white.
    expect(html).toMatch(/th\s*\{\s*background-color:\s*#eeeeee\s*!important;\s*\}/);
    // Table borders (the fillable ruled grid) are never touched.
    expect(html).toContain(`border:1px solid ${"#777777"}`);
    expect(html).not.toMatch(/border[^:]*:\s*none\s*!important/);
  });

  // FEEDBACK 2a (2026-08-07): the footer must never be able to start its own
  // page — target it by its unique inline-style substrings (briefingToHtml
  // has no id/class to hook) with a break-before ban + minimal top spacer.
  it("bans a page break before the footer and shrinks its top spacer", () => {
    const html = composePrintSheetHtml(inputs());
    expect(html).toMatch(
      /td\[style\*="padding:64px 0 0"\]\s*\{[^}]*padding-top:\s*8px\s*!important;[^}]*break-before:\s*avoid\s*!important;[^}]*break-inside:\s*avoid\s*!important;/,
    );
    expect(html).toMatch(
      /div\[style\*="border-top:1px solid"\]\s*\{[^}]*break-before:\s*avoid\s*!important;[^}]*break-inside:\s*avoid\s*!important;/,
    );
  });

  // Compaction step (worksheet one-sheet ladder, step 3).
  it("emits the compaction block only when compact:true is passed", () => {
    const normal = composePrintSheetHtml(inputs());
    expect(normal).not.toContain("compact-print-sheet");

    const compact = composePrintSheetHtml(inputs(), { compact: true });
    expect(compact).toContain("compact-print-sheet");
    expect(compact).toContain("font-size: 90% !important");
    expect(compact).toMatch(/th, td \{ padding: 4px 6px !important; \}/);
    // Compaction is additive — the base white/black + footer overrides still
    // apply, it doesn't replace PRINT_CSS.
    expect(compact).toContain("background-color: #ffffff !important;");
  });

  it("stacks compact with includePastPrints:false (step 3 of the one-sheet ladder)", () => {
    const html = composePrintSheetHtml(inputs(), { includePastPrints: false, compact: true });
    expect(html).not.toContain("Past prints");
    expect(html).toContain("compact-print-sheet");
  });
});
