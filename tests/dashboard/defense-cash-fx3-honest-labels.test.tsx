/**
 * Review 2026-11-16 (FX3), honest labels:
 *  1. An unmeasured beta says the APP has not collected enough of the fund's
 *     price history, and shows the counts on file. No sentence promises that
 *     opening the chart fills it in: the chart writes `ohlcv_bars`, which the
 *     beta never reads.
 *  2. Every cash line says what it counts: cash-equivalent funds held as
 *     positions, never a cash balance at the broker. Defense says so even
 *     when the scope holds none.
 *  3. Position-Level Risk never ranks a cash fund; it states the count left
 *     out in one line.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { anchorIndex } from "@/tests/helpers/source-anchor";

vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: false, setPrivate: () => {}, toggle: () => {} }),
  PrivacyProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/analysis",
}));

import { DefenseTables, betaHistoryLine, NOT_CREDITED_INTRO } from "@/app/dashboard/components/DefenseTables";
import {
  CashEquivalentsLine,
  CASH_FUNDS_LABEL,
  CASH_FUNDS_SCOPE_CAPTION,
  HHI_CASH_NOTE,
  EFFECTIVE_WHOLE_LABEL,
  EFFECTIVE_INVESTED_LABEL,
} from "@/app/dashboard/components/analysis/ClassificationCard";

const defenseView = readFileSync("app/dashboard/components/DefenseView.tsx", "utf8");
const defenseTables = readFileSync("app/dashboard/components/DefenseTables.tsx", "utf8");
const positionRisk = readFileSync("app/dashboard/components/PositionRisk.tsx", "utf8");

describe("FX3 item 1: an unmeasured beta is a collection gap, with the counts", () => {
  it("the intro and the row say the app has not collected enough history, and show the counts", () => {
    const html = renderToStaticMarkup(
      <DefenseTables
        rankedExposures={[]}
        hedgeScores={[]}
        standaloneBets={[]}
        standaloneBetKinds={{}}
        shortSideHedgeNotional={0}
        notCreditedHedges={[
          {
            underlying: "ZZN",
            symbols: ["ZZN P"],
            protectiveNotional: 100,
            reason: "this app has not collected enough of its price history to measure a beta",
            betaHistory: { closesOnFile: 10, usablePairs: 8, pairsNeeded: 30 },
          },
        ]}
      />
    );
    expect(html).toContain("has not collected enough of the fund&#x27;s price history");
    expect(html).toContain("10 daily closes on file; 8 usable day-to-day moves against the market, 30 needed");
    expect(NOT_CREDITED_INTRO).not.toMatch(/cannot be measured yet\./);
  });

  it("singular counts read as words, and a row with no history shows no count line", () => {
    expect(betaHistoryLine({ closesOnFile: 1, usablePairs: 1, pairsNeeded: 30 })).toBe(
      "1 daily close on file; 1 usable day-to-day move against the market, 30 needed"
    );
    const html = renderToStaticMarkup(
      <DefenseTables
        rankedExposures={[]}
        hedgeScores={[]}
        standaloneBets={[]}
        standaloneBetKinds={{}}
        shortSideHedgeNotional={0}
        notCreditedHedges={[{ underlying: "ZZU", symbols: ["ZZU P"], protectiveNotional: 100, reason: "fund type unknown" }]}
      />
    );
    expect(html).not.toContain("daily close");
  });

  it("promises nothing about opening the chart (the beta does not read chart bars)", () => {
    for (const src of [defenseView, defenseTables]) {
      expect(src).not.toMatch(/opening the fund's chart/i);
      expect(src).not.toMatch(/History is collected for funds you hold or chart/);
    }
  });

  it("the headline count names a collection gap", () => {
    anchorIndex(defenseView, "too little of its price history collected yet to measure its beta");
    expect(defenseView).not.toContain('"not enough price history to measure its beta"');
  });
});

describe("FX3 item 2: every cash line says it counts funds only", () => {
  it("the concentration line is labelled Cash-equivalent funds and carries the caption", () => {
    const html = renderToStaticMarkup(<CashEquivalentsLine weightPct={10} marketValue={1000} holdingCount={1} />);
    expect(html).toContain(CASH_FUNDS_LABEL);
    expect(CASH_FUNDS_LABEL).toBe("Cash-equivalent funds");
    expect(html).toContain("Money-market and sweep funds held as positions. Cash balances at the broker are not included.");
    expect(html).not.toContain("Cash and equivalents");
  });

  it("the dilution wording names cash-equivalent funds", () => {
    expect(HHI_CASH_NOTE).toMatch(/^Cash-equivalent funds count as dilution/);
    expect(EFFECTIVE_WHOLE_LABEL).toBe("Whole portfolio, cash-equivalent funds counted as dilution");
    expect(EFFECTIVE_INVESTED_LABEL).toBe("Invested holdings only, cash-equivalent funds left out");
  });

  it("Defense carries the same caption word for word (a server file holds its own copy)", () => {
    const m = /DEFENSE_CASH_SCOPE_CAPTION =\s*"([^"]+)"/.exec(defenseView);
    expect(m?.[1]).toBe(CASH_FUNDS_SCOPE_CAPTION);
    anchorIndex(defenseView, "Cash-equivalent funds:");
    anchorIndex(defenseView, "{DEFENSE_CASH_SCOPE_CAPTION}");
    expect(defenseView).not.toContain("Cash and equivalents:");
  });

  it("Defense says when the scope holds no cash-equivalent fund, naming broker cash", () => {
    anchorIndex(defenseView, "No cash-equivalent funds in this scope (broker cash balances are not counted here).");
    const empty = defenseView.slice(
      anchorIndex(defenseView, "if (cash.holdingCount === 0 && cash.borrowed.holdingCount === 0) {"),
      anchorIndex(defenseView, "{cash.holdingCount > 0 && (")
    );
    expect(empty).toContain("{DEFENSE_NO_CASH_FUNDS_NOTE}");
    expect(empty).not.toContain("return null");
  });
});

describe("FX3 item 3: Position-Level Risk states the cash funds it left out", () => {
  it("renders one line with the count, through Count", () => {
    anchorIndex(positionRisk, "(data.cashEquivalentsLeftOut ?? 0) > 0 && (");
    anchorIndex(positionRisk, "<Count value={data.cashEquivalentsLeftOut ?? 0} />");
    anchorIndex(positionRisk, 'export const CASH_LEFT_OUT_TEXT = "left out: cash is not ranked as a position."');
  });
});
