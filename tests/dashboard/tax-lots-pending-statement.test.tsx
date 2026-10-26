/**
 * Pending-statement UI on the Tax Lots page (spec
 * docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md
 * §2.2; options and shorts: plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 9). The security-page pins live in
 * tests/dashboard/security-page-pending-chips.test.ts and the popover pins in
 * tests/dashboard/data-confidence-pending-kinds.test.ts (ruling R16).
 *
 * No jsdom in this repo: hook-free server components (the summary line, the
 * summary cards) get a genuine renderToStaticMarkup pass with the privacy
 * context mocked; client components and the pages (hooks / the real db
 * singleton) are pinned by source scans. Every anchor fails when missing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PendingStatementLines,
  TaxLotSummaryCards,
} from "@/app/dashboard/components/TaxLotSummary";
import {
  PENDING_STATEMENT_CHIP_LABEL,
  PENDING_STATEMENT_TITLE,
  STATEMENT_LAG_LABEL,
  pendingFigureWords,
  pendingLineAction,
  pendingLineLead,
} from "@/app/dashboard/components/pending-statement-copy";
import type { TaxLotSummary } from "@/lib/queries/tax-lots";
import type { PendingDisclosureRow } from "@/lib/queries/pending-statement-types";
import { anchorIndex } from "@/tests/helpers/source-anchor";

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

beforeEach(() => {
  privacyState.isPrivate = false;
});

function summary(over: Partial<TaxLotSummary> = {}): TaxLotSummary {
  return {
    totalOpenLots: 5,
    totalClosedSales: 0,
    totalUnrealizedGain: 100,
    totalRealizedGain: 0,
    longTermGain: 0,
    shortTermGain: 0,
    excludedNonUsdSales: 0,
    engineEstimatedSales: 0,
    engineEstimatedGain: 0,
    engineEstimatedLongTermSales: 0,
    engineEstimatedLongTermGain: 0,
    engineEstimatedShortTermSales: 0,
    engineEstimatedShortTermGain: 0,
    pendingStatement: [],
    ...over,
  };
}

describe("shared copy", () => {
  it("the chip and popover labels stand alone in domain language", () => {
    expect(PENDING_STATEMENT_CHIP_LABEL).toBe("pending statement");
    expect(STATEMENT_LAG_LABEL).toBe("awaiting statement");
    expect(PENDING_STATEMENT_TITLE).toMatch(/closed per live broker data/i);
    expect(PENDING_STATEMENT_TITLE).toMatch(/excluded from Unrealized/);
  });
});

// Synthetic disclosure rows (never real figures).
function row(over: Partial<PendingDisclosureRow> & Pick<PendingDisclosureRow, "reason" | "side">): PendingDisclosureRow {
  const side = over.side;
  return {
    positions: 1,
    lots: 1,
    figure: 100,
    figureKind: side === "short" ? "short_sale_proceeds" : "cost_basis",
    ...over,
  };
}
const AWAITING_LONG = row({ reason: "awaiting_statement", side: "long", positions: 2, lots: 3, figure: 1100 });
const MISSING_LONG = row({ reason: "closing_entry_missing", side: "long", positions: 1, lots: 1, figure: 320 });
const MISSING_SHORT = row({ reason: "closing_entry_missing", side: "short", positions: 1, lots: 2, figure: 450 });
const RESYMBOL_LONG = row({ reason: "resymbol_repair_pending", side: "long", positions: 1, lots: 1, figure: 75 });

describe("PendingStatementLines (summary disclosure)", () => {
  it("names the count and the cost basis, and says the lots are out of Unrealized", () => {
    const html = renderToStaticMarkup(<PendingStatementLines rows={[AWAITING_LONG]} />);
    expect(html).toContain(`${pendingLineLead("awaiting_statement")}: <span>2</span>`);
    expect(html).toContain("$1,100");
    expect(html).toContain(pendingFigureWords("cost_basis"));
    expect(html).toContain("excluded from Unrealized");
    expect(html).toContain(pendingLineAction("awaiting_statement"));
  });

  it("two lines when two reasons exist; re-symbol line only when present", () => {
    const two = renderToStaticMarkup(<PendingStatementLines rows={[AWAITING_LONG, MISSING_LONG]} />);
    expect(two.match(/<p /g)?.length).toBe(2);
    expect(two).toContain(pendingLineLead("awaiting_statement"));
    expect(two).toContain(pendingLineLead("closing_entry_missing"));
    expect(two).toContain(pendingLineAction("closing_entry_missing"));
    expect(two).not.toContain(pendingLineLead("resymbol_repair_pending"));
    // Shared reason order: awaiting before closing entry missing.
    expect(two.indexOf(pendingLineLead("awaiting_statement"))).toBeLessThan(
      two.indexOf(pendingLineLead("closing_entry_missing"))
    );

    const three = renderToStaticMarkup(
      <PendingStatementLines rows={[AWAITING_LONG, MISSING_LONG, RESYMBOL_LONG]} />
    );
    expect(three.match(/<p /g)?.length).toBe(3);
    expect(three).toContain(pendingLineLead("resymbol_repair_pending"));
    expect(three).toContain(pendingLineAction("resymbol_repair_pending"));
  });

  it("a two-sided bracket prints two figures and no sum", () => {
    const html = renderToStaticMarkup(<PendingStatementLines rows={[MISSING_LONG, MISSING_SHORT]} />);
    // One paragraph for the one reason; both sides in its bracket.
    expect(html.match(/<p /g)?.length).toBe(1);
    expect(html).toContain(`${pendingLineLead("closing_entry_missing")}: <span>2</span>`);
    expect(html).toContain("$320");
    expect(html).toContain(pendingFigureWords("cost_basis"));
    expect(html).toContain("$450");
    expect(html).toContain(pendingFigureWords("short_sale_proceeds"));
    // Never a combined figure: neither the sum nor the difference.
    expect(html).not.toContain("$770");
    expect(html).not.toContain("$130");
    // A short side is never called cost basis.
    const shortOnly = renderToStaticMarkup(<PendingStatementLines rows={[MISSING_SHORT]} />);
    expect(shortOnly).not.toContain("cost basis");
    expect(shortOnly).toContain("short-sale proceeds");
  });

  it("the noun does not change with the count (a masked count must not leak one-vs-many)", () => {
    const one = renderToStaticMarkup(<PendingStatementLines rows={[{ ...AWAITING_LONG, positions: 1 }]} />);
    expect(one).toContain(`${pendingLineLead("awaiting_statement")}: <span>1</span>`);
    privacyState.isPrivate = true;
    const maskedOne = renderToStaticMarkup(
      <PendingStatementLines rows={[{ ...AWAITING_LONG, positions: 1, figure: 10 }]} />
    );
    const maskedMany = renderToStaticMarkup(
      <PendingStatementLines rows={[{ ...AWAITING_LONG, positions: 7, figure: 10 }]} />
    );
    expect(maskedOne).toBe(maskedMany);
  });

  it("renders nothing when no position is pending", () => {
    expect(renderToStaticMarkup(<PendingStatementLines rows={[]} />)).toBe("");
  });

  it("Hide amounts masks every new figure and count", () => {
    privacyState.isPrivate = true;
    const html = renderToStaticMarkup(
      <PendingStatementLines rows={[AWAITING_LONG, MISSING_LONG, MISSING_SHORT, RESYMBOL_LONG]} />
    );
    for (const reason of ["awaiting_statement", "closing_entry_missing", "resymbol_repair_pending"] as const) {
      expect(html).toContain(`${pendingLineLead(reason)}: <span>${MASK}</span>`);
    }
    for (const figure of ["1,100", "320", "450", "75"]) expect(html).not.toContain(figure);
    expect(html).not.toMatch(/>\s*\d+\s*</);
    expect(html).not.toMatch(/\$\d/);
    // The prose (and the words naming each figure) stay.
    expect(html).toContain(pendingFigureWords("short_sale_proceeds"));
  });

  it("TaxLotSummaryCards renders the lines from the summary's pending list", () => {
    const html = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary({ pendingStatement: [AWAITING_LONG, MISSING_SHORT] })} year={2026} />
    );
    expect(html).toContain(`${pendingLineLead("awaiting_statement")}: <span>2</span>`);
    expect(html).toContain(`${pendingLineLead("closing_entry_missing")}: <span>1</span>`);
    const none = renderToStaticMarkup(<TaxLotSummaryCards summary={summary()} year={2026} />);
    expect(none).not.toContain(pendingLineLead("awaiting_statement"));
    expect(none).not.toContain("excluded from Unrealized");
  });
});

describe("Open Lots table chip (source pin — client component)", () => {
  const src = readFileSync("app/dashboard/components/TaxLotTables.tsx", "utf8");

  it("renders a <Chip> whose label and title come from the lot's own reason", () => {
    expect(src).toMatch(
      /\{lot\.pending_statement && !lot\.expired_option && lot\.pending_statement_reason && \([\s\S]{0,120}<Chip tone="neutral" size="xs" wrap title=\{pendingChipTitle\(lot\.pending_statement_reason\)\}>\s*\{pendingChipLabel\(lot\.pending_statement_reason\)\}\s*<\/Chip>/
    );
  });

  it("an expired row never carries a pending chip (the gate names expired_option)", () => {
    const at = anchorIndex(src, "{lot.pending_statement && !lot.expired_option");
    expect(at).toBeGreaterThan(0);
  });

  it("keeps the Short sale chip", () => {
    expect(src).toContain('{lot.is_short === 1 && <> <Chip tone="gold" size="xs">Short sale</Chip></>}');
  });

  it("imports the copy from the shared module (no inline duplicate)", () => {
    expect(src).toMatch(/import \{ pendingChipLabel, pendingChipTitle \} from "\.\/pending-statement-copy";/);
    expect(src).not.toMatch(/>\s*pending statement\s*</);
    expect(src).not.toMatch(/>\s*closing entry missing\s*</);
    expect(src).not.toContain("PENDING_STATEMENT_TITLE");
  });
});

describe("Tax Lots page filtered reducer (source pin)", () => {
  const src = readFileSync("app/dashboard/tax-lots/page.tsx", "utf8");

  it("splits rows by the shared pending_statement flag", () => {
    expect(src).toContain("const pendingStatementRows = capitalOpenLots.filter((l) => l.pending_statement);");
    expect(src).toContain("const heldOpenLots = capitalOpenLots.filter((l) => !l.pending_statement);");
  });

  it("unrealized sums held lots only; the pending list is the shared reducer over the pending rows", () => {
    expect(src).toMatch(/totalUnrealizedGain: heldOpenLots\.reduce\(/);
    expect(src).not.toMatch(/totalUnrealizedGain: openLots\.reduce\(/);
    expect(src).toContain("pendingStatement: reducePendingDisclosure(pendingDisclosureInputs),");
    expect(src).toMatch(/const pendingDisclosureInputs: PendingDisclosureInput\[\] = pendingStatementRows\.flatMap\(/);
    expect(src).toContain("reason: l.pending_statement_reason,");
    expect(src).toContain("is_short: l.is_short,");
    // The three old scalars are gone.
    expect(src).not.toMatch(/pendingStatementPositions|pendingStatementLots|pendingStatementBasis/);
  });

  it("the page builds no pending key by hand", () => {
    // No account:security template key, no Set of keys, no key helper: the
    // reducer is the only place a position is identified.
    expect(src).not.toMatch(/`\$\{l\.account_id\}:\$\{l\.security_id\}/);
    expect(src).not.toMatch(/new Set\(\s*pendingStatementRows/);
    expect(src).not.toMatch(/pendingStatementKey|pendingStatementKeySet/);
    // And it never sums the pending figures itself.
    expect(src).not.toMatch(/pendingStatementRows\.reduce\(/);
  });

  it("?pending=1 narrows the table to every pending lot, whatever its reason", () => {
    expect(src).toContain('const pendingOnly = searchParams.pending === "1" && pendingStatementRows.length > 0;');
    expect(src).toContain("lots={pendingOnly ? pendingStatementRows : capitalOpenLots}");
    expect(src).not.toMatch(/pending_statement_reason === "awaiting_statement"/);
  });

  it("never re-derives pending locally (no holdings-source vocabulary in the page)", () => {
    expect(src).not.toMatch(/holding-sources|recon:closed-equity|:live|tws-|plaid:/);
  });
});
