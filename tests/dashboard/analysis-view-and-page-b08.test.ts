import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// Source pins for the Analysis view + page QA unit (no DOM harness here).
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const view = read("app/dashboard/components/AnalysisView.tsx");
const page = read("app/dashboard/analysis/page.tsx");

describe("allocation donut tooltip and centre label", () => {
  const tooltip = sliceBetween(view, "<Tooltip", "itemStyle");

  // [qa:analysis-allocation-donut--unlabelled-arcs-no-legend-tooltip-omits-category]
  it("the tooltip names the slice instead of overwriting the name with a literal", () => {
    expect(tooltip).toMatch(/formatter=\{\(value, name\) => \[<Money key="v" value=\{Number\(value\)\} \/>, name\]\}/);
    expect(tooltip).not.toContain('"Value"');
    // The name it passes through is the bucket: the Pie's nameKey.
    expect(sliceBetween(view, "<Pie\n", "</Pie>")).toContain('nameKey="group_name"');
  });

  // [qa:analysis-allocation-donut--centre-total-near-invisible-on-light-theme]
  it("no hardcoded dark-theme hex in the tooltip or the centre label", () => {
    const chart = sliceBetween(view, "<PieChart>", "</PieChart>");
    const afterCells = chart.slice(anchorIndex(chart, "</Pie>"));
    expect(afterCells).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
    expect(afterCells).toContain('fill="var(--color-ink-faint)"');
    expect(afterCells).toContain('fill="var(--color-ink)"');
    expect(afterCells).toContain('backgroundColor: "var(--color-panel)"');
  });
});

describe("breakdown rows", () => {
  const body = sliceBetween(view, "<tbody>", "</tbody>");

  // [qa:analysis-breakdown--drilldown-rows-mouse-only-not-focusable-no-role-no-key-handler]
  it("a drillable row carries a real button, so Tab and Enter/Space reach the drill-down", () => {
    const start = anchorIndex(body, "{rowIsDrillable ? (");
    const branch = body.slice(start, anchorIndex(body, ") : (", start));
    expect(branch).toContain("<button");
    expect(branch).toContain('type="button"');
    expect(branch).toContain("aria-label={`Drill down into ${row.group_name}`}");
    expect(branch).toContain("focus-ring");
    // One drill path: the button has no handler of its own, its click bubbles
    // to the row's handler.
    expect(branch).not.toContain("onClick");
    expect(body).toContain("? () => handleClassificationDrill(row.group_name)");
  });

  // [qa:analysis-classification--privacy-leaves-per-category-position-counts-unmasked]
  it("the Positions cell masks under privacy", () => {
    expect(body).toContain("<Count value={row.position_count} />");
    expect(body).not.toMatch(/>\s*\{row\.position_count\}\s*</);
  });
});

describe("analysis/page.tsx", () => {
  // [qa:analysis-diagnostics--unknown-dimension-param-renders-unrelated-dimension]
  it("validates ?dimension= against the active mode's list and says when it fell back", () => {
    expect(page).not.toContain("ALL_DIMENSIONS");
    expect(page).toMatch(
      /const modeDimensions: readonly string\[\] =\s*mode === "factors" \? FACTOR_DIMENSIONS : CLASSIFICATION_DIMENSIONS;/,
    );
    const start = anchorIndex(page, "const hiddenCreditRating");
    const block = page.slice(start, anchorIndex(page, "allocation =", start));
    expect(block).toContain("if (requested && modeDimensions.includes(requested) && !hiddenCreditRating)");
    expect(block).toContain("} else if (requested) {");
    expect(block).toContain("That link asked for a breakdown this view does not have.");
    expect(page).toContain("{dimensionNotice && (");
  });

  // [qa:analysis-copy--internal-dev-references-in-user-facing-text-regression-6]
  it("the Trade Reviews subtitle names no project phase", () => {
    const branch = sliceBetween(page, 'resolved.view === "trade-reviews"', 'resolved.view === "performance"');
    expect(branch).toContain("Monthly AI trade analysis.");
    expect(branch).not.toMatch(/Phase \d|relocated/);
  });

  // [qa:analysis-header--tax-lots-button-drops-account-scope]
  it("both header Tax Lots links carry the scope's account", () => {
    expect(page).not.toContain('href="/dashboard/tax-lots"');
    expect(page.split("href={taxLotsHref(scope)}").length - 1).toBe(2);
    const fn = sliceBetween(page, "function taxLotsHref", "export default async function");
    expect(fn).toContain("ids.length !== 1");
    expect(fn).toContain("?account=${encodeURIComponent(row.name)}");
  });

  // [qa:analysis-trade-reviews--ignores-scope-param-submenu-roth-link-opens-ibkr]
  it("Trade Reviews preselects the account the scope names, IBKR otherwise", () => {
    const branch = sliceBetween(page, 'resolved.view === "trade-reviews"', 'resolved.view === "performance"');
    expect(branch).toContain("resolveAccountIds(params.scope as AccountScope)");
    expect(branch).toContain('params.scope !== "all"');
    expect(branch).toContain("const defaultAccountId = scoped?.id ?? ibkr?.id ?? accounts[0]?.id ?? null;");
  });
});
