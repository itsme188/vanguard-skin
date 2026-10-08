import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dataWindowCoveredCaption } from "@/lib/compute/data-window-caption";
import { dataWindowNotice } from "@/lib/compute/data-window";

describe("dataWindowCoveredCaption", () => {
  it("names the window", () => {
    expect(dataWindowCoveredCaption("2026-01-02", "2026-03-31")).toBe(
      "Computed from daily data Jan 2, 2026 – Mar 31, 2026",
    );
  });
  it("null without a window", () => {
    expect(dataWindowCoveredCaption(null, "2026-03-31")).toBeNull();
    expect(dataWindowCoveredCaption("2026-01-02", null)).toBeNull();
  });
  it("is the covered-period case: dataWindowNotice is silent there", () => {
    expect(dataWindowNotice("2026-01-01", "2026-01-02", "2026-03-31")).toBeNull();
  });
});

describe("beta/alpha card always renders the window caption", () => {
  const src = readFileSync("app/dashboard/components/PeriodAttributionSection.tsx", "utf8");
  it("falls back to the covered caption when the shorter-history notice is null", () => {
    expect(src).toContain("betaWindowNotice ??");
    expect(src).toContain("dataWindowCoveredCaption(");
    expect(src).toContain("{betaWindowCaption && (");
  });
});
