import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClassificationCoverage, ConcentrationMetrics } from "@/lib/queries/analysis";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Analysis display consistency:
//   analysis-classification--coverage-100-vs-tilts-31pct-unclassified
//   analysis-classification--coverage-card-lists-unclassified-names-the-sector-breakdown-places
//   analysis-classification--privacy-leaves-per-category-position-counts-unmasked (drill-down title)
//   analysis-copy--internal-dev-references-in-user-facing-text-regression-6 (owned files)
//   analysis-defense--hedge-protects-raw-internal-key-regression-1
//
// No DOM harness: the privacy hook is mocked with a switch (precedent:
// tests/dashboard/classification-card-b10.test.tsx).
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
  CLASSIFICATION_MEASURE_NOTE,
} from "@/app/dashboard/components/analysis/ClassificationCard";
import { ToastProvider } from "@/app/dashboard/components/Toast";
import { titleFor, prettifyDimension } from "@/app/dashboard/components/analysis/DrillDownPanel";
import { protectsLabel } from "@/app/dashboard/components/DefenseTables";

const MASK = "•••";

const OWNED_COMPONENTS = [
  "app/dashboard/components/analysis/ClassificationCard.tsx",
  "app/dashboard/components/AnalysisView.tsx",
  "app/dashboard/components/analysis/DrillDownPanel.tsx",
  "app/dashboard/components/DefenseTables.tsx",
];

function concentration(): ConcentrationMetrics {
  return { hhi: 0.08, effective_positions: 12.5, top_positions: [], warnings: [] };
}

function coverage(overrides: Partial<ClassificationCoverage> = {}): ClassificationCoverage {
  return {
    total: 4,
    classified: 3,
    unclassified: 1,
    coverage_pct: 75,
    by_source: [
      { source: "static_lookup", count: 1 },
      { source: "auto", count: 1 },
      { source: "auto_option", count: 1 },
      { source: "unclassified", count: 1 },
    ],
    unclassified_securities: [{ id: 3, symbol: "CCC", name: "Gamma Co", security_type: "Stock" }],
    ...overrides,
  };
}

beforeEach(() => {
  privacy.on = false;
});

describe("the coverage card names what it measures", () => {
  // The card counts securities with a recorded category / geography / size /
  // style pass. The Sector breakdown reads the sector field and Portfolio
  // Tilts weigh by value, so the three figures are different measures; the
  // copy says so and no number changes.
  const card = () =>
    renderToStaticMarkup(
      <ToastProvider>
        <ClassificationCard concentration={concentration()} coverage={coverage()} />
      </ToastProvider>,
    );

  it("the tile says which fields it covers, that sector is not one, and that it counts securities", () => {
    const html = card();
    expect(html).toMatch(/securities classified \(category, geography, size and style; not sector\)/);
    expect(html).toContain("Counted per security, not by value");
  });

  it("the card explains why the tilts can show Unclassified at full coverage", () => {
    const html = card();
    expect(html).toContain(CLASSIFICATION_MEASURE_NOTE);
    expect(CLASSIFICATION_MEASURE_NOTE).toMatch(/Portfolio Tilts/);
    expect(CLASSIFICATION_MEASURE_NOTE).toMatch(/by value/);
    expect(CLASSIFICATION_MEASURE_NOTE).toMatch(/no size or style/);
  });

  it("the unclassified list says a listed name can already have a sector", () => {
    const html = renderToStaticMarkup(<ClassificationDetails coverage={coverage()} />);
    expect(html).toContain("CCC");
    expect(html).toMatch(/no category, geography, size or style/i);
    expect(html).toMatch(/can already appear in a sector row of the Breakdown/);
  });
});

describe("drill-down title: the holdings count masks and never singularises when masked", () => {
  const sector = { kind: "sector", sector: "Technology" } as const;

  it("shows the count with privacy off", () => {
    expect(titleFor(sector, 1, false)).toBe("Sector: Technology · 1 holding");
    expect(titleFor(sector, 7, false)).toBe("Sector: Technology · 7 holdings");
  });

  it("masked markup for one and for many is identical", () => {
    const one = titleFor(sector, 1, true);
    const many = titleFor(sector, 7, true);
    expect(one).toBe(many);
    expect(one).toBe(`Sector: Technology · ${MASK} holdings`);
    expect(one).not.toMatch(/\d/);
  });

  it("every filter kind masks the count", () => {
    const filters = [
      { kind: "classification", dimension: "geography", bucket: "US" },
      { kind: "factor", factor: "ai_exposure", bucket: "High" },
      sector,
    ] as const;
    for (const f of filters) {
      expect(titleFor(f, 1, true)).toBe(titleFor(f, 12, true));
      expect(titleFor(f, 12, true)).toContain(`${MASK} holdings`);
      expect(titleFor(f, 12, true)).not.toContain("12");
    }
  });

  it("the panel passes the privacy state into its title", () => {
    const src = readFileSync("app/dashboard/components/analysis/DrillDownPanel.tsx", "utf8");
    anchorIndex(src, "titleFor(filter, rows.length, isPrivate)");
  });

  it("a dimension with no label reads as words, never the stored key", () => {
    expect(prettifyDimension("credit_rating")).toBe("Credit rating");
    expect(prettifyDimension("market_cap_category")).toBe("Market Cap");
    expect(prettifyDimension("some_new_dimension")).not.toContain("_");
  });
});

