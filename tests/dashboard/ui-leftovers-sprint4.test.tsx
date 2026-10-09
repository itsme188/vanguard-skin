/**
 * Small UI leftovers from the 2026-10-08 night sprint.
 *
 *  1. Remove / undo / clear / rotate questions are asked in the app's own
 *     dialog (useConfirmPrompt), and a declined question sends nothing.
 *  2. A noun beside a MASKED count never switches between singular and
 *     plural: the switch says whether the hidden count is one.
 *  3. Security page section titles mask their counts.
 *  4. Tax Report tiles use the same noun-first form as the summary tiles.
 *  5. The wash-sale warning type no longer declares the removed description.
 *  6. No comment still points at the deleted stapled-wrap sender file.
 *  7. Tax Lots and Alerts name themselves in the browser tab.
 *
 * No DOM harness in this repo: pure helpers and hook-free components are
 * rendered with renderToStaticMarkup, handlers and server pages are
 * source-pinned.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import { plainDeleteCopy } from "@/app/dashboard/today/EarningsDeleteButton";
import { Section } from "@/app/dashboard/components/Section";
import { Count } from "@/lib/privacy/components";

const privacyState = vi.hoisted(() => ({ isPrivate: false }));
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({
    isPrivate: privacyState.isPrivate,
    setPrivate: () => {},
    toggle: () => {},
  }),
  PrivacyProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const MASK = "•••";

beforeEach(() => {
  privacyState.isPrivate = false;
});

const read = (file: string) => readFileSync(file, "utf8");

describe("1. questions are asked in the app dialog", () => {
  it("the earnings remove copy names the source and what a vendor removal means", () => {
    const manual = plainDeleteCopy("ZZA", "manual");
    expect(manual.title).toBe("Remove this manually-added earnings event for ZZA?");
    expect(manual.message).toContain("hand-entered");
    expect(manual.confirmLabel).toBe("Remove");

    const vendor = plainDeleteCopy("ZZA", "finnhub");
    expect(vendor.title).toBe("Remove this finnhub-sourced earnings event for ZZA?");
    expect(vendor.message).toContain("stay removed across calendar syncs");
    expect(vendor.message).toContain('"+ Add ticker"');

    expect(plainDeleteCopy(null, "manual").title).toBe("Remove this manually-added earnings event?");
  });

  it("EarningsDeleteButton asks through the hook and returns before any request when declined", () => {
    const src = read("app/dashboard/today/EarningsDeleteButton.tsx");
    anchorIndex(src, "const prompt = useConfirmPrompt();");
    const click = sliceBetween(src, "async function handleClick()", "const copy =");
    const ask = anchorIndex(click, "if (!(await prompt.ask(");
    const send = anchorIndex(click, "void remove(false);");
    expect(ask).toBeLessThan(send);
    expect(click.slice(ask, send)).toContain("return;");
    expect(click).toContain('variant: "danger"');
    anchorIndex(src, "{prompt.dialog}");
  });

  const HANDLERS: Array<{ file: string; handler: string; end: string; request: string }> = [
    {
      file: "app/dashboard/components/ImportHistory.tsx",
      handler: "const handleUndo = async",
      end: "return (",
      request: "await apiFetch(",
    },
    {
      file: "app/dashboard/components/CorporateActionsSection.tsx",
      handler: "async function handleUndo(",
      end: "function formatRatio(",
      request: "await apiFetch(",
    },
    {
      file: "app/dashboard/components/SecuritySection.tsx",
      handler: "async function handleRotateCredential()",
      end: "// --- Convenience PIN ---",
      request: "await api.rotateServiceCredential()",
    },
    {
      file: "app/dashboard/components/NotesAmbient.tsx",
      handler: "const handleClear = useCallback",
      end: "// Closed: render nothing",
      request: 'setDraft("");',
    },
  ];

  for (const { file, handler, end, request } of HANDLERS) {
    it(`${path.basename(file)} awaits the app dialog before it acts`, () => {
      const src = read(file);
      anchorIndex(src, 'import { useConfirmPrompt } from "');
      anchorIndex(src, "const prompt = useConfirmPrompt();");
      anchorIndex(src, "{prompt.dialog}");
      const body = sliceBetween(src, handler, end);
      const ask = anchorIndex(body, "await prompt.ask(");
      const act = anchorIndex(body, request);
      expect(ask).toBeLessThan(act);
      expect(body.slice(ask, act)).toMatch(/\breturn;/);
    });
  }

  it("ImportHistory calls the hook before its empty-list early return (hook order)", () => {
    const src = read("app/dashboard/components/ImportHistory.tsx");
    expect(anchorIndex(src, "const prompt = useConfirmPrompt();")).toBeLessThan(
      anchorIndex(src, "if (batches.length === 0) {"),
    );
  });

  it("a corporate-action failure is said on the page, not in a browser alert", () => {
    const src = read("app/dashboard/components/CorporateActionsSection.tsx");
    anchorIndex(src, "setActionError(");
    anchorIndex(src, "{actionError && (");
  });
});

describe("2. nouns beside a masked count do not switch", () => {
  it("security page: open-lot basis note, sign-mismatch line and excluded trips", () => {
    const page = read("app/dashboard/security/[id]/page.tsx");
    const note = sliceBetween(page, "{unknownBasisLotNotes.map((note) => (", "{basisDisagreements.length > 0 && (");
    expect(note).toContain("Open-lot cost basis below: <Money value={note.lotCostBasis} />");
    expect(note).not.toContain("lotCount === 1");

    const mismatch = sliceBetween(page, "{lotSignMismatches.map((m) => (", "{expiredOptionLotsAwaitingClose.length > 0 && (");
    expect(mismatch).toContain("(open lots: <Count value={m.longLotCount} />)");
    expect(mismatch).not.toContain("longLotCount === 1");

    const trips = sliceBetween(page, "{tradeGradesExcluded > 0 && (", "{tradeGrades.some(");
    expect(trips).toContain("Trips excluded: <Count value={tradeGradesExcluded} />");
    expect(trips).not.toContain("=== 1");

    // No count-keyed word switch is left anywhere on the page.
    expect(page).not.toMatch(/(?:Count|count|length|Excluded) === 1 \? "/);
  });

  it("tax lots page: the expired line leads with the plural noun", () => {
    const src = read("app/dashboard/tax-lots/page.tsx");
    const line = sliceBetween(src, "{expiredOptionContractCount > 0 && (", "<TaxReportCard");
    expect(line).toContain("Expired contracts awaiting a closing entry: <Count value={expiredOptionContractCount} />");
    expect(line).not.toContain("=== 1");
  });

  it("tax report card: the engine-estimated line leads with the plural noun", () => {
    const src = read("app/dashboard/components/TaxReportCard.tsx");
    expect(src).not.toMatch(/count === 1\s*\?/);
    expect(src).toMatch(
      /\{excludedEngineCloses > 0 && \(\s*<p[^>]*>\s*\{ENGINE_ESTIMATED_EXCLUDED_LABEL\}: <Count value=\{excludedEngineCloses\} \/>\. \{ENGINE_ESTIMATED_EXCLUDED_TAIL\}/,
    );
  });
});

describe("3. security page section titles mask their counts", () => {
  it("Section takes a node title, so a count can sit behind <Count>", () => {
    const title = (
      <>
        Open Tax Lots · <Count value={4} />
      </>
    );
    const shown = renderToStaticMarkup(<Section title={title}>body</Section>);
    expect(shown).toContain("Open Tax Lots · <span>4</span>");

    privacyState.isPrivate = true;
    const hidden = renderToStaticMarkup(<Section title={title}>body</Section>);
    expect(hidden).toContain(`Open Tax Lots · <span>${MASK}</span>`);
    expect(hidden).not.toContain(">4<");
  });

  it("the portfolio-derived titles render through <Count>, never a template literal", () => {
    const page = read("app/dashboard/security/[id]/page.tsx");
    anchorIndex(page, "Open Tax Lots · <Count value={openTaxLots.length} />");
    anchorIndex(page, "Recent Sales · <Count value={closedSales.length} /> of <Count value={closedSalesTotal} />");
    anchorIndex(page, "Recent Sales · <Count value={closedSales.length} />\n");
    anchorIndex(page, "AI Trade Grades · <Count value={tradeGrades.length} />");
    anchorIndex(page, "Related Options · <Count value={relatedOptions.length} />");
    expect(page).not.toMatch(/`(?:Open Tax Lots|Recent Sales|AI Trade Grades|Related Options) · \$\{/);
  });
});

describe("4. tax report tiles use the summary tiles' noun-first form", () => {
  it("Sales: N / Total sales: N", () => {
    const src = read("app/dashboard/components/TaxReportCard.tsx");
    const grid = sliceBetween(src, "{/* Summary grid */}", "{retirementNote && (");
    expect(grid).toContain("Sales: <Count value={report.shortTermRows?.length ?? 0} />");
    expect(grid).toContain("Sales: <Count value={report.longTermRows?.length ?? 0} />");
    expect(grid).toContain("Total sales: <Count value={totalSales} />");
    expect(grid).not.toMatch(/\/> (?:total )?sales/);
  });
});

