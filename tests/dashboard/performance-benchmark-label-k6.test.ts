/**
 * Performance view wording (review 2026-11-15, unit K6). No DOM harness:
 * source pins plus the label module's own strings.
 *
 * K6a: the stored SPY series is a price return, so every place the view
 *      names the benchmark says "SPY price return", and alpha carries one
 *      sentence saying it is overstated by about the dividend yield. One
 *      source for the words: lib/compute/benchmark-label.ts.
 * K6b: the money-weighted tile compares with the time-weighted return only
 *      on a basis the page shows (both annual rates).
 * K6c: every attribution empty-state sentence names the scope.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sliceBetween } from "../helpers/source-anchor";
import {
  ALPHA_PRICE_RETURN_NOTE,
  BENCHMARK_RETURN_LABEL,
  BENCHMARK_RETURN_LABEL_LONG,
  BENCHMARK_SYMBOL,
} from "@/lib/compute/benchmark-label";

const view = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
const section = readFileSync("app/dashboard/components/PeriodAttributionSection.tsx", "utf8");
const chart = readFileSync("app/dashboard/components/EquityCurveChart.tsx", "utf8");
const labelModule = readFileSync("lib/compute/benchmark-label.ts", "utf8");

describe("K6a: the benchmark is labelled as a price return", () => {
  it("the label module says price return and dividends not included, with no yield figure", () => {
    expect(BENCHMARK_SYMBOL).toBe("SPY");
    expect(BENCHMARK_RETURN_LABEL).toBe("SPY price return");
    expect(BENCHMARK_RETURN_LABEL_LONG).toBe("SPY, price return, dividends not included");
    expect(ALPHA_PRICE_RETURN_NOTE).toContain("price return");
    expect(ALPHA_PRICE_RETURN_NOTE).toContain("overstated by about the benchmark's dividend yield");
    expect(ALPHA_PRICE_RETURN_NOTE).not.toMatch(/\d/);
    // Plain module: the server page and the client chart can both import it.
    expect(labelModule).not.toContain('"use client"');
  });

  it("the page reads the symbol from the label module, not its own copy", () => {
    expect(view).toContain('from "@/lib/compute/benchmark-label"');
    expect(view).not.toContain('const BENCHMARK_SYMBOL = "SPY"');
  });

  it("the equity-curve legend and tooltip name the benchmark by its label", () => {
    expect(view).toContain("benchmarkLabel={BENCHMARK_RETURN_LABEL}");
    const line = sliceBetween(chart, 'dataKey="benchmark"', "/>");
    expect(line).toContain("name={benchmarkLabel}");
    expect(line).not.toContain("benchmarkSymbol");
  });

  it("the beta/alpha card heading, alpha caption and alpha note use the label", () => {
    expect(view).toContain("benchmarkLabel={BENCHMARK_RETURN_LABEL}");
    const heading = sliceBetween(section, "Beta vs alpha decomposition", "</h3>");
    expect(heading).toContain("vs {benchmarkLabel}");
    expect(heading).not.toContain("{benchmarkSymbol}");
    const alpha = sliceBetween(section, "                Alpha\n", "{betaWindowCaption &&");
    expect(alpha).not.toContain("Idiosyncratic return above benchmark");
    expect(alpha).toContain("Return above the {benchmarkLabel}");
    expect(alpha).toContain("{ALPHA_PRICE_RETURN_NOTE}");
  });
});

describe("K6b: money-weighted vs time-weighted compares like with like", () => {
  it("the tile compares with the SHOWN annual TWR, never the hidden one", () => {
    const tile = sliceBetween(view, 'label="MWR (XIRR) · annualized"', "/>");
    expect(tile).toContain("interpretTwrVsXirr(shownAnnualizedTwr, xirrAnnualized)");
    expect(tile).not.toMatch(/interpretTwrVsXirr\(annualizedTwr\b/);
  });

  it("YTD shows no annual TWR, so it gets no comparison sentence", () => {
    const fn = sliceBetween(view, "function shownAnnualized", "\n}\n");
    expect(fn).toContain('if (period === "ytd") return null;');
  });
});

describe("K6c: every attribution empty reason names the scope", () => {
  it("the view passes the scope's name to the section", () => {
    expect(view).toContain("scopeName={attributionScopeName}");
  });

  it("each reason sentence carries the scope or the account names", () => {
    const fn = sliceBetween(section, "function positionsEmptyText", "\n}\n");
    const sentences = fn.match(/return `[^`]*`;/g) ?? [];
    expect(sentences.length).toBe(5);
    for (const s of sentences) {
      expect(s.includes("${scopeName}") || s.includes("${missingAccounts.join")).toBe(true);
    }
    expect(fn).toContain("No position snapshot is on file for ${scopeName}");
  });
});
