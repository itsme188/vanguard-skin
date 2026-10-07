/**
 * Trade Reviews view — one counting unit, masked under Hide amounts, inside
 * the page gutter, Eastern timestamps.
 *
 *  - analysis-trade-reviews--picker-trade-count-contradicts-card (owner ruling
 *    2026-08-19, option 2): the month picker and the review card both count
 *    round trips; neither shows a leg count. A saved review whose count no
 *    longer matches the month WARNS on the card; the saved figure stays.
 *  - analysis-trade-reviews--privacy-leaves-trade-count-and-profit-factor-unmasked
 *  - analysis-reviews-mobile--generate-button-escapes-gutter-regression-1 and
 *    mobile-trade-reviews--generate-review-escapes-gutter-regression-1
 *  - analysis-trust-strip--last-classify-drawer-utc-contradicts-chip-regression-1
 *    (the trade-review "Generated:" half)
 *
 * Source-scanned rather than rendered: this repo has no DOM test harness.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  reviewPeriodOptionLabel,
  roundTripNoun,
  savedReviewRoundTripDrift,
} from "@/app/dashboard/components/TradeReviewView";
import { formatEnrichedAtET } from "@/lib/format";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/TradeReviewView.tsx", "utf8");

describe("round-trip unit", () => {
  it("names the unit, singular only for exactly one and never under Hide amounts", () => {
    expect(roundTripNoun(1)).toBe("round trip");
    expect(roundTripNoun(2)).toBe("round trips");
    expect(roundTripNoun(0)).toBe("round trips");
    expect(roundTripNoun(1, true)).toBe("round trips");
  });

  it("the picker shows the round-trip count the review will report", () => {
    expect(
      reviewPeriodOptionLabel("Mar 2026", { tradeCount: 12, reviewableCount: 12 }, { hasReview: true, isPrivate: false })
    ).toBe("Mar 2026 · 12 round trips ✓");
    expect(
      reviewPeriodOptionLabel("Aug 2026", { tradeCount: 1, reviewableCount: 1 }, { hasReview: false, isPrivate: false })
    ).toBe("Aug 2026 · 1 round trip");
  });

  it("a month with closes that lack lot history says so in words, with no leg count", () => {
    const label = reviewPeriodOptionLabel("Jan 2026", { tradeCount: 14, reviewableCount: 12 }, { hasReview: false, isPrivate: false });
    expect(label).toBe("Jan 2026 · 12 round trips (partial history)");
    expect(label).not.toContain("14");
    expect(label).not.toMatch(/reviewable|trades/);
  });

  it("under Hide amounts the picker prints no count at all", () => {
    const label = reviewPeriodOptionLabel("Mar 2026", { tradeCount: 14, reviewableCount: 12 }, { hasReview: true, isPrivate: true });
    expect(label).toBe("Mar 2026 (partial history) ✓");
    expect(label).not.toMatch(/\d+ round|1[24]/);
  });

  it("a saved review reports drift only when the month's count has moved", () => {
    expect(savedReviewRoundTripDrift(9, { reviewableCount: 9 })).toBeNull();
    expect(savedReviewRoundTripDrift(9, { reviewableCount: 14 })).toBe(14);
    expect(savedReviewRoundTripDrift(9, { reviewableCount: 0 })).toBe(0);
    // Month no longer offered (or another account's review): nothing to compare.
    expect(savedReviewRoundTripDrift(9, undefined)).toBeNull();
  });

  it("the picker option is built by the shared label helper, not a hand-rolled count", () => {
    const picker = sliceBetween(src, "{periods.map((p) => {", "</select>");
    expect(picker).toContain("reviewPeriodOptionLabel(");
    expect(picker).toContain("{ hasReview, isPrivate }");
    expect(picker).not.toMatch(/reviewable`|trade\$\{/);
  });

  it("the review card counts round trips through <Count>, and warns on drift without replacing the saved figure", () => {
    const card = sliceBetween(src, "function ReviewCard({", "// ─── Review Detail");
    expect(card).toMatch(/<Count\s+value=\{review\.total_trades\}/);
    expect(card).toContain("{roundTripNoun(review.total_trades, isPrivate)}");
    expect(card).not.toMatch(/\{review\.total_trades\}\s*<\/span>/);
    expect(card).not.toMatch(/trade\{review\.total_trades/);
    const warn = card.slice(anchorIndex(card, "{currentRoundTrips != null && ("));
    expect(warn).toContain("<Count value={review.total_trades} />");
    expect(warn).toContain("<Count value={currentRoundTrips} />");
    expect(warn).toMatch(/Regenerate/);
  });

  it("no surface in the view still says N trades for the review count", () => {
    expect(src).not.toContain("Trades (${groupedTrades.length})");
    expect(src).toMatch(/Round trips \(<Count value=\{groupedTrades\.length\} \/>\)/);
    expect(src).toMatch(/<Count value=\{data\.data\.tradeCount\} \/> round trip\(s\)/);
  });
});

describe("privacy", () => {
  it("profit factor renders inside <PrivateText> on the card and in the summary strip", () => {
    const uses = src.split("formatProfitFactor(review.profit_factor)").length - 1;
    expect(uses).toBe(2);
    const masked = src.match(/<PrivateText[^>]*>\s*\{formatProfitFactor\(review\.profit_factor\)\}\s*<\/PrivateText>/g) ?? [];
    expect(masked).toHaveLength(2);
  });

  it("the unreviewed-months count goes through <Count>", () => {
    const block = sliceBetween(src, "{/* ── Unreviewed prompt", "{/* ── Reviews list");
    expect(block).toContain("<Count value={unreviewedPeriods.length} />");
    expect(block).not.toMatch(/\{unreviewedPeriods\.length\}\s+month/);
  });
});

describe("page gutter at phone width", () => {
  it("the Month row wraps and the select can shrink, so the button stays inside the gutter", () => {
    const row = sliceBetween(src, "Wraps: at phone width", "{/* ── Progress message");
    expect(row).toMatch(/className="flex flex-wrap items-center gap-3 flex-1 min-w-0"/);
    const select = row.slice(anchorIndex(row, "<select"), anchorIndex(row, "{periods.length === 0"));
    expect(select).toContain("max-w-full");
    expect(select).toContain("sm:min-w-[160px]");
    expect(select).not.toMatch(/(?<![:\w-])min-w-\[160px\]/);
  });
});

describe("Generated stamp", () => {
  it("is formatted as Eastern time with a zone label", () => {
    expect(src).toContain("Generated: {formatEnrichedAtET(review.generated_at)}");
    expect(src).not.toContain("Generated: {review.generated_at}");
    // 07:59 UTC on a September date is 3:59 AM Eastern (daylight time).
    const shown = formatEnrichedAtET("2026-09-13 07:59:41");
    expect(shown).toMatch(/3:59\s?AM ET$/);
    expect(shown).not.toContain("07:59");
  });
});
