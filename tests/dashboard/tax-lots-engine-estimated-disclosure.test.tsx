/**
 * QA finding: tax-lots--headline-tiles-include-reconcile-close-engine-rows
 * (render half — the data half is tests/queries/tax-lots-engine-estimated-disclosure.test.ts)
 *
 * USER RULING — "disclose, never exclude". The REALIZED / LONG-TERM /
 * SHORT-TERM tiles keep their whole economic totals (RECONCILE_CLOSE rows
 * stay in) and each one appends "(incl. M engine-estimated closes, +$Y)"
 * when that bucket's engine-estimated count is > 0. When M is 0 the tile is
 * byte-unchanged. The per-account cards mirror the same disclosure.
 *
 * This repo has no jsdom / @testing-library/react (see the precedent note in
 * tests/dashboard/nearby-levels-privacy.test.tsx) — TaxLotSummary's two
 * exported components have no hooks of their own, so renderToStaticMarkup is
 * a genuine render pass over them.
 *
 * `usePrivacy` is mocked off a mutable flag so the same render can be
 * exercised in both privacy states: the disclosure's count and dollars must
 * go through <Count>/<Money>, i.e. they must MASK, while the surrounding
 * prose stays readable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaxLotSummaryCards,
  AccountSummaryCards,
  ENGINE_ESTIMATED_TITLE,
} from "@/app/dashboard/components/TaxLotSummary";
import type { TaxLotSummary, AccountTaxSummary } from "@/lib/queries/tax-lots";

const privacyState = vi.hoisted(() => ({ isPrivate: false }));
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({
    isPrivate: privacyState.isPrivate,
    setPrivate: () => {},
    toggle: () => {},
  }),
  PrivacyProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const MASK = "•••"; // lib/privacy/components.tsx MASK

function summary(overrides: Partial<TaxLotSummary> = {}): TaxLotSummary {
  return {
    totalOpenLots: 3,
    totalClosedSales: 6,
    totalUnrealizedGain: 1_000,
    totalRealizedGain: 1_100,
    longTermGain: 500,
    shortTermGain: 600,
    excludedNonUsdSales: 0,
    engineEstimatedSales: 0,
    engineEstimatedGain: 0,
    engineEstimatedLongTermSales: 0,
    engineEstimatedLongTermGain: 0,
    engineEstimatedShortTermSales: 0,
    engineEstimatedShortTermGain: 0,
    ...overrides,
  };
}

function account(overrides: Partial<AccountTaxSummary> = {}): AccountTaxSummary {
  return {
    account_id: 1,
    account_name: "Test Brokerage",
    totalClosedSales: 5,
    totalRealizedGain: 1_000,
    longTermGain: 500,
    shortTermGain: 500,
    excludedNonUsdSales: 0,
    engineEstimatedSales: 0,
    engineEstimatedGain: 0,
    engineEstimatedLongTermSales: 0,
    engineEstimatedLongTermGain: 0,
    engineEstimatedShortTermSales: 0,
    engineEstimatedShortTermGain: 0,
    ...overrides,
  };
}

const WITH_ENGINE_CLOSES: Partial<TaxLotSummary> = {
  engineEstimatedSales: 2,
  engineEstimatedGain: 700,
  engineEstimatedLongTermSales: 1,
  engineEstimatedLongTermGain: 400,
  engineEstimatedShortTermSales: 1,
  engineEstimatedShortTermGain: 300,
};

beforeEach(() => {
  privacyState.isPrivate = false;
});

describe("TaxLotSummaryCards engine-estimated disclosure", () => {
  it("says nothing when no bucket has an engine-estimated close", () => {
    const html = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary()} year={2026} />
    );
    expect(html).not.toContain("engine-estimated");
    expect(html).not.toContain("incl.");
  });

  it("discloses the count and dollars on each affected tile", () => {
    const html = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary(WITH_ENGINE_CLOSES)} year={2026} />
    );
    // Realized tile: 2 closes, +$700
    expect(html).toContain(
      "(incl. <span>2</span> engine-estimated closes, <span class=\"whitespace-nowrap\"><span>+$700</span>)</span>"
    );
    // Long-term tile: 1 close, +$400 — singular, no stray "closes"
    expect(html).toContain(
      "(incl. <span>1</span> engine-estimated close, <span class=\"whitespace-nowrap\"><span>+$400</span>)</span>"
    );
    // Short-term tile: 1 close, +$300
    expect(html).toContain(
      "(incl. <span>1</span> engine-estimated close, <span class=\"whitespace-nowrap\"><span>+$300</span>)</span>"
    );
    // Three disclosures, one per affected tile — the Unrealized tile has none.
    expect(html.match(/engine-estimated close/g) ?? []).toHaveLength(3);
  });

  it("leaves the economic totals themselves untouched (disclose, never exclude)", () => {
    const html = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary(WITH_ENGINE_CLOSES)} year={2026} />
    );
    expect(html).toContain("+$1,100"); // realized total still whole
    expect(html).toContain("+$500"); // long-term still whole
    expect(html).toContain("+$600"); // short-term still whole
  });

  it("omits the disclosure per bucket — a long-term-only engine close leaves the short-term tile clean", () => {
    const html = renderToStaticMarkup(
      <TaxLotSummaryCards
        summary={summary({
          engineEstimatedSales: 1,
          engineEstimatedGain: 400,
          engineEstimatedLongTermSales: 1,
          engineEstimatedLongTermGain: 400,
        })}
        year={2026}
      />
    );
    // Realized tile + Long-term tile only.
    expect(html.match(/engine-estimated close/g) ?? []).toHaveLength(2);
  });

  it("carries the same 'Estimated' wording family as the row-level chip, as a tooltip", () => {
    expect(ENGINE_ESTIMATED_TITLE.toLowerCase()).toContain("engine-generated reconciliation");
    expect(ENGINE_ESTIMATED_TITLE.toLowerCase()).toContain("estimated");
    const html = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary(WITH_ENGINE_CLOSES)} year={2026} />
    );
    expect(html).toContain(ENGINE_ESTIMATED_TITLE);
  });

  it("masks the disclosed count and dollars in privacy mode, keeping the prose", () => {
    privacyState.isPrivate = true;
    const html = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary(WITH_ENGINE_CLOSES)} year={2026} />
    );
    expect(html).toContain("engine-estimated close");
    expect(html).toContain(MASK);
    expect(html).not.toContain("$700");
    expect(html).not.toContain("$400");
  });
});

describe("AccountSummaryCards engine-estimated disclosure", () => {
  it("says nothing for the control account (no engine-estimated closes)", () => {
    const html = renderToStaticMarkup(
      <AccountSummaryCards accounts={[account()]} year={2026} />
    );
    expect(html).not.toContain("engine-estimated");
  });

  it("discloses the short-term engine-estimated closes behind the card's headline figure", () => {
    const html = renderToStaticMarkup(
      <AccountSummaryCards
        accounts={[
          account({
            engineEstimatedSales: 1,
            engineEstimatedGain: 300,
            engineEstimatedShortTermSales: 1,
            engineEstimatedShortTermGain: 300,
          }),
        ]}
        year={2026}
      />
    );
    expect(html).toContain("engine-estimated close");
    expect(html).toContain("+$300");
  });

  it("discloses the long-term engine-estimated closes beside the card's LT figure", () => {
    const html = renderToStaticMarkup(
      <AccountSummaryCards
        accounts={[
          account({
            engineEstimatedSales: 1,
            engineEstimatedGain: 400,
            engineEstimatedLongTermSales: 1,
            engineEstimatedLongTermGain: 400,
          }),
        ]}
        year={2026}
      />
    );
    expect(html.match(/engine-estimated close/g) ?? []).toHaveLength(1);
    expect(html).toContain("+$400");
  });
});
