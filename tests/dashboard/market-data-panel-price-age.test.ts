import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  priceFreshness,
  changeCaption,
  formatPublicUSD,
  formatPublicPct,
} from "@/app/dashboard/components/MarketDataPanel";
import { anchorIndex } from "../helpers/source-anchor";

// QA findings:
//   security-detail-hero--live-badge-today-change-on-stale-canonical-price-regression-1
//   security-detail-privacy--quotestats-masks-public-data-52w-range-unmasked-below
//   security-detail-hero-mobile--large-magnitude-price-clipped-regression-1
//   security-detail-hero--dollar-sign-wraps-onto-own-line-1280-chatrail
//
// The badge and the change caption are decided from the AGE of the price
// shown (its `prices.date`, a YYYY-MM-DD day) against the ET clock and the
// shared market calendar - never from connection state, and never a literal.
// All instants below are fixed UTC times; October 2026 is EDT (UTC-4).

const ET = (isoUtc: string) => new Date(isoUtc);

// Wed 2026-10-07 is a normal trading day. Sat 2026-10-10 / Sun 2026-10-11 are
// a weekend. Thu 2026-11-26 is a full closure in lib/calendar/market-holidays.
const WED_1040_ET = ET("2026-10-07T14:40:00Z");
const WED_1000_ET = ET("2026-10-07T14:00:00Z");
const WED_0800_ET = ET("2026-10-07T12:00:00Z");
const WED_1700_ET = ET("2026-10-07T21:00:00Z");
const SAT_1100_ET = ET("2026-10-10T15:00:00Z");
const SUN_2330_ET = ET("2026-10-12T03:30:00Z");
const THANKSGIVING_1100_ET = ET("2026-11-26T16:00:00Z");

describe("priceFreshness", () => {
  it("is live for a same-day price while the session is open", () => {
    expect(priceFreshness("2026-10-07", WED_1040_ET)).toBe("live");
  });

  it("is stale for yesterday's close once today's session has opened", () => {
    expect(priceFreshness("2026-10-06", WED_1000_ET)).toBe("stale");
  });

  it("is closed (not stale, not live) for yesterday's close before the open", () => {
    expect(priceFreshness("2026-10-06", WED_0800_ET)).toBe("closed");
  });

  it("is closed for today's price after the close", () => {
    expect(priceFreshness("2026-10-07", WED_1700_ET)).toBe("closed");
  });

  it("is closed for Friday's close on a weekend, by the ET date not the UTC date", () => {
    expect(priceFreshness("2026-10-09", SAT_1100_ET)).toBe("closed");
    // 03:30 UTC Monday is still Sunday night in New York.
    expect(priceFreshness("2026-10-09", SUN_2330_ET)).toBe("closed");
  });

  it("is stale on a weekend when the price predates the last session", () => {
    expect(priceFreshness("2026-10-08", SAT_1100_ET)).toBe("stale");
  });

  it("is closed on a full market holiday for the prior session's close", () => {
    expect(priceFreshness("2026-11-25", THANKSGIVING_1100_ET)).toBe("closed");
  });

  it("is stale for a months-old price (the MTUM repro shape)", () => {
    expect(priceFreshness("2026-06-11", WED_1040_ET)).toBe("stale");
  });

  it("is none when there is no price at all", () => {
    expect(priceFreshness(null, WED_1040_ET)).toBe("none");
  });
});

describe("changeCaption", () => {
  it("says Today only for a same-day price", () => {
    expect(changeCaption("2026-10-07", null, WED_1040_ET)).toBe("Today");
  });

  it("never says Today for an older price", () => {
    expect(changeCaption("2026-10-06", null, WED_1000_ET)).toBe("vs prior close");
    expect(changeCaption("2026-10-09", null, SAT_1100_ET)).toBe("vs prior close");
  });

  it("names the comparison date when the caller supplies it", () => {
    expect(changeCaption("2026-06-11", "2026-06-10", WED_1040_ET)).toBe("vs 2026-06-10");
  });

  it("does not call a multi-session move Today even on a same-day price", () => {
    // Previous stored row is two sessions back: the move spans more than today.
    expect(changeCaption("2026-10-07", "2026-10-05", WED_1040_ET)).toBe("vs 2026-10-05");
    expect(changeCaption("2026-10-07", "2026-10-06", WED_1040_ET)).toBe("Today");
  });

  it("treats Friday as Monday's prior session", () => {
    const MON_1100_ET = ET("2026-10-12T15:00:00Z");
    expect(changeCaption("2026-10-12", "2026-10-09", MON_1100_ET)).toBe("Today");
  });

  it("makes no Today claim before the clock is known (server render)", () => {
    expect(changeCaption("2026-10-07", null, null)).toBe("vs prior close");
    expect(priceFreshness("2026-10-07", null)).toBe("unknown");
  });
});

describe("public market-data formatters", () => {
  it("formats a bare price and a signed change", () => {
    expect(formatPublicUSD(123.456, { bare: true })).toBe("123.46");
    expect(formatPublicUSD(1.5, { signed: true })).toBe("+$1.50");
    expect(formatPublicUSD(-1.5, { signed: true })).toBe("−$1.50");
    expect(formatPublicUSD(-0.001, { signed: true })).toBe("$0.00");
  });

  it("formats a signed percent", () => {
    expect(formatPublicPct(4.621, 2, true)).toBe("+4.62%");
    expect(formatPublicPct(-3.24, 2, true)).toBe("−3.24%");
    expect(formatPublicPct(0.001, 2, true)).toBe("0.00%");
  });
});

describe("MarketDataPanel source pins", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "app/dashboard/components/MarketDataPanel.tsx"),
    "utf8",
  );

  it("renders public market data without the privacy components", () => {
    expect(source).not.toMatch(/@\/lib\/privacy\/components/);
    expect(source).not.toMatch(/<(Money|Pct|Count)\b/);
  });

  it("has no unconditional live badge or Today literal left in the markup", () => {
    expect(source).not.toMatch(/>live<\/span>/);
    expect(source).not.toMatch(/>\s*Today\s*<\/div>/);
    // The pulse is tied to the live state.
    const pulse = anchorIndex(source, 'animation: "pulse 1.6s');
    expect(source.slice(pulse - 200, pulse)).toMatch(/state === "live"/);
  });

  it("keeps the $ prefix and the number on one line", () => {
    const hero = anchorIndex(source, "Hero header: symbol + big price");
    const dollar = anchorIndex(source, "paddingTop: \"0.15em\"", hero);
    expect(source.slice(hero, dollar)).toMatch(/whitespace-nowrap/);
  });

  it("lets the hero type shrink on a phone", () => {
    expect(source).toMatch(/fontSize: "clamp\(1\.75rem, 8vw, 3rem\)"/);
    expect(source).toMatch(/fontSize: "clamp\(2rem, 7vw, 5rem\)"/);
    expect(source).not.toMatch(/clamp\(3rem, 7vw, 5rem\)/);
  });
});
