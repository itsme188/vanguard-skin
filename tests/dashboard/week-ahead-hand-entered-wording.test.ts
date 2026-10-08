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

  it("the week view uses the same wording and drops the old one", () => {
    expect(weekView).toContain("Entered by you");
    expect(weekView).not.toContain("added by hand");
  });
});
