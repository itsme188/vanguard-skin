/**
 * QA finding mobile-security-detail--tables-clip-right-columns-no-scrollfade-regression-1:
 * commit 3dcbcf04 gave every table on the security hub page
 * (app/dashboard/security/[id]/page.tsx) the shared ScrollFade wrapper so a
 * clipped right-hand column shows the scroll cue on narrow viewports, but
 * missed the Recent Transactions table — it lives in a separate client
 * component, app/dashboard/components/TransactionsSection.tsx, which still
 * wrapped its table in a bare `<div className="overflow-x-auto">`. This is a
 * source-pin test (no DOM harness in this repo — see
 * tests/repo/holdings-table-quantity-unit-helper.test.ts precedent): it
 * asserts the component imports ScrollFade and no longer has a bare
 * overflow-x-auto table wrapper.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("TransactionsSection — Recent Transactions table uses the shared ScrollFade wrapper", () => {
  const src = readFileSync("app/dashboard/components/TransactionsSection.tsx", "utf8");

  it("imports ScrollFade from the shared component", () => {
    expect(src).toMatch(/import\s*\{\s*ScrollFade\s*\}\s*from\s*["']\.\/ScrollFade["']/);
  });

  it("uses <ScrollFade> to wrap the table instead of a bare overflow-x-auto div", () => {
    expect(src).toMatch(/<ScrollFade>/);
  });

  it("no longer has a bare overflow-x-auto div wrapper", () => {
    expect(src).not.toMatch(/className="overflow-x-auto"/);
  });
});
