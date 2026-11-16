/**
 * Period attribution says what it weights and why it is empty (review
 * 2026-11-15, W4 b-d). No DOM harness: source pins.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sliceBetween } from "../helpers/source-anchor";

const section = readFileSync("app/dashboard/components/PeriodAttributionSection.tsx", "utf8");

describe("Period attribution captions and empty reasons", () => {
  it("the caption says long positions only, and what is left out", () => {
    const caption = sliceBetween(section, "attribution.positionsBasis.asOf &&", "</p>");
    expect(caption).toContain("Long positions only; shorts, options and bonds are not included.");
  });

  it("an option-only (or shorts-only) book gets its own reason, not 'no snapshot'", () => {
    const fn = sliceBetween(section, "function positionsEmptyText", "\n}\n");
    const branch = sliceBetween(fn, '"no_eligible_positions_at_start"', "\n  }");
    expect(branch).toContain("no long stocks, ETFs or funds");
    expect(branch).not.toContain("No position snapshot is on file");
  });

  it("missing end and start closes each get their own reason", () => {
    const fn = sliceBetween(section, "function positionsEmptyText", "\n}\n");
    expect(sliceBetween(fn, '"no_end_price"', "\n  }")).toContain("closing price");
    expect(sliceBetween(fn, '"no_start_price"', "\n  }")).toContain("closing price");
  });
});
