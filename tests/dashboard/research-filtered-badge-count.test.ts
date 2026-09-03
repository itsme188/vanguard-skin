import { describe, it, expect } from "vitest";
import { computeFilteredBadgeCount } from "@/app/dashboard/components/ResearchFeedsView";

// QA finding `research-feeds-filtered--badge-ignores-source-filter-regression-1`:
// the Filtered tab's badge stayed pinned to the GLOBAL filtered count
// (initialFilteredCount / getFilteredArticleCount, unscoped) even while the
// list and section headers correctly narrow to the active source/search
// filter — e.g. badge "221" over a list of 28 rows for source_id=1. The
// section-header counts (filteredCategoryCounts) are already fetched under
// the identical (sourceId, search) predicate as the list
// (buildFilteredArticlesWhere), so the badge should sum those whenever the
// Filtered tab is the active view, matching the project's countOnly
// convention: the badge and the list must never disagree.
describe("computeFilteredBadgeCount", () => {
  it("sums the scoped category counts when the Filtered tab is active", () => {
    const count = computeFilteredBadgeCount("filtered", 221, [
      { category: "off_topic", count: 28 },
    ]);
    expect(count).toBe(28);
  });

  it("sums across multiple categories under the active scope", () => {
    const count = computeFilteredBadgeCount("filtered", 221, [
      { category: "off_topic", count: 20 },
      { category: "spam", count: 8 },
    ]);
    expect(count).toBe(28);
  });

  it("falls back to the global count on the 'all' tab (no scoped list on screen to disagree with)", () => {
    const count = computeFilteredBadgeCount("all", 221, [
      { category: "off_topic", count: 28 },
    ]);
    expect(count).toBe(221);
  });

  it("matches the global count on the Filtered tab when no source/search filter narrows it", () => {
    const count = computeFilteredBadgeCount("filtered", 221, [
      { category: "off_topic", count: 150 },
      { category: "spam", count: 71 },
    ]);
    expect(count).toBe(221);
  });
});
