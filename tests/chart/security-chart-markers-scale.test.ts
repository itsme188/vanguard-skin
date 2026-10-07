import { describe, it, expect } from "vitest";
import {
  chartAxisPriceLabel,
  chartEmptyStateMessage,
  chartFooterStalenessText,
  dedupeSuggestedLevels,
  extendPriceRangeToInclude,
  hiddenTradesReason,
  indicatorUnavailableReason,
  markerEdgePaddingBars,
  markerText,
  placeTransactionMarkers,
} from "@/app/dashboard/components/SecurityChart";
import { formatUSDPrecise } from "@/lib/format";

// Synthetic daily bars: two full weeks, with Monday 2026-01-19 missing (a
// market holiday), then a three-week hole in the cache, then one more week.
const BARS = [
  "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", // Mon-Fri
  "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15", "2026-01-16", // Mon-Fri
  "2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23", //               Tue-Fri
  "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", // after the hole
];
const txn = (date: string, type = "BUY", quantity: number | null = 10) => ({
  date,
  type,
  quantity,
  price: null,
});

describe("placeTransactionMarkers (qa: charts-txn-markers--post-last-bar-markers-stack-right-edge)", () => {
  it("draws a Friday trade on its own Friday bar", () => {
    const r = placeTransactionMarkers([txn("2026-01-09")], BARS);
    expect(r.placed).toEqual([
      { txn: txn("2026-01-09"), barDate: "2026-01-09", snapped: false },
    ]);
  });

  it("draws a weekend-dated row on the previous Friday bar, flagged, never on Monday", () => {
    const r = placeTransactionMarkers([txn("2026-01-10"), txn("2026-01-11")], BARS);
    expect(r.placed.map((p) => [p.barDate, p.snapped])).toEqual([
      ["2026-01-09", true],
      ["2026-01-09", true],
    ]);
    expect(r.hiddenNoBar).toBe(0);
  });

  it("draws a holiday-dated trade on the previous trading day's bar", () => {
    const r = placeTransactionMarkers([txn("2026-01-19")], BARS);
    expect(r.placed.map((p) => [p.barDate, p.snapped])).toEqual([["2026-01-16", true]]);
  });

  it("does not draw a trade inside a hole in the cache; counts it", () => {
    const r = placeTransactionMarkers([txn("2026-02-03")], BARS);
    expect(r.placed).toEqual([]);
    expect(r.hiddenNoBar).toBe(1);
  });

  it("never pins a trade dated after the last bar onto that bar; counts it", () => {
    const r = placeTransactionMarkers(
      [txn("2026-02-20"), txn("2026-02-21"), txn("2026-02-23"), txn("2026-06-30", "SELL")],
      BARS,
    );
    expect(r.placed.map((p) => p.barDate)).toEqual(["2026-02-20"]);
    expect(r.hiddenAfterLastBar).toBe(3);
  });

  it("does not draw a trade older than the first bar; counts it", () => {
    const r = placeTransactionMarkers([txn("2025-12-31"), txn("2026-01-05")], BARS);
    expect(r.placed.map((p) => p.barDate)).toEqual(["2026-01-05"]);
    expect(r.hiddenBeforeFirstBar).toBe(1);
  });

  it("draws nothing and counts nothing when there are no bars", () => {
    expect(placeTransactionMarkers([txn("2026-01-09")], [])).toEqual({
      placed: [],
      hiddenBeforeFirstBar: 0,
      hiddenAfterLastBar: 0,
      hiddenNoBar: 0,
    });
  });

  it("gives the same answer whatever the process timezone (pure date strings)", () => {
    const before = process.env.TZ;
    try {
      for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York"]) {
        process.env.TZ = tz;
        const r = placeTransactionMarkers([txn("2026-01-11"), txn("2026-01-19")], BARS);
        expect(r.placed.map((p) => p.barDate)).toEqual(["2026-01-09", "2026-01-16"]);
      }
    } finally {
      process.env.TZ = before;
    }
  });
});

describe("markerText", () => {
  it("shows the share count, and drops it in privacy mode", () => {
    expect(markerText(txn("2026-01-09", "SELL_TO_CLOSE", 3), false)).toBe("SELL TO CLOSE 3");
    expect(markerText(txn("2026-01-09", "SELL_TO_CLOSE", 3), true)).toBe("SELL TO CLOSE");
  });

  it("carries the real trade date when drawn on another day's bar", () => {
    expect(markerText(txn("2026-01-10"), false, true)).toBe("BUY 10 · 01-10");
    expect(markerText(txn("2026-01-10"), true, true)).toBe("BUY · 01-10");
  });
});

