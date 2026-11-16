/**
 * Cash-Deploy card — review fix FX4 item 3 (2026-11-16), source pins.
 * One message for a zero or negative amount, shared by the card and the
 * route; an invalid amount or a failed request clears the previous result.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";
import { CASH_AMOUNT_INVALID_MESSAGE } from "@/lib/compute/cash-deploy";

const card = readFileSync("app/dashboard/components/analysis/CashDeployCard.tsx", "utf8");
const route = readFileSync("app/api/analysis/cash-deploy/route.ts", "utf8");

describe("FX4 item 3: one invalid-amount message", () => {
  it("is a plain sentence with no figure", () => {
    expect(CASH_AMOUNT_INVALID_MESSAGE).toBe("Enter a cash amount above zero.");
  });

  it("the card and the route both use the constant, and neither hand-writes a message", () => {
    expect(card).toContain("setError(CASH_AMOUNT_INVALID_MESSAGE)");
    expect(route).toContain("error: CASH_AMOUNT_INVALID_MESSAGE");
    for (const src of [card, route]) {
      expect(src).not.toMatch(/Enter a positive cash amount/);
      expect(src).not.toMatch(/"Enter a cash amount above zero\."/);
    }
  });
});

describe("FX4 item 3: an old result never stays under an error", () => {
  it("the invalid-amount branch clears the result before setting the error", () => {
    const at = anchorIndex(card, "setError(CASH_AMOUNT_INVALID_MESSAGE)");
    expect(card.slice(at - 120, at)).toContain("setResult(null);");
  });

  it("a failed request and a network failure clear the result", () => {
    const failed = anchorIndex(card, "setError(`Couldn't suggest an allocation:");
    expect(card.slice(failed - 80, failed)).toContain("setResult(null);");
    const network = anchorIndex(card, 'setError(networkFailureMessage("suggest an allocation"))');
    expect(card.slice(network - 80, network)).toContain("setResult(null);");
  });
});
