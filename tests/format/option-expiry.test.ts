import { describe, it, expect } from "vitest";
import { formatOptionExpiry } from "@/lib/format/option-expiry";

/**
 * QA finding analysis-greeks--expiry-column-omits-year: the Options Greeks
 * table's position cell printed bare "Sep 17" for both a 2026 and a 2027
 * contract, so two rows only a year apart read identically (only the
 * separate DTE column disambiguated). formatOptionExpiry always carries the
 * four-digit year. It accepts both shapes OptionsGreeksCard's data can carry
 * (see the same-shape comment in lib/compute/options-strategy.ts's sibling
 * formatExpiry ~line 548): ISO "YYYY-MM-DD" and the compact "YYYYMMDD" a
 * handful of TWS-enriched rows store instead.
 */
describe("formatOptionExpiry", () => {
  it("formats an ISO YYYY-MM-DD expiry with the year", () => {
    expect(formatOptionExpiry("2027-09-17")).toBe("Sep 17, 2027");
  });

  it("formats the compact YYYYMMDD shape the same way", () => {
    expect(formatOptionExpiry("20260917")).toBe("Sep 17, 2026");
  });

  it("disambiguates two contracts a year apart that DTE alone would not", () => {
    expect(formatOptionExpiry("2027-09-17")).not.toBe(formatOptionExpiry("2026-09-17"));
  });

  it("drops a leading zero from the day", () => {
    expect(formatOptionExpiry("2026-01-05")).toBe("Jan 5, 2026");
  });

  it("returns the input unchanged for an invalid/empty string, never 'undefined NaN'", () => {
    expect(formatOptionExpiry("")).toBe("");
    expect(formatOptionExpiry("not-a-date")).toBe("not-a-date");
    expect(formatOptionExpiry("2026-13-40")).toBe("2026-13-40");
  });
});
