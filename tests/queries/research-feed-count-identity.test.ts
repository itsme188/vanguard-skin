/**
 * Research -> Feeds: every count on the page equals the list it sits beside.
 *
 * Findings: research-feeds--filtered-articles-render-as-bare-cards-no-marker-regression-1
 * (the card needs is_relevant / excluded_category, and filtered rows STAY in
 * the main list by owner ruling), research-feeds--source-list-caps-at-50-no-disclosure-regression-1
 * and research-feeds-source-filter--omits-deactivated-sources-with-articles
 * (the "N of M" total and the dropdown count come from the per-source feed
 * count, which must be the list's own predicate).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getRecentArticles,
  countRecentArticles,
  getResearchSources,
  getFilteredArticles,
  getFilteredArticleCount,
  getFilteredArticleCategoryCounts,
} from "@/lib/queries/research";
import { feedTotalForSource } from "@/app/dashboard/components/ResearchFeedsView";

let db: Database.Database;
let active: number;
let inactive: number;
let empty: number;
const ALL = 100000;

function seed(o: {
  sourceId: number;
  subject: string;
  day: number;
  processed?: boolean;
  relevant?: 0 | 1;
  category?: string | null;
}): number {
  return db
    .prepare(
      `INSERT INTO research_articles
         (source_id, subject, sender, received_at, raw_text, summary,
          processed_at, is_relevant, excluded_category)
       VALUES (?, ?, 'x@example.test', ?, 'body', 'Summary', ?, ?, ?)`,
    )
    .run(
      o.sourceId,
      o.subject,
      `2026-01-${String(o.day).padStart(2, "0")} 12:00:00`,
      o.processed === false ? null : "2026-01-20 12:00:00",
      o.relevant ?? 1,
      o.category ?? null,
    ).lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const src = (name: string, isActive: number) =>
    db
      .prepare("INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, ?)")
      .run(name, `${name}@example.test`, isActive).lastInsertRowid as number;
  active = src("aaa", 1);
  inactive = src("bbb", 0);
  empty = src("ccc", 1);

  seed({ sourceId: active, subject: "alpha one", day: 1 });
  seed({ sourceId: active, subject: "alpha two", day: 2 });
  seed({ sourceId: active, subject: "alpha off topic", day: 3, relevant: 0, category: "off_topic" });
  seed({ sourceId: active, subject: "alpha receipt", day: 4, processed: false, relevant: 0, category: "receipt" });
  seed({ sourceId: active, subject: "alpha queued", day: 5, processed: false });
  seed({ sourceId: inactive, subject: "beta one", day: 6 });
  seed({ sourceId: inactive, subject: "beta no category", day: 7, relevant: 0, category: null });
  seed({ sourceId: empty, subject: "gamma receipt", day: 8, processed: false, relevant: 0, category: "receipt" });
});

describe("main feed: count equals list", () => {
  it("each source's feed count is the number of rows the list returns for it", () => {
    for (const s of getResearchSources(db)) {
      const filter = { sourceId: s.id, processedOnly: true };
      const list = getRecentArticles(db, { ...filter, limit: ALL });
      expect(s.processed_article_count).toBe(list.length);
      expect(countRecentArticles(db, filter)).toBe(list.length);
    }
  });

  it("the all-sources total is the unscoped list length, inactive sources included", () => {
    const sources = getResearchSources(db);
    const list = getRecentArticles(db, { processedOnly: true, limit: ALL });
    expect(feedTotalForSource(sources, null)).toBe(list.length);
    expect(countRecentArticles(db, { processedOnly: true })).toBe(list.length);
    expect(list.length).toBe(5);
    expect(feedTotalForSource(sources, inactive)).toBe(2);
    expect(feedTotalForSource(sources, empty)).toBe(0);
  });

  it("the feed count is not the all-articles count (unprocessed rows are not in the list)", () => {
    const a = getResearchSources(db).find((s) => s.id === active)!;
    expect(a.article_count).toBe(5);
    expect(a.processed_article_count).toBe(3);
  });

  it("count equals list under a search and under a paged limit's full window", () => {
    const filter = { processedOnly: true, search: "alpha" };
    expect(countRecentArticles(db, filter)).toBe(getRecentArticles(db, { ...filter, limit: ALL }).length);
    // A longer limit re-reads the same window: the shorter page is its prefix.
    const two = getRecentArticles(db, { processedOnly: true, limit: 2 }).map((r) => r.id);
    const four = getRecentArticles(db, { processedOnly: true, limit: 4 }).map((r) => r.id);
    expect(four.slice(0, 2)).toEqual(two);
  });
});

describe("main feed carries the filtered marker's data", () => {
  it("a filtered processed article stays in the list and carries is_relevant + excluded_category", () => {
    const list = getRecentArticles(db, { processedOnly: true, limit: ALL });
    const off = list.find((r) => r.subject === "alpha off topic")!;
    expect(off.is_relevant).toBe(0);
    expect(off.excluded_category).toBe("off_topic");
    const normal = list.find((r) => r.subject === "alpha one")!;
    expect(normal.is_relevant).toBe(1);
    expect(normal.excluded_category).toBeNull();
  });

  it("a pre-AI filtered row is in the Filtered list and NOT in the main list", () => {
    const main = getRecentArticles(db, { processedOnly: true, limit: ALL }).map((r) => r.subject);
    const filtered = getFilteredArticles(db, { limit: ALL }).map((r) => r.subject);
    expect(main).not.toContain("alpha receipt");
    expect(filtered).toContain("alpha receipt");
  });
});

describe("Filtered tab: badge equals section headers equals list", () => {
  const scopes = () => [
    {},
    { sourceId: active },
    { sourceId: inactive },
    { search: "receipt" },
    { sourceId: active, search: "alpha" },
    { search: "no such text" },
  ];

  it.each([0, 1, 2, 3, 4, 5])("scope %i: the category counts sum to the list length", (i) => {
    const scope = scopes()[i];
    const list = getFilteredArticles(db, { ...scope, limit: ALL });
    const counts = getFilteredArticleCategoryCounts(db, scope);
    expect(counts.reduce((sum, c) => sum + c.count, 0)).toBe(list.length);
    for (const c of counts) {
      expect(list.filter((r) => (r.excluded_category || "other") === c.category)).toHaveLength(c.count);
    }
  });

  it("the unscoped badge count is the unscoped list length", () => {
    expect(getFilteredArticleCount(db)).toBe(getFilteredArticles(db, { limit: ALL }).length);
    expect(getFilteredArticleCount(db)).toBe(4);
  });
});
