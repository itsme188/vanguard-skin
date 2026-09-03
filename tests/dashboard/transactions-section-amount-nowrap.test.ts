/**
 * QA finding security-detail-transactions--minus-sign-wraps-onto-own-line-amount-column-1280-chatrail
 * (security-detail RECENT TRANSACTIONS Amount column, 1280px + chat rail
 * open): 14 of 29 negative Amount cells on the AAPL page put the "−" on its
 * own line above the number — confusable with the table's own lone-dash
 * "no value" placeholder. Pure CSS fix (whitespace-nowrap on the Amount
 * <td>) — pinned with a source scan, no DOM/layout harness in this repo per
 * the precedent in tests/dashboard/narrative-block-refresh.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("RECENT TRANSACTIONS Amount cell — sign never wraps onto its own line", () => {
  const src = readFileSync("app/dashboard/components/TransactionsSection.tsx", "utf8");

  it("the Amount <td> (the one immediately wrapping the Money/displayCashEffect call) is whitespace-nowrap", () => {
    const amountCellMatch = src.match(
      /<td className=\{`\$\{TD_MONO\} text-right[^`]*`\}>\s*<Money value=\{displayCashEffect/
    );
    expect(
      amountCellMatch,
      "expected to find the Amount <td> immediately preceding the Money/displayCashEffect call"
    ).not.toBeNull();
    expect(amountCellMatch![0]).toContain("whitespace-nowrap");
  });
});
