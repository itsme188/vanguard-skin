import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NearbyLevelsCard } from "@/app/dashboard/components/NearbyLevelsCard";
import { PrivacyProvider } from "@/lib/privacy/context";
import type { LevelNearPrice } from "@/lib/queries/briefing-levels";

// QA finding: today-alerts-nearby-levels--privacy-masks-public-level-prices-inbox-shows-clear
//
// Privacy mode is meant to mask PORTFOLIO-DERIVED numbers only. Newsletter
// level prices and the distance from the current price to a level are public
// market data (the same figures /dashboard/alerts already renders unmasked
// with formatUSDPrecise/formatPercent) — they must stay visible even when
// privacy mode is on.
//
// react-dom/server's renderToStaticMarkup works fine here without jsdom:
// NearbyLevelsCard is a plain (non-"use client") function component with no
// hooks, so a real DOM/browser environment isn't needed to exercise it. This
// repo otherwise has no @testing-library/react harness (see the precedent
// note in tests/dashboard/narrative-block-refresh.test.ts) — this test
// sticks to what's actually renderable rather than adding a new dependency.
//
// Wrapping in the real <PrivacyProvider> documents the realistic parent tree
// (the page always sits inside one). PrivacyProvider only flips `isPrivate`
// true inside a useEffect reading localStorage, and renderToStaticMarkup
// never runs effects — so this always renders with the provider's initial
// `isPrivate = false`. That's not a gap for THIS test: the fix means
// NearbyLevelsCard no longer calls usePrivacy() at all, so no value of
// `isPrivate` — true or false — can change what it renders. The assertion
// that matters is that the mask token never appears, independent of privacy
// state.
const MASK = "•••"; // "•••", lib/privacy/components.ts MASK

function sampleLevel(overrides: Partial<LevelNearPrice> = {}): LevelNearPrice {
  return {
    level_id: 1,
    security_id: 42,
    symbol: "TEST",
    security_name: "Test Co",
    level_type: "resistance",
    level_price: 100,
    current_price: 98,
    distance_pct: -0.02,
    direction: null,
    source: "newsletter",
    source_author: null,
    thesis: null,
    action_hint: null,
    ...overrides,
  };
}

describe("NearbyLevelsCard renders public level data unmasked (privacy mode has no effect)", () => {
  it("shows the level price and distance percent in the clear, with no privacy mask", () => {
    const html = renderToStaticMarkup(
      <PrivacyProvider>
        <NearbyLevelsCard levels={[sampleLevel()]} />
      </PrivacyProvider>
    );
    expect(html).toContain("$100.00");
    expect(html).toContain("2.0%");
    expect(html).not.toContain(MASK);
  });

  it("shows an upward distance (price above the level) unmasked too", () => {
    const html = renderToStaticMarkup(
      <PrivacyProvider>
        <NearbyLevelsCard
          levels={[sampleLevel({ level_price: 50, current_price: 51.5, distance_pct: 0.03 })]}
        />
      </PrivacyProvider>
    );
    expect(html).toContain("$50.00");
    expect(html).toContain("3.0%");
    expect(html).not.toContain(MASK);
  });

  it("does not import the masking primitives (Money/Pct) at all", () => {
    // Static-scan backstop for the render assertions above: if a future edit
    // reintroduces <Money>/<Pct> here without also wiring a privacy-mode-on
    // render path, this catches it even though renderToStaticMarkup itself
    // can't observe isPrivate=true (see file header).
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/dashboard/components/NearbyLevelsCard.tsx"),
      "utf8"
    );
    expect(source).not.toMatch(/from ["']@\/lib\/privacy\/components["']/);
  });
});
