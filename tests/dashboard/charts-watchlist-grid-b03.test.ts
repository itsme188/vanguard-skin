/**
 * Charts page and Watchlist grid (QA unit B03). No DOM harness in this repo:
 * pure helpers are tested directly, wiring is source-pinned.
 *
 *  - charts-watchlist--seeds-alphabetical-not-watchlist-duplicates-symbol-regression-1
 *  - charts-watchlist-mode--ignores-watchlist-seeds-alphabetically-regression-1
 *  - charts--unknown-id-falls-back-to-default-security-silently-unpriced-option-full-chart-opens-spy
 *  - charts-header--usd-converted-price-beside-native-krw-chart-badge-unlabelled
 *  - mobile-charts-2x2--tile-header-overflows-name-paints-as-nothing
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import {
  seedWatchlistPanels,
  emptyPanelCopy,
} from "@/app/dashboard/components/MultiChart";
import {
  chartHeaderPrice,
  unavailableChartCopy,
} from "@/app/dashboard/components/ChartsView";

const pageSrc = () => readFileSync("app/dashboard/charts/page.tsx", "utf8");
const viewSrc = () =>
  readFileSync("app/dashboard/components/ChartsView.tsx", "utf8");
const multiSrc = () =>
  readFileSync("app/dashboard/components/MultiChart.tsx", "utf8");

describe("seedWatchlistPanels", () => {
  const chartable = [1, 2, 3, 4, 5, 6, 7];

  it("starts from the initial security, then the watchlist in watchlist order", () => {
    expect(seedWatchlistPanels(5, [7, 3], chartable)).toEqual([5, 7, 3, null]);
  });

  it("never seeds the same security twice (the initial one is on the watchlist)", () => {
    expect(seedWatchlistPanels(3, [7, 3, 2], chartable)).toEqual([3, 7, 2, null]);
    expect(seedWatchlistPanels(null, [7, 7, 2], chartable)).toEqual([
      7,
      2,
      null,
      null,
    ]);
  });

  it("leaves leftover panels empty — no alphabetical filler", () => {
    expect(seedWatchlistPanels(1, [], chartable)).toEqual([1, null, null, null]);
    expect(seedWatchlistPanels(null, [], chartable)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("skips a watchlist name that is not chartable (no panel could render it)", () => {
    expect(seedWatchlistPanels(null, [99, 2], chartable)).toEqual([
      2,
      null,
      null,
      null,
    ]);
  });

  it("caps at the panel count", () => {
    expect(seedWatchlistPanels(1, [2, 3, 4, 5, 6], chartable)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

describe("emptyPanelCopy", () => {
  it("names the empty watchlist", () => {
    expect(emptyPanelCopy(0)).toMatch(/watchlist is empty/i);
  });
  it("says the watchlist has run out when it has names", () => {
    expect(emptyPanelCopy(2)).toMatch(/no more watchlist names/i);
  });
});

describe("Watchlist mode reads the watchlist (wiring)", () => {
  it("page.tsx reads the active watchlist and passes the ids to ChartsView", () => {
    const src = pageSrc();
    expect(src).toContain("getActiveWatchlistSecurityIds(db)");
    expect(src).toMatch(/<ChartsView[\s\S]*?watchlistSecurityIds=\{watchlistSecurityIds\}/);
  });

  it("ChartsView hands them to MultiChart", () => {
    const src = viewSrc();
    const multi = src.slice(anchorIndex(src, "<MultiChart"));
    expect(multi).toContain("watchlistIds={watchlistSecurityIds}");
  });

  it("MultiChart seeds through the helper and no longer indexes an alphabetical slice", () => {
    const src = multiSrc();
    expect(src).toContain("seedWatchlistPanels(");
    expect(src).not.toMatch(/stocks\[i\]/);
    expect(src).not.toMatch(/securities\[i\]/);
  });

  it("an empty panel's picker has a placeholder option, so choosing the first security fires a change", () => {
    const src = multiSrc();
    const select = sliceBetween(src, "<select", "</select>");
    expect(select).toContain('<option value="" disabled>');
  });
});

describe("2x2 tile header fits its tile", () => {
  it("the header, the picker and the name can all shrink; the name carries a title", () => {
    const src = multiSrc();
    const header = sliceBetween(src, "{/* Per-panel security picker */}", "{/* Chart */}");
    const selectAt = anchorIndex(header, "<select");
    const headerDiv = header.slice(anchorIndex(header, "<div"), selectAt);
    expect(headerDiv).toContain("min-w-0");
    const selectClass = header.slice(
      anchorIndex(header, "className=", selectAt),
      anchorIndex(header, "{securities.map"),
    );
    expect(selectClass).toContain("min-w-0");
    expect(selectClass).toMatch(/max-w-\[/);
    const name = header.slice(anchorIndex(header, "<span"));
    expect(name).toContain("min-w-0");
    expect(name).toContain("truncate");
    expect(header).toContain("title={sec.name");
  });
});

