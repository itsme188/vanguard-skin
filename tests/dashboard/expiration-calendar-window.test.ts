import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  EXPIRATION_WINDOW_DAYS,
  splitExpirationWindow,
} from "@/app/dashboard/components/ExpirationCalendar";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// QA findings:
//   analysis-option-expirations--omits-28-of-40-live-contracts-no-window-caption
//   analysis-option-expirations--privacy-masks-public-option-strike

describe("splitExpirationWindow", () => {
  const row = (daysToExpiry: number) => ({ daysToExpiry });

  it("lists contracts inside the window and counts the rest", () => {
    const { within, beyondCount } = splitExpirationWindow([row(0), row(45), row(90), row(91), row(400)]);
    expect(EXPIRATION_WINDOW_DAYS).toBe(90);
    expect(within.map((r) => r.daysToExpiry)).toEqual([0, 45, 90]);
    expect(beyondCount).toBe(2);
  });

  it("listed + beyond = every live contract", () => {
    const all = [row(3), row(17), row(94), row(120), row(500)];
    const { within, beyondCount } = splitExpirationWindow(all);
    expect(within.length + beyondCount).toBe(all.length);
  });

  it("reports everything as beyond when nothing is inside the window", () => {
    expect(splitExpirationWindow([row(94), row(300)])).toEqual({ within: [], beyondCount: 2 });
    expect(splitExpirationWindow([])).toEqual({ within: [], beyondCount: 0 });
  });
});

describe("ExpirationCalendar source pins", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "app/dashboard/components/ExpirationCalendar.tsx"), "utf8");

  it("the populated card captions the window and counts what lies beyond it, masked under privacy", () => {
    const caption = sliceBetween(src, "{/* Window caption:", "</p>");
    expect(caption).toContain("{EXPIRATION_WINDOW_DAYS} days");
    expect(caption).toContain("<Count value={beyondCount} /> more beyond");
  });

  it("asks the API for every live contract so the beyond-count is real", () => {
    anchorIndex(src, "/api/compute/options-expirations?days=${ALL_LIVE_DAYS}");
    anchorIndex(src, "splitExpirationWindow(allOptions)");
  });

  it("no longer calls every contract past 90 days a LEAP", () => {
    expect(src).not.toMatch(/LEAP/);
  });

  it("renders the strike as public market data and still masks the quantity", () => {
    expect(src).not.toMatch(/<Money\b/);
    expect(src).not.toMatch(/import\s*\{[^}]*\bMoney\b[^}]*\}\s*from\s*"@\/lib\/privacy\/components"/);
    anchorIndex(src, "{formatUSDPrecise(o.strike)} {o.optionType[0]}");
    anchorIndex(src, "<Shares value={o.quantity} />");
  });
});
