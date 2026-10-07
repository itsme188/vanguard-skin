import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConcentrationMetrics, ClassificationCoverage, FactorCoverage } from "@/lib/queries/analysis";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// QA unit B10 (Classification card) plus two leftover items:
//   analysis-classification--show-details-noop-at-full-coverage-regression-4
//   analysis-classify-toast--noop-count-reports-entire-securities-table-regression-1
//   analysis-privacy--sharpe-hhi-inconsistent-masking-regression-3 (this card's part)
//   analysis-classification--privacy-leaves-per-category-position-counts-unmasked (card part)
//   analysis-copy--internal-dev-references-in-user-facing-text-regression-6 (legend part)
//
// No DOM harness: renderToStaticMarkup never runs effects, so the real
// PrivacyProvider would always render with privacy off. The shared hook is
// mocked instead (precedent: tests/dashboard/nearby-levels-privacy.test.tsx),
// with a switch so the same render is checked both ways.
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
  ClassificationDetails,
  CLASSIFICATION_METHOD_LABELS,
  classificationMethodLabel,
  classifyRunSummary,
} from "@/app/dashboard/components/analysis/ClassificationCard";
import { FactorModeCard } from "@/app/dashboard/components/analysis/FactorModeCard";
import { ToastProvider } from "@/app/dashboard/components/Toast";

const MASK = "•••";

function concentration(): ConcentrationMetrics {
  return { hhi: 0.08, effective_positions: 12.5, top_positions: [], warnings: [] };
}

// Synthetic counts, chosen so no figure collides with a class name.
function coverage(overrides: Partial<ClassificationCoverage> = {}): ClassificationCoverage {
  return {
    total: 43,
    classified: 41,
    unclassified: 2,
    coverage_pct: 95.3,
    by_source: [
      { source: "static_lookup", count: 37 },
      { source: "auto_option", count: 4 },
      { source: "unclassified", count: 2 },
    ],
    unclassified_securities: [
      { id: 1, symbol: "AAA", name: "Alpha Co", security_type: "Stock" },
      { id: 2, symbol: "ZZZ", name: "Zeta Co", security_type: "Stock" },
    ],
    ...overrides,
  };
}

function renderCard(cov = coverage()): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <ClassificationCard concentration={concentration()} coverage={cov} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  privacy.on = false;
});

describe("ClassificationCard counts mask in privacy mode", () => {
  it("shows the counts and the concentration figures with privacy off", () => {
    const html = renderCard();
    expect(html).toContain("0.0800");
    expect(html).toContain("equal positions");
    expect(html).toMatch(/>41<\/span> of <span[^>]*>43<\/span> securities classified/);
    expect(html).toMatch(/>37<\/span>/);
    // Effective Positions tile: round(1 / 0.08) = 13.
    expect(html).toMatch(/Effective Positions<\/p><p[^>]*><span>13<\/span>/);
  });

  it("masks the classified-of-total line, the per-method counts, HHI, its sentence and the effective-position count", () => {
    privacy.on = true;
    const html = renderCard();
    expect(html).toContain(MASK);
    expect(html).not.toContain("0.0800");
    expect(html).not.toContain("equal positions");
    expect(html).not.toMatch(/>\s*(41|43|37|13|4|2)\s*</);
    expect(html).toContain("securities classified");
    // Coverage percent keeps the file's existing convention (plain).
    expect(html).toContain("95.3%");
  });
});

describe("classification method labels", () => {
  // Every value the two coverage queries can emit: the writers of
  // securities.classification_source and security_factors.factor_source,
  // plus the COALESCE placeholders in lib/queries/analysis.ts.
  const EMITTED = [
    "static_lookup",
    "auto",
    "auto_option",
    "auto_ai",
    "manual",
    "unclassified",
    "auto_default",
    "csv_import",
    "none",
  ];

  it("has a plain-language label for every emitted value", () => {
    for (const value of EMITTED) {
      expect(CLASSIFICATION_METHOD_LABELS[value], value).toBeTruthy();
      const label = classificationMethodLabel(value);
      expect(label, value).not.toContain("_");
      if (value.includes("_")) expect(label).not.toBe(value);
    }
  });

  it("never prints an unknown stored value raw", () => {
    expect(classificationMethodLabel("some_new_method")).toBe("some new method");
    expect(classificationMethodLabel(null)).toBe(CLASSIFICATION_METHOD_LABELS.none);
    expect(classificationMethodLabel("STATIC_LOOKUP")).toBe(CLASSIFICATION_METHOD_LABELS.static_lookup);
  });

  it("the Classification legend prints labels, not stored values", () => {
    const html = renderCard();
    expect(html).toContain("reference table");
    expect(html).not.toContain("static_lookup");
    expect(html).not.toContain("auto_option");
  });

  it("the Factor Coverage legend reuses the same mapping and masks its counts", () => {
    const factorCoverage: FactorCoverage = {
      totalHoldings: 43,
      withFactors: 41,
      coveragePct: 95.3,
      bySource: [
        { source: "auto", count: 29 },
        { source: "csv_import", count: 8 },
        { source: "auto_default", count: 6 },
      ],
    };
    const render = () =>
      renderToStaticMarkup(
        <ToastProvider>
          <FactorModeCard factorCoverage={factorCoverage} scope="all" />
        </ToastProvider>,
      );
    const open = render();
    expect(open).toContain(CLASSIFICATION_METHOD_LABELS.csv_import);
    expect(open).toContain(CLASSIFICATION_METHOD_LABELS.auto_default);
    expect(open).not.toContain("csv_import");
    expect(open).not.toContain("auto_default");
    expect(open).toMatch(/>29<\/span>/);

    privacy.on = true;
    const masked = render();
    expect(masked).toContain(MASK);
    expect(masked).not.toMatch(/>\s*(41|43|29|8|6)\s*</);

    const src = readFileSync("app/dashboard/components/analysis/FactorModeCard.tsx", "utf8");
    anchorIndex(src, "classificationMethodLabel(s.source)");
    // A bare `{s.source}` text child (the `key={s.source}` attribute is fine).
    expect(src).not.toMatch(/^\s*\{s\.source\}\s*$/m);
  });
});

