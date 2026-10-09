/**
 * Parity for workers/cron/src/macro-figure.ts, the hand mirror of
 * lib/calendar/macro-figure.ts (the Worker bundle cannot cross the Next.js
 * path-alias boundary). Two pins:
 *
 *   1. the two files are byte-identical below the mirror marker;
 *   2. the Worker copy answers the SAME fixture list as the Mac copy
 *      (tests/fixtures/macro-figure-cases.json).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseMacroFigure,
  macroActualProblem,
  referencePeriodFor,
  isReferencePeriod,
  refusedReasonFromPayload,
  ACTUAL_REFUSED_PREFIX,
  type MacroFrequency,
} from "../src/macro-figure";

const MARKER = "// ── mirrored below this line ──";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const cases = JSON.parse(read("../../../tests/fixtures/macro-figure-cases.json")) as {
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

describe("macro-figure parity (Worker mirror of lib/calendar/macro-figure.ts)", () => {
  it("is byte-identical to the Mac source below the mirror marker", () => {
    const mac = read("../../../lib/calendar/macro-figure.ts");
    const wkr = read("../src/macro-figure.ts");
    expect(mac.indexOf(MARKER)).toBeGreaterThan(-1);
    expect(wkr.indexOf(MARKER)).toBeGreaterThan(-1);
    const strip = (s: string) => s.slice(s.indexOf(MARKER));
    expect(strip(wkr)).toBe(strip(mac));
  });

  it.each(cases.parse)("parses $input", ({ input, value, unit, step }) => {
    const parsed = parseMacroFigure(input);
    if (value === null) {
      expect(parsed).toBeNull();
      return;
    }
    expect(parsed!.unit).toBe(unit);
    expect(parsed!.value).toBeCloseTo(value, 6);
    expect(parsed!.step).toBeCloseTo(step!, 6);
  });

  it.each(cases.gate)("size check: $name", ({ actual, consensus, previous, fires }) => {
    const problem = macroActualProblem(actual, consensus, previous);
    if (fires) expect(problem).toEqual(expect.any(String));
    else expect(problem).toBeNull();
  });

  it.each(cases.period)("period: $date ($frequency) -> $period", ({ date, frequency, period }) => {
    expect(referencePeriodFor(date, frequency)).toBe(period);
    if (period) expect(isReferencePeriod(period)).toBe(true);
  });

  it("reads a refusal out of a payload reason", () => {
    expect(refusedReasonFromPayload(`${ACTUAL_REFUSED_PREFIX}too large`)).toBe("too large");
    expect(refusedReasonFromPayload("no_observation")).toBeNull();
  });
});
