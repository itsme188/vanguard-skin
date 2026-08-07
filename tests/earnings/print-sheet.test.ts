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
});
