/**
 * QA finding: the Type chip for a short sale and for a buy-to-cover stayed
 * neutral grey while every other buy / sell type was coloured. The rule is
 * the cash direction: a short sale takes cash in like a Sell, a cover pays
 * cash out like a Buy.
 */
import { describe, it, expect } from "vitest";
import { transactionTypeChipClass } from "@/app/dashboard/components/TransactionHistory";

const NEUTRAL = "bg-raised text-ink-dim";

describe("Type chip colour for the short-sale family", () => {
  it("a short sale is coloured like a Sell", () => {
    expect(transactionTypeChipClass("SHORT_SELL")).toBe(transactionTypeChipClass("SELL"));
    expect(transactionTypeChipClass("SHORT_SELL")).not.toBe(NEUTRAL);
  });

  it("a buy-to-cover is coloured like a Buy", () => {
    expect(transactionTypeChipClass("BUY_TO_COVER")).toBe(transactionTypeChipClass("BUY"));
    expect(transactionTypeChipClass("BUY_TO_COVER")).not.toBe(NEUTRAL);
  });

  it("the two legs of a short never share a colour", () => {
    expect(transactionTypeChipClass("SHORT_SELL")).not.toBe(transactionTypeChipClass("BUY_TO_COVER"));
  });
});
