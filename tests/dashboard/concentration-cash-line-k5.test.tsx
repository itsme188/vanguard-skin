/**
 * Owner ruling 2026-11-15: cash and cash-equivalent funds are protection and
 * flexibility, not a position to leave out or to rank. Both concentration
 * surfaces on Analysis show ONE "Cash and equivalents" line with its share of
 * the whole book and a plain sentence, never as a ranked position; the
 * Herfindahl is labelled so a reader knows cash counts as dilution.
 *
 * No DOM harness: the Concentration Metrics card and the shared cash line are
 * rendered with renderToStaticMarkup (privacy hook mocked, precedent
 * tests/dashboard/classification-card-b10.test.tsx); RiskMetrics fetches in
 * an effect, so it is source-pinned. Synthetic figures only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConcentrationMetrics, ClassificationCoverage } from "@/lib/queries/analysis";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const privacy = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: privacy.on, setPrivate: () => {}, toggle: () => {} }),
  PrivacyProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/analysis",
}));

import {
  ClassificationCard,
  CashEquivalentsLine,
  CASH_EQUIVALENTS_SENTENCE,
  HHI_CASH_NOTE,
} from "@/app/dashboard/components/analysis/ClassificationCard";
import { ToastProvider } from "@/app/dashboard/components/Toast";

const MASK = "•••";

function coverage(): ClassificationCoverage {
  return { total: 6, classified: 6, unclassified: 0, coverage_pct: 100, by_source: [], unclassified_securities: [] };
}

function concentration(over: Partial<ConcentrationMetrics> = {}): ConcentrationMetrics {
  return {
    hhi: 0.05,
    effective_positions: 20,
    invested_hhi: 0.2,
    top_positions: [{ symbol: "ZZA", security_name: "ZZA Test", market_value: 1_000, weight_pct: 10 }],
    cash: { market_value: 5_000, weight_pct: 50, holding_count: 1 },
    negative_cash: { market_value: 0, holding_count: 0 },
    warnings: [],
    ...over,
  };
}

function render(c: ConcentrationMetrics): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <ClassificationCard concentration={c} coverage={coverage()} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  privacy.on = false;
});

describe("Concentration Metrics card: cash and equivalents", () => {
  it("shows one labelled cash line with its share and the plain sentence", () => {
    const html = render(concentration());
    expect(html).toContain("Cash-equivalent funds");
    expect(html).toContain("50.0%");
    expect(html).toContain(CASH_EQUIVALENTS_SENTENCE);
  });

  it("labels the Herfindahl so a reader knows cash counts as dilution", () => {
    expect(render(concentration())).toContain(HHI_CASH_NOTE);
  });

  it("masks the cash share and value in privacy mode", () => {
    privacy.on = true;
    const html = render(concentration());
    expect(html).toContain("Cash-equivalent funds");
    expect(html).not.toContain("50.0%");
    expect(html).not.toContain("5,000");
    expect(html).toContain(MASK);
  });

  it("an all-cash book reads as all cash, not as 'no position weights'", () => {
    const html = render(
      concentration({
        hhi: 0,
        effective_positions: 0,
        invested_hhi: 0,
        top_positions: [],
        cash: { market_value: 5_000, weight_pct: 100, holding_count: 2 },
        negative_cash: { market_value: 0, holding_count: 0 },
      }),
    );
    expect(html).toContain("Everything in this scope is held as cash");
    expect(html).not.toContain("No position weights to measure concentration on.");
  });

  it("with no cash, no cash line is drawn", () => {
    const html = render(concentration({ cash: { market_value: 0, weight_pct: 0, holding_count: 0 } }));
    expect(html).not.toContain(CASH_EQUIVALENTS_SENTENCE);
  });

  it("the Effective Positions note no longer points at a sentence 'below' (it sits beside or above)", () => {
    const html = render(concentration());
    expect(html).not.toContain("same count as the sentence below");
    expect(html).toContain("same count as the Herfindahl sentence");
  });
});

describe("the shared cash line", () => {
  it("renders the share through the privacy components", () => {
    const html = renderToStaticMarkup(<CashEquivalentsLine weightPct={25} marketValue={2_500} holdingCount={3} />);
    expect(html).toContain("25.0%");
    expect(html).toContain("Cash-equivalent funds");
    privacy.on = true;
    const masked = renderToStaticMarkup(<CashEquivalentsLine weightPct={25} marketValue={2_500} holdingCount={3} />);
    expect(masked).not.toContain("25.0%");
    expect(masked).not.toContain("2,500");
  });
});

describe("Risk Decomposition uses the same cash line and keeps cash out of 'Other'", () => {
  const src = readFileSync("app/dashboard/components/RiskMetrics.tsx", "utf8");

  it("renders CashEquivalentsLine from the risk metrics' cash fields", () => {
    anchorIndex(src, "<CashEquivalentsLine");
    expect(src).toMatch(/weightPct=\{metrics\.cashWeight \* 100\}/);
  });

  it("the 'Other' bar is the rest of the RISKY book, not 1 - top5 (which swept cash in)", () => {
    const block = sliceBetween(src, "// Prepare concentration bar chart data", "return (");
    expect(block).toContain("metrics.cashWeight");
    expect(block).not.toMatch(/const restWeight = 1 - metrics\.top5Concentration;/);
  });

  it("labels its Herfindahl with the same cash note", () => {
    anchorIndex(src, "HHI_CASH_NOTE");
  });
});