describe("hiddenTradesReason", () => {
  it("names why trades are missing, or null when none are", () => {
    expect(hiddenTradesReason({ hiddenAfterLastBar: 0, hiddenNoBar: 0 })).toBeNull();
    expect(hiddenTradesReason({ hiddenAfterLastBar: 2, hiddenNoBar: 0 })).toBe(
      "dated after the last bar",
    );
    expect(hiddenTradesReason({ hiddenAfterLastBar: 0, hiddenNoBar: 1 })).toBe(
      "dated on days with no bar",
    );
    expect(hiddenTradesReason({ hiddenAfterLastBar: 2, hiddenNoBar: 1 })).toBe(
      "dated after the last bar or on days with no bar",
    );
  });
});

describe("chartAxisPriceLabel", () => {
  it("rounds a half-cent close the way the header does (qa: charts-header--half-cent-price-rounds-differently-from-chart-badge)", () => {
    // (418.215).toFixed(2) is "418.21" — the binary float sits under the half.
    expect(chartAxisPriceLabel("USD", 418.215)).toBe("$418.22");
    expect(chartAxisPriceLabel(null, 418.215)).toBe(formatUSDPrecise(418.215));
    expect(chartAxisPriceLabel("USD", 67.175)).toBe("$67.18");
  });

  it("keeps the chart's no-grouping USD style", () => {
    expect(chartAxisPriceLabel("USD", 1234.5)).toBe("$1234.50");
    expect(chartAxisPriceLabel("", 0)).toBe("$0.00");
  });

  it("prints no label for a sub-zero tick (qa: charts-price-axis--negative-dollar-ticks-*)", () => {
    expect(chartAxisPriceLabel("USD", -100)).toBe("");
    expect(chartAxisPriceLabel("KRW", -250000)).toBe("");
    expect(chartAxisPriceLabel("USD", Number.NaN)).toBe("");
  });

  it("labels a non-USD price in its own currency", () => {
    expect(chartAxisPriceLabel("KRW", 976000)).toMatch(/976,000/);
    expect(chartAxisPriceLabel("KRW", 976000)).not.toMatch(/\$/);
  });
});

describe("dedupeSuggestedLevels (qa: security-detail-chart--accepted-suggestion-duplicate-line-label-regression-1)", () => {
  const sug = (price: number, type = "support") => ({ price, type });

  it("drops a suggestion an active static level already shows", () => {
    const out = dedupeSuggestedLevels(
      [sug(100), sug(120, "resistance")],
      [{ price: 100, isStatic: true }],
      "USD",
    );
    expect(out).toEqual([sug(120, "resistance")]);
  });

  it("uses the Levels panel's tolerance: the larger of 0.5% or 0.25", () => {
    const active = [{ price: 200, isStatic: true }];
    expect(dedupeSuggestedLevels([sug(200.9)], active, "USD")).toEqual([]);
    expect(dedupeSuggestedLevels([sug(201.5)], active, "USD")).toEqual([sug(201.5)]);
    // Low-priced: the 0.25 floor applies.
    expect(dedupeSuggestedLevels([sug(4.2)], [{ price: 4, isStatic: true }], "USD")).toEqual([]);
  });

  it("applies the tolerance to static levels only, but never repeats an identical label", () => {
    const moving = [{ price: 200, isStatic: false }];
    expect(dedupeSuggestedLevels([sug(200.9)], moving, "USD")).toEqual([sug(200.9)]);
    expect(dedupeSuggestedLevels([sug(200.004)], moving, "USD")).toEqual([]);
  });

  it("keeps every suggestion when there are no active levels", () => {
    expect(dedupeSuggestedLevels([sug(1), sug(2)], [], null)).toEqual([sug(1), sug(2)]);
  });
});

describe("extendPriceRangeToInclude (qa: charts-short-ranges--last-price-line-dropped-while-header-shows-price)", () => {
  it("widens the range to a price above or below it", () => {
    expect(extendPriceRangeToInclude({ minValue: 90, maxValue: 100 }, 110)).toEqual({
      minValue: 90,
      maxValue: 110,
    });
    expect(extendPriceRangeToInclude({ minValue: 90, maxValue: 100 }, 80)).toEqual({
      minValue: 80,
      maxValue: 100,
    });
  });

  it("leaves the range alone for an inside price or no price", () => {
    const r = { minValue: 90, maxValue: 100 };
    expect(extendPriceRangeToInclude(r, 95)).toEqual(r);
    expect(extendPriceRangeToInclude(r, null)).toBe(r);
    expect(extendPriceRangeToInclude(r, Number.NaN)).toBe(r);
  });
});

