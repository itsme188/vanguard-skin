import { describe, it, expect } from "vitest";
import { buildReviewSections, isDefaultStreamSort } from "@/app/dashboard/alerts/page";

// Minimal PendingLevel fixture — only the fields buildReviewSections cares
// about (source_author for grouping, id/price for ordering checks) vary
// per-call; the rest are structurally required by the interface.
function level(id: number, source_author: string | null, opts: { price?: number } = {}) {
  return {
    id,
    security_id: id,
    symbol: `SYM${id}`,
    security_name: null,
    level_type: "support",
    price: opts.price ?? id,
    price_source: "static",
    direction: null,
    action_hint: null,
    source_author,
    thesis: null,
    timeframe: null,
    source_article_id: null,
    current_price: null,
    created_at: "2026-08-16T12:00:00.000Z",
  };
}

describe("isDefaultStreamSort", () => {
  it("recency desc is the default", () => {
    expect(isDefaultStreamSort({ field: "recency", dir: "desc" })).toBe(true);
  });

  it("a null field (unset URL param) counts as default", () => {
    expect(isDefaultStreamSort({ field: null, dir: "desc" })).toBe(true);
  });

  it("recency asc is NOT the default (direction flipped explicitly)", () => {
    expect(isDefaultStreamSort({ field: "recency", dir: "asc" })).toBe(false);
  });

  it("any other field is not the default", () => {
    expect(isDefaultStreamSort({ field: "level_price", dir: "desc" })).toBe(false);
    expect(isDefaultStreamSort({ field: "symbol", dir: "desc" })).toBe(false);
    expect(isDefaultStreamSort({ field: "source_author", dir: "desc" })).toBe(false);
  });
});

describe("buildReviewSections", () => {
  it("groups by author under the default sort, preserving group + within-group order", () => {
    // Interleaved input (as sortedItems would produce under recency desc):
    // Author B's newest level first, then A's, then B's older one.
    const levels = [level(1, "Author B"), level(2, "Author A"), level(3, "Author B")];
    const sections = buildReviewSections(levels, { field: "recency", dir: "desc" });

    expect(sections.map((s) => s.author)).toEqual(["Author B", "Author A"]);
    expect(sections.find((s) => s.author === "Author B")!.levels.map((l) => l.id)).toEqual([
      1, 3,
    ]);
    expect(sections.find((s) => s.author === "Author A")!.levels.map((l) => l.id)).toEqual([2]);
  });

  it("buckets levels with no source_author under 'Unknown'", () => {
    const levels = [level(1, null), level(2, "Author A")];
    const sections = buildReviewSections(levels, { field: "recency", dir: "desc" });
    expect(sections.map((s) => s.author)).toEqual(["Unknown", "Author A"]);
  });

  it("renders one flat, globally-ordered section under an explicit sort — the bug this fixes", () => {
    // Sorted globally by price ascending: this order interleaves authors
    // (10 < 12 < 15 < 20), which the OLD author-grouped rendering would
    // have re-partitioned into per-author buckets (A: [10, 15], B: [12,
    // 20]) — losing the requested global order across group boundaries.
    const levels = [
      level(1, "Author A", { price: 10 }),
      level(2, "Author B", { price: 12 }),
      level(3, "Author A", { price: 15 }),
      level(4, "Author B", { price: 20 }),
    ];
    const sections = buildReviewSections(levels, { field: "level_price", dir: "asc" });

    expect(sections).toHaveLength(1);
    expect(sections[0].author).toBeNull();
    expect(sections[0].levels.map((l) => l.id)).toEqual([1, 2, 3, 4]);
  });

  it("an explicit sort with only direction flipped from default also flattens", () => {
    const levels = [level(1, "Author A"), level(2, "Author B")];
    const sections = buildReviewSections(levels, { field: "recency", dir: "asc" });
    expect(sections).toHaveLength(1);
    expect(sections[0].author).toBeNull();
  });
});
