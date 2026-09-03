/**
 * QA finding data-health-data-gaps--hardcoded-plural-1-securities:
 * the Data Gaps card on /dashboard/data-health hardcoded the plural noun
 * ("1 securities with no prices") with no singular branch, unlike the rest
 * of the app's "N row{s}" / "N warning{s}" pattern (see e.g.
 * app/dashboard/components/DataConfidenceIndicator.tsx's
 * `warnings.length === 1 ? "" : "s"`). "Security" pluralizes irregularly
 * ("securities", not "securitys"), so the fix is a full-word ternary rather
 * than an appended "s".
 *
 * DataHealthView is "use client" with no jsdom/@testing-library/react
 * harness in this repo (see precedent note in
 * tests/dashboard/narrative-block-refresh.test.ts) — pinned with a source
 * scan, same pattern as tests/dashboard/tax-report-card-scope.md's "source
 * pin" section.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("DataHealthView — Data Gaps card pluralizes 'security' correctly", () => {
  const src = readFileSync("app/dashboard/components/DataHealthView.tsx", "utf8");

  it("the no-prices count branches singular/plural instead of hardcoding 'securities'", () => {
    expect(src).toMatch(
      /\{gaps\.securitiesNoPrices\.length\} \{gaps\.securitiesNoPrices\.length === 1 \? "security" : "securities"\} with no prices/
    );
  });

  it("the no-transactions count branches singular/plural too (same bug class, same card)", () => {
    expect(src).toMatch(
      /\{gaps\.securitiesNoTransactions\.length\} \{gaps\.securitiesNoTransactions\.length === 1 \? "security" : "securities"\} with no transactions/
    );
  });
});
