/**
 * Research -> Feeds: an article the summarising gate never sends to the model
 * (owner ruling 2026-11-02, lib/gmail/enrichment-policy.ts) keeps
 * processed_at NULL forever. It must still list, count and search in Feeds,
 * while the summary-reading callers (plain processedOnly) keep hiding it.
 *
 * Finding: dashboard-research-view-feeds-feeds-list-search-source-filter-digest-after-pr-133-articles-from-the-four-no-lo
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getRecentArticles,
  countRecentArticles,
  getResearchSources,
} from "@/lib/queries/research";

let db: Database.Database;
const ids: Record<string, number> = {};
const ALL = 100000;

const DAWN = "Vital Knowledge: Vital Dawn for Monday November 2, 2026";
const NON_DAWN = "Vital Knowledge: Company-specific news for Mon 11/2 (AMC)";

function seed(sourceId: number, subject: string, day: number, processed: boolean, raw = "body"): void {
  db.prepare(
    `INSERT INTO research_articles
       (source_id, subject, sender, received_at, raw_text, summary, processed_at)
     VALUES (?, ?, 'x@example.test', ?, ?, ?, ?)`,
  ).run(
    sourceId,
    subject,
    `2026-01-${String(day).padStart(2, "0")} 12:00:00`,
    raw,
    processed ? "Summary" : null,
    processed ? "2026-01-20 12:00:00" : null,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  for (const name of ["AAA Letter", "Semi Doped", "TBPN", "Vital Knowledge"]) {
    ids[name] = db
      .prepare("INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)")
      .run(name, `${name.replace(/\s/g, "")}@example.test`).lastInsertRowid as number;
  }
  seed(ids["AAA Letter"], "aaa processed", 1, true);
  seed(ids["AAA Letter"], "aaa queued", 2, false);
  seed(ids["Semi Doped"], "semi episode", 3, false, "talking about wafergizmo yields");
  seed(ids["TBPN"], "tbpn episode", 4, false);
  seed(ids["Vital Knowledge"], DAWN, 5, false);
  seed(ids["Vital Knowledge"], NON_DAWN, 6, false, "zorblat guidance raised");
  seed(ids["Vital Knowledge"], "Vital Knowledge: Vital Dawn for Tuesday", 7, true);
});

const subjects = (rows: { subject: string }[]) => rows.map((r) => r.subject).sort();

describe("articles never summarised by policy", () => {
  it("processedOnly alone still hides them (summary readers unchanged)", () => {
    const list = getRecentArticles(db, { processedOnly: true, limit: ALL });
    expect(subjects(list)).toEqual(subjects([{ subject: "aaa processed" }, { subject: "Vital Knowledge: Vital Dawn for Tuesday" }]));
    expect(countRecentArticles(db, { processedOnly: true })).toBe(2);
  });

  it("with includeNeverSummarized they list and count; queued summarisable rows stay hidden", () => {
    const filter = { processedOnly: true, includeNeverSummarized: true };
    const list = getRecentArticles(db, { ...filter, limit: ALL });
    const got = subjects(list);
    expect(got).toContain("semi episode");
    expect(got).toContain("tbpn episode");
    expect(got).toContain(NON_DAWN);
    expect(got).not.toContain(DAWN);
    expect(got).not.toContain("aaa queued");
    expect(list).toHaveLength(5);
    expect(countRecentArticles(db, filter)).toBe(5);
  });

  it("search by a word from the raw text finds them", () => {
    const filter = { processedOnly: true, includeNeverSummarized: true };
    expect(subjects(getRecentArticles(db, { ...filter, search: "wafergizmo", limit: ALL }))).toEqual(["semi episode"]);
    expect(subjects(getRecentArticles(db, { ...filter, search: "zorblat", limit: ALL }))).toEqual([NON_DAWN]);
    expect(countRecentArticles(db, { ...filter, search: "zorblat" })).toBe(1);
    expect(getRecentArticles(db, { processedOnly: true, search: "zorblat", limit: ALL })).toHaveLength(0);
  });

  it("the source filter's count matches the list it opens, per source", () => {
    for (const s of getResearchSources(db)) {
      const filter = { sourceId: s.id, processedOnly: true, includeNeverSummarized: true };
      const list = getRecentArticles(db, { ...filter, limit: ALL });
      expect(s.processed_article_count).toBe(list.length);
      expect(countRecentArticles(db, filter)).toBe(list.length);
    }
    const mine = new Set(Object.values(ids));
    const bySource = Object.fromEntries(
      getResearchSources(db)
        .filter((s) => mine.has(s.id))
        .map((s) => [s.name, s.processed_article_count]),
    );
    expect(bySource).toEqual({ "AAA Letter": 1, "Semi Doped": 1, TBPN: 1, "Vital Knowledge": 2 });
  });
});
