/**
 * A macro actual never prints as negative zero (owner follow-up to migration
 * 097, 2026-10-08). `formatFredValue` used to format the unrounded value, so
 * a small negative that rounds to zero at the printed precision was stored as
 * "-0.0%". The same case list is answered by the Worker copy in
 * workers/cron/test/fred-format-parity.test.ts. Synthetic observations only.
 */

import { describe, it, expect } from "vitest";
import { formatFredValue } from "@/lib/calendar/enrich-actuals";
import fixture from "../fixtures/fred-format-zero-cases.json";

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

describe("formatFredValue: a figure that rounds to zero prints as zero", () => {
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
    });
  }

  it("never returns a string that reads as negative zero", () => {
    for (const c of CASES) {
      const out = formatFredValue(
        {
          value: c.value,
          date: "2026-06-01",
          priorValue: c.priorValue ?? null,
          priorYearValue: c.priorYearValue ?? null,
        },
        { formatAs: c.formatAs as FormatAs, unitScale: c.unitScale },
      );
      expect(out).not.toMatch(/^-\$?0(?:\.0+)?%?$/);
    }
  });
});
