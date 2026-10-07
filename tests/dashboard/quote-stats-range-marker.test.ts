import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { rangeMarker } from "@/app/dashboard/components/QuoteStats";

// QA finding: security-detail-quotestats--52wk-marker-clamped-price-above-high-regression-1
//
// The 52-week bar clamped the marker to 100% when the price sat above the
// cached high, so the bar said "at the high" while the printed numbers said
// the price was well above it. A price outside the cached range is now
// reported as outside. Figures below are invented round numbers.

describe("rangeMarker", () => {
  it("places an in-range price proportionally", () => {
    expect(rangeMarker(150, 100, 200)).toEqual({ pos: 0.5, outside: null });
  });

  it("treats the exact bounds as inside the range", () => {
    expect(rangeMarker(200, 100, 200)).toEqual({ pos: 1, outside: null });
    expect(rangeMarker(100, 100, 200)).toEqual({ pos: 0, outside: null });
  });

  it("reports a price above the cached high instead of pinning it at 100%", () => {
    expect(rangeMarker(220, 100, 200)).toEqual({ pos: 1, outside: "above" });
  });

  it("reports a price below the cached low", () => {
    expect(rangeMarker(90, 100, 200)).toEqual({ pos: 0, outside: "below" });
  });

  it("returns null without a price", () => {
    expect(rangeMarker(null, 100, 200)).toBeNull();
  });
});

describe("QuoteStats source pins", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/dashboard/components/QuoteStats.tsx"),
    "utf8",
  );

  it("discloses the range as-of date when the price is outside it", () => {
    expect(source).toMatch(/marker\.outside/);
    expect(source).toMatch(/quote\.as_of_date/);
  });

  it("stays public market data (no privacy masking)", () => {
    expect(source).not.toMatch(/@\/lib\/privacy\/components/);
  });
});
