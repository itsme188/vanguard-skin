/**
 * Ledger finding
 * alerts-inbox--ma-alert-card-shows-stale-creation-price-and-ai-repeats-it-regression-1
 * — card half.
 *
 * SOURCE SCAN, not a render test: this repo has no jsdom/RTL harness, so the
 * card is pinned by reading app/dashboard/alerts/page.tsx and asserting on the
 * expression it uses. The behavioural coverage lives in
 * tests/queries/alerts-threshold-fallback.test.ts (the data the card is handed)
 * and tests/alerts/ma-alert-threshold-at-fire-time.test.ts (what gets recorded).
 *
 * What must hold:
 *   1. The threshold the card shows comes from the fallback chain
 *      `alert.threshold_price ?? level.effective_price ?? level.price`, not
 *      from `alert.level.price` directly.
 *   2. When the rendered number is the LIVE value rather than the one recorded
 *      at the cross, the card says so — an undisclosed live figure next to a
 *      fired alert reads as the fire-time threshold, which is the bug.
 *   3. The existing "[SMA 50]"-style source chip survives.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ALERTS_PAGE = "app/dashboard/alerts/page.tsx";

const src = fs.readFileSync(path.join(process.cwd(), ALERTS_PAGE), "utf8");

describe("alerts page — the alert card renders the fire-time threshold", () => {
  it("derives the threshold from the documented fallback chain", () => {
    expect(src).toContain(
      "alert.threshold_price ?? level.effective_price ?? level.price",
    );
  });

  it("no longer renders the level's creation snapshot as the threshold", () => {
    expect(src).not.toMatch(/formatUSDPrecise\(\s*alert\.level\.price\s*\)/);
  });

  it("captions the number when it is the live value, not the recorded one", () => {
    expect(src).toMatch(/fire-time threshold not recorded/);
    // Both live-fallback shapes are distinguished: today's MA, and (when the
    // MA cannot be resolved at all) the stored creation price.
    expect(src).toMatch(/current MA/);
    expect(src).toMatch(/at creation/);
  });

  it("keeps the MA source chip on the card", () => {
    expect(src).toMatch(/formatPriceSourceLabel\(alert\.level\.price_source\)/);
  });

  it("reuses the page's existing money helper for the threshold", () => {
    expect(src).toMatch(/formatUSDPrecise\(\s*threshold\.value\s*\)/);
  });
});
