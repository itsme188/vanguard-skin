/**
 * lib/calendar/macro-period-display.ts: how a stored reference period is
 * shown on a macro card (owner ruling 2026-10-08: "name the reference month
 * from FRED's observation period, not from the release date minus a fixed
 * lag"). The title itself is never edited: when it already names the stored
 * period nothing is added, and when it names a different one (or none) the
 * stored period is shown beside it.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatReferencePeriod, macroPeriodNote } from "@/lib/calendar/macro-period-display";

describe("formatReferencePeriod", () => {
  it("names a month, a quarter and a week", () => {
    expect(formatReferencePeriod("2026-08")).toBe("August 2026");
    expect(formatReferencePeriod("2025-12")).toBe("December 2025");
    expect(formatReferencePeriod("2026-Q2")).toBe("Q2 2026");
    expect(formatReferencePeriod("2026-08-29")).toBe("the week ended Aug 29, 2026");
  });

  it("returns null for anything that is not a stored period", () => {
    expect(formatReferencePeriod(null)).toBeNull();
    expect(formatReferencePeriod(undefined)).toBeNull();
    expect(formatReferencePeriod("")).toBeNull();
    expect(formatReferencePeriod("August")).toBeNull();
    expect(formatReferencePeriod("2026-13")).toBeNull();
  });
});

describe("macroPeriodNote", () => {
  it("adds nothing when the row has no stored period (the title keeps its estimate)", () => {
    expect(macroPeriodNote("August Producer Price Index", null)).toBeNull();
    expect(macroPeriodNote("August Producer Price Index", undefined)).toBeNull();
  });

  it("adds nothing when the title already names the stored month", () => {
    expect(macroPeriodNote("August Producer Price Index", "2026-08")).toBeNull();
    expect(macroPeriodNote("august producer price index", "2026-08")).toBeNull();
  });

  it("shows the stored month beside a title that names a different month", () => {
    expect(macroPeriodNote("September Producer Price Index", "2026-08")).toBe("for August 2026");
  });

  it("shows the stored month when the title names none", () => {
    expect(macroPeriodNote("Producer Price Index", "2026-08")).toBe("for August 2026");
    // "Maybe" is not the month of May.
    expect(macroPeriodNote("Maybe Index", "2026-05")).toBe("for May 2026");
  });

  it("quarters: silent when the title names the quarter, shown otherwise", () => {
    expect(macroPeriodNote("Q2 GDP Advance Estimate", "2026-Q2")).toBeNull();
    expect(macroPeriodNote("Q1 GDP Third Estimate", "2026-Q2")).toBe("for Q2 2026");
    expect(macroPeriodNote("GDP", "2026-Q2")).toBe("for Q2 2026");
  });

  it("weeks are always shown: a title never names one", () => {
    expect(macroPeriodNote("Initial Jobless Claims", "2026-08-29")).toBe(
      "for the week ended Aug 29, 2026",
    );
  });

  it("an unreadable stored value adds nothing", () => {
    expect(macroPeriodNote("Producer Price Index", "soon")).toBeNull();
  });
});

describe("the two card components print the note and never rewrite the title", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

  it.each(["app/dashboard/components/EventCard.tsx", "app/dashboard/today/WeekAheadView.tsx"])(
    "%s reads the stored period through macroPeriodNote",
    (file) => {
      const src = read(file);
      expect(src).toContain('from "@/lib/calendar/macro-period-display"');
      expect(src).toMatch(/macroPeriodNote\([^)]*reference_period\)/);
    },
  );
});
