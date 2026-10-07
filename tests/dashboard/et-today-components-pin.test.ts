/**
 * U22 — UTC "today" sweep, dashboard components.
 *
 * These four are server components that open the production db singleton at
 * import, and the repo has no DOM harness, so the date derivation is pinned
 * by reading the source (the no-DOM-test-harness convention).
 *
 * The rule: a "today" that picks a period boundary comes from `todayET()`.
 * A UTC slice of the wall clock (`new Date().toISOString().slice(0, 10)`, or
 * `Date.now()` arithmetic sliced the same way) reads TOMORROW between 20:00
 * and midnight Eastern. Slicing a Date that was BUILT from the ET day string
 * is fine — that is plain date arithmetic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "app/dashboard/components");
const read = (name: string) => readFileSync(join(dir, name), "utf8");

/** Comments stripped so prose describing the old bug never trips a pin. */
const code = (name: string) =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const FILES = [
  "MorningBriefing.tsx",
  "IncomeYieldSection.tsx",
  "PeriodComparisonTable.tsx",
  "PerformanceView.tsx",
];

describe("dashboard components anchor 'today' to Eastern time", () => {
  for (const name of FILES) {
    it(`${name} reads today from todayET()`, () => {
      const src = code(name);
      expect(src).toMatch(/import\s*\{[^}]*\btodayET\b[^}]*\}\s*from\s*"@\/lib\/calendar\/date-utils"/);
      expect(src).toMatch(/const today = todayET\(\)/);
    });

    it(`${name} never slices the wall clock in UTC`, () => {
      const src = code(name);
      expect(src).not.toMatch(/new Date\(\)\s*\.toISOString\(\)/);
      expect(src).not.toMatch(/new Date\(\s*Date\.now\(\)[^;]*toISOString\(\)/);
      // A bare `new Date()` assigned and later sliced (the old yearAgo form).
      expect(src).not.toMatch(/=\s*new Date\(\);[\s\S]{0,200}?\.toISOString\(\)\.slice\(0, 10\)/);
    });
  }

  it("IncomeYieldSection derives the trailing-12-month start from the ET day", () => {
    const src = code("IncomeYieldSection.tsx");
    expect(src).toMatch(/new Date\(today \+ "T00:00:00Z"\)/);
    expect(src).toMatch(/setUTCFullYear\(/);
    expect(src).not.toMatch(/\.setFullYear\(/);
  });

  it("PeriodComparisonTable derives 1Y/3Y/5Y starts from the ET day", () => {
    const src = code("PeriodComparisonTable.tsx");
    const starts = src.match(/startDate: addDays\(today, -/g) ?? [];
    expect(starts).toHaveLength(3);
  });
});