describe("Defense 'Protects' labels", () => {
  // Every shape lib/compute/hedging.ts::describeProxyRoute can emit, plus the
  // plain underlying name a paired hedge carries.
  it("a paired hedge keeps its underlying name", () => {
    expect(protectsLabel("AAA")).toBe("AAA");
    expect(protectsLabel("BRK.B")).toBe("BRK.B");
  });

  it("geography route", () => {
    expect(protectsLabel("geography: US")).toBe("US equities (broad)");
    expect(protectsLabel("geography: Europe")).toBe("Europe equities (broad)");
    expect(protectsLabel("geography: Unknown")).toBe("Equities with no region on file (broad)");
  });

  it("sector route, one sector and several", () => {
    expect(protectsLabel("sector: Technology 100%")).toBe("Technology sector (100%)");
    expect(protectsLabel("sector: Technology 90% / Communication Services 10%")).toBe(
      "Technology sector (90%), Communication Services sector (10%)",
    );
  });

  it("book route", () => {
    expect(protectsLabel("book (β=1.2)")).toBe("Whole portfolio (β=1.2)");
  });

  it("an unknown kind falls back to readable words, never the raw key", () => {
    expect(protectsLabel("asset_class: Fixed Income")).toBe("Asset class: Fixed Income");
    for (const raw of ["geography: US", "sector: Technology 100%", "asset_class: Bond", "book (β=0.8)"]) {
      expect(protectsLabel(raw)).not.toMatch(/^[a-z_]+:/);
    }
  });

  it("the table cell renders the label, not the raw value", () => {
    const src = readFileSync("app/dashboard/components/DefenseTables.tsx", "utf8");
    anchorIndex(src, "{protectsLabel(row.protects)}");
    expect(src).not.toMatch(/>\{row\.protects\}</);
  });
});

describe("no internal names in the owned files' on-screen copy", () => {
  // On-screen copy = JSX text and prose string literals (a quoted string that
  // contains a space). Comments, imports, class names and object keys are
  // code, not copy.
  function copyOf(path: string): string[] {
    const src = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/ .*$/gm, "")
      .replace(/className=(?:"[^"]*"|\{`[^`]*`\})/g, "")
      .replace(/^import[\s\S]*?;$/gm, "");
    const out: string[] = [];
    // A `>` ... `<` span that holds a property access or an operator is a
    // comparison in code (`a.b > 1 ? x : y`), not text between two tags.
    const isCode = (t: string) => /\w\.\w|&&|\|\||\?|=>/.test(t);
    for (const m of src.matchAll(/>([^<>{}=;]*[A-Za-z][^<>{}=;]*)</g)) {
      if (!isCode(m[1])) out.push(m[1].trim());
    }
    // The span between two neighbouring literals (`"a" : x.y > 1 ? "b"`) is
    // code too: it carries a property access beside a ternary.
    const isBetweenLiterals = (t: string) => /\w\.\w/.test(t) && /\s[?:]\s/.test(t);
    for (const m of src.matchAll(/"([^"\n]* [^"\n]*)"/g)) {
      if (!isBetweenLiterals(m[1])) out.push(m[1]);
    }
    for (const m of src.matchAll(/`([^`\n]* [^`\n]*)`/g)) out.push(m[1].replace(/\$\{[^}]*\}/g, ""));
    return out.filter((s) => s.length > 0);
  }

  const BANNED: RegExp[] = [
    /\b[a-z]+_[a-z_]+\b/, // stored keys and column names
    /\bTODO\b/i,
    /\bPhase \d/,
    /\bqa:/,
    /\b(AnalysisView|ClassificationCard|DrillDownPanel|DefenseTables|TrustStrip)\b/,
    /\b(getHoldingsInBucket|computePositionRisk|describeProxyRoute|classifySecurities)\b/,
    /\b(security_factors|securities\.|holdings\.|monthly_snapshots)\b/,
    /\bmigration \d/i,
  ];

  it.each(OWNED_COMPONENTS)("%s", (path) => {
    const copy = copyOf(path);
    expect(copy.length).toBeGreaterThan(5);
    const hits = copy.flatMap((text) =>
      BANNED.filter((re) => re.test(text)).map((re) => `${re} in ${JSON.stringify(text)}`),
    );
    expect(hits).toEqual([]);
  });

  it("the scan does see a banned string when one is present", () => {
    expect(BANNED.some((re) => re.test("or the Classify button in AnalysisView."))).toBe(true);
    expect(BANNED.some((re) => re.test("37 static_lookup"))).toBe(true);
  });
});
