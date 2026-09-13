/**
 * QA finding accounts-holdings--quantity-unit-hardcoded-plural-1-contracts:
 * the single-account Holdings table (app/dashboard/components/HoldingsTable.tsx)
 * hardcoded the plural unit noun ("1 contracts") with no singular branch —
 * same bug class as data-health-data-gaps--hardcoded-plural-1-securities
 * (tests/dashboard/data-health-view-pluralization.test.ts), this time for the
 * option/stock/bond quantity unit label instead of the "security" noun.
 *
 * quantityUnitLabel(securityType, quantity) singularises "contract"/"share"
 * when the ABSOLUTE quantity is exactly 1 (so a short 1-contract position
 * also reads "1 contract", not "-1 contracts"); "face value" is uncountable
 * and never pluralizes.
 */

import { describe, it, expect } from "vitest";
import { quantityUnitLabel } from "@/lib/format/quantity-unit";

describe("quantityUnitLabel", () => {
  it("singularises option contracts at quantity 1", () => {
    expect(quantityUnitLabel("option", 1)).toBe("contract");
  });

  it("pluralises option contracts at quantity 2", () => {
    expect(quantityUnitLabel("option", 2)).toBe("contracts");
  });

  it("singularises a short 1-contract position (-1)", () => {
    expect(quantityUnitLabel("option", -1)).toBe("contract");
  });

  it("singularises stock shares at quantity 1", () => {
    expect(quantityUnitLabel("stock", 1)).toBe("share");
  });

  it("pluralises stock shares at a fractional quantity", () => {
    expect(quantityUnitLabel("stock", 0.5)).toBe("shares");
  });

  it("pluralises stock shares at quantity 0", () => {
    expect(quantityUnitLabel("stock", 0)).toBe("shares");
  });

  it("bonds are always 'face value', uncountable, never singular/plural branched", () => {
    expect(quantityUnitLabel("bond", 1)).toBe("face value");
    expect(quantityUnitLabel("bond", 100)).toBe("face value");
    expect(quantityUnitLabel("Bond", 1)).toBe("face value");
  });

  it("is case-insensitive on security_type per repo convention", () => {
    expect(quantityUnitLabel("OPTION", 1)).toBe("contract");
    expect(quantityUnitLabel("Option", 2)).toBe("contracts");
    expect(quantityUnitLabel("STOCK", 1)).toBe("share");
    expect(quantityUnitLabel("ETF", 1)).toBe("share");
  });

  it("defaults to 'shares' (plural) for a null/unknown security type at non-1 quantity", () => {
    expect(quantityUnitLabel(null, 5)).toBe("shares");
  });

  it("singularises the default 'share' label too at quantity 1 for a null security type", () => {
    expect(quantityUnitLabel(null, 1)).toBe("share");
  });
});
