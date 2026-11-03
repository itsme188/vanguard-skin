/**
 * Research -> Feeds card words for an article the summarising policy never
 * sends to the model (owner ruling 2026-11-02). Such an article now lists in
 * All articles with processed_at NULL forever, so "pre-AI", "Enrichment
 * pending" and "appears after the next sync" would all be false for it.
 *
 * Finding: dashboard-research-view-feeds-feeds-list-search-source-filter-digest-after-pr-133-articles-from-the-four-no-lo
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  isNeverSummarizedArticle,
  feedCardEmptyLabel,
  NEVER_SUMMARIZED_MARKER,
  resolveLinkedArticle,
  describeUnfilterOutcome,
} from "@/app/dashboard/components/ResearchFeedsView";

const NON_DAWN = { source_name: "Vital Knowledge", subject: "Vital Knowledge: Company-specific news for Mon 11/2 (AMC)" };
const DAWN = { source_name: "Vital Knowledge", subject: "Vital Knowledge: Vital Dawn for Monday November 2, 2026" };

describe("isNeverSummarizedArticle", () => {
  it("is true only for an unprocessed article of a skipped source or issue", () => {
    expect(isNeverSummarizedArticle({ ...NON_DAWN, processed_at: null })).toBe(true);
    expect(isNeverSummarizedArticle({ source_name: "TBPN", subject: "x", processed_at: null })).toBe(true);
    expect(isNeverSummarizedArticle({ ...DAWN, processed_at: null })).toBe(false);
    expect(isNeverSummarizedArticle({ source_name: "AAA Letter", subject: "x", processed_at: null })).toBe(false);
    expect(isNeverSummarizedArticle({ source_name: "TBPN", subject: "x", processed_at: "2026-01-01" })).toBe(false);
    expect(isNeverSummarizedArticle({ processed_at: null })).toBe(false);
  });
});

describe("card label", () => {
  it("a by-design article says so instead of Enrichment pending", () => {
    expect(NEVER_SUMMARIZED_MARKER).toBe("not summarised by design");
    expect(
      feedCardEmptyLabel({ source_name: "Semi Doped", subject: "ep", summary: null, key_themes: null, processed_at: null }),
    ).toBe("Not summarised by design");
    expect(
      feedCardEmptyLabel({ source_name: "AAA Letter", subject: "ep", summary: null, key_themes: null, processed_at: null }),
    ).toBe("Enrichment pending");
  });

  it("the Filtered-tab row keeps pre-AI only for a genuinely never-analysed article", () => {
    const src = readFileSync("app/dashboard/components/ResearchFeedsView.tsx", "utf8");
    expect(src).toContain("isNeverSummarizedArticle(article) ? NEVER_SUMMARIZED_MARKER : \"pre-AI\"");
  });
});

describe("deep link and Unfilter wording", () => {
  it("a deep link to a by-design article opens it", () => {
    expect(resolveLinkedArticle("7", { id: 7, processed_at: null, is_relevant: 1, ...NON_DAWN })).toEqual({
      kind: "open",
      id: 7,
    });
  });

  it("Unfilter of a by-design article does not promise a later sync", () => {
    const o = describeUnfilterOutcome(null, true);
    expect(o.text).toMatch(/back in All articles/);
    expect(o.text).toMatch(/not summarised by design/);
    expect(o.text).not.toMatch(/sync/i);
    expect(describeUnfilterOutcome(null).text).toMatch(/next feed sync/);
  });
});
