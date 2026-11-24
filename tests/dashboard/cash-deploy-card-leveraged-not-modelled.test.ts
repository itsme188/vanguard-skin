/**
 * Cash-Deploy card — bug 4 (2026-11-24), source pins. A leveraged or inverse
 * fund with no stored factor is left out of the weights; the card says so in
 * one caption line, the count through the privacy component.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";
import { LEVERAGED_NOT_MODELLED_LABEL } from "@/lib/compute/cash-deploy";

const card = readFileSync("app/dashboard/components/analysis/CashDeployCard.tsx", "utf8");

describe("bug 4: the not-modelled caption", () => {
  it("is a plain sentence with no figure", () => {
    expect(LEVERAGED_NOT_MODELLED_LABEL).not.toMatch(/\d/);
  });

  it("the card shows the label with the count through <Count>", () => {
    const at = anchorIndex(card, "{LEVERAGED_NOT_MODELLED_LABEL}");
    expect(card.slice(at, at + 120)).toContain("<Count value={result.leveragedFundsNotModelled.length} />");
    expect(card.slice(at - 200, at)).toContain("leveragedFundsNotModelled");
  });
});
