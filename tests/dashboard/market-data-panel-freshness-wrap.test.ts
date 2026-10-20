import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

// QA finding: security-detail-hero-mobile--large-magnitude-price-clipped-regression-2
//
// The command strip's freshness group ("market closed · as of YYYY-MM-DD ·
// now HH:MM:SS ET") was a shrink-0 flex row, so at 390px it ran past the
// card's overflow-hidden edge and the phone showed "· NO" with the clock cut
// off. The group may now wrap onto a second line and shrink, and the strip
// row itself wraps so the clock always lands inside the card.
describe("MarketDataPanel freshness stamp fits a phone", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/dashboard/components/MarketDataPanel.tsx"),
    "utf8",
  );
  const start = anchorIndex(source, "function FreshnessStamp(");
  const end = anchorIndex(source, "function ChangeCaption(", start, "next component");
  const region = source.slice(start, end);

  it("lets the freshness group wrap and shrink instead of pinning it at content width", () => {
    const groupOpen = anchorIndex(region, "<div className=", 0, "group div");
    const groupTag = region.slice(groupOpen, region.indexOf(">", groupOpen));
    expect(groupTag).toMatch(/flex-wrap/);
    expect(groupTag).toMatch(/min-w-0/);
    expect(groupTag).not.toMatch(/shrink-0/);
  });

  it("keeps the clock readable: the now-span never wraps mid-time", () => {
    const clock = anchorIndex(region, "· now", 0, "clock span");
    const before = region.slice(Math.max(0, clock - 80), clock);
    expect(before).toMatch(/whitespace-nowrap/);
  });

  it("lets the command strip row wrap so the stamp can drop below the name", () => {
    const strip = anchorIndex(source, "Command strip", 0, "command strip comment");
    const rowOpen = anchorIndex(source, "<div", strip, "strip row");
    const rowTag = source.slice(rowOpen, source.indexOf(">", rowOpen));
    expect(rowTag).toMatch(/flex-wrap/);
    expect(rowTag).toMatch(/md:flex-nowrap/);
  });
});
