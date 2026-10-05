/**
 * QA: Research feeds leaked AI portfolio-relevance prose and Filtered-tab
 * exclusion reasons in clear text under privacy mode. No DOM harness, so pin
 * by source scan: each field must only be rendered inside <PrivateText>.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("app/dashboard/components/ResearchFeedsView.tsx", "utf8");

describe("ResearchFeedsView prose privacy", () => {
  it("imports PrivateText", () => {
    expect(src).toMatch(/PrivateText[\s\S]*?from\s+"@\/lib\/privacy\/components"/);
  });

  for (const field of ["portfolio_relevance", "excluded_reason"]) {
    it(`renders ${field} only inside <PrivateText>`, () => {
      const re = new RegExp(`\\{\\s*article\\.${field}\\s*\\}`, "g");
      const matches = [...src.matchAll(re)];
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        const before = src.slice(Math.max(0, m.index! - 40), m.index!);
        const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
        expect(before).toMatch(/<PrivateText>\s*$/);
        expect(after).toMatch(/^\s*<\/PrivateText>/);
      }
    });
  }
});