describe("5. the removed wash-sale description is gone from the card", () => {
  it("neither the local type nor the comment names it", () => {
    const src = read("app/dashboard/components/TaxReportCard.tsx");
    const type = sliceBetween(src, "washSaleWarnings: {", "}[];");
    expect(type).not.toContain("description");
    expect(src).not.toContain("WashSaleWarning.description");
  });
});

describe("6. no comment points at the deleted stapled-wrap sender", () => {
  // Built from parts so this file does not match its own scan.
  const NAME = ["wrap", "send"].join("-");

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "fixtures") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it("the file is gone, and only its own absence guard still names it", () => {
    expect(existsSync(`lib/earnings/${NAME}.ts`)).toBe(false);
    const mentions = [...walk("lib"), ...walk("app"), ...walk("tests")]
      .filter((file) => read(file).includes(NAME))
      .sort();
    expect(mentions).toEqual(["tests/repo/one-claim-owner.test.ts"]);
  });
});

describe("7. browser tab titles", () => {
  it("Tax Lots and Alerts set a fixed title with no ticker or figure", () => {
    const taxLots = read("app/dashboard/tax-lots/page.tsx");
    anchorIndex(taxLots, 'export const metadata = { title: "Tax Lots" };');
    expect(taxLots).not.toContain("generateMetadata");

    // The Alerts page is a client component, which cannot export metadata;
    // its segment layout carries the title.
    const alertsLayout = read("app/dashboard/alerts/layout.tsx");
    anchorIndex(alertsLayout, 'export const metadata = { title: "Alerts" };');
    expect(alertsLayout).not.toContain('"use client"');
    expect(alertsLayout).not.toContain("generateMetadata");

    // The root template appends the app name.
    anchorIndex(read("app/layout.tsx"), 'template: "%s · Portfolio Desk"');
  });
});
