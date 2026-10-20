import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// QA finding: dashboard-today-earnings-hub-date-conflict-popover-earningsdatechip-tsx-781-date-conflict-popover-says-pick-th
//
// The date-conflict popover offered "pick the IBKR date" on every row, naming
// a ticker that has nothing to do with the company in the row (and that is
// itself a listed company with its own print). The heading must name no
// company; the buttons under it already name the two vendors.
const src = readFileSync("app/dashboard/today/EarningsDateChip.tsx", "utf8");

describe("Hub date-conflict popover heading", () => {
  it("names no company in the heading or the chip title", () => {
    const heading = src.indexOf("Sources disagree");
    expect(heading).toBeGreaterThan(-1);
    const lines = src.split("\n").filter((l) => l.includes("Sources disagree"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/\bIBKR\b/);
  });

  it("tells the user to check their broker's calendar when choosing", () => {
    expect(src).toMatch(/Sources disagree[^\n]*check your broker/);
  });
});
