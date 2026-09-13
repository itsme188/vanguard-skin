/**
 * QA analysis-detected-strategies--privacy-leaves-share-and-contract-counts-unmasked
 *
 * The Detected Strategies card (app/dashboard/components/OptionsStrategies.tsx)
 * renders `s.description` verbatim. `detectStrategies` (lib/compute/options-strategy.ts)
 * composes that string from portfolio-derived share/contract counts — e.g.
 * "Long 300 shares + long 3 Jan 16 $50 puts" (synthetic example; the real
 * strings carry the holder's actual position sizes).
 * Under privacy mode those counts leaked in plain text even though the card's
 * Max Profit / Max Loss figures were already wrapped in <PrivateText>.
 *
 * This repo has no jsdom/RTL harness (tests/dashboard/narrative-block-refresh.test.ts) —
 * pin the fix by reading the source file, same pattern as
 * tests/dashboard/notes-composer-save-failure-copy.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(
  "app/dashboard/components/OptionsStrategies.tsx",
  "utf8"
);

describe("OptionsStrategies privacy masking", () => {
  it("imports PrivateText", () => {
    expect(src).toMatch(
      /import\s*\{\s*PrivateText\s*\}\s*from\s*["']@\/lib\/privacy\/components["']/
    );
  });

  it("wraps the strategy description (share/contract counts) in PrivateText", () => {
    // Allow whitespace/newlines between the tags and the expression.
    expect(src).toMatch(/<PrivateText>\s*\{s\.description\}\s*<\/PrivateText>/);
  });

  it("still masks Max Profit through PrivateText", () => {
    expect(src).toMatch(
      /<PrivateText>\s*\{formatDollar\(s\.maxProfit\)\}\s*<\/PrivateText>/
    );
  });

  it("still masks Max Loss through PrivateText", () => {
    expect(src).toMatch(
      /<PrivateText>\s*\{formatDollar\(s\.maxLoss\)\}\s*<\/PrivateText>/
    );
  });

  it("does not wrap the strategy name — names carry strikes/underlyings, not counts", () => {
    // s.name renders bare (e.g. "Covered Call: AAPL $150 Call") — public
    // market data (symbol, strike), not a portfolio-derived quantity.
    expect(src).toMatch(/<p className="text-sm text-ink mt-0\.5">\{s\.name\}<\/p>/);
  });

  it("leaves breakevens unmasked — public strike-derived values", () => {
    expect(src).toMatch(/\{s\.breakevens\.map/);
    expect(src).not.toMatch(/<PrivateText>\s*\{s\.breakevens/);
  });
});
