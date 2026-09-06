import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts) — following the static-scan
// precedent in tests/dashboard/data-confidence-indicator-privacy.test.ts, this
// scans the component source for the fix idiom instead of rendering it.
//
// Landing-review follow-up #4 (commit 256833e5): commit ebe76f40 added a
// `title=` attribute to TodayReleases.tsx's clipped macro-release title
// (line-clamp truncation with no way to recover the full text on hover).
// WeekAheadView's EventRow renders `event.title` in an identically clipped
// (`line-clamp-2`) paragraph with no `title=` — same bug, same fix.

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/today/WeekAheadView.tsx",
);

describe("WeekAheadView EventRow's clipped title carries a title= attribute", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  it("renders event.title inside a line-clamp-2 element", () => {
    expect(source).toMatch(/line-clamp-2[\s\S]{0,200}\{event\.title\}/);
  });

  it("that element also carries title={event.title ?? undefined}", () => {
    // Grab the small window around the line-clamp-2 className up through the
    // {event.title} expression and require the title= prop to appear in it
    // (order-independent — className and title= can appear in either order).
    const idx = source.indexOf("line-clamp-2");
    expect(idx, "line-clamp-2 not found").toBeGreaterThan(-1);
    const windowSrc = source.slice(Math.max(0, idx - 200), idx + 300);
    expect(windowSrc).toMatch(/title=\{event\.title \?\? undefined\}/);
  });
});
