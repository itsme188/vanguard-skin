import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { priceAsOfLabel, priceIsFromEarlierDay } from "@/lib/alerts/price-as-of-label";

/**
 * QA finding: the alerts inbox labelled Thursday's close "Now" on a Sunday
 * with no date anywhere on the row, while the hub for the same symbol said
 * "STALE · AS OF <date>". A price that is not today's is dated.
 */
describe("priceAsOfLabel", () => {
  it("says Now for a close dated today", () => {
    expect(priceAsOfLabel("2026-11-05", "2026-11-05")).toBe("Now");
  });
  it("dates a close from an earlier day", () => {
    expect(priceAsOfLabel("2026-11-05", "2026-11-08")).toBe("2026-11-05 close");
    expect(priceIsFromEarlierDay("2026-11-05", "2026-11-08")).toBe(true);
  });
  it("falls back to Now when the date is unknown", () => {
    expect(priceAsOfLabel(null, "2026-11-08")).toBe("Now");
    expect(priceAsOfLabel(undefined, "2026-11-08")).toBe("Now");
    expect(priceIsFromEarlierDay(null, "2026-11-08")).toBe(false);
  });
});

describe("alerts page reads the one label", () => {
  const src = readFileSync("app/dashboard/alerts/page.tsx", "utf8");
  it("imports priceAsOfLabel and no longer hardcodes a bare Now label", () => {
    expect(src).toMatch(/import \{[^}]*priceAsOfLabel[^}]*\} from "@\/lib\/alerts\/price-as-of-label"/);
    // The armed row's label and the review card's "now $x" both go through it.
    expect(src).not.toMatch(/\? l\.price_date : "Now"/);
    expect(src).toMatch(/priceIsFromEarlierDay\(level\.price_date, todayET\(\)\)/);
    expect(src).toMatch(/priceAsOfLabel\(l\.price_date, todayET\(\)\)/);
  });
  it("the pending-review query carries the price date the card needs", () => {
    const q = readFileSync("lib/queries/security-levels.ts", "utf8");
    const fn = q.slice(q.indexOf("export function getPendingReviewLevels"));
    expect(fn.slice(0, 900)).toMatch(/p\.date AS price_date/);
  });
});
