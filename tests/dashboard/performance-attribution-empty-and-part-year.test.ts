import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// No DOM harness in this repo: source pins, browser proof separately.
const section = readFileSync("app/dashboard/components/PeriodAttributionSection.tsx", "utf8");
const view = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");

describe("Period attribution says why it is empty", () => {
  it("renders <EmptySection> when there are no contributors or detractors, never nothing", () => {
    anchorIndex(section, 'import { EmptySection } from "./EmptySection";');
    const block = sliceBetween(section, "{!hasContribDetract && (", "/>");
    expect(block).toContain("<EmptySection");
    expect(block).toContain('title="Period attribution"');
    expect(block).toContain("positionsEmptyText(attribution, requestedStart)");
  });

  it("names the accounts missing a start book, from positionsBasis", () => {
    const fn = sliceBetween(section, "function positionsEmptyText", "\n}\n");
    expect(fn).toContain('"accounts_missing_at_start"');
    expect(fn).toContain("missingAccounts.join");
  });

  it("captions the date the weights were read from", () => {
    expect(section).toContain("attribution.positionsBasis.asOf &&");
    expect(section).toContain("Trades during the period are not included.");
  });
});

describe("Performance view: a part-year TWR is not annualized", () => {
  it("the threshold is one year", () => {
    expect(view).toContain("const MIN_ANNUALIZED_DAYS = 365;");
    const fn = sliceBetween(view, "function shownAnnualized", "\n}\n");
    expect(fn).toContain("totalDays < MIN_ANNUALIZED_DAYS");
  });

  it("the TWR tile and the per-account column both go through shownAnnualized", () => {
    expect(view).toContain("shownAnnualized(annualizedTwr, twrResult?.totalDays)");
    const tile = sliceBetween(view, "subNode={", "/>");
    expect(tile).toContain("shownAnnualizedTwr !== null");
    expect(tile).not.toMatch(/\bannualizedTwr !== null/);
    expect(view).toContain("shownAnnualized(acc.annualizedReturn, acc.totalDays)");
    expect(view).not.toContain("acc.annualizedReturn !== null ? acc.annualizedReturn * 100");
  });
});

describe("Performance view: the Cash flows cell counts real flows", () => {
  it("shows externalFlowCount, not the solver's list length", () => {
    const cell = sliceBetween(view, ">Cash flows</dt>", "</div>");
    const dd = cell.slice(anchorIndex(cell, "<dd"));
    expect(dd).toContain("xirrResult?.externalFlowCount");
    expect(dd).not.toContain("cashFlowCount");
  });
});
