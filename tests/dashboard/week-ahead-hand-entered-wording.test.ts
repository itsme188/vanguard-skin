import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("hand-entered earnings row wording", () => {
  const weekView = read("app/dashboard/today/WeekAheadView.tsx");
  const chip = read("app/dashboard/today/EarningsDateChip.tsx");

  it("the Hub chip's label is the ruled wording", () => {
    expect(chip).toContain('export const HAND_ENTERED_LABEL = "Entered by you";');
  });

  // Unit 16: the week view prints the shared constant instead of its own
  // copy of the words. It is a Server Component, so it takes the constant
  // from the plain lib module; tests/dashboard/today-week-tidy-u16.test.ts
  // pins that constant equal to the Hub chip's.
  it("the week view uses the same wording and drops the old one", () => {
    const lib = read("lib/calendar/manual-row-display.ts");
    expect(lib).toContain('export const HAND_ENTERED_LABEL = "Entered by you";');
    expect(weekView.indexOf("{HAND_ENTERED_LABEL}")).toBeGreaterThan(-1);
    expect(weekView.indexOf('from "@/lib/calendar/manual-row-display"')).toBeGreaterThan(-1);
    expect(weekView).not.toContain("added by hand");
  });
});
