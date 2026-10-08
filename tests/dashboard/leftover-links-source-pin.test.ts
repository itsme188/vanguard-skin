/**
 * Source pins for two links that used to land on a generic page.
 *  - Macro sources drawer: each cited article opens that article
 *    (QA finding analysis-macro-sources--generic-links-unlabeled-events-regression-3).
 *  - Data-confidence popover: "Full audit" lands on the Integrity checks
 *    section of Data Health, which carries id="integrity".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("macro sources drawer — article deep link", () => {
  const drawer = read("app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx");

  it("links each article to ?view=feeds&article=<its id>", () => {
    const start = anchorIndex(drawer, "sourceSummary.articles.map((a) => (");
    const row = drawer.slice(start, start + 500);
    anchorIndex(row, "href={`/dashboard/research?view=feeds&article=${a.id}`}");
    expect(drawer).not.toContain('href="/dashboard/research?view=feeds"');
  });

  it("the research page reads the article param the link sends", () => {
    anchorIndex(read("app/dashboard/research/page.tsx"), "params.article");
  });
});

describe("data-confidence popover — Full audit link", () => {
  it("points at the Integrity checks section, which exists on Data Health", () => {
    const indicator = read("app/dashboard/components/DataConfidenceIndicator.tsx");
    const at = anchorIndex(indicator, 'href="/dashboard/data-health#integrity"');
    anchorIndex(indicator.slice(at, at + 300), "Full audit");
    anchorIndex(read("app/dashboard/data-health/page.tsx"), 'id="integrity"');
  });
});
