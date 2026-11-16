import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Review round 5 (2026-11-15), Defense wording:
//  R2 the not-credited line covers an unknown fund type too; an assumed beta
//     says whether history was short or a measured beta failed the fit test;
//     "Hedges scored" says how many are long-side and short-side.
//  R3 a geography-route row says its basis: regional exposure, no beta.
//  R1 a sector credited past its holdings names the excess beside the bar.
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: false, setPrivate: () => {}, toggle: () => {} }),
  PrivacyProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/analysis",
}));

import { DefenseTables, protectsLabel } from "@/app/dashboard/components/DefenseTables";

describe("Defense wording (review R2/R3)", () => {
  it("an assumed beta that failed the fit test is not called 'not enough history'", () => {
    const low = protectsLabel("book (β=1.0, assumed, low fit)");
    expect(low).not.toMatch(/not enough price history/);
    expect(low).toMatch(/measured/);
    expect(protectsLabel("own_sector: Healthcare + book (β=1.0, assumed, low fit)")).toMatch(/measured/);
    // The no-history wording stays for a plain "assumed".
    expect(protectsLabel("book (β=1.0, assumed)")).toMatch(/not enough price history/);
  });

  it("a geography row says it is regional exposure with no beta applied", () => {
    expect(protectsLabel("geography: Europe")).toBe("Europe equities (regional exposure, no beta applied)");
  });

  it("the not-credited list intro covers an unknown fund type", () => {
    const html = renderToStaticMarkup(
      <DefenseTables
        rankedExposures={[]}
        hedgeScores={[]}
        standaloneBets={[]}
        standaloneBetKinds={{}}
        shortSideHedgeNotional={0}
        notCreditedHedges={[
          { underlying: "ZZU", symbols: ["ZZU P"], protectiveNotional: 100, reason: "fund type unknown: no fund category or asset class on file" },
        ]}
      />
    );
    expect(html).toMatch(/fund type is not on file/);
  });

  it("the headline strip counts the not-credited reasons, the assumed-beta reasons and the long/short split", () => {
    const src = readFileSync("app/dashboard/components/DefenseView.tsx", "utf8");
    anchorIndex(src, "NOT_CREDITED_UNKNOWN");
    anchorIndex(src, "fund type not on file");
    anchorIndex(src, "summary.assumedBetaLowFitCount");
    anchorIndex(src, "failed the fit test");
    anchorIndex(src, "<Count value={summary.longSideHedgeCount} /> long-side");
    anchorIndex(src, "<Count value={summary.shortSideHedgeCount} /> short-side");
    anchorIndex(src, "sc.protectedBeyondExposure");
  });
});
