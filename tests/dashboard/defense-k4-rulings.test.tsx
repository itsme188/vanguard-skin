import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { HedgeScore, NotCreditedHedge } from "@/lib/compute/hedging";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Defense owner rulings 2026-11-15 (K4), on screen:
//  K4a short-side hedges get their own section, out of the Hedge book;
//  K4b not-credited fund hedges are listed with the reason;
//  K4c an assumed beta reads as assumed;
//  K4d "Hide amounts" masks the sector percentages in "Protects".
// No DOM harness: the privacy hook is mocked with a switch (precedent:
// tests/dashboard/analysis-display-consistency-wave5.test.tsx).
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

import { DefenseTables, protectsLabel } from "@/app/dashboard/components/DefenseTables";

const MASK = "•••";

function score(over: Partial<HedgeScore>): HedgeScore {
  return {
    securityId: 1,
    symbol: "ZZE P",
    underlying: "ZZE",
    protects: "sector: Technology 60% / Financials 40%",
    protectedNotional: 1000,
    thetaPerDay: -1,
    monthlyBleedPct: 0.03,
    runwayDays: 90,
    moneynessPct: -0.05,
    efficiency: 33,
    badges: [],
    side: "long",
    ...over,
  };
}

function render(hedgeScores: HedgeScore[], notCredited: NotCreditedHedge[] = []): string {
  return renderToStaticMarkup(
    <DefenseTables
      rankedExposures={[]}
      hedgeScores={hedgeScores}
      standaloneBets={[]}
      standaloneBetKinds={{}}
      shortSideHedgeNotional={500}
      notCreditedHedges={notCredited}
    />
  );
}

function section(html: string, heading: string): string {
  const start = anchorIndex(html, `>${heading}<`);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

describe("Defense on screen (K4)", () => {
  beforeEach(() => {
    privacy.on = false;
  });

  it("K4d: Hide amounts masks the sector shares in Protects; the sector names stay", () => {
    privacy.on = true;
    const html = section(render([score({})]), "Hedge book");
    expect(html).toContain("Technology sector (");
    expect(html).toContain("Financials sector (");
    expect(html).not.toContain("60%");
    expect(html).not.toContain("40%");
    expect(html).toContain(MASK);
  });

  it("K4d: with Hide amounts off the shares show", () => {
    const html = section(render([score({})]), "Hedge book");
    expect(html).toContain("60%");
  });

  it("K4a: a call against a short is in its own section, not in the Hedge book", () => {
    const html = render([
      score({}),
      score({ securityId: 2, symbol: "ZZS C", underlying: "ZZS", protects: "ZZS", side: "short" }),
    ]);
    const book = section(html, "Hedge book");
    const shortSide = section(html, "Short-side hedges");
    expect(book).not.toContain("ZZS C");
    expect(shortSide).toContain("ZZS C");
    expect(shortSide).toContain("protect against a rally");
    expect(shortSide).toContain("not counted in the");
  });

  it("K4a: no short-side section when there is none", () => {
    expect(render([score({})])).not.toContain("Short-side hedges");
  });

  it("K4b: not-credited fund hedges are listed with their reason", () => {
    const html = render([], [
      { underlying: "ZZC", symbols: ["ZZC P"], protectiveNotional: 800, reason: "commodity fund: it moves with raw materials, not with stocks" },
    ]);
    const list = section(html, "Not credited");
    expect(list).toContain("ZZC");
    expect(list).toContain("commodity fund");
  });

  it("a measured beta reads as measured (ruling 19 = B: an unmeasured one earns no row at all)", () => {
    expect(protectsLabel("book (β=1.2)")).toBe("Whole portfolio (β=1.2)");
    expect(protectsLabel("own_sector: Healthcare (β=1.3)")).toBe("Healthcare sector, the fund's own (β=1.3)");
    expect(protectsLabel("own_sector: Healthcare + book (β=1.3)")).toBe(
      "Healthcare sector (the fund's own), then the whole portfolio (β=1.3)"
    );
  });

  it("ruling 19 = B: the headline strip has no assumed-beta count; unmeasured betas count as not credited", () => {
    const src = readFileSync("app/dashboard/components/DefenseView.tsx", "utf8");
    expect(src).not.toMatch(/assumedBeta/);
    anchorIndex(src, "NOT_CREDITED_BETA_NO_HISTORY");
    anchorIndex(src, "NOT_CREDITED_BETA_LOW_FIT");
    anchorIndex(src, "notCreditedHedges={analysis.notCreditedHedges}");
  });
});
