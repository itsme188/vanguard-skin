import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/DataConfidenceIndicator.tsx"),
  "utf8",
);

// The popover container is the element carrying the shadow-xl panel classes.
const match = src.match(/className=\{`([^`]*shadow-xl[^`]*)`\}/);
const classes = match?.[1] ?? "";

describe("DataConfidenceIndicator popover scroll", () => {
  it("finds the popover container class string", () => {
    expect(classes).toContain("absolute");
    expect(classes).toContain("z-50");
  });

  it("bounds the popover height to the viewport", () => {
    expect(classes).toMatch(/max-h-\[calc\(100dvh-[\d.]+rem\)\]/);
  });

  it("scrolls vertically inside the popover so the actions stay reachable", () => {
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("overscroll-contain");
  });
});
