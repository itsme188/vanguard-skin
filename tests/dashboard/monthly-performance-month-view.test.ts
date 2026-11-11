/**
 * The month view on the Performance page.
 *
 * Source-pinned (no DOM harness in this repo — see the sibling dashboard
 * tests): these guard the wiring and the copy contract, and the engine's own
 * behaviour is pinned in tests/compute/monthly-performance.test.ts.
 *
 * What must stay true:
 *  1. Every refusal / flow-evidence / method code has owner-facing copy. A
 *     new code cannot reach a screen as a bare token.
 *  2. The month view reads the SAME scope as the rest of the page, so the
 *     blend covers exactly the accounts the scope pills select.
 *  3. The section does no arithmetic on the figures — it renders what the
 *     engine returned, so "the blend is not an average of the percentages"
 *     cannot be undone in the view.
 *  4. The `month` search param is threaded from the page to the view.
 *  5. Money and percentages render through the privacy components.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import {
  MONTHLY_FLOW_SOURCES,
  MONTHLY_PERF_METHODS,
  MONTHLY_PERF_REFUSALS,
} from "@/lib/compute/monthly-performance";
import {
  FLOW_SOURCE_TEXT,
  METHOD_BLURB,
  METHOD_TEXT,
  REFUSAL_TEXT,
  monthLabel,
} from "@/app/dashboard/components/monthly-performance-labels";

const SECTION = "app/dashboard/components/MonthlyPerformanceSection.tsx";
const VIEW = "app/dashboard/components/PerformanceView.tsx";
const PAGE = "app/dashboard/analysis/page.tsx";

const read = (path: string) => readFileSync(path, "utf8");

describe("owner-facing copy", () => {
  it("has a sentence for every refusal code", () => {
    expect(Object.keys(REFUSAL_TEXT).sort()).toEqual([...MONTHLY_PERF_REFUSALS].sort());
    for (const code of MONTHLY_PERF_REFUSALS) {
      expect(REFUSAL_TEXT[code].length).toBeGreaterThan(10);
      // Copy, not the code itself.
      expect(REFUSAL_TEXT[code]).not.toContain(code);
    }
  });

  it("has a sentence for every flow-evidence code", () => {
    expect(Object.keys(FLOW_SOURCE_TEXT).sort()).toEqual([...MONTHLY_FLOW_SOURCES].sort());
    for (const code of MONTHLY_FLOW_SOURCES) {
      // A full sentence naming what it is about, never the bare code.
      expect(FLOW_SOURCE_TEXT[code]).toMatch(/deposit/i);
      expect(FLOW_SOURCE_TEXT[code]).toMatch(/\.$/);
      expect(FLOW_SOURCE_TEXT[code]).not.toContain(code);
    }
  });

  it("has a label for every method", () => {
    expect(Object.keys(METHOD_TEXT).sort()).toEqual([...MONTHLY_PERF_METHODS].sort());
    for (const code of MONTHLY_PERF_METHODS) {
      expect(METHOD_TEXT[code]).toContain("Modified Dietz");
    }
  });

  it("states the method and the blended rule in the UI copy", () => {
    expect(METHOD_BLURB).toContain("Modified Dietz");
    expect(METHOD_BLURB).toContain("never counted as performance");
    expect(METHOD_BLURB).toContain("not an average of their percentages");
  });

  it("names a month in full", () => {
    expect(monthLabel("2026-03-31")).toBe("March 2026");
    expect(monthLabel("2026-12-31")).toBe("December 2026");
  });
});

describe("the view's wiring", () => {
  it("reads the month list and the month's figures over the page's own scope", () => {
    const src = read(VIEW);
    const block = sliceBetween(src, "const statementMonths =", "const buildHref =");
    expect(block).toContain("listStatementMonths(db, scopeAccountIds)");
    expect(block).toContain("computeMonthlyPerformance(db, scopeAccountIds, activeMonth)");
    // Never the first account of a multi-account scope.
    expect(block).not.toContain("scopeAccountIds[0]");
    expect(block).not.toContain("twrAccountId");
  });

  it("falls back to the newest statement month for an absent or unknown month", () => {
    const src = read(VIEW);
    const block = sliceBetween(src, "const activeMonth =", "const monthly =");
    expect(block).toContain("statementMonths.includes(month)");
    expect(block).toContain("statementMonths[0]");
  });

  it("threads the month search param from the page into the view", () => {
    const page = read(PAGE);
    anchorIndex(page, "month?: string;", 0, "searchParams type");
    anchorIndex(page, "month={params.month}", 0, "prop passed to PerformanceView");
  });

  it("keeps the month on a period switch and drops it on a scope switch", () => {
    const src = read(VIEW);
    const block = sliceBetween(src, "const buildHref =", "return (");
    // next.scope set => undefined (the new scope picks its own newest month).
    expect(block).toContain("next.month ?? (next.scope ? undefined : activeMonth ?? undefined)");
  });

  it("renders the section even when the scope has no statement month", () => {
    const src = read(VIEW);
    const block = sliceBetween(src, "<MonthlyPerformanceSection", "/>");
    expect(block).toContain("monthly?.accounts ?? []");
    expect(block).toContain("monthly?.blended ?? null");
  });
});

describe("the section renders, and never recomputes", () => {
  const src = read(SECTION);

  it("does no arithmetic on a return or a gain", () => {
    // The only multiplication allowed is the fraction -> percent conversion
    // the privacy <Pct> component expects.
    const arithmetic = src.match(/returnFraction\s*[+\-/*]/g) ?? [];
    expect(arithmetic.filter((m) => !m.includes("*"))).toEqual([]);
    expect(src).not.toMatch(/accounts\.length/);
    expect(src).not.toMatch(/reduce\([^)]*returnFraction/);
    expect(src).not.toMatch(/gainLoss\s*[+\-/*]/);
  });

  it("renders every figure through the privacy components", () => {
    const body = src.slice(anchorIndex(src, "export function MonthlyPerformanceSection"));
    // No bare formatter and no raw toFixed on a portfolio figure.
    expect(body).not.toContain("toFixed");
    expect(body).not.toContain("formatUSD");
    expect(body).toContain("<Pct");
    expect(body).toContain("<Money");
  });

  it("names the blocking accounts and the reason when the blend is incomplete", () => {
    const block = sliceBetween(src, "blended.incomplete ? (", "{/* ── Per-account rows");
    expect(block).toContain("blended.blockedBy.map");
    expect(block).toContain("b.accountName");
    expect(block).toContain("REFUSAL_TEXT[b.refusal]");
    expect(block).toContain("Incomplete");
    // The two present accounts are still shown, and the copy says so.
    expect(block).toContain("never blended");
  });

  it("takes small coloured figures from the checked tone table", () => {
    const block = sliceBetween(src, "function toneText", "function headlineTone");
    expect(block).toContain("CHIP_TONE_TEXT.up");
    expect(block).toContain("CHIP_TONE_TEXT.down");
    // Never a faded status ink on small text.
    expect(src).not.toMatch(/text-(up|down)\/\d/);
  });

  it("reads the flow-evidence footnote through the engine's weakest-evidence rule", () => {
    expect(src).toContain("weakestFlowSource(sources)");
  });

  it("derives the year and month pills from the data, with no hardcoded year", () => {
    const block = sliceBetween(src, "const years =", "if (months.length === 0");
    expect(block).toContain("new Set(months.map((m) => m.slice(0, 4)))");
    expect(src).not.toMatch(/"20\d\d"/);
  });
});
