/**
 * Parity for formatFredValue's zero handling: the Worker copy
 * (workers/cron/src/enrich-actuals.ts) answers the SAME case list as the Mac
 * copy (tests/calendar/fred-format-negative-zero.test.ts). A figure that
 * rounds to zero at the printed precision prints as zero, never "-0.0%".
 * Synthetic observations only.
 */

import { describe, it, expect } from "vitest";
import { formatFredValue } from "../src/enrich-actuals";
import fixture from "../../../tests/fixtures/fred-format-zero-cases.json";

type FormatAs = Parameters<typeof formatFredValue>[1]["formatAs"];

interface Case {
  name: string;
  formatAs: string;
  unitScale?: number;
  value: number;
  priorValue?: number;
  priorYearValue?: number;
  expected: string;
}

const CASES = fixture.cases as Case[];

describe("formatFredValue (Worker mirror): a figure that rounds to zero prints as zero", () => {
  it("covers every unit the formatter prints", () => {
    expect(new Set(CASES.map((c) => c.formatAs))).toEqual(
      new Set(["pct", "pct_mom", "pct_yoy", "qoq_saar", "delta_k", "level_count", "usd_millions"]),
    );
  });

  for (const c of CASES) {
    it(c.name, () => {
      const out = formatFredValue(
        {
          value: c.value,
          date: "2026-06-01",
          priorValue: c.priorValue ?? null,
          priorYearValue: c.priorYearValue ?? null,
        },
        { formatAs: c.formatAs as FormatAs, unitScale: c.unitScale },
      );
      expect(out).toBe(c.expected);
      expect(out).not.toMatch(/^-\$?0(?:\.0+)?%?$/);
    });
  }
});
