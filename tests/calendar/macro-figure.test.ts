/**
 * lib/calendar/macro-figure.ts: the macro figure parser, the size check
 * (owner ruling 2026-10-08: "an actual more than ten times both consensus and
 * prior is refused and stored empty with a reason") and the reference period
 * taken from FRED's observation date.
 *
 * Cases live in tests/fixtures/macro-figure-cases.json and are shared with the
 * Worker mirror's parity test, so both sides answer the same list.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseMacroFigure,
  macroActualProblem,
  referencePeriodFor,
  isReferencePeriod,
  refusedReasonFromPayload,
  ACTUAL_REFUSED_PREFIX,
  type MacroFrequency,
} from "@/lib/calendar/macro-figure";

const cases = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/macro-figure-cases.json"), "utf8"),
) as {
  parse: Array<{ input: string; value: number | null; unit?: string; step?: number }>;
  gate: Array<{
    name: string;
    actual: string | null;
    consensus: string | null;
    previous: string | null;
    fires: boolean;
  }>;
  period: Array<{ date: string; frequency: MacroFrequency; period: string | null }>;
};

describe("parseMacroFigure", () => {
  it.each(cases.parse)("parses $input", ({ input, value, unit, step }) => {
    const parsed = parseMacroFigure(input);
    if (value === null) {
      expect(parsed).toBeNull();
      return;
    }
    expect(parsed).not.toBeNull();
    expect(parsed!.unit).toBe(unit);
    expect(parsed!.value).toBeCloseTo(value, 6);
    expect(parsed!.step).toBeCloseTo(step!, 6);
  });

  it("returns null for null and undefined", () => {
    expect(parseMacroFigure(null)).toBeNull();
    expect(parseMacroFigure(undefined)).toBeNull();
  });
});

describe("macroActualProblem", () => {
  it.each(cases.gate)("$name", ({ actual, consensus, previous, fires }) => {
    const problem = macroActualProblem(actual, consensus, previous);
    if (fires) {
      expect(problem).toEqual(expect.any(String));
      // The reason names all three figures so the refusal can be judged later.
      expect(problem).toContain(actual!);
      expect(problem).toContain(consensus!);
      expect(problem).toContain(previous!);
    } else {
      expect(problem).toBeNull();
    }
  });

  it("the fixture exercises both outcomes", () => {
    expect(cases.gate.some((c) => c.fires)).toBe(true);
    expect(cases.gate.some((c) => !c.fires)).toBe(true);
  });
});

describe("referencePeriodFor", () => {
  it.each(cases.period)("$date ($frequency) -> $period", ({ date, frequency, period }) => {
    expect(referencePeriodFor(date, frequency)).toBe(period);
  });

  it("every period it produces passes isReferencePeriod", () => {
    for (const c of cases.period) {
      if (c.period) expect(isReferencePeriod(c.period)).toBe(true);
    }
    expect(isReferencePeriod("August 2026")).toBe(false);
    expect(isReferencePeriod("2026-13")).toBe(false);
    expect(isReferencePeriod("2026-Q5")).toBe(false);
    expect(isReferencePeriod(null)).toBe(false);
    expect(isReferencePeriod(42)).toBe(false);
  });
});

describe("refusedReasonFromPayload", () => {
  it("reads a refusal out of the payload reason and ignores every other reason", () => {
    expect(refusedReasonFromPayload(`${ACTUAL_REFUSED_PREFIX}too large`)).toBe("too large");
    expect(refusedReasonFromPayload("no_observation")).toBeNull();
    expect(refusedReasonFromPayload(`${ACTUAL_REFUSED_PREFIX}   `)).toBeNull();
    expect(refusedReasonFromPayload(undefined)).toBeNull();
    expect(refusedReasonFromPayload(7)).toBeNull();
  });
});