describe("Show Details always renders something", () => {
  const details = (cov: ClassificationCoverage) =>
    renderToStaticMarkup(<ClassificationDetails coverage={cov} />);

  it("at full coverage it states that nothing is outstanding", () => {
    const html = details(
      coverage({ total: 43, classified: 43, unclassified: 0, coverage_pct: 100, unclassified_securities: [] }),
    );
    expect(html).toContain("held securities are classified");
    expect(html).toContain("Nothing is outstanding");
    expect(html).toContain(">43<");
  });

  it("the full-coverage count masks in privacy mode", () => {
    privacy.on = true;
    const html = details(
      coverage({ total: 43, classified: 43, unclassified: 0, coverage_pct: 100, unclassified_securities: [] }),
    );
    expect(html).toContain(MASK);
    expect(html).not.toContain("43");
  });

  it("an empty scope says so instead of rendering nothing", () => {
    const html = details(
      coverage({ total: 0, classified: 0, unclassified: 0, coverage_pct: 0, by_source: [], unclassified_securities: [] }),
    );
    expect(html).toContain("nothing to classify");
  });

  it("below full coverage it lists the unclassified securities", () => {
    const html = details(coverage());
    expect(html).toContain("Unclassified Securities");
    expect(html).toContain("AAA");
    expect(html).toContain("ZZZ");
  });

  it("the card opens the details through that one component, with no length gate on the toggle", () => {
    const src = readFileSync("app/dashboard/components/analysis/ClassificationCard.tsx", "utf8");
    anchorIndex(src, "{showCoverage && <ClassificationDetails coverage={coverage} />}");
    expect(src).not.toMatch(/showCoverage\s*&&\s*coverage\.unclassified_securities\.length/);
  });
});

describe("Auto-Classify completion line names both populations", () => {
  it("says the tally covers the whole security list and the card counts holdings only", () => {
    const line = classifyRunSummary({ classified: 55, skipped: 900, unresolvedCount: 0 }, [], 10);
    expect(line).toContain("Classified 55 securities across the whole security list");
    expect(line).toContain("not only current holdings");
    expect(line).toContain("900 already classified");
    expect(line).toContain("this card counts current holdings only and listed 10 unclassified before the run");
    expect(line).not.toContain("already done");
  });

  it("leaves the card's own count out when it is withheld (privacy mode) or zero", () => {
    for (const held of [null, 0]) {
      const line = classifyRunSummary({ classified: 3, skipped: 5, unresolvedCount: 0 }, [], held);
      expect(line).toMatch(/this card counts current holdings only$/);
    }
  });

  it("keeps the unresolved and AI-failure parts, and survives a malformed response", () => {
    const line = classifyRunSummary({ classified: 1, skipped: "x", unresolvedCount: 2 }, ["bad JSON"], 4);
    expect(line).toContain("Classified 1 security across");
    expect(line).toContain("0 already classified");
    expect(line).toContain("2 couldn't be auto-classified");
    expect(line).toContain("AI step failed: bad JSON");
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("NaN");
  });

  it("the card passes its held-unclassified count, withheld in privacy mode", () => {
    const src = readFileSync("app/dashboard/components/analysis/ClassificationCard.tsx", "utf8");
    const at = anchorIndex(src, "classifyRunSummary(\n              data,");
    expect(src.slice(at, at + 200)).toContain("isPrivate ? null : coverage.unclassified_securities.length");
  });
});
