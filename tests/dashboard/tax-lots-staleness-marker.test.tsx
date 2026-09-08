/**
 * QA finding: tax-lots--headline-tiles-stale-until-recompute-no-marker
 * (render half — the state half is tests/compute/tax-convention-staleness.test.ts)
 *
 * USER RULING: the UNREALIZED / REALIZED / LONG-TERM / SHORT-TERM tiles are
 * drawn from STORED tax-lot rows, which can lag the transaction ledger or
 * predate the current engine convention. The page must SAY so, next to the
 * Recompute button, and must never recompute by itself on load.
 *
 * This repo has no jsdom / @testing-library/react (see the precedent note in
 * tests/dashboard/tax-lots-engine-estimated-disclosure.test.tsx), so the
 * notice component is exercised with renderToStaticMarkup — a genuine render
 * pass, since it has no hooks of its own — and the page's WIRING is pinned by
 * reading its source (importing the page would open the real database).
 *
 * `usePrivacy` is mocked off a mutable flag: the ledger-change count is a
 * portfolio-derived count and must mask, while the prose stays readable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { TaxLotStalenessNotice } from "@/app/dashboard/components/TaxLotSummary";
import type { TaxLotStalenessMarker } from "@/lib/compute/tax-convention";

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

function render(marker: TaxLotStalenessMarker): string {
  return renderToStaticMarkup(<TaxLotStalenessNotice marker={marker} />);
}

describe("TaxLotStalenessNotice", () => {
  it("renders nothing when the stored lots are current", () => {
    expect(render({ stale: false, inputChangesSince: null, reason: null })).toBe("");
  });

  it("names the number of ledger changes the figures predate", () => {
    const html = render({ stale: true, inputChangesSince: 8, reason: "behind" });
    expect(html).toContain("These figures predate");
    expect(html).toContain("<span>8</span> ledger changes");
    expect(html).toContain("press Recompute to refresh them.");
  });

  it("uses the singular for a single ledger change", () => {
    const html = render({ stale: true, inputChangesSince: 1, reason: "behind" });
    expect(html).toContain("<span>1</span> ledger change ");
    expect(html).not.toContain("ledger changes");
  });

  it("says the figures come from an earlier lot convention, and how far back", () => {
    const html = render({ stale: true, inputChangesSince: 8, reason: "legacy" });
    expect(html).toContain(
      "These figures were computed under an earlier lot convention"
    );
    // The superseded convention is the headline, but the ledger distance is
    // the user's ruling and is named too.
    expect(html).toContain("<span>8</span> ledger changes ago");
    expect(html).toContain("press Recompute to refresh them.");
  });

  it("drops the count from the convention message when it is unknown", () => {
    const html = render({ stale: true, inputChangesSince: null, reason: "legacy" });
    expect(html).toContain(
      "These figures were computed under an earlier lot convention"
    );
    expect(html).toContain("press Recompute to refresh them.");
    expect(html).not.toContain("ledger change");
  });

  it("says the figures carry no recompute stamp at all", () => {
    const html = render({ stale: true, inputChangesSince: null, reason: "never" });
    expect(html).toContain("These figures have no recompute stamp");
    expect(html).toContain("press Recompute to refresh them.");
  });

  it("falls back to a countless sentence when the change count is unknown", () => {
    const html = render({ stale: true, inputChangesSince: null, reason: "behind" });
    expect(html).toContain("These figures do not match the current ledger");
    expect(html).toContain("press Recompute to refresh them.");
    expect(html).not.toContain("—</span>"); // never an empty <Count> dash
  });

  it("masks the ledger-change count in privacy mode, keeping the prose", () => {
    privacyState.isPrivate = true;
    const html = render({ stale: true, inputChangesSince: 8, reason: "behind" });
    expect(html).toContain(`<span>${MASK}</span> ledger changes`);
    expect(html).not.toContain(">8<");
    expect(html).toContain("press Recompute to refresh them.");
  });

  it("is announced as a status and uses the theme's warning tokens", () => {
    const html = render({ stale: true, inputChangesSince: 2, reason: "behind" });
    expect(html).toContain('role="status"');
    expect(html).toContain("text-warn");
    // No raw palette colours — the amber tokens are theme-aware (globals.css).
    expect(html).not.toContain("amber-400");
  });
});

describe("tax lots page wiring", () => {
  const src = readFileSync("app/dashboard/tax-lots/page.tsx", "utf8");

  it("reads the tax convention state from the single source", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*getTaxConventionState[^}]*\}\s*from\s*"@\/lib\/compute\/tax-convention"/
    );
    expect(src).toMatch(/describeTaxLotStaleness\(/);
    expect(src).toContain("getTaxConventionState(db)");
  });

  it("shows the notice only when the page has data and the lots are stale", () => {
    expect(src).toMatch(/hasData\s*&&\s*\w*[sS]taleness\w*\.stale\s*&&/);
    expect(src).toContain("<TaxLotStalenessNotice");
  });

  it("keeps the notice adjacent to the Recompute button", () => {
    const noticeAt = src.indexOf("<TaxLotStalenessNotice");
    const buttonAt = src.indexOf('<RecomputeButton endpoint="/api/compute/tax-lots"');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(noticeAt);
    // Same JSX block — nothing but the notice sits between them.
    expect(src.slice(noticeAt, buttonAt)).not.toContain("</div>");
  });

  it("never recomputes on load — the page only ever reads", () => {
    expect(src).not.toContain("computeTaxLots");
    expect(src).not.toMatch(/stampTaxLotsConvention|bumpTaxInputGeneration/);
  });
});
