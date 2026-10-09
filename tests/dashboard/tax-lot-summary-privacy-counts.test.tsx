/**
 * QA follow-up to tax-lots--headline-tiles-include-reconcile-close-engine-rows
 * (see tests/dashboard/tax-lots-engine-estimated-disclosure.test.tsx).
 *
 * The engine-estimated disclosure line renders its count/dollars through
 * `<Count>`/`<Money>` so they mask in privacy mode. The tile's OWN sale-count
 * sublabel sitting right above it — `{summary.totalClosedSales} sale…` in
 * TaxLotSummaryCards and `{acct.totalClosedSales} sale…` in
 * AccountSummaryCards — rendered as bare text, so a privacy-mode screenshot
 * could read "6 sales / (incl. ••• engine-estimated closes…)": the masked
 * disclosure sits directly beside its own unmasked total. Both are
 * portfolio-derived counts and must mask together.
 *
 * Same idiom as the disclosure test: no jsdom/RTL in this repo, so
 * `renderToStaticMarkup` over the two exported (hookless-of-their-own)
 * components is a genuine render pass, with `usePrivacy` mocked off a
 * mutable flag so the same render can be exercised in both privacy states.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaxLotSummaryCards,
  AccountSummaryCards,
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
    pendingStatementPositions: 0,
    pendingStatementLots: 0,
    pendingStatementBasis: 0,
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

beforeEach(() => {
  privacyState.isPrivate = false;
});

describe("TaxLotSummaryCards — Realized tile's own sale count masks with the rest of the tile", () => {
  it("shows the bare sale count when privacy is off", () => {
    const html = renderToStaticMarkup(<TaxLotSummaryCards summary={summary()} year={2026} />);
    expect(html).toContain("Sales: <span>6</span>");
  });

  it("the noun does not switch with the count: one sale reads the same as many, shown or masked", () => {
    // "1 sale" / "6 sales" beside a masked figure would say whether the count
    // is exactly one. Noun first and always plural, like "Open lots:".
    const one = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary({ totalClosedSales: 1 })} year={2026} />
    );
    expect(one).toContain("Sales: <span>1</span>");
    expect(one).not.toMatch(/<\/span> sale\b/);
    privacyState.isPrivate = true;
    const oneMasked = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary({ totalClosedSales: 1 })} year={2026} />
    );
    const manyMasked = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary({ totalClosedSales: 6 })} year={2026} />
    );
    expect(oneMasked).toBe(manyMasked);
  });

  it("the engine-estimated note does not switch its noun either", () => {
    const one = { engineEstimatedSales: 1, engineEstimatedGain: 400 };
    const many = { engineEstimatedSales: 2, engineEstimatedGain: 400 };
    const shown = renderToStaticMarkup(<TaxLotSummaryCards summary={summary(one)} year={2026} />);
    expect(shown).toContain("(incl. engine-estimated closes: <span>1</span>,");
    privacyState.isPrivate = true;
    expect(renderToStaticMarkup(<TaxLotSummaryCards summary={summary(one)} year={2026} />)).toBe(
      renderToStaticMarkup(<TaxLotSummaryCards summary={summary(many)} year={2026} />)
    );
  });

  it("masks the sale count in privacy mode — no bare digit count survives", () => {
    privacyState.isPrivate = true;
    const html = renderToStaticMarkup(<TaxLotSummaryCards summary={summary()} year={2026} />);
    expect(html).toContain(`Sales: <span>${MASK}</span>`);
    expect(html).not.toContain("6 sales");
    expect(html).not.toContain("Sales: <span>6");
  });
});

describe("AccountSummaryCards — per-account sale count masks with the rest of the card", () => {
  it("shows the bare sale count when privacy is off", () => {
    const html = renderToStaticMarkup(<AccountSummaryCards accounts={[account()]} year={2026} />);
    expect(html).toContain("Sales: <span>5</span>");
  });

  it("one sale and many sales read the same when masked", () => {
    const shown = renderToStaticMarkup(
      <AccountSummaryCards accounts={[account({ totalClosedSales: 1 })]} year={2026} />
    );
    expect(shown).toContain("Sales: <span>1</span>");
    privacyState.isPrivate = true;
    expect(
      renderToStaticMarkup(<AccountSummaryCards accounts={[account({ totalClosedSales: 1 })]} year={2026} />)
    ).toBe(renderToStaticMarkup(<AccountSummaryCards accounts={[account()]} year={2026} />));
  });

  it("masks the sale count in privacy mode — no bare digit count survives", () => {
    privacyState.isPrivate = true;
    const html = renderToStaticMarkup(<AccountSummaryCards accounts={[account()]} year={2026} />);
    expect(html).toContain(`Sales: <span>${MASK}</span>`);
    expect(html).not.toContain("5 sales");
    expect(html).not.toContain("Sales: <span>5");
  });
});