describe("indicatorUnavailableReason (qa: charts-indicators--sma-200-toggle-active-on-short-history-draws-nothing-no-reason)", () => {
  it("says how many bars the average needs and how many are loaded", () => {
    expect(
      indicatorUnavailableReason({ label: "SMA 200", period: 200, loadedBars: 120 }),
    ).toBe("SMA 200 needs 200 daily bars — 120 loaded.");
  });

  it("is null once enough bars are loaded", () => {
    expect(indicatorUnavailableReason({ label: "SMA 200", period: 200, loadedBars: 200 })).toBeNull();
    expect(indicatorUnavailableReason({ label: "EMA 9", period: 9, loadedBars: 120 })).toBeNull();
  });
});

describe("intraday empty state (qa: charts-intraday--empty-state-copy-denies-cached-daily-bars, security-detail-chart-intraday--false-no-cached-history-claim)", () => {
  it("never claims there is no cached history while daily bars are cached", () => {
    const msg = chartEmptyStateMessage({
      visibleBarCount: 0,
      lastBarDate: null,
      rangeLabel: "1 year",
      symbol: "AAA",
      intradayLabel: "5m",
      dailyLastBarDate: "2026-01-23",
    });
    expect(msg).toBe(
      "No 5m intraday bars for AAA — intraday needs a live TWS connection. Daily bars are cached through 2026-01-23.",
    );
    expect(msg).not.toMatch(/No cached price history/);
  });

  it("says only that intraday bars are missing when there is no daily cache either", () => {
    expect(
      chartEmptyStateMessage({
        visibleBarCount: 0,
        lastBarDate: null,
        rangeLabel: "1 year",
        symbol: "AAA",
        intradayLabel: "1m",
      }),
    ).toBe("No 1m intraday bars for AAA — intraday needs a live TWS connection.");
  });

  it("keeps the footer honest about the daily cache", () => {
    expect(
      chartFooterStalenessText({
        barCount: 0,
        lastDate: null,
        intraday: true,
        dailyLastBarDate: "2026-01-23",
      }),
    ).toBe("No intraday bars · daily bars cached through 2026-01-23");
    expect(chartFooterStalenessText({ barCount: 0, lastDate: null, intraday: true })).toBe(
      "No intraday bars",
    );
    // Intraday WITH bars is unchanged.
    expect(chartFooterStalenessText({ barCount: 78, lastDate: null, intraday: true })).toBe(
      "78 bars",
    );
  });
});

describe("markerEdgePaddingBars (qa: charts-txn-markers--first-visible-bar-trade-label-clipped-at-left-plot-edge)", () => {
  it("needs no room when no edge bar carries a label", () => {
    expect(
      markerEdgePaddingBars({ plotWidth: 800, barCount: 60, firstBarLabelChars: 0, lastBarLabelChars: 0 }),
    ).toEqual({ left: 0, right: 0 });
  });

  it("leaves at least half a label of room left of a labelled first bar", () => {
    const chars = 8; // e.g. "SELL 300"
    const args = { plotWidth: 800, barCount: 120, firstBarLabelChars: chars, lastBarLabelChars: 0 };
    const pad = markerEdgePaddingBars(args);
    expect(pad.right).toBe(0);
    expect(pad.left).toBeGreaterThan(0);
    const spacing = args.plotWidth / (args.barCount + pad.left + pad.right);
    const roomPx = (0.5 + pad.left) * spacing;
    expect(roomPx).toBeGreaterThanOrEqual((chars * 6.6) / 2 + 4 - 0.5);
  });

  it("needs no room when the bars are already wider than the label", () => {
    expect(
      markerEdgePaddingBars({ plotWidth: 900, barCount: 3, firstBarLabelChars: 8, lastBarLabelChars: 8 }),
    ).toEqual({ left: 0, right: 0 });
  });

  it("is safe before the chart has a width", () => {
    expect(
      markerEdgePaddingBars({ plotWidth: 0, barCount: 60, firstBarLabelChars: 8, lastBarLabelChars: 8 }),
    ).toEqual({ left: 0, right: 0 });
  });
});
