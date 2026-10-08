/**
 * C02 (Charts) — owner-delegated decisions, 2026-10-07:
 *  - charts-txn-markers--same-date-trades-overprint-quantity-labels (option 1)
 *  - charts-price-axis--level-badges-collide-ticks-unreadable-regression-1 (option 1)
 *  - charts-symbol-picker--lists-expired-option-contracts-promising-bars-after-tws-connect (option 1)
 *
 * No DOM harness: pure functions are tested directly, wiring is source-pinned.
 * All symbols and quantities are synthetic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import {
  groupPlacedMarkers,
  groupedMarkerText,
  markerFillsText,
  markerText,
  placeTransactionMarkers,
} from "@/app/dashboard/components/SecurityChart";
import { unavailableChartCopy } from "@/app/dashboard/components/ChartsView";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const chartSrc = read("app/dashboard/components/SecurityChart.tsx");
const pageSrc = read("app/dashboard/charts/page.tsx");

const BARS = ["2026-01-08", "2026-01-09", "2026-01-12", "2026-01-13"];
const txn = (date: string, type = "BUY", quantity: number | null = 10) => ({
  date,
  type,
  quantity,
  price: null,
});
const groupsFor = (txns: ReturnType<typeof txn>[]) =>
  groupPlacedMarkers(placeTransactionMarkers(txns, BARS).placed);

describe("groupPlacedMarkers — one marker per (trade date, type)", () => {
  it("merges two same-type fills on one date and keeps their order", () => {
    const g = groupsFor([txn("2026-01-09", "SELL", 50), txn("2026-01-09", "SELL", 100)]);
    expect(g).toHaveLength(1);
    expect(g[0].barDate).toBe("2026-01-09");
    expect(g[0].fills.map((f) => f.quantity)).toEqual([50, 100]);
  });

  it("keeps a buy and a sell on one date apart", () => {
    const g = groupsFor([txn("2026-01-09", "BUY", 5), txn("2026-01-09", "SELL", 5)]);
    expect(g.map((x) => x.fills[0].type)).toEqual(["BUY", "SELL"]);
  });

  it("keeps same-type trades on adjacent bars as separate markers", () => {
    const g = groupsFor([txn("2026-01-08", "BUY", 5), txn("2026-01-09", "BUY", 5)]);
    expect(g.map((x) => x.barDate)).toEqual(["2026-01-08", "2026-01-09"]);
  });

  it("never merges a weekend-dated row into the real Friday trade it is drawn beside", () => {
    const g = groupsFor([txn("2026-01-09", "BUY", 5), txn("2026-01-10", "BUY", 7)]);
    expect(g.map((x) => [x.barDate, x.snapped, x.fills.length])).toEqual([
      ["2026-01-09", false, 1],
      ["2026-01-09", true, 1],
    ]);
  });

  it("conserves the trades: every placed fill is in exactly one group", () => {
    const txns = [
      txn("2026-01-08", "BUY", 1),
      txn("2026-01-09", "SELL", 2),
      txn("2026-01-09", "SELL", 3),
      txn("2026-01-09", "SELL", 4),
      txn("2026-01-12", "BUY", 5),
    ];
    const g = groupsFor(txns);
    expect(g.reduce((n, x) => n + x.fills.length, 0)).toBe(txns.length);
    expect(g.map((x) => x.fills.length)).toEqual([1, 3, 1]);
  });
});

describe("groupedMarkerText", () => {
  it("a single fill reads exactly as before", () => {
    const [g] = groupsFor([txn("2026-01-09", "SELL_TO_CLOSE", 3)]);
    expect(groupedMarkerText(g, false)).toBe(markerText(g.fills[0], false));
    expect(groupedMarkerText(g, true)).toBe("SELL TO CLOSE");
  });

  it("several fills read as the summed quantity and the fill count", () => {
    const [g] = groupsFor([txn("2026-01-09", "SELL", 50), txn("2026-01-09", "SELL", 100)]);
    expect(groupedMarkerText(g, false)).toBe("SELL 150 ×2");
  });

  it("sums fractional shares without float noise", () => {
    const [g] = groupsFor([txn("2026-01-09", "BUY", 0.1), txn("2026-01-09", "BUY", 0.2)]);
    expect(groupedMarkerText(g, false)).toBe("BUY 0.3 ×2");
  });

  it("leaves the sum out when a fill has no quantity, rather than understating it", () => {
    const [g] = groupsFor([txn("2026-01-09", "BUY", 10), txn("2026-01-09", "BUY", null)]);
    expect(groupedMarkerText(g, false)).toBe("BUY ×2");
  });

  it("privacy mode drops the quantity AND the fill count", () => {
    const [g] = groupsFor([txn("2026-01-09", "SELL", 50), txn("2026-01-09", "SELL", 100)]);
    expect(groupedMarkerText(g, true)).toBe("SELL");
  });

  it("a snapped group keeps its real trade date", () => {
    const [g] = groupsFor([txn("2026-01-10", "BUY", 4), txn("2026-01-10", "BUY", 6)]);
    expect(groupedMarkerText(g, false)).toBe("BUY 10 ×2 · 01-10");
    expect(groupedMarkerText(g, true)).toBe("BUY · 01-10");
  });
});

describe("markerFillsText — the split behind a summed marker", () => {
  it("lists the fills of an aggregated marker", () => {
    const g = groupsFor([txn("2026-01-09", "SELL", 50), txn("2026-01-09", "SELL", 100)]);
    expect(markerFillsText(g, false)).toBe("SELL 50 + 100");
  });

  it("is null for single-fill markers, a missing quantity, and privacy mode", () => {
    expect(markerFillsText(groupsFor([txn("2026-01-09", "SELL", 50)]), false)).toBeNull();
    expect(
      markerFillsText(groupsFor([txn("2026-01-09", "BUY", 1), txn("2026-01-09", "BUY", null)]), false),
    ).toBeNull();
    expect(
      markerFillsText(groupsFor([txn("2026-01-09", "SELL", 50), txn("2026-01-09", "SELL", 100)]), true),
    ).toBeNull();
  });
});

describe("marker wiring (source pins)", () => {
  const fn = chartSrc.slice(anchorIndex(chartSrc, "function updateMarkers("));

  it("draws one marker per group, not per trade", () => {
    expect(fn).toContain("groupPlacedMarkers(placement.placed)");
    expect(fn).toContain("groups.map((group) => {");
    expect(fn).not.toContain("placement.placed.map(");
    expect(fn).toContain("groupedMarkerText(group, privateMode)");
  });

  it("the hover readout shows the fills only outside privacy mode", () => {
    expect(fn).toContain("markerFillsText(onBar, privateMode)");
    expect(chartSrc).toContain("{!isPrivate && legend.fills && (");
  });
});

describe("level lines carry no axis pill (qa: charts-price-axis--level-badges-collide-ticks-unreadable-regression-1)", () => {
  it("active level lines are drawn without an axis label", () => {
    const active = sliceBetween(chartSrc, "for (const lvl of json.levels) {", "priceLinesRef.current.push(line);");
    expect(active).toContain("createPriceLine(");
    expect(active).toContain("axisLabelVisible: false");
    expect(active).not.toContain("axisLabelVisible: true");
  });

  it("suggested S/R lines are drawn without an axis label", () => {
    const suggested = sliceBetween(chartSrc, "const draw = () => {", "redrawSuggestedRef.current = draw;");
    expect(suggested).toContain("createPriceLine(");
    expect(suggested).toContain("axisLabelVisible: false");
    expect(suggested).not.toContain("axisLabelVisible: true");
  });

  it("the last-price line keeps its pill", () => {
    const last = sliceBetween(chartSrc, "lastPriceLineRef.current = series.createPriceLine({", "});");
    expect(last).toContain("axisLabelVisible: true");
  });
});

describe("expired option contracts and the Charts picker (qa: charts-symbol-picker--lists-expired-option-contracts-promising-bars-after-tws-connect)", () => {
  it("page.tsx filters the chartable list through the shared expiry helper, options only", () => {
    expect(pageSrc).toContain('import { isOptionLive } from "@/lib/compute/option-expiry";');
    const pred = sliceBetween(pageSrc, "const isExpiredOption =", "const securities =");
    expect(pred).toContain('s.security_type?.toLowerCase() === "option"');
    expect(pred).toContain("!isOptionLive(getSecurityById(db, s.id)?.expiration_date)");
    const list = sliceBetween(pageSrc, "const securities =", ";");
    expect(list).toContain("getChartableSecurities(db).filter(");
    expect(list).toContain("!isExpiredOption(s)");
    // No hand-rolled date compare.
    expect(pageSrc).not.toMatch(/expiration_date\s*[<>]/);
  });

  it("a direct link to an expired contract is classified as such, after the no-contract check", () => {
    const reason = sliceBetween(pageSrc, "unavailableRequest = asked", ": { securityId: null");
    expect(anchorIndex(reason, '"no_contract"')).toBeLessThan(anchorIndex(reason, "isExpiredOption(asked)"));
    expect(anchorIndex(reason, "isExpiredOption(asked)")).toBeLessThan(anchorIndex(reason, '"mutual_fund"'));
  });

  it("the copy says no history is available, and never promises bars after a TWS connect", () => {
    const copy = unavailableChartCopy({
      securityId: 9,
      symbol: "AAA 260116C00100000",
      reason: "expired_option",
    });
    expect(copy.title).toContain("AAA 260116C00100000");
    expect(copy.reason).toMatch(/expired option contract/);
    expect(copy.reason).toMatch(/no price history is available for an expired contract/);
    expect(copy.reason).not.toMatch(/TWS|connect/i);
    expect(copy.hubHref).toBe("/dashboard/security/9");
  });
});
