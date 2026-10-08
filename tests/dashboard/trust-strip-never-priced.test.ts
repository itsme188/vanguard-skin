import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import { stalePricesSummary } from "@/app/dashboard/components/analysis/TrustStripDrawer";

// QA finding analysis-trust-strip-stale-prices--drawer-omits-never-priced-held-options
// (recommended option 1: a "Never priced" group above the stale group, two counts).
// No DOM harness in this repo: the pure helper is tested directly and the
// wiring is pinned by a source scan.

const DRAWER = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");
const STRIP = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");

describe("stalePricesSummary", () => {
  it("keeps the two counts apart", () => {
    expect(stalePricesSummary(115, 4)).toBe("115 stale · 4 never priced");
  });

  it("reads as before when nothing is unpriced", () => {
    expect(stalePricesSummary(0, 0)).toBe("All fresh");
    expect(stalePricesSummary(3, 0)).toBe("3 stale");
  });

  it("never says 'All fresh' while a holding has no price", () => {
    expect(stalePricesSummary(0, 2)).toBe("2 never priced");
  });
});

describe("Stale-prices drawer lists never-priced holdings first, with their own count", () => {
  const body = sliceBetween(DRAWER, "function StalePricesContent(", "// Band copy + tone");

  it("the never-priced group comes before the stale group", () => {
    const never = anchorIndex(body, 'aria-label="Never priced"');
    const stale = anchorIndex(body, 'aria-label="Stale prices"');
    expect(never).toBeLessThan(stale);
  });

  it("each group prints its own count through the privacy mask and its own symbols", () => {
    const never = sliceBetween(body, 'aria-label="Never priced"', "{stalePrices.count > 0 && (");
    expect(never).toContain("<PrivateText>{String(neverPriced.count)}</PrivateText>");
    expect(never).toContain("<SymbolChips symbols={neverPriced.symbols} />");
    expect(never).not.toContain("stalePrices");
    const stale = body.slice(anchorIndex(body, 'aria-label="Stale prices"'));
    expect(stale).toContain("<PrivateText>{String(stalePrices.count)}</PrivateText>");
    expect(stale).toContain("<SymbolChips symbols={stalePrices.symbols} />");
    // The two counts are never added together in the drawer.
    expect(body).not.toMatch(/stalePrices\.count\s*\+\s*neverPriced\.count/);
  });

  it("the all-fresh line needs BOTH lists empty", () => {
    expect(body).toContain("{stalePrices.count === 0 && neverPriced.count === 0 ? (");
  });
});

describe("Trust strip cell", () => {
  it("prints the two-count summary and cannot read 'All fresh' over a never-priced holding", () => {
    const cell = sliceBetween(STRIP, 'label="Stale prices"', 'onClick={() => togglePanel("stalePrices")}');
    expect(cell).toContain("untrustedPrices === 0");
    expect(cell).toContain("<PrivateText>{stalePricesSummary(stalePrices.count, neverPriced.count)}</PrivateText>");
    expect(cell).toContain("Never priced: ");
    expect(STRIP).toContain("const untrustedPrices = stalePrices.count + neverPriced.count;");
  });
});
