import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

// QA finding: security-detail-hero-mobile--large-magnitude-price-clipped-regression-3
//
// An option's ticker is a padded OCC symbol ("ZZZ   270115P00100000", 20+
// characters with spaces inside). The hero grid's `auto` column took the
// symbol's full width and pushed the price and the day change past the
// card's overflow-hidden right edge on a 390px phone. The fix: the hero is a
// two-column grid at every width whose symbol column may shrink
// (minmax(0,auto)) while the symbol itself wraps anywhere inside it, so a
// short ticker keeps the price beside it and only a long symbol wraps. Source pin (no DOM harness), browser
// measurement recorded in the fix commit's QA run.
describe("MarketDataPanel hero: a long OCC symbol cannot push the price out", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/dashboard/components/MarketDataPanel.tsx"),
    "utf8",
  );
  const hero = anchorIndex(source, "Hero header: symbol + big price");
  const priceBlock = anchorIndex(source, "currentPrice != null &&", hero, "price block");
  const region = source.slice(hero, priceBlock);

  it("uses the shrinkable two-column grid at every width, with no inline override", () => {
    expect(region).toMatch(/grid-cols-\[minmax\(0,auto\)_1fr\]/);
    // No one-column class and no sm: switch of the column template.
    expect(region).not.toMatch(/grid-cols-1/);
    expect(region).not.toMatch(/sm:\[?grid-template-columns|sm:grid-cols/);
    // An inline gridTemplateColumns would override the classes at every width.
    expect(region).not.toMatch(/gridTemplateColumns:/);
  });

  it("lets the symbol cell shrink and the symbol wrap anywhere", () => {
    const symbolCell = anchorIndex(region, '<div className="min-w-0">', 0, "symbol cell");
    const symbolText = anchorIndex(region, "{symbol}", symbolCell, "symbol text");
    expect(region.slice(symbolCell, symbolText)).toMatch(/\[overflow-wrap:anywhere\]/);
  });
});
