/**
 * QA finding security-detail-transactions--buy-amount-sign-convention-differs-by-source-regression-1
 * (security-detail RECENT TRANSACTIONS Amount column):
 *
 * Vanguard canonical imports historically stored principal UNSIGNED while
 * IBKR stores a signed cash flow — adjacent BUY rows for the identical
 * action rendered with opposite signs in the same column (321 of 1,624 BUY
 * rows read as money coming IN). displayCashEffect() fixes this at DISPLAY
 * time only (never rewrites transactions.amount): a BUY is always a cash
 * outflow (negative), a SELL is always a cash inflow (positive), regardless
 * of source or era.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { displayCashEffect } from "@/lib/format/cash-effect";

describe("displayCashEffect (Amount column sign normalization)", () => {
  it("renders a Vanguard-sourced BUY (stored positive/unsigned) as negative", () => {
    // Repro row: '2024-05-07 BUY Vanguard Taxable — 25 $183.80 $4,595'
    expect(displayCashEffect("BUY", 4595)).toBe(-4595);
  });

  it("leaves an IBKR-sourced BUY (already stored negative) negative", () => {
    // Repro row: '2024-05-10 BUY IBKR — 50 $182.59 −$9,129'
    expect(displayCashEffect("BUY", -9129)).toBe(-9129);
  });

  it("covers the full BUY family (options included)", () => {
    expect(displayCashEffect("BUY_TO_OPEN", 5879)).toBe(-5879);
    expect(displayCashEffect("BUY_TO_OPEN", -859)).toBe(-859);
    expect(displayCashEffect("BUY_TO_CLOSE", 100)).toBe(-100);
    expect(displayCashEffect("BUY_TO_COVER", 200)).toBe(-200);
  });

  it("keeps every SELL positive regardless of stored sign", () => {
    expect(displayCashEffect("SELL", 1000)).toBe(1000);
    expect(displayCashEffect("SELL", -1000)).toBe(1000);
    expect(displayCashEffect("SELL_TO_CLOSE", -500)).toBe(500);
    expect(displayCashEffect("SELL_TO_OPEN", -50)).toBe(50);
  });

  it("leaves non-BUY/SELL types (DIVIDEND, FEE, TRANSFER, ...) completely untouched", () => {
    expect(displayCashEffect("DIVIDEND", 42)).toBe(42);
    expect(displayCashEffect("DIVIDEND", -42)).toBe(-42); // e.g. a reversal
    expect(displayCashEffect("FEE", -5)).toBe(-5);
    expect(displayCashEffect("TRANSFER", 100)).toBe(100);
    expect(displayCashEffect("TRANSFER", -100)).toBe(-100);
  });

  it("passes through null/undefined/NaN unchanged (fallback dash still renders)", () => {
    expect(displayCashEffect("BUY", null)).toBeNull();
    expect(displayCashEffect("BUY", NaN)).toBeNaN();
  });

  it("a zero-amount BUY stays zero (Money's own rendersAsZero guard still suppresses any sign)", () => {
    expect(displayCashEffect("BUY", 0)).toBe(0);
  });
});

describe("RECENT TRANSACTIONS Amount cell wiring (source pin)", () => {
  const src = readFileSync("app/dashboard/components/TransactionsSection.tsx", "utf8");

  it("the Amount cell renders through displayCashEffect, not the raw stored amount", () => {
    expect(src).toMatch(
      /<Money value=\{displayCashEffect\(t\.type, t\.amount\)\} fallback="–" \/>/
    );
  });
});
