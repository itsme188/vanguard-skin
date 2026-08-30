import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NearbyLevelsCard } from "@/app/dashboard/components/NearbyLevelsCard";
import { AlertLevelLine } from "@/app/dashboard/components/NotificationBell";
import { AlertPriceRow } from "@/app/dashboard/components/RecentAlertsPanel";
import type { LevelNearPrice } from "@/lib/queries/briefing-levels";

// QA finding: today-alerts-nearby-levels--privacy-masks-public-level-prices-inbox-shows-clear
// PR #58 review finding #1/#2: NotificationBell and RecentAlertsPanel had the
// identical bug (level price / triggered price wrapped in <Money>) — fixed
// alongside NearbyLevelsCard, and pinned here together.
//
// Privacy mode is meant to mask PORTFOLIO-DERIVED numbers only. Newsletter
// level prices and the distance from the current price to a level are public
// market data (the same figures /dashboard/alerts already renders unmasked
// with formatUSDPrecise/formatPercent) — they must stay visible even when
// privacy mode is on.
//
// react-dom/server's renderToStaticMarkup works fine here without jsdom: all
// three components under test are plain (non-"use client"-gated at the
// render level) function components. This repo otherwise has no
// @testing-library/react harness (see the precedent note in
// tests/dashboard/narrative-block-refresh.test.ts) — this test sticks to
// what's actually renderable rather than adding a new dependency.
//
// PREVIOUS VERSION OF THIS FILE wrapped renders in the real <PrivacyProvider>,
// whose `isPrivate` only flips true inside a useEffect reading localStorage —
// renderToStaticMarkup never runs effects, so every assertion ran against
// isPrivate=false and would have passed against the OLD masked (<Money>)
// code too. That made the render assertions vacuous; only a source-grep
// test actually pinned the fix.
//
// This version instead mocks the shared `usePrivacy` hook (the one <Money>/
// <Pct> call internally, from lib/privacy/components.tsx) to force
// isPrivate=true for the whole module graph. That makes the render
// assertions a REAL pin: if <Money>/<Pct> were reintroduced anywhere in
// these components, THIS mocked hook would make them render the mask token
// ("•••"), and the "$100.00" / "2.0%" assertions below would fail.
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: true, setPrivate: () => {}, toggle: () => {} }),
  PrivacyProvider: ({ children }: { children: React.ReactNode }) => children,
}));

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

describe("NearbyLevelsCard renders public level data unmasked under privacy mode (isPrivate forced true)", () => {
  it("shows the level price and distance percent in the clear, with no privacy mask", () => {
    const html = renderToStaticMarkup(<NearbyLevelsCard levels={[sampleLevel()]} />);
    expect(html).toContain("$100.00");
    expect(html).toContain("2.0%");
    expect(html).not.toContain(MASK);
  });

  it("shows an upward distance (price above the level) unmasked too", () => {
    const html = renderToStaticMarkup(
      <NearbyLevelsCard
        levels={[sampleLevel({ level_price: 50, current_price: 51.5, distance_pct: 0.03 })]}
      />
    );
    expect(html).toContain("$50.00");
    expect(html).toContain("3.0%");
    expect(html).not.toContain(MASK);
  });

  it("does not import the masking primitives (Money/Pct) at all", () => {
    // Static-scan backstop for the render assertions above.
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/dashboard/components/NearbyLevelsCard.tsx"),
      "utf8"
    );
    expect(source).not.toMatch(/from ["']@\/lib\/privacy\/components["']/);
  });
});

describe("NotificationBell's AlertLevelLine renders public level/triggered price unmasked under privacy mode", () => {
  it("shows the level price and triggered price in the clear, with no privacy mask", () => {
    const html = renderToStaticMarkup(
      <AlertLevelLine
        level={{ level_type: "resistance", price: 100, source_author: "J. Analyst" }}
        triggeredPrice={101.25}
      />
    );
    expect(html).toContain("$100.00");
    expect(html).toContain("$101.25");
    expect(html).not.toContain(MASK);
  });

  it("renders nothing when there is no level (guards the @-price line, not the whole row)", () => {
    const html = renderToStaticMarkup(<AlertLevelLine level={null} triggeredPrice={101.25} />);
    expect(html).toBe("");
  });
});

describe("RecentAlertsPanel's AlertPriceRow renders public level/triggered price unmasked under privacy mode", () => {
  it("shows the level price and triggered price in the clear, with no privacy mask", () => {
    const html = renderToStaticMarkup(
      <AlertPriceRow
        level={{
          level_type: "support",
          price: 250.5,
          price_source: "static",
          direction: null,
          source: "newsletter",
          source_author: "K. Writer",
          thesis: null,
        }}
        triggeredPrice={249.75}
      />
    );
    expect(html).toContain("$250.50");
    expect(html).toContain("$249.75");
    expect(html).not.toContain(MASK);
  });
});
