/**
 * Pending-statement UI (spec
 * docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md
 * §2.2, §3 items 6 and 11).
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
  PendingStatementLine,
  TaxLotSummaryCards,
} from "@/app/dashboard/components/TaxLotSummary";
import {
  PENDING_STATEMENT_CHIP_LABEL,
  PENDING_STATEMENT_TITLE,
  STATEMENT_LAG_LABEL,
} from "@/app/dashboard/components/pending-statement-copy";
import type { TaxLotSummary } from "@/lib/queries/tax-lots";

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
    pendingStatementPositions: 0,
    pendingStatementLots: 0,
    pendingStatementBasis: 0,
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

describe("PendingStatementLine (summary disclosure)", () => {
  it("names the count and the basis, and says the lots are out of Unrealized", () => {
    const html = renderToStaticMarkup(<PendingStatementLine positions={2} basis={1100} />);
    expect(html).toContain("Positions closed per live data: <span>2</span> —");
    expect(html).toContain("awaiting statement");
    expect(html).toContain("$1,100");
    expect(html).toContain("excluded from Unrealized");
  });

  it("the noun does not change with the count (a masked count must not leak one-vs-many)", () => {
    const one = renderToStaticMarkup(<PendingStatementLine positions={1} basis={10} />);
    expect(one).toContain("Positions closed per live data: <span>1</span>");
    privacyState.isPrivate = true;
    const maskedOne = renderToStaticMarkup(<PendingStatementLine positions={1} basis={10} />);
    const maskedMany = renderToStaticMarkup(<PendingStatementLine positions={7} basis={10} />);
    privacyState.isPrivate = false;
    expect(maskedOne).toBe(maskedMany);
  });

  it("renders nothing when no position is pending", () => {
    expect(renderToStaticMarkup(<PendingStatementLine positions={0} basis={0} />)).toBe("");
  });

  it("privacy mode masks the count and the basis, keeping the prose", () => {
    privacyState.isPrivate = true;
    const html = renderToStaticMarkup(<PendingStatementLine positions={2} basis={1100} />);
    expect(html).toContain(`Positions closed per live data: <span>${MASK}</span>`);
    expect(html).not.toContain("1,100");
    expect(html).not.toMatch(/>2</);
  });

  it("TaxLotSummaryCards renders the line from the summary's pending fields", () => {
    const html = renderToStaticMarkup(
      <TaxLotSummaryCards
        summary={summary({ pendingStatementPositions: 3, pendingStatementLots: 4, pendingStatementBasis: 900 })}
        year={2026}
      />
    );
    expect(html).toContain("Positions closed per live data: <span>3</span>");
    const none = renderToStaticMarkup(<TaxLotSummaryCards summary={summary()} year={2026} />);
    expect(none).not.toContain("closed per live data");
  });
});

describe("Open Lots table chip (source pin — client component)", () => {
  const src = readFileSync("app/dashboard/components/TaxLotTables.tsx", "utf8");

  it("renders a <Chip> with the shared label, gated on the shared flag", () => {
    expect(src).toMatch(
      /\{lot\.pending_statement && \([\s\S]{0,120}<Chip tone="neutral" size="xs" title=\{PENDING_STATEMENT_TITLE\}>\s*\{PENDING_STATEMENT_CHIP_LABEL\}\s*<\/Chip>/
    );
  });

  it("imports the copy from the shared module (no inline duplicate)", () => {
    expect(src).toMatch(
      /import \{ PENDING_STATEMENT_CHIP_LABEL, PENDING_STATEMENT_TITLE \} from "\.\/pending-statement-copy";/
    );
    expect(src).not.toMatch(/>\s*pending statement\s*</);
  });
});

describe("Tax Lots page filtered reducer (source pin)", () => {
  const src = readFileSync("app/dashboard/tax-lots/page.tsx", "utf8");

  it("splits rows by the shared pending_statement flag", () => {
    expect(src).toContain("const pendingStatementRows = capitalOpenLots.filter((l) => l.pending_statement);");
    expect(src).toContain("const heldOpenLots = capitalOpenLots.filter((l) => !l.pending_statement);");
  });

  it("unrealized sums held lots only; the pending fields come from the pending rows", () => {
    expect(src).toMatch(/totalUnrealizedGain: heldOpenLots\.reduce\(/);
    expect(src).not.toMatch(/totalUnrealizedGain: openLots\.reduce\(/);
    expect(src).toMatch(/pendingStatementLots: pendingStatementRows\.length/);
    expect(src).toMatch(/pendingStatementPositions: new Set\(\s*pendingStatementRows\.map/);
    expect(src).toMatch(/pendingStatementBasis: pendingStatementRows\.reduce\(/);
  });

  it("never re-derives pending locally (no holdings-source vocabulary in the page)", () => {
    expect(src).not.toMatch(/holding-sources|recon:closed-equity|:live|tws-|plaid:/);
  });
});

describe("Security detail open lots (source pin)", () => {
  const src = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");

  it("shows the shared chip in place of the unrealized figure for a pending lot", () => {
    expect(src).toMatch(
      /\{lot\.pending_statement \? \(\s*<Chip tone="neutral" size="xs" title=\{PENDING_STATEMENT_TITLE\}>\s*\{PENDING_STATEMENT_CHIP_LABEL\}\s*<\/Chip>\s*\) : \(\s*<Money value=\{lot\.unrealized_gain\} fallback="–" \/>\s*\)\}/
    );
  });
});

describe("Data-confidence popover (source pin)", () => {
  const src = readFileSync("app/dashboard/components/DataConfidenceIndicator.tsx", "utf8");
  const warningsFn = src.match(/^function IntegrityWarningsRow\([\s\S]*?\n\}/m)?.[0] ?? "";

  it("isolates the warnings row", () => {
    expect(warningsFn).not.toBe("");
  });

  it("labels a statement-lag hit 'awaiting statement' with the shared chip", () => {
    expect(warningsFn).toMatch(
      /\{w\.kind === "statement-lag" && \([\s\S]{0,80}<Chip tone="neutral" size="xs" title=\{PENDING_STATEMENT_TITLE\}>\s*\{STATEMENT_LAG_LABEL\}\s*<\/Chip>/
    );
  });

  it("keeps the reason inside <PrivateText>", () => {
    expect(warningsFn).toMatch(/<PrivateText>\{w\.reason\}<\/PrivateText>/);
  });

  it("statement-lag stays in the warnings (informational) row, never in the critical row", () => {
    const criticalFn = src.match(/^function IntegrityCriticalRow\([\s\S]*?\n\}/m)?.[0] ?? "";
    expect(criticalFn).not.toBe("");
    expect(criticalFn).not.toContain("statement-lag");
  });
});
