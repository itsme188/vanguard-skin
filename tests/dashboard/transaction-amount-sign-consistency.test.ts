/**
 * Two components render a transaction Amount cell for the same underlying
 * row shape: app/dashboard/components/TransactionsSection.tsx (security
 * detail "RECENT TRANSACTIONS") and app/dashboard/components/
 * TransactionHistory.tsx (Accounts tab transaction history). Only the
 * former was fixed (transactions-section-amount-sign.test.ts) to print
 * displayCashEffect(t.type, t.amount) instead of the raw stored amount — a
 * legacy Vanguard BUY row (stored positive/unsigned) still read as a cash
 * INFLOW in TransactionHistory while the identical row read as an outflow
 * in the security-detail table. Both surfaces must render through
 * displayCashEffect so a BUY always reads negative and a SELL always reads
 * positive, regardless of source/era.
 *
 * Following the source-scan precedent in
 * tests/dashboard/import-flow-donation-warning-privacy.test.ts — this repo
 * has no React component-rendering harness.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const TRANSACTIONS_SECTION = "app/dashboard/components/TransactionsSection.tsx";
const TRANSACTION_HISTORY = "app/dashboard/components/TransactionHistory.tsx";

describe("Amount cell sign normalization is consistent across transaction tables", () => {
  it("TransactionsSection renders the Amount cell through displayCashEffect", () => {
    const src = readFileSync(TRANSACTIONS_SECTION, "utf8");
    expect(src).toMatch(/<Money value=\{displayCashEffect\(t\.type, t\.amount\)\}/);
  });

  it("TransactionHistory renders the Amount cell through displayCashEffect", () => {
    const src = readFileSync(TRANSACTION_HISTORY, "utf8");
    expect(src).toMatch(/<Money value=\{displayCashEffect\(txn\.type, txn\.amount\)\}/);
  });

  it("TransactionHistory imports displayCashEffect from the shared module", () => {
    const src = readFileSync(TRANSACTION_HISTORY, "utf8");
    expect(src).toMatch(
      /import\s*\{\s*displayCashEffect\s*\}\s*from\s*["']@\/lib\/format\/cash-effect["']/,
    );
  });

  it("TransactionHistory does not render the raw unsigned amount in the Amount cell", () => {
    const src = readFileSync(TRANSACTION_HISTORY, "utf8");
    expect(src).not.toMatch(/<Money value=\{txn\.amount\} precise \/>/);
  });
});
