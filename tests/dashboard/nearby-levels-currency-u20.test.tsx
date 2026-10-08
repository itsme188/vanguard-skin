import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NearbyLevelsCard } from "@/app/dashboard/components/NearbyLevelsCard";
import type { LevelNearPrice } from "@/lib/queries/briefing-levels";

// U20 — a level price is stored in the security's native currency, so the
// card must not print it with a "$" for a non-USD security. Synthetic row.
function level(overrides: Partial<LevelNearPrice> = {}): LevelNearPrice {
  return {
    level_id: 1,
    security_id: 42,
    symbol: "ZZZ",
    security_name: "ZZZ Corp",
    currency: "JPY",
    level_type: "support",
    level_price: 1500,
    current_price: 1530,
    distance_pct: 0.02,
    direction: null,
    source: "manual",
    source_author: null,
    thesis: null,
    action_hint: null,
    ...overrides,
  };
}

describe("NearbyLevelsCard — level price label follows the security's currency", () => {
  it("does not dollar-label a JPY level", () => {
    const html = renderToStaticMarkup(<NearbyLevelsCard levels={[level()]} />);
    expect(html).not.toContain("$");
    expect(html).toContain("1,500");
    expect(html).toContain("2.0%");
  });

  it("keeps the USD label unchanged", () => {
    const html = renderToStaticMarkup(
      <NearbyLevelsCard levels={[level({ currency: "USD", level_price: 1500 })]} />
    );
    expect(html).toContain("@ $1,500.00");
  });
});