describe("chartHeaderPrice", () => {
  it("a USD (or currency-less) security shows one dollar figure", () => {
    expect(chartHeaderPrice(123.456, 123.456, "USD")).toEqual({
      primary: "$123.46",
      native: null,
    });
    expect(chartHeaderPrice(50, 50, null)).toEqual({
      primary: "$50.00",
      native: null,
    });
  });

  it("a foreign security shows the converted figure AND the native one with its currency code", () => {
    const out = chartHeaderPrice(700, 1_000_000, "KRW");
    expect(out.primary).toBe("$700.00");
    expect(out.native).toMatch(/1,000,000/);
    expect(out.native).toMatch(/ KRW$/);
  });

  it("a foreign security with no native row falls back to the converted figure alone", () => {
    expect(chartHeaderPrice(700, null, "KRW")).toEqual({
      primary: "$700.00",
      native: null,
    });
  });

  it("a foreign security with no usable rate (converted equals native) shows the native figure only, never a dollar sign on a native magnitude", () => {
    const out = chartHeaderPrice(30_000, 30_000, "jpy");
    expect(out.native).toBeNull();
    expect(out.primary).toMatch(/30,000/);
    expect(out.primary).toMatch(/ JPY$/);
    expect(out.primary.startsWith("$")).toBe(false);
  });
});

describe("charts header price (wiring)", () => {
  it("the header is public market data: plain formatters, no privacy wrapper", () => {
    const src = viewSrc();
    expect(src).not.toContain("<Money");
    const header = src.slice(anchorIndex(src, "{/* Price info (single mode only) */}"));
    expect(header).toContain("headerPrice.primary");
    expect(header).toContain("headerPrice.native");
  });

  it("page.tsx reads the native close beside the converted one", () => {
    const src = pageSrc();
    expect(src).toContain("getLatestPriceNative(db, initialSecurity.id)");
    expect(src).toMatch(/<ChartsView[\s\S]*?initialPriceNative=\{/);
  });
});

describe("unavailableChartCopy", () => {
  it("names a security that has no contract id", () => {
    const copy = unavailableChartCopy({
      securityId: 9,
      symbol: "ZZZ",
      reason: "no_contract",
    });
    expect(copy.title).toContain("ZZZ");
    expect(copy.reason).toMatch(/contract/i);
    expect(copy.hubHref).toBe("/dashboard/security/9");
  });

  it("names a mutual fund as such", () => {
    const copy = unavailableChartCopy({
      securityId: 9,
      symbol: "AAAFX",
      reason: "mutual_fund",
    });
    expect(copy.title).toContain("AAAFX");
    expect(copy.reason).toMatch(/mutual fund/i);
    expect(copy.hubHref).toBe("/dashboard/security/9");
  });

  it("an id that matches nothing gets no hub link", () => {
    const copy = unavailableChartCopy({
      securityId: null,
      symbol: null,
      reason: "not_found",
    });
    expect(copy.hubHref).toBeNull();
    expect(copy.reason).toMatch(/pick a security/i);
  });
});

describe("an ?id= the page cannot chart is said, not swapped (wiring)", () => {
  it("page.tsx looks the security up by id and passes an unavailable request", () => {
    const src = pageSrc();
    expect(src).toContain("getSecurityById(db, request.id)");
    expect(src).toMatch(/<ChartsView[\s\S]*?unavailableRequest=\{unavailableRequest\}/);
  });

  it("ChartsView starts with nothing selected and renders an EmptySection instead of the default chart", () => {
    const src = viewSrc();
    expect(src).toContain("unavailableRequest ? null : initialSecurity");
    expect(src).toContain("<EmptySection");
    expect(src).toContain("unavailableChartCopy(unavailableRequest)");
  });

  it("the single-mode picker has a placeholder while nothing is selected", () => {
    const src = viewSrc();
    const select = sliceBetween(src, "<select", "</select>");
    expect(select).toContain('<option value="" disabled>');
  });
});
